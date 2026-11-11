import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ActionButton } from "@/components/ActionButton";
import { AutoRefresh } from "@/components/AutoRefresh";
import { PayeeForm } from "@/components/PayeeForm";
import { RequirementPicker } from "@/components/RequirementPicker";
import { SubmitEvidenceForm, UploadForm } from "@/components/EvidenceForms";
import { currentActor } from "@/lib/auth";
import { splitAmounts } from "@/lib/contract";
import { getPool } from "@/lib/db";
import {
  filesUnlocked, getCaptures, getEvents, getFiles, getLatestVerdicts, getMilestone, getReputation, getRequirements, getSignatures, getUser,
} from "@/lib/read";
import { MAX_VERIFICATION_ROUNDS } from "@/lib/stateMachine";
import { CHECK_LABEL, EVENT_LABEL, fmtDate, fmtMoney, proofSummary, STATE_LABEL, STEP_NAMES, stateTone, stepIndex, VERDICT_LABEL, VERDICT_TONE } from "@/lib/ui";

export const dynamic = "force-dynamic";

const card = "rounded-xl border border-zinc-200 bg-white p-5";

export default async function RoomPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { id } = await params;
  const sp = await searchParams;
  const actor = await currentActor();
  if (!actor) redirect("/login");

  const pool = getPool();
  const m = await getMilestone(pool, id);
  if (!m) notFound();
  const isClient = actor.role === "client" && actor.id === m.clientId;
  const isFreelancer = actor.role === "freelancer" && (actor.id === m.freelancerId || (m.freelancerId === null && m.state === "awaiting_signatures"));
  if (!isClient && !isFreelancer) notFound();
  const mineAsFreelancer = actor.role === "freelancer" && actor.id === m.freelancerId;

  const [requirements, verdicts, signatures, files, captures, events, me, client, freelancer] = await Promise.all([
    getRequirements(pool, id), getLatestVerdicts(pool, id), getSignatures(pool, id), getFiles(pool, id), getCaptures(pool, id), getEvents(pool, id),
    getUser(pool, actor.id), getUser(pool, m.clientId), m.freelancerId ? getUser(pool, m.freelancerId) : Promise.resolve(null),
  ]);

  const verdictOf = new Map(verdicts.map((v) => [v.requirementId, v]));
  const signedBy = (uid: string | null) => !!uid && signatures.some((s) => s.userId === uid && s.contractVersion === m.contractVersion && s.contractHash === m.contractHash);
  const { part1Cents, part2Cents } = splitAmounts(m.amountCents, m.part1Percent);
  const unlocked = filesUnlocked(m);
  const step = stepIndex(m.state);
  const demo = process.env.DEMO_MODE === "true";
  const reauthFailed = events.some((e) => e.type === "reauthorize.failed");
  const lastCaptureIssue = [...events].reverse().find((e) => e.type === "capture.refused")?.data.reason as string | undefined;
  const gaps = requirements.filter((r) => verdictOf.get(r.id) && verdictOf.get(r.id)!.verdict !== "verified");
  const [clientRep, freelancerRep] = m.state === "closed" ? await Promise.all([getReputation(pool, m.clientId), m.freelancerId ? getReputation(pool, m.freelancerId) : null]) : [null, null];

  return (
    <main className="grid gap-6">
      <div>
        <Link href="/" className="text-sm text-zinc-500 underline">← Job board</Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">{m.title}</h1>
          <span className={`rounded-full px-3 py-1 text-xs font-medium ${stateTone(m.state)}`}>{STATE_LABEL[m.state]}</span>
        </div>
        <p className="mt-1 text-sm text-zinc-600">
          {fmtMoney(m.amountCents, m.currency)} · {fmtMoney(part1Cents, m.currency)} after approval{part2Cents > 0 ? ` + ${fmtMoney(part2Cents, m.currency)} after the ${m.acceptanceWindowHours}-hour acceptance window` : ""} ·
          Client {client?.displayName} · Freelancer {freelancer?.displayName ?? "not accepted yet"}
        </p>
      </div>

      {sp.notice && <p className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm">{sp.notice}</p>}
      {sp.error && <p className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800">{sp.error}</p>}

      {step >= 0 && (
        <ol className="flex flex-wrap gap-1.5 text-xs">
          {STEP_NAMES.map((n, i) => (
            <li key={n} className={`rounded-full px-3 py-1 ${i < step ? "bg-emerald-100 text-emerald-800" : i === step ? "bg-indigo-600 text-white" : "bg-zinc-200 text-zinc-600"}`}>{n}</li>
          ))}
        </ol>
      )}

      {/* ------------------------------------------------ what to do now */}
      <section className={card}>
        <h2 className="mb-3 font-semibold">What happens now</h2>
        <div className="grid gap-3 text-sm">
          {m.state === "awaiting_signatures" && (
            <>
              <p>Both sides sign the final list of checks. The contract fingerprint is saved, and later changes need both signatures.</p>
              {actor.role === "freelancer" && (
                signedBy(actor.id) ? <p>You signed. Waiting for the client.</p> : !me?.paypalPayeeEmail ? (
                  <div><p className="mb-2 text-amber-700">Add where you get paid before you accept.</p><PayeeForm current={null} /></div>
                ) : <div><ActionButton url={`/api/m/${id}/sign`} label="Accept the job and sign the checks" /></div>
              )}
              {isClient && <p>{signedBy(m.clientId) ? "You signed when you posted the job. Waiting for a freelancer to accept." : <ActionButton url={`/api/m/${id}/sign`} label="Sign the checks" />}</p>}
            </>
          )}

          {(m.state === "awaiting_funding" || (m.state === "capture_failed" && m.failedPart === 1)) && (
            <>
              {m.state === "capture_failed" && (
                <p className="rounded-lg border border-red-300 bg-red-50 p-3 text-red-800">
                  PayPal could not collect the payment{lastCaptureIssue ? ` (${lastCaptureIssue})` : ""}. The files are still locked. Reserve the funds again to retry. Nothing was unlocked.
                </p>
              )}
              {isClient ? (
                <>
                  <p>Reserve {fmtMoney(m.amountCents, m.currency)} with PayPal. This is an authorization (a hold), not a payment: PayPal keeps it for you, and nothing moves until the checks pass and you approve.</p>
                  <div className="flex flex-wrap gap-2"><ActionButton url={`/api/m/${id}/fund`} follow="approveUrl" label="Reserve funds with PayPal" />
                    {m.state === "awaiting_funding" && <ActionButton url={`/api/m/${id}/cancel`} tone="danger" label="Cancel the job" confirm="Cancel this job?" />}
                    {m.state === "capture_failed" && <ActionButton url={`/api/m/${id}/cancel`} tone="danger" label="Cancel and release" confirm="Cancel this job?" />}
                  </div>
                </>
              ) : <p>Waiting for the client to reserve the funds.</p>}
            </>
          )}

          {(m.state === "funded" || m.state === "gaps_returned") && (
            <>
              {m.state === "gaps_returned" && (
                <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
                  <p className="font-medium">Round {m.gapRounds} of {MAX_VERIFICATION_ROUNDS}: these lines were not verified</p>
                  <ul className="mt-1 list-disc pl-5">{gaps.map((g) => <li key={g.id}>{g.position}. {g.text} — {proofSummary(verdictOf.get(g.id)!.proof)}</li>)}</ul>
                </div>
              )}
              {mineAsFreelancer ? (
                <div className="grid gap-5 md:grid-cols-2">
                  <div><h3 className="mb-2 font-medium">1. Add files</h3><UploadForm milestoneId={id} /></div>
                  <div><h3 className="mb-2 font-medium">2. Submit evidence</h3><SubmitEvidenceForm milestoneId={id} /></div>
                </div>
              ) : <p>{isClient ? "The money is reserved. Waiting for the freelancer to submit evidence." : ""}</p>}
              {isClient && <ActionButton url={`/api/m/${id}/cancel`} tone="danger" label="Cancel and release the reservation" confirm="Release the reservation and cancel?" />}
            </>
          )}

          {m.state === "failed_verification" && (
            <>
              <p>The checks did not pass after {MAX_VERIFICATION_ROUNDS} rounds. No money moved. {isClient ? "You can release the reservation." : "The client can release the reservation."}</p>
              {isClient && <ActionButton url={`/api/m/${id}/cancel`} tone="danger" label="Release the reservation" confirm="Release the reservation and cancel?" />}
            </>
          )}

          {m.state === "awaiting_client_approval" && (
            <>
              <p className="font-medium">Work verified. Proceed to pay?</p>
              <p>The checks appear to show every requirement is met (see the report below). Look at the work first. The preview is view-only. Review deadline: <b>{fmtDate(m.reviewDeadlineAt)}</b>. If the client does not reply, the signed rule applies: {m.noReplyRule === "release" ? "part 1 is released to the freelancer" : "the reservation is returned to the client"}.</p>
              {isClient ? (
                <div className="grid gap-4">
                  <div className="flex flex-wrap gap-2">
                    <ActionButton url={`/api/m/${id}/preview-link`} follow="path" tone="plain" label="Open the view-only preview" />
                    <ActionButton url={`/api/m/${id}/approve`} label={`Approve and pay ${fmtMoney(part1Cents, m.currency)}`} confirm={`Approve? PayPal will capture ${fmtMoney(part1Cents, m.currency)} now.`} />
                  </div>
                  <div className="rounded-lg border border-zinc-200 p-3">
                    <p className="mb-2 text-sm font-medium">Or decline, by naming a failing requirement (the platform re-runs it fresh)</p>
                    <RequirementPicker milestoneId={id} action="decline" label="Decline and re-check" requirements={requirements} />
                  </div>
                </div>
              ) : <p>Waiting for the client&apos;s decision.</p>}
            </>
          )}

          {m.state === "capturing_part1" && <><p>Part 1 was requested from PayPal. The files unlock when PayPal confirms the payment, not before.</p><AutoRefresh /></>}
          {m.state === "capturing_part2" && <><p>Part 2 was requested from PayPal. The milestone closes when PayPal confirms.</p><AutoRefresh /></>}
          {m.state === "verifying" && <><p>The platform is running the checks from its own servers.</p><AutoRefresh /></>}
          {m.state === "rechecking" && <><p>A fresh check of the requirement the client named is running.</p><AutoRefresh /></>}

          {(m.state === "acceptance_window" || (m.state === "capture_failed" && m.failedPart === 2)) && (
            <>
              <p>The files are unlocked. The acceptance window ends <b>{fmtDate(m.acceptanceWindowEndsAt)}</b>; then part 2 ({fmtMoney(part2Cents, m.currency)}) is captured. Inspect the files: the fingerprints below should match.</p>
              {m.state === "capture_failed" && <p className="rounded-lg border border-red-300 bg-red-50 p-3 text-red-800">PayPal could not collect part 2{lastCaptureIssue ? ` (${lastCaptureIssue})` : ""}. The platform will retry. Files stay unlocked because part 1 was paid.</p>}
              {isClient && m.state === "acceptance_window" && (
                <div className="rounded-lg border border-zinc-200 p-3">
                  <p className="mb-2 text-sm font-medium">Something failing? Name the requirement. The platform runs a fresh check before part 2.</p>
                  <RequirementPicker milestoneId={id} action="cite" label="Cite a failing requirement" requirements={requirements} />
                </div>
              )}
            </>
          )}

          {m.state === "held_for_review" && (
            <p>The fresh check did not pass, so part 2 is held for a person to review. Nothing more is captured until they decide.</p>
          )}

          {m.state === "closed" && <p>Closed. Both payments were confirmed by PayPal. The Evidence Pack has the full record.</p>}
          {m.state === "cancelled" && <p>Cancelled. Any reservation was released back to the client.</p>}

          {reauthFailed && <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-900">The reservation could not be renewed automatically. Check the expiry below.</p>}
        </div>
      </section>

      {/* ------------------------------------------------ report + contract */}
      <section className={card}>
        <h2 className="mb-1 font-semibold">Requirements and verification report</h2>
        <p className="mb-3 text-xs text-zinc-500">
          Both sides signed this exact list. Contract fingerprint <code>{m.contractHash?.slice(0, 16)}…</code>. Wording: the evidence <i>appears to show</i> a result; it does not prove it. The AI only informs the client&apos;s decision and can never trigger a payment.
        </p>
        <div className="grid gap-3">
          {requirements.map((r) => {
            const v = verdictOf.get(r.id);
            return (
              <div key={r.id} className="rounded-lg border border-zinc-200 p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="text-sm font-medium">{r.position}. {r.text}</p>
                  {v ? <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${VERDICT_TONE[v.verdict]}`}>{VERDICT_LABEL[v.verdict]}</span> : <span className="rounded-full bg-zinc-100 px-2.5 py-1 text-xs text-zinc-600">Not checked yet</span>}
                </div>
                <p className="mt-1 text-xs text-zinc-500">{CHECK_LABEL[r.checkType]}</p>
                {v && <p className="mt-1 text-sm text-zinc-700">{proofSummary(v.proof)}</p>}
              </div>
            );
          })}
        </div>
        <p className="mt-3 text-sm text-zinc-600">
          Signed by client: {signedBy(m.clientId) ? "yes" : "not yet"} · Signed by freelancer: {signedBy(m.freelancerId) ? "yes" : "not yet"}
        </p>
      </section>

      {/* ------------------------------------------------ money */}
      <section className={card}>
        <h2 className="mb-2 font-semibold">Money</h2>
        <div className="grid gap-1 text-sm text-zinc-700">
          <p>Reservation: {m.authorizationId ? <>held by PayPal since {fmtDate(m.authorizedAt)}. Expires <b>{fmtDate(m.authorizationExpiresAt)}</b>. {m.reauthorizedAt ? "Renewed once." : `PayPal's 3-day honor period ends ${fmtDate(m.honorUntil)}; the platform then renews it.`}</> : "not reserved yet"}</p>
          {captures.map((c) => (
            <p key={c.id}>Part {c.part}: {fmtMoney(c.amountCents, m.currency)} — {c.status === "confirmed" ? `confirmed by PayPal ${fmtDate(c.confirmedAt)}` : c.status === "failed" ? "failed" : "requested, waiting for PayPal to confirm"}</p>
          ))}
          <p className="text-xs text-zinc-500">PayPal fees come out of the freelancer&apos;s payout. Money moves only at part 1 and part 2.</p>
        </div>
      </section>

      {/* ------------------------------------------------ files */}
      {files.length > 0 && (
        <section className={card}>
          <h2 className="mb-1 font-semibold">Locked vault</h2>
          <p className="mb-3 text-xs text-zinc-500">Files are fingerprinted (SHA-256) before any check reads them. {isClient && !unlocked ? "You can download them after PayPal confirms the first payment." : ""}</p>
          <ul className="grid gap-2 text-sm">
            {files.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-200 p-3">
                <span><b>{f.name}</b> <span className="text-zinc-500">({Math.ceil(f.sizeBytes / 1024)} KB)</span><br /><code className="text-xs text-zinc-500">{f.sha256}</code></span>
                {(mineAsFreelancer || (isClient && unlocked)) ? <a className="text-indigo-700 underline" href={`/api/m/${id}/files/${f.id}`}>Download</a> : <span className="text-xs text-zinc-500">🔒 Locked</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {m.state === "closed" && clientRep && (
        <section className={card}>
          <h2 className="mb-2 font-semibold">Track record (from the event log, shown to both sides together)</h2>
          <div className="grid gap-2 text-sm sm:grid-cols-2">
            {[[client?.displayName, clientRep], [freelancer?.displayName, freelancerRep]].map(([name, r]) => r && (
              <p key={String(name)}><b>{String(name)}</b>: {(r as typeof clientRep).enoughHistory ? `${(r as typeof clientRep).closedMilestones} closed, ${(r as typeof clientRep).firstTimeVerified} verified with no gaps` : `no history yet (${(r as typeof clientRep).closedMilestones} of 3 closed milestones)`}</p>
            ))}
          </div>
        </section>
      )}

      {demo && (m.state === "awaiting_client_approval" || m.state === "acceptance_window" || m.state === "held_for_review") && (
        <section className="rounded-xl border border-dashed border-violet-300 bg-violet-50 p-5">
          <h2 className="mb-2 font-semibold text-violet-900">Demo controls</h2>
          <p className="mb-3 text-sm text-violet-900">Only for recording the video. These use the same code as the real deadline and the real reviewer decision.</p>
          <div className="flex flex-wrap gap-2">
            {(m.state === "awaiting_client_approval" || m.state === "acceptance_window") && <ActionButton url={`/api/m/${id}/fast-forward`} tone="plain" label={m.state === "acceptance_window" ? "End the acceptance window now" : "Pass the review deadline now"} />}
            {m.state === "held_for_review" && <><ActionButton url={`/api/m/${id}/resolve`} body={{ release: true }} tone="plain" label="Reviewer: release part 2" /><ActionButton url={`/api/m/${id}/resolve`} body={{ release: false }} tone="plain" label="Reviewer: return it" /></>}
          </div>
        </section>
      )}

      <section className={card}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">Event log</h2>
          <a className="text-sm text-indigo-700 underline" href={`/api/m/${id}/evidence-pack`}>Download the Evidence Pack (JSON)</a>
        </div>
        <ol className="grid gap-1.5 text-sm">
          {events.filter((e) => e.type !== "preview.viewed").slice(-60).map((e) => (
            <li key={e.id} className="flex flex-wrap gap-x-3 text-zinc-700"><span className="w-44 shrink-0 text-xs text-zinc-500">{fmtDate(e.createdAt)}</span><span>{EVENT_LABEL[e.type] ?? e.type} <span className="text-xs text-zinc-500">· {e.actor}</span></span></li>
          ))}
        </ol>
      </section>
    </main>
  );
}
