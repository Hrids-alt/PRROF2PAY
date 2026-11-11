// Usage: DATABASE_URL=... [SEED_FREELANCER_PAYEE=<freelancer sandbox business email>] node scripts/seed.mjs
import pg from "pg";
import { seed } from "./seedLib.mjs";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  const r = await seed(client, { freelancerPayee: process.env.SEED_FREELANCER_PAYEE });
  console.log(`seeded ${r.users} accounts, ${r.jobsCreated} new jobs`);
  if (!process.env.SEED_FREELANCER_PAYEE) console.log("Tip: set SEED_FREELANCER_PAYEE to the freelancer's sandbox business email, or enter it on the home page when signed in as Fiona.");
} finally {
  await client.end();
}
