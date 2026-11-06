export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-4 px-6">
      <h1 className="text-3xl font-semibold">Proof2Pay</h1>
      <p className="text-zinc-600">
        Money is reserved before work starts. It is released only when checks
        pass and the client approves. Files stay locked until PayPal confirms
        the capture.
      </p>
      <p className="text-sm text-zinc-500">
        PayPal sandbox demo. Not legal advice.
      </p>
    </main>
  );
}
