"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

/** Used for a decline and for a dispute: both must name the requirement that is failing. */
export function RequirementPicker(props: { milestoneId: string; action: "decline" | "cite"; label: string; requirements: Array<{ id: string; position: number; text: string }> }) {
  const router = useRouter();
  const [id, setId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="grid gap-2">
      <select className="rounded-lg border border-zinc-300 px-3 py-2 text-sm" value={id} onChange={(e) => setId(e.target.value)}>
        <option value="">Choose the requirement you believe is failing…</option>
        {props.requirements.map((r) => (
          <option key={r.id} value={r.id}>{r.position}. {r.text.slice(0, 90)}</option>
        ))}
      </select>
      <button
        disabled={busy || !id}
        className="w-fit rounded-lg border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
        onClick={async () => {
          setBusy(true);
          setError(null);
          const res = await fetch(`/api/m/${props.milestoneId}/${props.action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requirementId: id }) });
          const json = await res.json().catch(() => ({}));
          setBusy(false);
          if (!res.ok) setError(json.error ?? "Could not send");
          else router.refresh();
        }}
      >
        {busy ? "Re-running the check…" : props.label}
      </button>
      {error && <p className="text-sm text-red-700">{error}</p>}
    </div>
  );
}
