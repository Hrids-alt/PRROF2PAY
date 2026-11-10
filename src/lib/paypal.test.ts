/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from "vitest";
import { PaypalClient, PaypalError, money } from "./paypal";

function client(handler: (path: string, init: RequestInit) => { status: number; body?: unknown }) {
  const calls: Array<{ path: string; method: string; headers: Record<string, string>; body: any }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    const path = new URL(String(url)).pathname;
    if (path === "/v1/oauth2/token") return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
    calls.push({ path, method: init.method ?? "GET", headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const r = handler(path, init);
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status });
  });
  return { calls, pp: new PaypalClient({ baseUrl: "https://pp.test", clientId: "i", clientSecret: "s", fetchImpl: fetchImpl as unknown as typeof fetch }) };
}

describe("money", () => {
  it("formats cents with two decimals", () => {
    expect(money(500)).toBe("5.00");
    expect(money(1999)).toBe("19.99");
  });
});

describe("PaypalClient", () => {
  it("creates an AUTHORIZE order that names the payee and returns the approve link", async () => {
    const { pp, calls } = client(() => ({ status: 201, body: { id: "O1", links: [{ rel: "payer-action", href: "https://pp/approve" }] } }));
    const r = await pp.createAuthorizeOrder({
      requestId: "req-1", referenceId: "m1", amountCents: 1000, currency: "USD",
      payeeEmail: "f@x.io", description: "Job", returnUrl: "https://app/r", cancelUrl: "https://app/c",
    });
    expect(r).toEqual({ orderId: "O1", approveUrl: "https://pp/approve" });
    const sent = calls[0];
    expect(sent.headers["PayPal-Request-Id"]).toBe("req-1");
    expect(sent.body.intent).toBe("AUTHORIZE");
    expect(sent.body.purchase_units[0].payee.email_address).toBe("f@x.io");
    expect(sent.body.purchase_units[0].amount).toEqual({ currency_code: "USD", value: "10.00" });
  });

  it("throws a PaypalError carrying PayPal's reason when the order is refused", async () => {
    const { pp } = client(() => ({ status: 422, body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "CURRENCY_NOT_SUPPORTED" }] } }));
    await expect(
      pp.createAuthorizeOrder({ requestId: "r", referenceId: "m", amountCents: 100, currency: "INR", payeeEmail: "f@x.io", description: "", returnUrl: "u", cancelUrl: "u" }),
    ).rejects.toMatchObject({ name: "PaypalError", issue: "CURRENCY_NOT_SUPPORTED", status: 422 });
  });

  it("reads the authorization id, expiry and payee", async () => {
    const { pp } = client(() => ({
      status: 201,
      body: { purchase_units: [{ payee: { email_address: "f@x.io" }, payments: { authorizations: [{ id: "A1", expiration_time: "2026-12-08T00:00:00Z" }] } }] },
    }));
    const r = await pp.authorizeOrder("O1", "authz-1");
    expect(r.authorizationId).toBe("A1");
    expect(r.expiresAt?.toISOString()).toBe("2026-12-08T00:00:00.000Z");
    expect(r.payeeEmail).toBe("f@x.io");
  });

  it("sends a partial capture with invoice_id and final_capture", async () => {
    const { pp, calls } = client(() => ({ status: 201, body: { id: "C1", status: "COMPLETED", invoice_id: "p2p:m:1" } }));
    const r = await pp.capture({ authorizationId: "A1", requestId: "cap-1", amountCents: 500, currency: "USD", invoiceId: "p2p:m:1", finalCapture: false });
    expect(r).toMatchObject({ accepted: true, id: "C1", status: "COMPLETED", invoiceId: "p2p:m:1" });
    expect(calls[0].body).toEqual({ amount: { currency_code: "USD", value: "5.00" }, invoice_id: "p2p:m:1", final_capture: false });
    expect(calls[0].headers["PayPal-Request-Id"]).toBe("cap-1");
  });

  it("reports a declined capture as not accepted instead of throwing", async () => {
    const { pp } = client(() => ({ status: 201, body: { id: "C2", status: "DECLINED" } }));
    const r = await pp.capture({ authorizationId: "A1", requestId: "c", amountCents: 500, currency: "USD", invoiceId: "i", finalCapture: true });
    expect(r.accepted).toBe(false);
    expect(r.issue).toBe("DECLINED");
  });

  it("reports a refused capture (HTTP 422) with PayPal's reason", async () => {
    const { pp } = client(() => ({ status: 422, body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "AUTHORIZATION_VOIDED" }] } }));
    const r = await pp.capture({ authorizationId: "A1", requestId: "c", amountCents: 500, currency: "USD", invoiceId: "i", finalCapture: true });
    expect(r).toMatchObject({ accepted: false, issue: "AUTHORIZATION_VOIDED" });
  });

  it("throws on a server error, because the outcome is unknown and the caller must replay", async () => {
    const { pp } = client(() => ({ status: 503, body: {} }));
    await expect(pp.capture({ authorizationId: "A1", requestId: "c", amountCents: 500, currency: "USD", invoiceId: "i", finalCapture: true })).rejects.toBeInstanceOf(PaypalError);
  });

  it("treats a void of an already-voided authorization as done", async () => {
    const { pp } = client(() => ({ status: 422, body: { name: "UNPROCESSABLE_ENTITY" } }));
    await expect(pp.voidAuthorization("A1")).resolves.toBeUndefined();
  });

  it("reauthorizes with the amount and a request id", async () => {
    const { pp, calls } = client(() => ({ status: 201, body: { expiration_time: "2026-12-08T00:00:00Z" } }));
    const r = await pp.reauthorize({ authorizationId: "A1", amountCents: 1000, currency: "USD", requestId: "re-1" });
    expect(r.expiresAt).toBeInstanceOf(Date);
    expect(calls[0].path).toBe("/v2/payments/authorizations/A1/reauthorize");
    expect(calls[0].body.amount.value).toBe("10.00");
  });
});
