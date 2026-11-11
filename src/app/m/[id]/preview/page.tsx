import { cookies } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ViewOnlyGuard } from "@/components/ViewOnlyGuard";
import { currentActor } from "@/lib/auth";
import { loadEvidenceForChecks } from "@/lib/verification";
import { getDeps } from "@/lib/deps";
import { getLatestVerdicts, getRequirements } from "@/lib/read";
import { loadPreviewSession, PREVIEW_COOKIE } from "@/lib/preview";
import { CHECK_LABEL, proofSummary, VERDICT_LABEL, VERDICT_TONE } from "@/lib/ui";

export const dynamic = "force-dynamic";

const card = "rounded-xl border border-zinc-200 bg-white p-5";

/**
 * View-only preview: no download, watermarked with the client name and session id, one session,
 * every view logged. Binary files are shown by name and fingerprint only.
 */
export default async function PreviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await currentActor();
  if (!actor) redirect("/login");
  const deps = await getDeps();
  const session = await loadPreviewSession(deps, actor, (await cookies()).get(PREVIEW_COOKIE)?.value, id);
  if (!session) {
    return (
      <main className="mx-auto max-w-lg rounded-xl border border-amber-300 bg-amber-50 p-5 text-sm">
        <p className="font-medium">This preview is not open.</p>
        <p className="mt-1">Preview links last 5 minutes, open once, and the session ends after 30 minutes. <Link className="underline" href={`/m/${id}`}>Go back to the milestone</Link> and open a new one.</p>
      </main>
    );
  }
  const m = session.milestone;
  if (m.clientId !== actor.id) notFound();

  const [requirements, verdicts, evidence] = await Promise.all([getRequirements(deps.pool, id), getLatestVerdicts(deps.pool, id), loadEvidenceForChecks(deps, id)]);
  const vOf = new Map(verdicts.map((v) => [v.requirementId, v]));
  const watermark = `${actor.name} · session ${session.sid} · ${new Date().toISOString().slice(0, 10)}`;

  return (
    <ViewOnlyGuard milestoneId={id} watermark={watermark}>
      <main className="grid gap-6">
        <div data-section="intro">
          <Link href={`/m/${id}`} className="text-sm text-zinc-500 underline">← Back to the decision</Link>
          <h1 className="mt-2 text-2xl font-semibold">Preview: {m.title}</h1>
          <p className="mt-1 text-sm text-zinc-600">View-only. No download. Marked with your name and this session id; every view is logged. The full files unlock only after PayPal confirms the first payment.</p>
        </div>

        <section className={card} data-section="report">
          <h2 className="mb-3 font-semibold">Verification report</h2>
          <div className="grid gap-2">
            {requirements.map((r) => {
              const v = vOf.get(r.id);
              return (
                <div key={r.id} className="rounded-lg border border-zinc-200 p-3 text-sm">
                  <div className="flex flex-wrap justify-between gap-2"><b>{r.position}. {r.text}</b>{v && <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${VERDICT_TONE[v.verdict]}`}>{VERDICT_LABEL[v.verdict]}</span>}</div>
                  <p className="text-xs text-zinc-500">{CHECK_LABEL[r.checkType]}</p>
                  {v && <p className="mt-1 text-zinc-700">{proofSummary(v.proof)}</p>}
                </div>
              );
            })}
          </div>
        </section>

        {evidence.liveUrl && (
          <section className={card} data-section="live-site">
            <h2 className="mb-1 font-semibold">Live site</h2>
            <p className="mb-3 text-xs text-zinc-500">{evidence.liveUrl} — shown in a sandboxed frame. Some sites refuse to be framed; the report above is from our own server-side checks.</p>
            <iframe title="Live site" src={evidence.liveUrl} sandbox="allow-scripts" referrerPolicy="no-referrer" className="h-[480px] w-full rounded-lg border border-zinc-200" />
          </section>
        )}

        {evidence.repo && (
          <section className={card} data-section="code">
            <h2 className="mb-1 font-semibold">Code (facts only)</h2>
            <p className="text-sm text-zinc-700">Repository {evidence.repo.fullName}{evidence.repo.commitSha ? ` at commit ${evidence.repo.commitSha}` : ""}. The checks above read the repository through GitHub. There is no downloadable copy here.</p>
          </section>
        )}

        {evidence.files.map((f) => (
          <section key={f.id} className={card} data-section={`file-${f.name}`.slice(0, 50)}>
            <h2 className="mb-1 font-semibold">{f.name}</h2>
            <p className="mb-2 text-xs text-zinc-500">Fingerprint <code>{f.sha256.slice(0, 20)}…</code></p>
            {f.text !== null ? (
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-zinc-50 p-3 text-sm">{f.text.slice(0, 8000)}</pre>
            ) : (
              <p className="text-sm text-zinc-600">🔒 Binary file. Its contents are locked until PayPal confirms the first payment.</p>
            )}
          </section>
        ))}
      </main>
    </ViewOnlyGuard>
  );
}
