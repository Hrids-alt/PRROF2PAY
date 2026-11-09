// Day 1 kill tests against the PayPal sandbox.
//   K1  Money goes to the freelancer's account (order created with a payee).
//   K2  One authorization can be captured twice (two partial captures), and
//       PayPal returns our invoice_id on each capture so webhooks can be matched.
//   Bonus: replaying a capture with the same PayPal-Request-Id must not charge twice.
//
// Run it with: node scripts/kill-tests.mjs (see README)
import { randomUUID } from "node:crypto";
import http from "node:http";

const money = (cents) => (cents / 100).toFixed(2);

export async function runKillTests({
  base = "https://api-m.sandbox.paypal.com",
  clientId,
  clientSecret,
  payeeEmail,
  fetchImpl = fetch,
  waitForApproval,
  log = console.log,
  totalCents = 1000,
  part1Cents = 500,
}) {
  const report = { startedAt: new Date().toISOString(), base, steps: [], results: {} };
  const record = (step, status, body) => report.steps.push({ step, status, body });

  async function call(step, method, path, { token, body, headers = {}, form } = {}) {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: form ?? (body ? JSON.stringify(body) : undefined),
    });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }
    // The access token is never recorded.
    record(step, res.status, step === "oauth token" ? { status: res.status } : json);
    return { ok: res.ok, status: res.status, json };
  }

  // 1. Access token
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const tok = await call("oauth token", "POST", "/v1/oauth2/token", {
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    form: "grant_type=client_credentials",
  });
  if (!tok.ok) {
    report.results.setup = "FAIL: could not get an access token. Check client ID/secret and that they are SANDBOX credentials.";
    return report;
  }
  const token = tok.json.access_token;

  // 2. Order with a payee
  const milestoneId = randomUUID();
  const returnUrl = "http://localhost:3999/return";
  const order = await call("create order", "POST", "/v2/checkout/orders", {
    token,
    headers: { "PayPal-Request-Id": `order-${milestoneId}` },
    body: {
      intent: "AUTHORIZE",
      purchase_units: [
        {
          reference_id: milestoneId,
          amount: { currency_code: "USD", value: money(totalCents) },
          payee: { email_address: payeeEmail },
        },
      ],
      application_context: {
        return_url: returnUrl,
        cancel_url: "http://localhost:3999/cancel",
        user_action: "PAY_NOW",
        shipping_preference: "NO_SHIPPING",
      },
    },
  });
  if (!order.ok) {
    report.results.K1 =
      `FAIL: PayPal refused an order with a different payee (HTTP ${order.status}). ` +
      "Fallback: take the money on the platform account and pay the freelancer with PayPal Payouts. Paste this output to Claude.";
    return report;
  }
  const approveUrl = order.json.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href;
  log(`\nOpen this link in a browser and approve as the SANDBOX BUYER (not the freelancer):\n\n  ${approveUrl}\n`);
  log("Waiting for you to approve (this script listens on http://localhost:3999)...");
  await waitForApproval(order.json.id);

  // 3. Authorize
  const authz = await call("authorize order", "POST", `/v2/checkout/orders/${order.json.id}/authorize`, {
    token,
    headers: { "PayPal-Request-Id": `authz-${milestoneId}` },
    body: {},
  });
  const unit = authz.json.purchase_units?.[0];
  const authorization = unit?.payments?.authorizations?.[0];
  if (!authz.ok || !authorization?.id) {
    report.results.K1 = `FAIL: authorization did not succeed (HTTP ${authz.status}). Paste this output to Claude.`;
    return report;
  }
  const payeeSeen = unit.payee?.email_address;
  report.results.K1 =
    payeeSeen && payeeSeen.toLowerCase() === payeeEmail.toLowerCase()
      ? `PASS: the authorization is addressed to ${payeeSeen}. Now open that sandbox account's Activity page (sandbox.paypal.com) after the captures and confirm the money arrives there, not on the platform account.`
      : `CHECK: PayPal reports payee "${payeeSeen ?? "none"}", expected "${payeeEmail}".`;

  // 4. Two partial captures
  const part2Cents = totalCents - part1Cents;
  const capture = (part, cents, finalCapture, requestId) =>
    call(`capture part ${part}`, "POST", `/v2/payments/authorizations/${authorization.id}/capture`, {
      token,
      headers: { "PayPal-Request-Id": requestId },
      body: {
        amount: { currency_code: "USD", value: money(cents) },
        invoice_id: `p2p:${milestoneId}:${part}`,
        final_capture: finalCapture,
      },
    });

  const req1 = `cap1-${milestoneId}`;
  const c1 = await capture(1, part1Cents, false, req1);
  const c1again = await capture(1, part1Cents, false, req1); // same request id: must be a replay
  const c2 = await capture(2, part2Cents, true, `cap2-${milestoneId}`);

  const okStatus = (r) => r.ok && ["COMPLETED", "PENDING"].includes(r.json.status);
  const k2 = [];
  if (okStatus(c1) && okStatus(c2) && c1.json.id !== c2.json.id) {
    k2.push(`PASS: two captures from one authorization (${c1.json.id}, ${c2.json.id}).`);
    if (c1.json.status === "PENDING" || c2.json.status === "PENDING") {
      k2.push("NOTE: a capture is PENDING. The webhook, not the API reply, must decide the unlock.");
    }
  } else {
    k2.push(
      `FAIL: capture 1 -> HTTP ${c1.status} ${c1.json.status ?? c1.json.name ?? ""}; capture 2 -> HTTP ${c2.status} ${c2.json.status ?? c2.json.name ?? ""}. ` +
        "If PayPal refuses the second partial capture, the plan falls back to authorize-and-capture 100% at step 9.",
    );
  }
  report.results.K2 = k2.join(" ");

  report.results.idempotency =
    c1again.ok && c1again.json.id === c1.json.id
      ? "PASS: replaying capture 1 with the same PayPal-Request-Id returned the same capture, so no double charge."
      : `CHECK: replay returned HTTP ${c1again.status} id ${c1again.json.id ?? "none"} (first was ${c1.json.id ?? "none"}).`;

  // 5. Does PayPal give our invoice_id back? The webhook handler depends on this.
  const readBack = [];
  for (const [part, c] of [[1, c1], [2, c2]]) {
    if (!c.json.id) continue;
    const got = await call(`read capture ${part}`, "GET", `/v2/payments/captures/${c.json.id}`, { token });
    readBack.push({ part, expected: `p2p:${milestoneId}:${part}`, got: got.json.invoice_id ?? null });
  }
  report.results.invoiceIdOnCapture = readBack.every((r) => r.got === r.expected)
    ? "PASS: PayPal returns invoice_id on captures, so the webhook can find the milestone."
    : `FAIL: invoice_id not returned as sent (${JSON.stringify(readBack)}). The webhook handler must look milestones up by capture id instead. Paste this to Claude.`;

  return report;
}

/** Starts a tiny local server and resolves when the buyer's browser comes back from PayPal. */
export function waitForLocalReturn(port = 3999, timeoutMs = 10 * 60_000) {
  return (orderId) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        server.close();
        reject(new Error("Timed out waiting for approval"));
      }, timeoutMs);
      const server = http.createServer((req, res) => {
        const url = new URL(req.url, `http://localhost:${port}`);
        if (url.pathname === "/return" && url.searchParams.get("token") === orderId) {
          res.end("Approved. You can close this tab and go back to the terminal.");
          clearTimeout(timer);
          server.close();
          resolve();
        } else {
          res.statusCode = 400;
          res.end("Not approved. Run the script again.");
        }
      });
      server.listen(port);
    });
}
