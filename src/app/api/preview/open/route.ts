import { cookies } from "next/headers";
import { currentActor } from "@/lib/auth";
import { getDeps } from "@/lib/deps";
import { toAppError } from "@/lib/errors";
import { LINK_MINUTES, openPreview, PREVIEW_COOKIE, SESSION_MINUTES } from "@/lib/preview";

export const runtime = "nodejs";

const to = (request: Request, path: string) => Response.redirect(new URL(path, process.env.APP_URL || request.url), 303);

export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("t") ?? "";
  const actor = await currentActor();
  if (!actor) return to(request, "/login");
  const jar = await cookies();
  try {
    const r = await openPreview(await getDeps(), actor, token, jar.get(PREVIEW_COOKIE)?.value);
    if (r.claimed) {
      jar.set(PREVIEW_COOKIE, r.sid, { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", path: "/", maxAge: SESSION_MINUTES * 60 });
    }
    return to(request, `/m/${r.milestoneId}/preview`);
  } catch (err) {
    const app = toAppError(err);
    if (!app) console.error("preview open failed", err);
    return new Response(`${app?.message ?? "Could not open the preview."} (Links last ${LINK_MINUTES} minutes and open once.)`, { status: app?.status ?? 500 });
  }
}
