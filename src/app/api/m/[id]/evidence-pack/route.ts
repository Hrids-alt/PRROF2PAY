import { handle, requireActor } from "@/lib/api";
import { getDeps } from "@/lib/deps";
import { AppError } from "@/lib/errors";
import { buildEvidencePack } from "@/lib/pack";
import { getMilestone } from "@/lib/read";

export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await ctx.params;
    const actor = await requireActor();
    const deps = await getDeps();
    const m = await getMilestone(deps.pool, id);
    if (!m || (actor.id !== m.clientId && actor.id !== m.freelancerId)) throw new AppError(404, "Not found");
    const pack = await buildEvidencePack(deps, id);
    return new Response(JSON.stringify(pack, null, 2), {
      headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="evidence-pack-${id}.json"`, "Cache-Control": "no-store" },
    });
  });
}
