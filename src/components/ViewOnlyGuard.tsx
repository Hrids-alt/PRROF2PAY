"use client";
import { useEffect, useRef } from "react";

/**
 * Deterrent only: blocks right-click, copy, drag and print shortcuts, draws a watermark with the
 * client name and session id, and reports time spent per section. A person can still photograph the screen.
 */
export function ViewOnlyGuard({ milestoneId, watermark, children }: { milestoneId: string; watermark: string; children: React.ReactNode }) {
  const current = useRef("top");
  const seconds = useRef<Record<string, number>>({});

  useEffect(() => {
    const stop = (e: Event) => e.preventDefault();
    const keys = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && ["p", "s", "c", "x", "a", "u"].includes(e.key.toLowerCase())) e.preventDefault();
    };
    document.addEventListener("contextmenu", stop);
    document.addEventListener("copy", stop);
    document.addEventListener("cut", stop);
    document.addEventListener("dragstart", stop);
    document.addEventListener("keydown", keys);

    const sections = document.querySelectorAll<HTMLElement>("[data-section]");
    const io = new IntersectionObserver(
      (entries) => {
        for (const en of entries) if (en.isIntersecting) current.current = (en.target as HTMLElement).dataset.section ?? "top";
      },
      { threshold: 0.5 },
    );
    sections.forEach((s) => io.observe(s));

    const tick = setInterval(() => {
      if (document.visibilityState === "visible") seconds.current[current.current] = (seconds.current[current.current] ?? 0) + 1;
    }, 1000);
    const send = () => {
      for (const [section, secs] of Object.entries(seconds.current)) {
        if (secs <= 0) continue;
        void fetch("/api/preview/heartbeat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ milestoneId, section, seconds: secs }), keepalive: true });
      }
      seconds.current = {};
    };
    const beat = setInterval(send, 15000);
    window.addEventListener("pagehide", send);
    return () => {
      clearInterval(tick);
      clearInterval(beat);
      io.disconnect();
      window.removeEventListener("pagehide", send);
      document.removeEventListener("contextmenu", stop);
      document.removeEventListener("copy", stop);
      document.removeEventListener("cut", stop);
      document.removeEventListener("dragstart", stop);
      document.removeEventListener("keydown", keys);
    };
  }, [milestoneId]);

  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='560' height='220'><text x='20' y='130' fill='rgba(0,0,0,0.12)' font-size='18' font-family='sans-serif' transform='rotate(-18 280 110)'>${watermark.replace(/[<>&']/g, "")}</text></svg>`;
  return (
    <div className="view-only relative">
      {children}
      <div aria-hidden className="pointer-events-none fixed inset-0 z-50" style={{ backgroundImage: `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")` }} />
    </div>
  );
}
