"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

const input = "w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm";

export function UploadForm({ milestoneId }: { milestoneId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <form
      className="grid gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        setBusy(true);
        setMsg(null);
        const res = await fetch(`/api/m/${milestoneId}/upload`, { method: "POST", body: new FormData(form) });
        const json = await res.json().catch(() => ({}));
        setBusy(false);
        if (res.ok) {
          setMsg(`Added. Fingerprint ${String(json.sha256).slice(0, 12)}…`);
          form.reset();
          router.refresh();
        } else setMsg(json.error ?? "Upload failed");
      }}
    >
      <input className={input} type="file" name="file" required />
      <select className={input} name="kind" defaultValue="document">
        <option value="document">Document the checks should read (brief, report)</option>
        <option value="deliverable">Deliverable (stays locked, e.g. a zip)</option>
      </select>
      <button disabled={busy} className="w-fit rounded-lg bg-white px-4 py-2 text-sm font-medium border border-zinc-300 hover:bg-zinc-100 disabled:opacity-50">{busy ? "Uploading…" : "Add file to the locked vault"}</button>
      {msg && <p className="text-xs text-zinc-600">{msg}</p>}
    </form>
  );
}

export function SubmitEvidenceForm({ milestoneId }: { milestoneId: string }) {
  const router = useRouter();
  const [v, setV] = useState({ liveUrl: "", repo: "", commit: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="grid gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        const res = await fetch(`/api/m/${milestoneId}/evidence`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(v) });
        const json = await res.json().catch(() => ({}));
        setBusy(false);
        if (!res.ok) setError(json.error ?? "Could not submit");
        else router.refresh();
      }}
    >
      <input className={input} placeholder="Live URL (https only), e.g. https://my-site.onrender.com" value={v.liveUrl} onChange={(e) => setV({ ...v, liveUrl: e.target.value })} />
      <input className={input} placeholder="Repository, e.g. owner/name (public)" value={v.repo} onChange={(e) => setV({ ...v, repo: e.target.value })} />
      <input className={input} placeholder="Commit hash (optional)" value={v.commit} onChange={(e) => setV({ ...v, commit: e.target.value })} />
      <button disabled={busy} className="w-fit rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:bg-indigo-300">{busy ? "Running checks…" : "Submit for checks"}</button>
      <p className="text-xs text-zinc-500">The platform runs the checks itself from its own servers. Submitted code is never run.</p>
      {error && <p className="text-sm text-red-700">{error}</p>}
    </form>
  );
}
