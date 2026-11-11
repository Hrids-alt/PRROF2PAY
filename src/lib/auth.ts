import { cookies } from "next/headers";
import { getPool } from "./db";
import { getUser } from "./read";
import type { Actor } from "./service";
import { signToken, verifyToken } from "./tokens";

export const SESSION_COOKIE = "p2p_session";
export const SESSION_DAYS = 7;

export function sessionToken(userId: string): string {
  return signToken({ uid: userId, exp: Math.floor(Date.now() / 1000) + SESSION_DAYS * 86_400 });
}

/** Demo login: anyone can pick a seeded account. Real sign-in (for example Log in with PayPal) is a Tier 3 item. */
export async function currentActor(): Promise<Actor | null> {
  const value = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!value) return null;
  const payload = verifyToken<{ uid: string }>(value);
  if (!payload) return null;
  const u = await getUser(getPool(), payload.uid);
  return u ? { id: u.id, role: u.role, name: u.displayName } : null;
}
