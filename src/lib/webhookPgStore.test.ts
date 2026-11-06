/**
 * Integration test against a real Postgres. Runs only when TEST_DATABASE_URL points at a
 * database that already has db/migrations applied (node scripts/migrate.mjs).
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleWebhook, invoiceRef } from "./webhook";
import { createPgWebhookStore } from "./webhookPgStore";
import { applyMilestoneEvent } from "./milestoneRepo";
import { IllegalTransitionError } from "./stateMachine";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("webhook + Postgres", () => {
  let pool: pg.Pool;
  const clientId = randomUUID();
  const jobId = randomUUID();

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url });
    await pool.query(`INSERT INTO users (id, email, display_name, role) VALUES ($1, $2, 'C', 'client')`, [
      clientId,
      `c-${clientId}@test.io`,
    ]);
    await pool.query(`INSERT INTO jobs (id, client_id, title) VALUES ($1, $2, 'J')`, [jobId, clientId]);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function milestoneIn(state: string, extra: { failedPart?: number } = {}) {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO milestones (id, job_id, title, amount_cents, state, failed_part, acceptance_window_hours)
       VALUES ($1, $2, 'M', 10000, $3, $4, 48)`,
      [id, jobId, state, extra.failedPart ?? null],
    );
    return id;
  }

  async function requestCapture(milestoneId: string, part: 1 | 2) {
    await pool.query(
      `INSERT INTO captures (milestone_id, part, amount_cents, paypal_request_id) VALUES ($1, $2, 5000, $3)`,
      [milestoneId, part, randomUUID()],
    );
  }

  const deliver = (milestoneId: string, part: 1 | 2, eventId: string, type = "PAYMENT.CAPTURE.COMPLETED") =>
    handleWebhook({
      rawBody: JSON.stringify({
        id: eventId,
        event_type: type,
        resource: { id: `CAP-${eventId}`, invoice_id: invoiceRef({ milestoneId, part }) },
      }),
      getHeader: () => "x",
      verify: async () => true,
      store: createPgWebhookStore(pool),
    });

  const milestone = async (id: string) =>
    (await pool.query(`SELECT * FROM milestones WHERE id = $1`, [id])).rows[0];
  const eventCount = async (id: string) =>
    Number((await pool.query(`SELECT count(*) FROM events WHERE milestone_id = $1`, [id])).rows[0].count);

  it("confirmed capture 1 unlocks the vault and opens the acceptance window", async () => {
    const id = await milestoneIn("capturing_part1");
    await requestCapture(id, 1);
    const res = await deliver(id, 1, `evt-${randomUUID()}`);
    expect(res).toEqual({ status: 200, body: "applied" });

    const m = await milestone(id);
    expect(m.state).toBe("acceptance_window");
    expect(m.vault_unlocked_at).not.toBeNull();
    const hours = (m.acceptance_window_ends_at.getTime() - m.vault_unlocked_at.getTime()) / 3_600_000;
    expect(Math.round(hours)).toBe(48);

    const cap = (await pool.query(`SELECT status, paypal_capture_id FROM captures WHERE milestone_id = $1`, [id])).rows[0];
    expect(cap.status).toBe("confirmed");
    expect(cap.paypal_capture_id).toMatch(/^CAP-/);
  });

  it("a redelivered event changes nothing and writes no extra log rows", async () => {
    const id = await milestoneIn("capturing_part1");
    await requestCapture(id, 1);
    const eventId = `evt-${randomUUID()}`;
    await deliver(id, 1, eventId);
    const logged = await eventCount(id);

    const again = await deliver(id, 1, eventId);
    expect(again).toEqual({ status: 200, body: "duplicate" });
    expect(await eventCount(id)).toBe(logged);
    expect((await milestone(id)).state).toBe("acceptance_window");
  });

  it("a different event for a milestone that already moved on is ignored, not an error", async () => {
    const id = await milestoneIn("capturing_part1");
    await requestCapture(id, 1);
    await deliver(id, 1, `evt-${randomUUID()}`);
    const res = await deliver(id, 1, `evt-${randomUUID()}`);
    expect(res).toEqual({ status: 200, body: "ignored" });
    expect((await milestone(id)).state).toBe("acceptance_window");
  });

  it("a denied capture keeps the vault locked", async () => {
    const id = await milestoneIn("capturing_part1");
    await requestCapture(id, 1);
    await deliver(id, 1, `evt-${randomUUID()}`, "PAYMENT.CAPTURE.DENIED");

    const m = await milestone(id);
    expect(m.state).toBe("capture_failed");
    expect(m.failed_part).toBe(1);
    expect(m.vault_unlocked_at).toBeNull();
    const cap = (await pool.query(`SELECT status FROM captures WHERE milestone_id = $1`, [id])).rows[0];
    expect(cap.status).toBe("failed");
  });

  it("capture 2 confirmed closes the milestone", async () => {
    const id = await milestoneIn("capturing_part2");
    await requestCapture(id, 2);
    await deliver(id, 2, `evt-${randomUUID()}`);
    expect((await milestone(id)).state).toBe("closed");
  });

  it("a capture webhook cannot unlock a milestone that is not capturing", async () => {
    const id = await milestoneIn("awaiting_client_approval");
    const res = await deliver(id, 1, `evt-${randomUUID()}`);
    expect(res.body).toBe("ignored");
    const m = await milestone(id);
    expect(m.state).toBe("awaiting_client_approval");
    expect(m.vault_unlocked_at).toBeNull();
  });

  it("applyMilestoneEvent rolls everything back when the transition is illegal", async () => {
    const id = await milestoneIn("draft");
    const before = await eventCount(id);
    await expect(applyMilestoneEvent(pool, id, { type: "client_approved" }, "test")).rejects.toBeInstanceOf(IllegalTransitionError);
    expect(await eventCount(id)).toBe(before);
    expect((await milestone(id)).state).toBe("draft");
  });

  it("applyMilestoneEvent rolls back the transition when the in-transaction work fails", async () => {
    const id = await milestoneIn("draft");
    await expect(
      applyMilestoneEvent(pool, id, { type: "post" }, "test", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect((await milestone(id)).state).toBe("draft");
  });

  it("two concurrent deliveries of the same event apply once", async () => {
    const id = await milestoneIn("capturing_part1");
    await requestCapture(id, 1);
    const eventId = `evt-${randomUUID()}`;
    const results = await Promise.all([deliver(id, 1, eventId), deliver(id, 1, eventId)]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect((await milestone(id)).state).toBe("acceptance_window");
    const log = await pool.query(`SELECT count(*) FROM events WHERE milestone_id = $1 AND type = 'milestone.capture_confirmed'`, [id]);
    expect(Number(log.rows[0].count)).toBe(1);
  });
});
