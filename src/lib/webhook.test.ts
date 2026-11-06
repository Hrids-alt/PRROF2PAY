import { describe, expect, it, vi } from "vitest";
import {
  handleWebhook,
  invoiceRef,
  makePaypalVerifier,
  parseInvoiceRef,
  type BeginResult,
  type WebhookStore,
} from "./webhook";

const MID = "123e4567-e89b-12d3-a456-426614174000";

const goodHeaders: Record<string, string> = {
  "paypal-transmission-id": "t-1",
  "paypal-transmission-time": "2026-11-07T00:00:00Z",
  "paypal-transmission-sig": "sig",
  "paypal-cert-url": "https://api.sandbox.paypal.com/cert.pem",
  "paypal-auth-algo": "SHA256withRSA",
};

function fakeStore(begin: BeginResult = "new") {
  return {
    begin: vi.fn(async () => begin),
    applyCapture: vi.fn(async () => "applied" as const),
    markProcessed: vi.fn(async () => undefined),
  } satisfies WebhookStore;
}

function run(opts: {
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
  verify?: () => Promise<boolean>;
  store?: ReturnType<typeof fakeStore>;
}) {
  const store = opts.store ?? fakeStore();
  const headers = opts.headers ?? goodHeaders;
  return {
    store,
    promise: handleWebhook({
      rawBody: opts.rawBody ?? JSON.stringify(opts.body),
      getHeader: (n) => headers[n.toLowerCase()],
      verify: opts.verify ?? (async () => true),
      store,
    }),
  };
}

const completed = (part: 1 | 2 = 1, id = "evt-1") => ({
  id,
  event_type: "PAYMENT.CAPTURE.COMPLETED",
  resource: { id: "CAP-1", invoice_id: invoiceRef({ milestoneId: MID, part }) },
});

describe("parseInvoiceRef", () => {
  it("round-trips", () => {
    expect(parseInvoiceRef(invoiceRef({ milestoneId: MID, part: 2 }))).toEqual({ milestoneId: MID, part: 2 });
  });
  it("rejects anything else", () => {
    for (const v of [undefined, 5, "", "p2p:nope:1", `p2p:${MID}:3`, `x:${MID}:1`, `p2p:${MID}:1 `]) {
      expect(parseInvoiceRef(v)).toBeNull();
    }
  });
});

describe("handleWebhook", () => {
  it("rejects missing signature headers before touching the store", async () => {
    const { promise, store } = run({ body: completed(), headers: {} });
    expect((await promise).status).toBe(400);
    expect(store.begin).not.toHaveBeenCalled();
  });

  it("rejects a body that is not JSON", async () => {
    const { promise } = run({ rawBody: "{nope" });
    expect((await promise).status).toBe(400);
  });

  it("returns 401 and stores nothing when the signature does not verify", async () => {
    const { promise, store } = run({ body: completed(), verify: async () => false });
    expect((await promise).status).toBe(401);
    expect(store.begin).not.toHaveBeenCalled();
  });

  it("treats a verifier that throws as unverified", async () => {
    const { promise, store } = run({
      body: completed(),
      verify: async () => {
        throw new Error("PayPal is down");
      },
    });
    expect((await promise).status).toBe(401);
    expect(store.begin).not.toHaveBeenCalled();
  });

  it("applies a completed capture", async () => {
    const { promise, store } = run({ body: completed(1) });
    expect((await promise).status).toBe(200);
    expect(store.applyCapture).toHaveBeenCalledWith({
      eventId: "evt-1",
      ref: { milestoneId: MID, part: 1 },
      captureId: "CAP-1",
      outcome: "confirmed",
    });
  });

  it("maps denied and declined captures to failed", async () => {
    for (const type of ["PAYMENT.CAPTURE.DENIED", "PAYMENT.CAPTURE.DECLINED"]) {
      const { promise, store } = run({ body: { ...completed(2), event_type: type } });
      await promise;
      expect(store.applyCapture).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed", ref: { milestoneId: MID, part: 2 } }));
    }
  });

  it("does not apply a redelivered event", async () => {
    const { promise, store } = run({ body: completed(), store: fakeStore("duplicate") });
    const res = await promise;
    expect(res).toEqual({ status: 200, body: "duplicate" });
    expect(store.applyCapture).not.toHaveBeenCalled();
  });

  it("processes an event that was stored but never finished", async () => {
    const { promise, store } = run({ body: completed(), store: fakeStore("retry") });
    await promise;
    expect(store.applyCapture).toHaveBeenCalledTimes(1);
  });

  it("acknowledges unrelated event types without moving money state", async () => {
    const { promise, store } = run({ body: { id: "evt-2", event_type: "CUSTOMER.DISPUTE.CREATED", resource: {} } });
    expect((await promise).status).toBe(200);
    expect(store.applyCapture).not.toHaveBeenCalled();
    expect(store.markProcessed).toHaveBeenCalledWith("evt-2");
  });

  it("acknowledges captures that are not ours", async () => {
    const body = { id: "evt-3", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "CAP-9", invoice_id: "INV-77" } };
    const { promise, store } = run({ body });
    expect((await promise).status).toBe(200);
    expect(store.applyCapture).not.toHaveBeenCalled();
    expect(store.markProcessed).toHaveBeenCalledWith("evt-3");
  });

  it("returns 500 so PayPal redelivers when the store fails", async () => {
    const store = fakeStore();
    store.applyCapture.mockRejectedValueOnce(new Error("db down"));
    const { promise } = run({ body: completed(), store });
    expect((await promise).status).toBe(500);
  });
});

describe("makePaypalVerifier", () => {
  const input = {
    headers: {
      transmissionId: "t-1",
      transmissionTime: "2026-11-07T00:00:00Z",
      transmissionSig: "sig",
      certUrl: "https://api.sandbox.paypal.com/cert.pem",
      authAlgo: "SHA256withRSA",
    },
    event: completed(),
  };

  function paypalFake(verification: unknown, verifyOk = true) {
    return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/v1/oauth2/token")) {
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
      }
      expect(u.endsWith("/v1/notifications/verify-webhook-signature")).toBe(true);
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
      return new Response(JSON.stringify(verification), { status: verifyOk ? 200 : 500 });
    });
  }

  const cfg = (fetchImpl: typeof fetch) => ({
    baseUrl: "https://api-m.sandbox.paypal.com",
    clientId: "id",
    clientSecret: "secret",
    webhookId: "WH-1",
    fetchImpl,
  });

  it("is true only for SUCCESS, and sends our webhook id", async () => {
    const f = paypalFake({ verification_status: "SUCCESS" });
    const verify = makePaypalVerifier(cfg(f as unknown as typeof fetch));
    expect(await verify(input)).toBe(true);
    const call = f.mock.calls.find(([u]) => String(u).includes("verify-webhook-signature"))!;
    const sent = JSON.parse(String(call[1]!.body));
    expect(sent.webhook_id).toBe("WH-1");
    expect(sent.transmission_id).toBe("t-1");
    expect(sent.webhook_event).toEqual(input.event);
  });

  it("is false for FAILURE and for HTTP errors", async () => {
    expect(await makePaypalVerifier(cfg(paypalFake({ verification_status: "FAILURE" }) as unknown as typeof fetch))(input)).toBe(false);
    expect(await makePaypalVerifier(cfg(paypalFake({}, false) as unknown as typeof fetch))(input)).toBe(false);
  });

  it("reuses the access token", async () => {
    const f = paypalFake({ verification_status: "SUCCESS" });
    const verify = makePaypalVerifier(cfg(f as unknown as typeof fetch));
    await verify(input);
    await verify(input);
    const tokenCalls = f.mock.calls.filter(([u]) => String(u).endsWith("/v1/oauth2/token"));
    expect(tokenCalls).toHaveLength(1);
  });

  it("throws when the token request fails, which the handler treats as unverified", async () => {
    const f = vi.fn(async () => new Response("no", { status: 401 }));
    const verify = makePaypalVerifier(cfg(f as unknown as typeof fetch));
    await expect(verify(input)).rejects.toThrow();
  });
});
