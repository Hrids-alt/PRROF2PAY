/** Small HMAC-signed tokens: login cookie and view-only preview links. */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) throw new Error("SESSION_SECRET must be set (16+ characters)");
  return s;
}

const b64 = (b: Buffer) => b.toString("base64url");

export function signToken(payload: Record<string, unknown>, key: string = secret()): string {
  const body = b64(Buffer.from(JSON.stringify(payload)));
  const mac = b64(createHmac("sha256", key).update(body).digest());
  return `${body}.${mac}`;
}

/** Returns the payload only for an untampered, unexpired token. `exp` is epoch seconds. */
export function verifyToken<T extends Record<string, unknown>>(token: string, key: string = secret(), now = Date.now()): T | null {
  const [body, mac, extra] = token.split(".");
  if (!body || !mac || extra !== undefined) return null;
  const expected = createHmac("sha256", key).update(body).digest();
  let given: Buffer;
  try {
    given = Buffer.from(mac, "base64url");
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
    if (typeof payload.exp === "number" && payload.exp * 1000 < now) return null;
    return payload;
  } catch {
    return null;
  }
}

export const newSessionId = (): string => randomBytes(9).toString("base64url");
