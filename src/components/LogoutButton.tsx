"use client";
export function LogoutButton() {
  return (
    <button
      className="text-sm text-zinc-600 underline hover:text-zinc-900"
      onClick={async () => {
        await fetch("/api/logout", { method: "POST" });
        window.location.href = "/";
      }}
    >
      Sign out
    </button>
  );
}
