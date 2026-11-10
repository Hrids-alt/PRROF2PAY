/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * PayPal REST client (Orders v2 with intent AUTHORIZE, Payments v2).
 * Money moves only through `capture`. Confirmed in the sandbox on Day 1:
 *  - an order can name another business account as payee,
 *  - one authorization takes two partial captures (final_capture=false, then true),
 *  - a repeated capture with the same PayPal-Request-Id returns the same capture,
 *  - the capture's invoice_id comes back on reads and on webhooks.
 */

export interface PaypalConfig {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
}

export class PaypalError extends Error {
  constructor(
    public readonly status: number,
    public readonly issue: string,
    public readonly body: unknown,
  ) {
    super(`PayPal ${status}: ${issue}`);
    this.name = "PaypalError";
  }
}

export interface CaptureResult {
  /** True when PayPal accepted the request. The webhook, not this, decides the unlock. */
  accepted: boolean;
  id: string | null;
  status: string | null;
  invoiceId: string | null;
  /** Set when not accepted: PayPal's reason, for the failed-capture screen. */
  issue: string | null;
}

export const money = (cents: number): string => (cents / 100).toFixed(2);

export class PaypalClient {
  private token: { value: string; expiresAt: number } | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: PaypalConfig) {
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return this.token.value;
    const res = await this.fetchImpl(`${this.cfg.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) throw new PaypalError(res.status, "TOKEN_REQUEST_FAILED", null);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
    return this.token.value;
  }

  private async call(
    method: string,
    path: string,
    opts: { body?: unknown; requestId?: string } = {},
  ): Promise<{ status: number; json: Record<string, any> }> {
    const res = await this.fetchImpl(`${this.cfg.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await this.accessToken()}`,
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(opts.requestId ? { "PayPal-Request-Id": opts.requestId } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let json: Record<string, any> = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }
    return { status: res.status, json };
  }

  private static issueOf(json: Record<string, any>): string {
    return json.details?.[0]?.issue ?? json.name ?? "UNKNOWN";
  }

  /** Step 3: reserve the money. Returns the link the client must open to approve. */
  async createAuthorizeOrder(args: {
    requestId: string;
    referenceId: string;
    amountCents: number;
    currency: string;
    payeeEmail: string;
    description: string;
    returnUrl: string;
    cancelUrl: string;
  }): Promise<{ orderId: string; approveUrl: string }> {
    const { status, json } = await this.call("POST", "/v2/checkout/orders", {
      requestId: args.requestId,
      body: {
        intent: "AUTHORIZE",
        purchase_units: [
          {
            reference_id: args.referenceId,
            description: args.description.slice(0, 127),
            amount: { currency_code: args.currency, value: money(args.amountCents) },
            payee: { email_address: args.payeeEmail },
          },
        ],
        application_context: {
          return_url: args.returnUrl,
          cancel_url: args.cancelUrl,
          user_action: "PAY_NOW",
          shipping_preference: "NO_SHIPPING",
        },
      },
    });
    const approveUrl = (json.links as Array<{ rel: string; href: string }> | undefined)?.find(
      (l) => l.rel === "payer-action" || l.rel === "approve",
    )?.href;
    if (status >= 300 || !json.id || !approveUrl) throw new PaypalError(status, PaypalClient.issueOf(json), json);
    return { orderId: json.id, approveUrl };
  }

  /** After the client approves: turn the approved order into an authorization (the hold). */
  async authorizeOrder(
    orderId: string,
    requestId: string,
  ): Promise<{ authorizationId: string; expiresAt: Date | null; payeeEmail: string | null }> {
    const { status, json } = await this.call("POST", `/v2/checkout/orders/${encodeURIComponent(orderId)}/authorize`, {
      requestId,
      body: {},
    });
    const unit = json.purchase_units?.[0];
    const auth = unit?.payments?.authorizations?.[0];
    if (status >= 300 || !auth?.id) throw new PaypalError(status, PaypalClient.issueOf(json), json);
    return {
      authorizationId: auth.id,
      expiresAt: auth.expiration_time ? new Date(auth.expiration_time) : null,
      payeeEmail: unit?.payee?.email_address ?? null,
    };
  }

  /** Steps 9 and 12. Never throws for a refused capture: the caller shows the failed state. */
  async capture(args: {
    authorizationId: string;
    requestId: string;
    amountCents: number;
    currency: string;
    invoiceId: string;
    finalCapture: boolean;
  }): Promise<CaptureResult> {
    const { status, json } = await this.call("POST", `/v2/payments/authorizations/${encodeURIComponent(args.authorizationId)}/capture`, {
      requestId: args.requestId,
      body: {
        amount: { currency_code: args.currency, value: money(args.amountCents) },
        invoice_id: args.invoiceId,
        final_capture: args.finalCapture,
      },
    });
    if (status >= 500) throw new PaypalError(status, PaypalClient.issueOf(json), json); // outcome unknown: caller replays
    const accepted = status < 300 && ["COMPLETED", "PENDING"].includes(json.status);
    return {
      accepted,
      id: json.id ?? null,
      status: json.status ?? null,
      invoiceId: json.invoice_id ?? null,
      issue: accepted ? null : json.status ?? PaypalClient.issueOf(json),
    };
  }

  async getCapture(captureId: string): Promise<CaptureResult> {
    const { status, json } = await this.call("GET", `/v2/payments/captures/${encodeURIComponent(captureId)}`);
    if (status >= 300) throw new PaypalError(status, PaypalClient.issueOf(json), json);
    return {
      accepted: ["COMPLETED", "PENDING"].includes(json.status),
      id: json.id ?? null,
      status: json.status ?? null,
      invoiceId: json.invoice_id ?? null,
      issue: null,
    };
  }

  async voidAuthorization(authorizationId: string): Promise<void> {
    const { status, json } = await this.call("POST", `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/void`);
    // 204 on success. 422 means it is already voided or captured, which is the state we want or must not touch.
    if (status >= 300 && status !== 422) throw new PaypalError(status, PaypalClient.issueOf(json), json);
  }

  /** Allowed after the 3-day honor period. Extends the hold up to the 29-day limit. */
  async reauthorize(args: {
    authorizationId: string;
    amountCents: number;
    currency: string;
    requestId: string;
  }): Promise<{ expiresAt: Date | null }> {
    const { status, json } = await this.call("POST", `/v2/payments/authorizations/${encodeURIComponent(args.authorizationId)}/reauthorize`, {
      requestId: args.requestId,
      body: { amount: { currency_code: args.currency, value: money(args.amountCents) } },
    });
    if (status >= 300) throw new PaypalError(status, PaypalClient.issueOf(json), json);
    return { expiresAt: json.expiration_time ? new Date(json.expiration_time) : null };
  }
}

export function paypalFromEnv(env: NodeJS.ProcessEnv = process.env): PaypalClient {
  const { PAYPAL_API_BASE, PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET } = env;
  if (!PAYPAL_API_BASE || !PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
    throw new Error("PAYPAL_API_BASE, PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set");
  }
  return new PaypalClient({ baseUrl: PAYPAL_API_BASE, clientId: PAYPAL_CLIENT_ID, clientSecret: PAYPAL_CLIENT_SECRET });
}
