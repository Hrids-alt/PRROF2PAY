// A local stand-in for PayPal and the AI API, for offline demos and browser tests.
// It follows the same request shapes as the real services (and replays by PayPal-Request-Id),
// but it is NOT PayPal: use real sandbox credentials for the real demo.
//
//   APP_URL=http://localhost:3000 node scripts/fake-services.mjs
//   then start the app with PAYPAL_API_BASE=http://127.0.0.1:4010 AI_BASE_URL=http://127.0.0.1:4010
//
// Env: PORT (4010), APP_URL (where to send webhooks), FAKE_WEBHOOKS=false (do not send webhooks,
// to try the reconcile path), FAKE_DECLINE_CAPTURES=true (refuse captures).
import http from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT || 4010);
const APP_URL = (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
const orders = new Map();
const auths = new Map();
const captures = new Map();
const byRequest = new Map();
let n = 0;

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(body === undefined ? "" : JSON.stringify(body));
};
const readBody = (req) =>
  new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => {
      try {
        resolve(d ? JSON.parse(d) : {});
      } catch {
        resolve({ _raw: d });
      }
    });
  });

async function sendWebhook(capture) {
  if (process.env.FAKE_WEBHOOKS === "false") return;
  setTimeout(async () => {
    try {
      await fetch(`${APP_URL}/api/webhooks/paypal`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "paypal-transmission-id": randomUUID(),
          "paypal-transmission-time": new Date().toISOString(),
          "paypal-transmission-sig": "fake",
          "paypal-cert-url": "https://api.sandbox.paypal.com/fake.pem",
          "paypal-auth-algo": "SHA256withRSA",
        },
        body: JSON.stringify({ id: `WH-${capture.id}`, event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: capture.id, invoice_id: capture.invoice_id, status: "COMPLETED" } }),
      });
    } catch (e) {
      console.error("fake webhook failed", e.message);
    }
  }, 1500);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;
  const body = req.method === "POST" ? await readBody(req) : {};
  const requestId = req.headers["paypal-request-id"];

  if (p === "/v1/oauth2/token") return send(res, 200, { access_token: "fake-token", expires_in: 3600 });
  if (p === "/v1/notifications/verify-webhook-signature") return send(res, 200, { verification_status: "SUCCESS" });

  if (p === "/v2/checkout/orders" && req.method === "POST") {
    const id = `ORDER-${++n}`;
    orders.set(id, { id, unit: body.purchase_units?.[0], returnUrl: body.application_context?.return_url, cancelUrl: body.application_context?.cancel_url });
    return send(res, 201, { id, status: "CREATED", links: [{ rel: "payer-action", href: `http://localhost:${PORT}/approve/${id}` }] });
  }
  if (p.startsWith("/approve/")) {
    const o = orders.get(p.split("/")[2]);
    if (!o) return send(res, 404, { name: "NOT_FOUND" });
    res.writeHead(303, { Location: `${o.returnUrl}${o.returnUrl.includes("?") ? "&" : "?"}token=${o.id}&PayerID=FAKEPAYER` });
    return res.end();
  }
  let m = p.match(/^\/v2\/checkout\/orders\/([^/]+)\/authorize$/);
  if (m && req.method === "POST") {
    const o = orders.get(m[1]);
    if (!o) return send(res, 404, { name: "RESOURCE_NOT_FOUND" });
    const id = `AUTH-${++n}`;
    const auth = { id, orderId: o.id, amount: o.unit.amount, payee: o.unit.payee, remaining: Math.round(Number(o.unit.amount.value) * 100), status: "CREATED" };
    auths.set(id, auth);
    return send(res, 201, {
      id: o.id, status: "COMPLETED",
      purchase_units: [{ payee: o.unit.payee, payments: { authorizations: [{ id, status: "CREATED", expiration_time: new Date(Date.now() + 29 * 86400e3).toISOString() }] } }],
    });
  }
  m = p.match(/^\/v2\/payments\/authorizations\/([^/]+)\/capture$/);
  if (m && req.method === "POST") {
    if (requestId && byRequest.has(requestId)) return send(res, 200, byRequest.get(requestId));
    const a = auths.get(m[1]);
    if (!a) return send(res, 404, { name: "RESOURCE_NOT_FOUND" });
    if (a.status === "VOIDED") return send(res, 422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "AUTHORIZATION_VOIDED" }] });
    const cents = Math.round(Number(body.amount.value) * 100);
    if (cents > a.remaining) return send(res, 422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "AUTHORIZATION_AMOUNT_EXCEEDED" }] });
    const id = `CAP-${++n}`;
    if (process.env.FAKE_DECLINE_CAPTURES === "true") {
      const declined = { id, status: "DECLINED", invoice_id: body.invoice_id };
      byRequest.set(requestId, declined);
      return send(res, 201, declined);
    }
    a.remaining -= cents;
    const cap = { id, status: "COMPLETED", amount: body.amount, invoice_id: body.invoice_id, final_capture: !!body.final_capture, payee: a.payee };
    captures.set(id, cap);
    if (requestId) byRequest.set(requestId, cap);
    sendWebhook(cap);
    return send(res, 201, cap);
  }
  m = p.match(/^\/v2\/payments\/captures\/([^/]+)$/);
  if (m) return captures.has(m[1]) ? send(res, 200, captures.get(m[1])) : send(res, 404, { name: "RESOURCE_NOT_FOUND" });
  m = p.match(/^\/v2\/payments\/authorizations\/([^/]+)\/void$/);
  if (m && req.method === "POST") {
    const a = auths.get(m[1]);
    if (a) a.status = "VOIDED";
    res.writeHead(204);
    return res.end();
  }
  m = p.match(/^\/v2\/payments\/authorizations\/([^/]+)\/reauthorize$/);
  if (m && req.method === "POST") return send(res, 201, { id: m[1], status: "CREATED", expiration_time: new Date(Date.now() + 26 * 86400e3).toISOString() });

  // The AI API: judge verdicts and check drafting.
  if (p === "/v1/messages" && req.method === "POST") {
    const content = String(body.messages?.[0]?.content ?? "");
    if (String(body.system ?? "").includes("verification function")) {
      const text = (content.match(/<evidence>([\s\S]*?)<\/evidence>/)?.[1] ?? "").toLowerCase();
      const ok = text.includes("three plans") || text.includes("minimum size");
      const quote = text.includes("three plans") ? "three plans" : "minimum size";
      return send(res, 200, { content: [{ type: "text", text: JSON.stringify(ok ? { verdict: "verified", proof: "The document appears to show the requirement is met.", quote } : { verdict: "not_demonstrated", proof: "The document does not appear to cover this.", quote: null }) }] });
    }
    return send(res, 200, { content: [{ type: "text", text: "[]" }] });
  }
  send(res, 404, { name: "NOT_FOUND", path: p });
});

server.listen(PORT, "127.0.0.1", () => console.log(`fake PayPal + AI on http://127.0.0.1:${PORT}, webhooks to ${APP_URL}`));
