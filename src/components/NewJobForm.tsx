"use client";
import { useState } from "react";

type Row = { text: string; checkType: string; checkConfig: Record<string, unknown> };
const input = "w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm";
const TYPES: Array<[string, string]> = [
  ["http", "HTTP check (our servers call your URL)"],
  ["repo", "Repo fact (GitHub API)"],
  ["document", "Document rubric (AI reads the file)"],
  ["browser", "Browser flow (scripted steps)"],
  ["needs_human", "Needs a person (no machine check)"],
];
const csv = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

function ConfigFields({ row, onChange }: { row: Row; onChange: (c: Record<string, unknown>) => void }) {
  const c = row.checkConfig;
  if (row.checkType === "http")
    return (
      <div className="grid gap-2 sm:grid-cols-3">
        <input className={input} placeholder="Path, e.g. /pricing" value={(c.path as string) ?? ""} onChange={(e) => onChange({ ...c, path: e.target.value })} />
        <input className={input} placeholder="Expected status (200)" value={(c.expectStatus as number | undefined) ?? ""} onChange={(e) => onChange({ ...c, expectStatus: e.target.value ? Number(e.target.value) : undefined })} />
        <input className={input} placeholder="Must contain (comma separated)" value={((c.contains as string[]) ?? []).join(", ")} onChange={(e) => onChange({ ...c, contains: csv(e.target.value) })} />
      </div>
    );
  if (row.checkType === "repo")
    return <input className={input} placeholder="Files that must exist, comma separated, e.g. README.md, LICENSE" value={((c.fileExists as string[]) ?? []).join(", ")} onChange={(e) => onChange({ ...c, fileExists: csv(e.target.value) })} />;
  if (row.checkType === "document")
    return <input className={input} placeholder="Rubric: what the document must show (defaults to the requirement text)" value={(c.rubric as string) ?? ""} onChange={(e) => onChange({ ...c, rubric: e.target.value })} />;
  if (row.checkType === "browser")
    return (
      <textarea
        className={`${input} font-mono`}
        rows={3}
        placeholder='Steps as JSON, e.g. [{"action":"goto","path":"/cart"},{"action":"expectText","text":"Checkout"}]'
        defaultValue={c.steps ? JSON.stringify(c.steps) : ""}
        onChange={(e) => {
          try {
            onChange({ ...c, steps: JSON.parse(e.target.value) });
          } catch {
            /* keep typing */
          }
        }}
      />
    );
  return <p className="text-xs text-zinc-500">No machine check. The report will say a person must review this line.</p>;
}

export function NewJobForm() {
  const [f, setF] = useState({ title: "", description: "", amount: "100", part1Percent: "50", reviewWindowHours: "72", acceptanceWindowHours: "72", noReplyRule: "release", dueAt: "" });
  const [rows, setRows] = useState<Row[]>([{ text: "", checkType: "http", checkConfig: { path: "/", expectStatus: 200 } }]);
  const [rough, setRough] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [draftNote, setDraftNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="grid gap-6"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        const res = await fetch("/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...f, requirements: rows.filter((r) => r.text.trim()) }) });
        const json = await res.json().catch(() => ({}));
        if (res.ok) window.location.href = `/m/${json.id}`;
        else {
          setError(json.error ?? "Could not post the job");
          setBusy(false);
        }
      }}
    >
      <section className="grid gap-3 rounded-xl border border-zinc-200 bg-white p-5">
        <h2 className="font-semibold">The job</h2>
        <input className={input} placeholder="Title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required />
        <textarea className={input} rows={3} placeholder="What do you need?" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="text-sm">Amount (USD, sandbox)<input className={input} type="number" min="1" step="0.01" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></label>
          <label className="text-sm">Split<select className={input} value={f.part1Percent} onChange={(e) => setF({ ...f, part1Percent: e.target.value })}>
            <option value="50">50% after approval, 50% after the acceptance window</option>
            <option value="70">70% / 30%</option>
            <option value="100">100% after approval</option>
          </select></label>
          <label className="text-sm">Due date (optional)<input className={input} type="date" value={f.dueAt} onChange={(e) => setF({ ...f, dueAt: e.target.value })} /></label>
          <label className="text-sm">Client review window (hours)<input className={input} type="number" min="1" value={f.reviewWindowHours} onChange={(e) => setF({ ...f, reviewWindowHours: e.target.value })} /></label>
          <label className="text-sm">Acceptance window (hours)<input className={input} type="number" min="1" value={f.acceptanceWindowHours} onChange={(e) => setF({ ...f, acceptanceWindowHours: e.target.value })} /></label>
          <label className="text-sm">If the client does not reply by the deadline<select className={input} value={f.noReplyRule} onChange={(e) => setF({ ...f, noReplyRule: e.target.value })}>
            <option value="release">Release part 1 to the freelancer</option>
            <option value="return">Return the reservation to the client</option>
          </select></label>
        </div>
        <p className="text-xs text-zinc-500">Keep milestones to about 3 weeks: a PayPal hold lasts up to 29 days. PayPal fees come out of the freelancer&apos;s payout.</p>
      </section>

      <section className="grid gap-3 rounded-xl border border-zinc-200 bg-white p-5">
        <h2 className="font-semibold">Requirements the platform will check</h2>
        <div className="grid gap-2 rounded-lg bg-zinc-50 p-3">
          <label className="text-sm text-zinc-700">Paste rough lines, one per line, and let the assistant turn them into checkable requirements</label>
          <textarea className={input} rows={3} value={rough} onChange={(e) => setRough(e.target.value)} placeholder={"The site should load fast and show pricing\nThere is a short brief explaining the three plans\nThe repo has a README"} />
          <button
            type="button"
            disabled={drafting || !rough.trim()}
            className="w-fit rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm hover:bg-zinc-100 disabled:opacity-50"
            onClick={async () => {
              setDrafting(true);
              setDraftNote(null);
              const res = await fetch("/api/ai/draft-checks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lines: rough.split("\n") }) });
              const json = await res.json().catch(() => ({}));
              setDrafting(false);
              if (res.ok) {
                setRows(json.requirements);
                setDraftNote(json.source === "ai" ? "Drafted by the AI. Read each line: both of you will sign this list." : "Drafted with simple rules (no AI key is set). Anything unclear is marked as needing a person.");
              } else setDraftNote(json.error ?? "Could not draft");
            }}
          >
            {drafting ? "Drafting…" : "Draft checks"}
          </button>
          {draftNote && <p className="text-xs text-zinc-600">{draftNote}</p>}
        </div>

        {rows.map((r, i) => (
          <div key={i} className="grid gap-2 rounded-lg border border-zinc-200 p-3">
            <div className="flex gap-2">
              <input className={input} placeholder={`Requirement ${i + 1}`} value={r.text} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} />
              <button type="button" className="rounded-lg border border-zinc-300 px-3 text-sm hover:bg-zinc-100" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label="Remove requirement">✕</button>
            </div>
            <select className={input} value={r.checkType} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, checkType: e.target.value, checkConfig: {} } : x)))}>
              {TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <ConfigFields row={r} onChange={(c) => setRows(rows.map((x, j) => (j === i ? { ...x, checkConfig: c } : x)))} />
          </div>
        ))}
        <button type="button" className="w-fit rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm hover:bg-zinc-100" onClick={() => setRows([...rows, { text: "", checkType: "needs_human", checkConfig: {} }])}>Add a requirement</button>
      </section>

      {error && <p className="text-sm text-red-700">{error}</p>}
      <button disabled={busy} className="w-fit rounded-lg bg-indigo-600 px-5 py-2.5 font-medium text-white hover:bg-indigo-700 disabled:bg-indigo-300">{busy ? "Posting…" : "Post and sign as client"}</button>
    </form>
  );
}
