import { describe, expect, it } from "vitest";
import { runKillTests } from "./killTests.mjs";

/** A small stand-in for PayPal, so the script's logic is tested without the network. */
function fakePaypal({ allowSecondCapture = true, returnInvoice = true, rejectPayee = false } = {}) {
  const captures = new Map();
  const byRequestId = new Map();
  let captured = 0;
  const seen = [];
  const json = (status, body) => new Response(JSON.stringify(body), { status });

  const impl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const method = init.method ?? "GET";
    const body = init.body && typeof init.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : init.body;
    seen.push({ method, path, headers: init.headers, body });

    if (path === "/v1/oauth2/token") return json(200, { access_token: "tok", expires_in: 3600 });
    if (path === "/v2/checkout/orders") {
      if (rejectPayee) return json(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "PAYEE_ACCOUNT_RESTRICTED" }] });
      return json(201, { id: "ORDER-1", links: [{ rel: "payer-action", href: "https://sandbox.paypal.com/approve?token=ORDER-1" }] });
    }
    if (path === "/v2/checkout/orders/ORDER-1/authorize") {
      return json(201, {
        purchase_units: [{ payee: { email_address: "Freelancer@Test.com" }, payments: { authorizations: [{ id: "AUTH-1" }] } }],
      });
    }
    if (path === "/v2/payments/authorizations/AUTH-1/capture") {
      const reqId = init.headers["PayPal-Request-Id"];
      if (byRequestId.has(reqId)) return json(200, byRequestId.get(reqId));
      if (captured >= 1 && !allowSecondCapture) return json(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "AUTHORIZATION_ALREADY_CAPTURED" }] });
      captured += 1;
      const cap = { id: `CAP-${captured}`, status: "COMPLETED", invoice_id: body.invoice_id };
      captures.set(cap.id, cap);
      byRequestId.set(reqId, cap);
      return json(201, cap);
    }
    const m = path.match(/^\/v2\/payments\/captures\/(CAP-\d)$/);
    if (m) {
      const c = captures.get(m[1]);
      return json(200, returnInvoice ? c : { ...c, invoice_id: undefined });
    }
    return json(404, { name: "NOT_FOUND", path });
  };
  return { impl, seen };
}

const run = (fake, extra = {}) =>
  runKillTests({
    clientId: "id",
    clientSecret: "secret",
    payeeEmail: "freelancer@test.com",
    fetchImpl: fake.impl,
    waitForApproval: async () => undefined,
    log: () => undefined,
    ...extra,
  });

describe("runKillTests", () => {
  it("passes K1, K2, idempotency and invoice_id when PayPal behaves", async () => {
    const fake = fakePaypal();
    const { results } = await run(fake);
    expect(results.K1).toMatch(/^PASS/);
    expect(results.K2).toMatch(/^PASS/);
    expect(results.idempotency).toMatch(/^PASS/);
    expect(results.invoiceIdOnCapture).toMatch(/^PASS/);
  });

  it("creates the order with the freelancer as payee and authorize intent", async () => {
    const fake = fakePaypal();
    await run(fake);
    const order = fake.seen.find((r) => r.path === "/v2/checkout/orders");
    expect(order.body.intent).toBe("AUTHORIZE");
    expect(order.body.purchase_units[0].payee.email_address).toBe("freelancer@test.com");
  });

  it("makes the first capture partial and the second final, with the amounts adding up", async () => {
    const fake = fakePaypal();
    await run(fake);
    const caps = fake.seen.filter((r) => r.path.endsWith("/capture") && r.headers["PayPal-Request-Id"].startsWith("cap"));
    const first = caps.find((c) => c.body.invoice_id.endsWith(":1"));
    const second = caps.find((c) => c.body.invoice_id.endsWith(":2"));
    expect(first.body.final_capture).toBe(false);
    expect(second.body.final_capture).toBe(true);
    expect(Number(first.body.amount.value) + Number(second.body.amount.value)).toBe(10);
  });

  it("reports K2 FAIL with the fallback when the second capture is refused", async () => {
    const { results } = await run(fakePaypal({ allowSecondCapture: false }));
    expect(results.K2).toMatch(/^FAIL/);
    expect(results.K2).toMatch(/authorize-and-capture 100%/);
  });

  it("reports K1 FAIL with the Payouts fallback when PayPal refuses the payee", async () => {
    const { results } = await run(fakePaypal({ rejectPayee: true }));
    expect(results.K1).toMatch(/^FAIL/);
    expect(results.K1).toMatch(/Payouts/);
  });

  it("flags a missing invoice_id, which the webhook handler depends on", async () => {
    const { results } = await run(fakePaypal({ returnInvoice: false }));
    expect(results.invoiceIdOnCapture).toMatch(/^FAIL/);
  });

  it("never records the access token or the client secret in the report", async () => {
    const report = await run(fakePaypal());
    const text = JSON.stringify(report);
    expect(text).not.toContain('"tok"');
    expect(text).not.toContain("secret");
  });

  it("stops with a clear message when the credentials are wrong", async () => {
    const fake = { impl: async () => new Response("{}", { status: 401 }), seen: [] };
    const { results } = await run(fake);
    expect(results.setup).toMatch(/SANDBOX credentials/);
    expect(results.K1).toBeUndefined();
  });
});
