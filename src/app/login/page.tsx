import { LoginList } from "@/components/LoginList";
import { getPool } from "@/lib/db";
import { listUsers } from "@/lib/read";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const users = await listUsers(getPool()).catch(() => []);
  return (
    <main className="mx-auto max-w-lg">
      <h1 className="mb-1 text-2xl font-semibold">Sign in (demo)</h1>
      <p className="mb-6 text-sm text-zinc-600">This is a sandbox demo. Pick a seeded account to play that role. Real sign-in is not part of this build.</p>
      {users.length === 0 ? (
        <p className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">No accounts yet. Run <code>node scripts/seed.mjs</code> against the database first.</p>
      ) : (
        <LoginList users={users.map((u) => ({ id: u.id, name: u.displayName, role: u.role, email: u.email }))} />
      )}
    </main>
  );
}
