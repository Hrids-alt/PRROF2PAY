import { cookies } from "next/headers";
import { assertSameOrigin, handle, jsonBody, str } from "@/lib/api";
import { SESSION_COOKIE, SESSION_DAYS, sessionToken } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { getUser } from "@/lib/read";

export const runtime = "nodejs";

/** Demo sign-in: pick one of the seeded accounts. Switched off with DEMO_LOGIN=false. */
export async function POST(request: Request) {
  return handle(async () => {
    assertSameOrigin(request);
    if (process.env.DEMO_LOGIN === "false") throw new AppError(403, "Demo sign-in is switched off");
    const body = await jsonBody(request);
    const user = await getUser(getPool(), str(body.userId, 60));
    if (!user) throw new AppError(404, "No such account");
    (await cookies()).set(SESSION_COOKIE, sessionToken(user.id), {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: SESSION_DAYS * 86_400,
    });
    return { ok: true };
  });
}
