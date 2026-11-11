import { assertSameOrigin, handle, jsonBody, requireActor, str } from "@/lib/api";
import { getDeps } from "@/lib/deps";
import { AppError } from "@/lib/errors";
import { createPreviewLink } from "@/lib/preview";
import * as svc from "@/lib/service";

export const runtime = "nodejs";

const demoOnly = () => {
  if (process.env.DEMO_MODE !== "true") throw new AppError(404, "Not available");
};

export async function POST(request: Request, ctx: { params: Promise<{ id: string; action: string }> }) {
  return handle(async () => {
    assertSameOrigin(request);
    const { id, action } = await ctx.params;
    const actor = await requireActor();
    const deps = await getDeps();

    if (action === "upload") {
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) throw new AppError(422, "Choose a file");
      const kind = form.get("kind") === "deliverable" ? "deliverable" : "document";
      return svc.uploadFile(deps, actor, id, { name: file.name, mime: file.type || "application/octet-stream", bytes: new Uint8Array(await file.arrayBuffer()), kind });
    }

    const b = await jsonBody(request);
    switch (action) {
      case "sign":
        return void (await svc.signMilestone(deps, actor, id));
      case "fund":
        return svc.startFunding(deps, actor, id);
      case "evidence":
        return void (await svc.submitEvidence(deps, actor, id, { liveUrl: str(b.liveUrl, 500), repo: str(b.repo, 200), commit: str(b.commit, 40) }));
      case "approve":
        return void (await svc.approve(deps, actor, id));
      case "decline":
        return void (await svc.decline(deps, actor, id, str(b.requirementId, 60) || undefined));
      case "cite":
        return void (await svc.citeFailure(deps, actor, id, str(b.requirementId, 60) || undefined));
      case "cancel":
        return void (await svc.cancelMilestone(deps, actor, id));
      case "preview-link": {
        const link = await createPreviewLink(deps, actor, id);
        return { path: link.path, expiresAt: link.expiresAt };
      }
      case "fast-forward":
        demoOnly();
        await svc.fastForwardDeadline(deps, actor, id);
        return void (await (await import("@/lib/effects")).tick(deps));
      case "resolve":
        demoOnly();
        return void (await svc.resolveHold(deps, `${actor.name} (demo reviewer)`, id, b.release === true));
      default:
        throw new AppError(404, "Unknown action");
    }
  });
}
