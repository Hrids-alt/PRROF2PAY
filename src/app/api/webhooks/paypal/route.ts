import { getPool } from "@/lib/db";
import { handleWebhook, makePaypalVerifier } from "@/lib/webhook";
import { createPgWebhookStore } from "@/lib/webhookPgStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export async function POST(request: Request): Promise<Response> {
  let verify;
  try {
    verify = makePaypalVerifier({
      baseUrl: required("PAYPAL_API_BASE"),
      clientId: required("PAYPAL_CLIENT_ID"),
      clientSecret: required("PAYPAL_CLIENT_SECRET"),
      webhookId: required("PAYPAL_WEBHOOK_ID"),
    });
  } catch {
    // Misconfigured: fail closed. 500 makes PayPal retry once this is fixed.
    return new Response("webhook is not configured", { status: 500 });
  }

  // The raw text is read once; verification needs the exact event PayPal sent.
  const rawBody = await request.text();
  const res = await handleWebhook({
    rawBody,
    getHeader: (name) => request.headers.get(name),
    verify,
    store: createPgWebhookStore(getPool()),
  });
  return new Response(res.body, { status: res.status });
}
