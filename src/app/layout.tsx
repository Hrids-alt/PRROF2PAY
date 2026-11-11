import type { Metadata } from "next";
import Link from "next/link";
import { LogoutButton } from "@/components/LogoutButton";
import { currentActor } from "@/lib/auth";
import "./globals.css";

export const metadata: Metadata = {
  title: "Proof2Pay",
  description: "Reserve the money first. Release it when verified checks pass and the client approves.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  let actor = null;
  try {
    actor = await currentActor();
  } catch {
    actor = null; // the database may not be reachable yet; pages show their own message
  }
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-zinc-50 text-zinc-900">
        <header className="border-b border-zinc-200 bg-white">
          <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
            <Link href="/" className="text-lg font-semibold tracking-tight">Proof2Pay</Link>
            <div className="flex items-center gap-4 text-sm">
              {actor ? (
                <>
                  <span className="text-zinc-600">{actor.name} · {actor.role}</span>
                  <LogoutButton />
                </>
              ) : (
                <Link href="/login" className="rounded-lg bg-indigo-600 px-3 py-1.5 font-medium text-white hover:bg-indigo-700">Sign in (demo)</Link>
              )}
            </div>
          </div>
        </header>
        <div className="mx-auto w-full max-w-5xl flex-1 px-6 py-8">{children}</div>
        <footer className="border-t border-zinc-200 bg-white py-4 text-center text-xs text-zinc-500">
          PayPal sandbox demo. Not legal advice. PayPal holds the authorization; Proof2Pay does not hold your money.
        </footer>
      </body>
    </html>
  );
}
