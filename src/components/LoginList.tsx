"use client";
import { useState } from "react";

export function LoginList({ users }: { users: Array<{ id: string; name: string; role: string; email: string }> }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="grid gap-3">
      {users.map((u) => (
        <button
          key={u.id}
          className="flex items-center justify-between rounded-xl border border-zinc-200 bg-white p-4 text-left hover:border-indigo-400"
          onClick={async () => {
            const res = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: u.id }) });
            if (res.ok) window.location.href = "/";
            else setError((await res.json().catch(() => ({}))).error ?? "Could not sign in");
          }}
        >
          <span>
            <span className="block font-medium">{u.name}</span>
            <span className="text-sm text-zinc-500">{u.email}</span>
          </span>
          <span className={`rounded-full px-3 py-1 text-xs font-medium ${u.role === "client" ? "bg-indigo-100 text-indigo-800" : "bg-emerald-100 text-emerald-800"}`}>{u.role}</span>
        </button>
      ))}
      {error && <p className="text-sm text-red-700">{error}</p>}
    </div>
  );
}
