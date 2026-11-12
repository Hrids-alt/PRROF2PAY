// Demo data: accounts and a few open jobs for the board. Safe to run more than once.
import { createHash } from "node:crypto";

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
    .join(",")}}`;
}

/** Must stay identical to contractHash in src/lib/contract.ts (a test checks this). */
export function seedContractHash(c, version) {
  return createHash("sha256")
    .update(
      canonicalJson({
        version,
        title: c.title.trim(),
        description: c.description.trim(),
        amountCents: c.amountCents,
        currency: c.currency,
        part1Percent: c.part1Percent,
        reviewWindowHours: c.reviewWindowHours,
        acceptanceWindowHours: c.acceptanceWindowHours,
        noReplyRule: c.noReplyRule,
        dueAt: c.dueAt,
        requirements: c.requirements.map((r) => ({ text: r.text.trim(), checkType: r.checkType, checkConfig: r.checkConfig })),
      }),
    )
    .digest("hex");
}

export const USERS = [
  { email: "cleo@demo.test", name: "Cleo Client", role: "client" },
  { email: "acme@demo.test", name: "Acme Studio", role: "client" },
  { email: "fiona@demo.test", name: "Fiona Freelancer", role: "freelancer" },
  { email: "sam@demo.test", name: "Sam Developer", role: "freelancer" },
];

export const JOBS = [
  {
    owner: "cleo@demo.test",
    title: "Demo: site goes live",
    description: "The freelancer's live site must load and show the sign-in page.",
    amountCents: 5000, currency: "USD", part1Percent: 50, reviewWindowHours: 24, acceptanceWindowHours: 24, noReplyRule: "release", dueAt: null,
    requirements: [
      { text: "The live site loads and shows Sign in", checkType: "http", checkConfig: { path: "/login", expectStatus: 200, contains: ["Sign in"] } },
    ],
  },
  {
    owner: "acme@demo.test",
    title: "Maple & Co pricing page",
    description: "A one-page site with a pricing table for three plans, plus a short written brief.",
    amountCents: 20000, currency: "USD", part1Percent: 50, reviewWindowHours: 72, acceptanceWindowHours: 72, noReplyRule: "release", dueAt: null,
    requirements: [
      { text: "The home page loads and shows the word Pricing", checkType: "http", checkConfig: { path: "/", expectStatus: 200, contains: ["Pricing"] } },
      { text: "A brief describes the three pricing plans", checkType: "document", checkConfig: { rubric: "The brief lists three pricing plans by name" } },
      { text: "The repository has a README", checkType: "repo", checkConfig: { fileExists: ["README.md"] } },
    ],
  },
  {
    owner: "acme@demo.test",
    title: "Newsletter signup endpoint",
    description: "An API endpoint that accepts an email and answers with a confirmation message.",
    amountCents: 12000, currency: "USD", part1Percent: 70, reviewWindowHours: 48, acceptanceWindowHours: 48, noReplyRule: "release", dueAt: null,
    requirements: [
      { text: "GET /health answers with status 200", checkType: "http", checkConfig: { path: "/health", expectStatus: 200 } },
      { text: "The repository has a LICENSE file", checkType: "repo", checkConfig: { fileExists: ["LICENSE"] } },
    ],
  },
  {
    owner: "cleo@demo.test",
    title: "Logo usage guide (PDF text brief)",
    description: "A short document describing how the logo may and may not be used.",
    amountCents: 8000, currency: "USD", part1Percent: 100, reviewWindowHours: 24, acceptanceWindowHours: 24, noReplyRule: "return", dueAt: null,
    requirements: [
      { text: "The document explains minimum logo size and clear space", checkType: "document", checkConfig: { rubric: "States a minimum size and clear space around the logo" } },
    ],
  },
];

export async function seed(db, { freelancerPayee } = {}) {
  const ids = {};
  for (const u of USERS) {
    const payee = u.email === "fiona@demo.test" ? freelancerPayee || null : null;
    const r = await db.query(
      `INSERT INTO users (email, display_name, role, paypal_payee_email) VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO UPDATE SET paypal_payee_email = COALESCE(EXCLUDED.paypal_payee_email, users.paypal_payee_email)
       RETURNING id`,
      [u.email, u.name, u.role, payee],
    );
    ids[u.email] = r.rows[0].id;
  }

  let created = 0;
  for (const j of JOBS) {
    const exists = await db.query(`SELECT 1 FROM milestones m JOIN jobs jb ON jb.id = m.job_id WHERE m.title = $1 AND jb.client_id = $2`, [j.title, ids[j.owner]]);
    if (exists.rowCount) continue;
    const hash = seedContractHash(j, 1);
    const job = await db.query(`INSERT INTO jobs (client_id, title, description) VALUES ($1, $2, $3) RETURNING id`, [ids[j.owner], j.title, j.description]);
    const m = await db.query(
      `INSERT INTO milestones (job_id, title, amount_cents, currency, part1_percent, no_reply_rule, review_window_hours, acceptance_window_hours, due_at, contract_version, contract_hash, state)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, $10, 'awaiting_signatures') RETURNING id`,
      [job.rows[0].id, j.title, j.amountCents, j.currency, j.part1Percent, j.noReplyRule, j.reviewWindowHours, j.acceptanceWindowHours, j.dueAt, hash],
    );
    for (const [i, r] of j.requirements.entries()) {
      await db.query(`INSERT INTO requirements (milestone_id, position, text, check_type, check_config) VALUES ($1, $2, $3, $4, $5)`, [m.rows[0].id, i + 1, r.text, r.checkType, JSON.stringify(r.checkConfig)]);
    }
    await db.query(`INSERT INTO signatures (milestone_id, user_id, contract_version, contract_hash) VALUES ($1, $2, 1, $3)`, [m.rows[0].id, ids[j.owner], hash]);
    await db.query(`INSERT INTO events (milestone_id, type, actor, data) VALUES ($1, 'milestone.post', 'seed', $2)`, [m.rows[0].id, JSON.stringify({ from: "draft", to: "awaiting_signatures", effects: [], event: { type: "post" } })]);
    created++;
  }
  return { users: USERS.length, jobsCreated: created };
}
