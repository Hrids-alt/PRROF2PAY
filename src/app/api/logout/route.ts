import { cookies } from "next/headers";
import { assertSameOrigin, handle } from "@/lib/api";
import { SESSION_COOKIE } from "@/lib/auth";
import { PREVIEW_COOKIE } from "@/lib/preview";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return handle(async () => {
    assertSameOrigin(request);
    const jar = await cookies();
    jar.delete(SESSION_COOKIE);
    jar.delete(PREVIEW_COOKIE);
    return { ok: true };
  });
}
