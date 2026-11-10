import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Proof2Pay",
  description:
    "Reserve the money first. Release it when verified checks pass and the client approves.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-zinc-50 text-zinc-900">{children}</body>
    </html>
  );
}
