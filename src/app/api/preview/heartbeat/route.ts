import { cookies } from "next/headers";
import { assertSameOrigin, handle, jsonBody, requireActor, str } from "@/lib/api";
import { getDeps } from "@/lib/deps";
import { AppError } from "@/lib/errors";
import { loadPreviewSession, logPreviewView, PREVIEW_COOKIE } from "@/lib/preview";

export const runtime = "nodejs";

/** Logs time spent and the section on screen. Only accepted from the claimed preview session. */
export async function POST(request: Request) {
  return handle(async () => {
    assertSameOrigin(request);
    const actor = await requireActor();
    const b = await jsonBody(request);
    const deps = await getDeps();
    const milestoneId = str(b.milestoneId, 60);
    const session = await loadPreviewSession(deps, actor, (await cookies()).get(PREVIEW_COOKIE)?.value, milestoneId);
    if (!session) throw new AppError(403, "Preview session ended");
    await logPreviewView(deps, actor, milestoneId, { sid: session.sid, section: str(b.section, 60), seconds: Number(b.seconds) || 0 });
    return { ok: true };
  });
}
