import Link from "next/link";
import { PayeeForm } from "@/components/PayeeForm";
import { currentActor } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { getReputation, getUser, listBoard } from "@/lib/read";
import { fmtMoney, STATE_LABEL, stateTone } from "@/lib/ui";

export const dynamic = "force-dynamic";

export default async function Home() {
  const actor = await currentActor().catch(() => null);
  const pool = getPool();
  const board = await listBoard(pool).catch(() => null);
  const me = actor ? await getUser(pool, actor.id) : null;
  const rep = actor ? await getReputation(pool, actor.id).catch(() => null) : null;

  return (
    <main className="grid gap-8">
      <section>
        <h1 className="text-3xl font-semibold tracking-tight">Reserve first. Verify. Then pay.</h1>
        <p className="mt-2 max-w-2xl text-zinc-600">
          The client&apos;s money is reserved with PayPal before work starts. It is released only when checks the platform runs itself pass and the client approves.
          The finished files stay locked until PayPal confirms the payment.
        </p>
        {!actor && (
          <p className="mt-4">
            <Link href="/login" className="rounded-lg bg-indigo-600 px-4 py-2 font-medium text-white hover:bg-indigo-700">Sign in with a demo account</Link>
          </p>
        )}
        {actor?.role === "client" && (
          <p className="mt-4">
            <Link href="/jobs/new" className="rounded-lg bg-indigo-600 px-4 py-2 font-medium text-white hover:bg-indigo-700">Post a job</Link>
          </p>
        )}
      </section>

      {actor?.role === "freelancer" && me && (
        <section className="rounded-xl border border-zinc-200 bg-white p-5">
          <h2 className="mb-2 font-semibold">Where you get paid</h2>
          <PayeeForm current={me.paypalPayeeEmail} />
          {!me.paypalPayeeEmail && <p className="mt-2 text-sm text-amber-700">Add this before you accept a job.</p>}
        </section>
      )}

      {rep && (
        <section className="rounded-xl border border-zinc-200 bg-white p-5">
          <h2 className="mb-2 font-semibold">Your track record</h2>
          {rep.enoughHistory ? (
            <p className="text-sm text-zinc-700">{rep.closedMilestones} closed milestones · {rep.firstTimeVerified} verified with no gaps · {rep.declines} declines · {rep.disputes} disputes. Counted from the event log.</p>
          ) : (
            <p className="text-sm text-zinc-600">No history yet. Counts appear after 3 closed milestones ({rep.closedMilestones} so far). They come from the event log, not from ratings people type.</p>
          )}
        </section>
      )}

      <section>
        <h2 className="mb-3 text-xl font-semibold">Job board</h2>
        {board === null ? (
          <p className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">The database is not reachable. Check DATABASE_URL and run the migrations.</p>
        ) : board.length === 0 ? (
          <p className="text-sm text-zinc-600">No jobs yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase text-zinc-500">
                <tr><th className="p-3">Job</th><th className="p-3">Client</th><th className="p-3">Amount</th><th className="p-3">Status</th><th className="p-3" /></tr>
              </thead>
              <tbody>
                {board.map((b) => {
                  const mine = actor && (b.clientId === actor.id || b.freelancerId === actor.id);
                  const open = b.state === "awaiting_signatures" && !b.freelancerId;
                  return (
                    <tr key={b.id} className="border-b border-zinc-100 last:border-0">
                      <td className="p-3 font-medium">{b.title}</td>
                      <td className="p-3 text-zinc-600">{b.clientName}</td>
                      <td className="p-3">{fmtMoney(b.amountCents, b.currency)}</td>
                      <td className="p-3"><span className={`rounded-full px-2.5 py-1 text-xs font-medium ${stateTone(b.state)}`}>{STATE_LABEL[b.state]}</span></td>
                      <td className="p-3 text-right">
                        {(mine || open) && <Link className="text-indigo-700 underline" href={`/m/${b.id}`}>{open && actor?.role === "freelancer" ? "Review and accept" : "Open"}</Link>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
