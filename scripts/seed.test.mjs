import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contractHash } from "../src/lib/contract.ts";
import { JOBS, seed, seedContractHash } from "./seedLib.mjs";

describe("seed contract hash", () => {
  it("matches the app's contractHash for every seeded job", () => {
    for (const j of JOBS) expect(seedContractHash(j, 1)).toBe(contractHash(j, 1));
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("seed (database)", () => {
  let db;
  beforeAll(async () => {
    db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  });
  afterAll(async () => db.end());
  it("is safe to run twice and leaves open jobs on the board", async () => {
    await seed(db, { freelancerPayee: "free@biz.example.com" });
    const second = await seed(db, {});
    expect(second.jobsCreated).toBe(0);
    const open = await db.query(`SELECT count(*) FROM milestones WHERE state = 'awaiting_signatures' AND title = ANY($1)`, [JOBS.map((j) => j.title)]);
    expect(Number(open.rows[0].count)).toBeGreaterThanOrEqual(JOBS.length);
    const payee = await db.query(`SELECT paypal_payee_email FROM users WHERE email = 'fiona@demo.test'`);
    expect(payee.rows[0].paypal_payee_email).toBe("free@biz.example.com");
  });
});
