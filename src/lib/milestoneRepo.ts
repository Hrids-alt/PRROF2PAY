/**
 * Persists state machine transitions. Every change to a milestone's state goes through
 * `applyMilestoneEvent`: it locks the row, runs the pure transition, saves the result and
 * appends to the event log in one transaction.
 *
 * Effects such as `capture_part1` are returned, not executed here. A worker runs them,
 * so the PayPal call is never made inside a database transaction.
 */
import type { Pool, PoolClient } from "pg";
import {
  transition,
  type Effect,
  type MilestoneContext,
  type MilestoneEvent,
  type MilestoneState,
  type NoReplyRule,
} from "./stateMachine";

export class MilestoneNotFoundError extends Error {
  constructor(id: string) {
    super(`Milestone ${id} not found`);
    this.name = "MilestoneNotFoundError";
  }
}

export interface AppliedTransition {
  from: MilestoneState;
  ctx: MilestoneContext;
  effects: Effect[];
}

interface MilestoneRow {
  state: MilestoneState;
  gap_rounds: number;
  no_reply_rule: NoReplyRule;
  failed_part: 1 | 2 | null;
  acceptance_window_hours: number;
  review_window_hours: number;
}

/**
 * @param inTx optional work to do in the same transaction (for example, marking a capture row
 *   or a webhook event as processed). If it throws, the transition is rolled back too.
 */
export async function applyMilestoneEvent(
  pool: Pool,
  milestoneId: string,
  ev: MilestoneEvent,
  actor: string,
  inTx?: (client: PoolClient, applied: AppliedTransition) => Promise<void>,
): Promise<AppliedTransition> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const found = await client.query<MilestoneRow>(
      `SELECT state, gap_rounds, no_reply_rule, failed_part, acceptance_window_hours, review_window_hours
         FROM milestones WHERE id = $1 FOR UPDATE`,
      [milestoneId],
    );
    const row = found.rows[0];
    if (!row) throw new MilestoneNotFoundError(milestoneId);

    const before: MilestoneContext = {
      state: row.state,
      gapRounds: row.gap_rounds,
      noReplyRule: row.no_reply_rule,
      failedPart: row.failed_part,
    };
    const { ctx, effects } = transition(before, ev);
    const unlocks = effects.includes("unlock_vault");

    await client.query(
      `UPDATE milestones SET
         state = $2,
         gap_rounds = $3,
         failed_part = $4,
         vault_unlocked_at = CASE WHEN $5 THEN now() ELSE vault_unlocked_at END,
         acceptance_window_ends_at = CASE WHEN $5 THEN now() + make_interval(hours => $6) ELSE acceptance_window_ends_at END,
         review_deadline_at = CASE WHEN $2::text = 'awaiting_client_approval' AND $7::text <> 'awaiting_client_approval'
                                   THEN now() + make_interval(hours => $8) ELSE review_deadline_at END,
         updated_at = now()
       WHERE id = $1`,
      [milestoneId, ctx.state, ctx.gapRounds, ctx.failedPart, unlocks, row.acceptance_window_hours, before.state, row.review_window_hours],
    );

    await client.query(
      `INSERT INTO events (milestone_id, type, actor, data) VALUES ($1, $2, $3, $4)`,
      [milestoneId, `milestone.${ev.type}`, actor, JSON.stringify({ from: before.state, to: ctx.state, effects, event: ev })],
    );

    const applied: AppliedTransition = { from: before.state, ctx, effects };
    if (inTx) await inTx(client, applied);

    await client.query("COMMIT");
    return applied;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
