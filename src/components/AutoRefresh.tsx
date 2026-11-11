"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Reloads the server data every few seconds while something is running in the background. */
export function AutoRefresh({ seconds = 4 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(t);
  }, [router, seconds]);
  return <p className="text-xs text-zinc-500">Updating automatically…</p>;
}
