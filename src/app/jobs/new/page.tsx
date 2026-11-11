import { redirect } from "next/navigation";
import { NewJobForm } from "@/components/NewJobForm";
import { currentActor } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function NewJobPage() {
  const actor = await currentActor();
  if (!actor) redirect("/login");
  if (actor.role !== "client") return <p className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">Only clients post jobs. Sign in as a client.</p>;
  return (
    <main>
      <h1 className="mb-1 text-2xl font-semibold">Post a job</h1>
      <p className="mb-6 text-sm text-zinc-600">Posting also signs the final check list for you. The freelancer reads and signs it next. Nothing is charged until you reserve funds, and money moves only after verification and your approval.</p>
      <NewJobForm />
    </main>
  );
}
