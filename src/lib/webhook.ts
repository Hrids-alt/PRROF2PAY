/**
 * PayPal webhook handling.
 *
 * - The signature is verified with PayPal's verify-webhook-signature API before anything is trusted.
 *   Any error while verifying counts as "not verified".
 * - Events are stored by PayPal event id, and processing is idempotent: a redelivered event
 *   never moves a milestone twice.
 * - Capture events are matched to a milestone through `invoice_id`, which the capture call
 *   must set to `p2p:<milestoneId>:<part>` (see `invoiceRef`). Confirm on Day 1 (K2/K3) that
 *   PayPal returns it on the webhook resource.
 * - The vault unlocks only through the state machine, on a verified PAYMENT.CAPTURE.COMPLETED.
 */

export interface WebhookHeaders {
  transmissionId: string;
  transmissionTime: string;
  transmissionSig: string;
  certUrl: string;
  authAlgo: string;
}

export interface VerifyInput {
  headers: WebhookHeaders;
  event: unknown;
}

export type Verifier = (input: VerifyInput) => Promise<boolean>;

export type CaptureOutcome = "confirmed" | "failed";

export interface CaptureRef {
  milestoneId: string;
  part: 1 | 2;
}

export type BeginResult = "new" | "retry" | "duplicate";

export interface WebhookStore {
  /** Stores the event. "new" = first time, "retry" = seen but not finished, "duplicate" = already processed. */
  begin(eventId: string, eventType: string, payload: unknown): Promise<BeginResult>;
  /** Moves the milestone and marks the event processed in one transaction. "ignored" = the milestone had already moved on. */
  applyCapture(args: {
    eventId: string;
    ref: CaptureRef;
    captureId: string;
    outcome: CaptureOutcome;
  }): Promise<"applied" | "ignored">;
  markProcessed(eventId: string): Promise<void>;
}

export interface WebhookResponse {
  status: number;
  body: string;
}

export function invoiceRef(ref: CaptureRef): string {
  return `p2p:${ref.milestoneId}:${ref.part}`;
}

const INVOICE_RE = /^p2p:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([12])$/i;

export function parseInvoiceRef(value: unknown): CaptureRef | null {
  if (typeof value !== "string") return null;
  const m = INVOICE_RE.exec(value);
  if (!m) return null;
  return { milestoneId: m[1].toLowerCase(), part: m[2] === "1" ? 1 : 2 };
}

const CAPTURE_EVENTS: Record<string, CaptureOutcome> = {
  "PAYMENT.CAPTURE.COMPLETED": "confirmed",
  "PAYMENT.CAPTURE.DENIED": "failed",
  "PAYMENT.CAPTURE.DECLINED": "failed",
};

function readHeaders(get: (name: string) => string | null | undefined): WebhookHeaders | null {
  const h = {
    transmissionId: get("paypal-transmission-id"),
    transmissionTime: get("paypal-transmission-time"),
    transmissionSig: get("paypal-transmission-sig"),
    certUrl: get("paypal-cert-url"),
    authAlgo: get("paypal-auth-algo"),
  };
  if (Object.values(h).some((v) => !v)) return null;
  return h as WebhookHeaders;
}

export interface HandleWebhookArgs {
  rawBody: string;
  getHeader: (name: string) => string | null | undefined;
  verify: Verifier;
  store: WebhookStore;
}

const ok = (body: string): WebhookResponse => ({ status: 200, body });

export async function handleWebhook(args: HandleWebhookArgs): Promise<WebhookResponse> {
  const headers = readHeaders(args.getHeader);
  if (!headers) return { status: 400, body: "missing PayPal signature headers" };

  let event: unknown;
  try {
    event = JSON.parse(args.rawBody);
  } catch {
    return { status: 400, body: "body is not JSON" };
  }

  // Nothing from `event` is used until this passes.
  let verified = false;
  try {
    verified = await args.verify({ headers, event });
  } catch {
    verified = false;
  }
  if (!verified) return { status: 401, body: "signature not verified" };

  const e = event as { id?: unknown; event_type?: unknown; resource?: Record<string, unknown> };
  if (typeof e.id !== "string" || typeof e.event_type !== "string") {
    return { status: 400, body: "event has no id or type" };
  }

  try {
    const begun = await args.store.begin(e.id, e.event_type, event);
    if (begun === "duplicate") return ok("duplicate");

    const outcome = CAPTURE_EVENTS[e.event_type];
    if (!outcome) {
      await args.store.markProcessed(e.id);
      return ok("ignored event type");
    }

    const ref = parseInvoiceRef(e.resource?.invoice_id);
    const captureId = e.resource?.id;
    if (!ref || typeof captureId !== "string") {
      // Not one of ours (or malformed). Acknowledge so PayPal stops retrying, and keep the record.
      await args.store.markProcessed(e.id);
      return ok("not a Proof2Pay capture");
    }

    const result = await args.store.applyCapture({ eventId: e.id, ref, captureId, outcome });
    return ok(result);
  } catch {
    // 500 makes PayPal redeliver; the handler is idempotent.
    return { status: 500, body: "processing failed, will retry" };
  }
}

export interface PaypalVerifierConfig {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  webhookId: string;
  fetchImpl?: typeof fetch;
}

/** Calls PayPal's verify-webhook-signature. Returns true only for verification_status SUCCESS. */
export function makePaypalVerifier(cfg: PaypalVerifierConfig): Verifier {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  let token: { value: string; expiresAt: number } | null = null;

  async function accessToken(): Promise<string> {
    if (token && token.expiresAt > Date.now() + 30_000) return token.value;
    const res = await fetchImpl(`${cfg.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) throw new Error(`PayPal token request failed: ${res.status}`);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    token = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
    return token.value;
  }

  return async ({ headers, event }) => {
    const res = await fetchImpl(`${cfg.baseUrl}/v1/notifications/verify-webhook-signature`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        auth_algo: headers.authAlgo,
        cert_url: headers.certUrl,
        transmission_id: headers.transmissionId,
        transmission_sig: headers.transmissionSig,
        transmission_time: headers.transmissionTime,
        webhook_id: cfg.webhookId,
        webhook_event: event,
      }),
    });
    if (!res.ok) return false;
    const json = (await res.json()) as { verification_status?: string };
    return json.verification_status === "SUCCESS";
  };
}
