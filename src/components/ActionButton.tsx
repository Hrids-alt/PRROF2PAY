"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

const TONES = {
  primary: "bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-indigo-300",
  danger: "bg-white text-red-700 border border-red-300 hover:bg-red-50 disabled:opacity-50",
  plain: "bg-white text-zinc-800 border border-zinc-300 hover:bg-zinc-100 disabled:opacity-50",
};

export function ActionButton(props: {
  url: string;
  label: string;
  body?: Record<string, unknown>;
  confirm?: string;
  tone?: keyof typeof TONES;
  /** Follow `approveUrl` or `path` from the reply with a full navigation. */
  follow?: "approveUrl" | "path";
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-col gap-1">
      <button
        type="button"
        disabled={busy}
        className={`rounded-lg px-4 py-2 text-sm font-medium ${TONES[props.tone ?? "primary"]}`}
        onClick={async () => {
          if (props.confirm && !window.confirm(props.confirm)) return;
          setBusy(true);
          setError(null);
          try {
            const res = await fetch(props.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(props.body ?? {}) });
            const json = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(json.error ?? "Something went wrong");
            const next = props.follow ? json[props.follow] : null;
            if (next) {
              if (props.follow === "path") window.open(next, "_blank", "noopener");
              else window.location.href = next;
              setBusy(false);
            } else {
              router.refresh();
              setBusy(false);
            }
          } catch (e) {
            setError(e instanceof Error ? e.message : "Something went wrong");
            setBusy(false);
          }
        }}
      >
        {busy ? "Working…" : props.label}
      </button>
      {error && <span className="max-w-sm text-xs text-red-700">{error}</span>}
    </span>
  );
}
