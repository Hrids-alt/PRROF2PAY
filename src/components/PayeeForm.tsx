"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function PayeeForm({ current }: { current: string | null }) {
  const router = useRouter();
  const [email, setEmail] = useState(current ?? "");
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        const res = await fetch("/api/me/payee", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
        const json = await res.json().catch(() => ({}));
        setMsg(res.ok ? "Saved" : json.error ?? "Could not save");
        if (res.ok) router.refresh();
      }}
    >
      <label className="text-sm">
        <span className="mb-1 block text-zinc-600">Your PayPal sandbox business email (where payments go)</span>
        <input className="w-80 rounded-lg border border-zinc-300 px-3 py-2" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="sb-xxxx@business.example.com" />
      </label>
      <button className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700">Save</button>
      {msg && <span className="text-sm text-zinc-600">{msg}</span>}
    </form>
  );
}
