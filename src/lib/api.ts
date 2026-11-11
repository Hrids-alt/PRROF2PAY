import { currentActor } from "./auth";
import { AppError, toAppError } from "./errors";
import type { Actor } from "./service";

export async function requireActor(): Promise<Actor> {
  const a = await currentActor();
  if (!a) throw new AppError(401, "Please sign in first");
  return a;
}

/** Browsers send Origin on cross-site POSTs. Refuse any that is not this site. */
export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin) return;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (new URL(origin).host !== host) throw new AppError(403, "Cross-site request refused");
}

export async function handle(fn: () => Promise<unknown>): Promise<Response> {
  try {
    const out = await fn();
    return out instanceof Response ? out : Response.json(out ?? { ok: true });
  } catch (err) {
    const app = toAppError(err);
    if (app) return Response.json({ error: app.message }, { status: app.status });
    console.error("request failed", err);
    return Response.json({ error: "Something went wrong on our side. Nothing was charged." }, { status: 500 });
  }
}

export async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const v = await request.json();
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export const str = (v: unknown, max = 2000): string => (typeof v === "string" ? v.slice(0, max) : "");
