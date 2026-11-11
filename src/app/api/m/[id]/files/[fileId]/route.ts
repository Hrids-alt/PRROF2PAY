import { handle, requireActor } from "@/lib/api";
import { getDeps } from "@/lib/deps";
import { AppError } from "@/lib/errors";
import { filesUnlocked, getMilestone } from "@/lib/read";

export const runtime = "nodejs";

/** The only way a file leaves the vault. The client gets it only after PayPal confirmed capture 1. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string; fileId: string }> }) {
  return handle(async () => {
    const { id, fileId } = await ctx.params;
    const actor = await requireActor();
    const deps = await getDeps();
    const m = await getMilestone(deps.pool, id);
    if (!m) throw new AppError(404, "Not found");
    const isFreelancer = actor.role === "freelancer" && actor.id === m.freelancerId;
    const isClient = actor.role === "client" && actor.id === m.clientId;
    if (!isFreelancer && !isClient) throw new AppError(403, "Not your milestone");
    if (isClient && !filesUnlocked(m)) throw new AppError(403, "The files unlock after PayPal confirms the first payment");
    if (!/^[0-9a-f-]{36}$/i.test(fileId)) throw new AppError(404, "Not found");

    const { rows } = await deps.pool.query(`SELECT name, mime, sha256, data FROM vault_files WHERE id = $1 AND milestone_id = $2`, [fileId, id]);
    const f = rows[0];
    if (!f) throw new AppError(404, "Not found");
    await deps.pool.query(`INSERT INTO events (milestone_id, type, actor, data) VALUES ($1, 'vault.file_downloaded', $2, $3)`, [id, actor.name, JSON.stringify({ name: f.name, sha256: f.sha256 })]);
    return new Response(new Uint8Array(f.data as Buffer), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${String(f.name).replace(/"/g, "")}"`,
        "X-Content-SHA256": f.sha256,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      },
    });
  });
}
