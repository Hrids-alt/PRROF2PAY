/**
 * Runs the side effects the state machine asks for, and the background tick.
 *
 * Rules:
 *  - The only code that calls PayPal's capture is `performCapture`, and it only runs for the
 *    effects `capture_part1` and `capture_part2`.
 *  - Effects run AFTER the state change is committed, never inside a database transaction.
 *    If the process dies in between, `tick` finds the milestone and finishes the job.
 *  - Nothing here marks files unlocked. The unlock comes from a confirmed capture
 *    (webhook, or the reconcile poller reading PayPal's own record).
 */
import type { PoolClient } from "pg";
import type { Deps } from "./deps";
import { applyCaptureOutcome } from "./captureOutcome";
import { splitAmounts } from "./contract";
import { getMilestone } from "./read";
import { applyMilestoneEvent, type AppliedTransition } from "./milestoneRepo";
import { PaypalError } from "./paypal";
import { runVerification } from "./verification";
import { IllegalTransitionError, type Effect, type MilestoneEvent } from "./stateMachine";
import { invoiceRef } from "./webhook";

export async function logEvent(deps: Deps | { pool: PoolClient }, milestoneId: string, type: string, actor: string, data: Record<string, unknown> = {}) {
  await deps.pool.query(`INSERT INTO events (milestone_id, type, actor, data) VALUES ($1, $2, $3, $4)`, [milestoneId, type, actor, JSON.stringify(data)]);
}

export interface RunExtras {
  /** For a decline or a dispute: the requirement the client named. */
  focusRequirementId?: string;
}

/** Applies an event, then runs the effects it asked for. */
export async function applyAndRun(
  deps: Deps,
  milestoneId: string,
  ev: MilestoneEvent,
  actor: string,
  extras: RunExtras = {},
  inTx?: (client: PoolClient, applied: AppliedTransition) => Promise<void>,
): Promise<AppliedTransition> {
  const applied = await applyMilestoneEvent(deps.pool, milestoneId, ev, actor, inTx);
  await executeEffects(deps, milestoneId, applied, extras);
  return applied;
}

export async function executeEffects(deps: Deps, milestoneId: string, applied: AppliedTransition, extras: RunExtras = {}): Promise<void> {
  for (const effect of applied.effects) {
    try {
      await runEffect(deps, milestoneId, effect, applied, extras);
    } catch (err) {
      // Leave the milestone where it is; `tick` retries. Never let one effect hide the state change.
      await logEvent(deps, milestoneId, "effect.failed", "platform", {
        effect,
        error: err instanceof Error ? err.message : "unknown error",
      });
    }
  }
}

async function runEffect(deps: Deps, milestoneId: string, effect: Effect, applied: AppliedTransition, extras: RunExtras): Promise<void> {
  switch (effect) {
    case "run_checks": {
      const rechecking = applied.ctx.state === "rechecking";
      const outcome = await runVerification(deps, milestoneId, { fresh: applied.from === "awaiting_client_approval" || rechecking });
      if (rechecking) {
        const focus = extras.focusRequirementId ? outcome.results.find((r) => r.requirementId === extras.focusRequirementId) : null;
        const passed = focus ? focus.verdict === "verified" : outcome.allVerified;
        await applyAndRun(deps, milestoneId, { type: "recheck_finished", passed }, "platform", extras);
      } else {
        await applyAndRun(deps, milestoneId, { type: "verification_finished", allVerified: outcome.allVerified }, "platform", extras);
      }
      return;
    }
    case "capture_part1":
      await performCapture(deps, milestoneId, 1);
      return;
    case "capture_part2":
      await performCapture(deps, milestoneId, 2);
      return;
    case "void_authorization": {
      const m = await getMilestone(deps.pool, milestoneId);
      if (m?.authorizationId) {
        await deps.paypal.voidAuthorization(m.authorizationId);
        await logEvent(deps, milestoneId, "authorization.voided", "platform", { authorizationId: m.authorizationId });
      }
      return;
    }
    case "notify_capture_failed":
      await logEvent(deps, milestoneId, "capture.failed_notice", "platform", { part: applied.ctx.failedPart });
      return;
    case "unlock_vault":
    case "close_milestone":
      // Recorded by the state change itself (vault_unlocked_at, state, event log).
      return;
  }
}

function captureInputs(m: NonNullable<Awaited<ReturnType<typeof getMilestone>>>, part: 1 | 2) {
  const { part1Cents, part2Cents } = splitAmounts(m.amountCents, m.part1Percent);
  return {
    amountCents: part === 1 ? part1Cents : part2Cents,
    // Close the authorization on the last payment so nothing stays reserved.
    finalCapture: part === 2 || part2Cents === 0,
  };
}

/** Steps 9 and 12. Safe to call twice: a second call finds the live capture row and stops. */
export async function performCapture(deps: Deps, milestoneId: string, part: 1 | 2): Promise<void> {
  const m = await getMilestone(deps.pool, milestoneId);
  if (!m || m.state !== (part === 1 ? "capturing_part1" : "capturing_part2")) return;
  if (!m.authorizationId) throw new Error("No authorization to capture from");

  const live = await deps.pool.query(`SELECT 1 FROM captures WHERE milestone_id = $1 AND part = $2 AND status IN ('requested', 'confirmed')`, [milestoneId, part]);
  if (live.rowCount) return;

  const { amountCents, finalCapture } = captureInputs(m, part);
  if (amountCents <= 0) {
    // 100/0 split: nothing is left to capture for part 2.
    await applyCaptureOutcome(deps.pool, { ref: { milestoneId, part }, captureId: "none", outcome: "confirmed", actor: "platform" });
    return;
  }

  const attempt = Number((await deps.pool.query(`SELECT count(*) AS n FROM captures WHERE milestone_id = $1 AND part = $2`, [milestoneId, part])).rows[0].n) + 1;
  const requestId = `p2p-cap-${milestoneId}-${part}-${attempt}`;
  try {
    await deps.pool.query(`INSERT INTO captures (milestone_id, part, amount_cents, paypal_request_id) VALUES ($1, $2, $3, $4)`, [milestoneId, part, amountCents, requestId]);
  } catch (err) {
    if ((err as { code?: string }).code === "23505") return; // another worker got there first
    throw err;
  }

  let result;
  try {
    result = await deps.paypal.capture({
      authorizationId: m.authorizationId,
      requestId,
      amountCents,
      currency: m.currency,
      invoiceId: invoiceRef({ milestoneId, part }),
      finalCapture,
    });
  } catch (err) {
    // Outcome unknown. The row stays 'requested' and reconcile replays it with the same request id.
    await logEvent(deps, milestoneId, "capture.unknown_outcome", "platform", { part, requestId, error: err instanceof Error ? err.message : "error" });
    return;
  }

  if (!result.accepted) {
    await deps.pool.query(`UPDATE captures SET status = 'failed', paypal_capture_id = $2 WHERE paypal_request_id = $1`, [requestId, result.id]);
    await logEvent(deps, milestoneId, "capture.refused", "paypal_api", { part, reason: result.issue });
    await applyAndRun(deps, milestoneId, { type: "capture_failed", part }, "paypal_api");
    return;
  }

  await deps.pool.query(`UPDATE captures SET paypal_capture_id = $2 WHERE paypal_request_id = $1`, [requestId, result.id]);
  await logEvent(deps, milestoneId, "capture.requested", "platform", { part, requestId, paypalStatus: result.status, captureId: result.id });
  // Do NOT unlock here. The webhook (or reconcile) confirms.
}

const RECONCILE_AFTER_SECONDS = 20;

/**
 * Safety net for a lost webhook: asks PayPal what happened to each capture still marked 'requested'.
 * The replay uses the same PayPal-Request-Id, so PayPal answers with the original capture and never charges twice.
 */
export async function reconcileCaptures(deps: Deps): Promise<number> {
  const { rows } = await deps.pool.query(
    `SELECT c.milestone_id, c.part, c.paypal_request_id, c.amount_cents
       FROM captures c WHERE c.status = 'requested' AND c.created_at < now() - make_interval(secs => $1)`,
    [RECONCILE_AFTER_SECONDS],
  );
  let settled = 0;
  for (const row of rows) {
    try {
      const m = await getMilestone(deps.pool, row.milestone_id);
      if (!m?.authorizationId) continue;
      const part = row.part as 1 | 2;
      const { finalCapture } = captureInputs(m, part);
      const r = await deps.paypal.capture({
        authorizationId: m.authorizationId,
        requestId: row.paypal_request_id,
        amountCents: row.amount_cents,
        currency: m.currency,
        invoiceId: invoiceRef({ milestoneId: m.id, part }),
        finalCapture,
      });
      if (r.accepted && r.status === "COMPLETED" && r.id) {
        await applyCaptureOutcome(deps.pool, { ref: { milestoneId: m.id, part }, captureId: r.id, outcome: "confirmed", actor: "reconcile" });
        settled++;
      } else if (!r.accepted) {
        await applyCaptureOutcome(deps.pool, { ref: { milestoneId: m.id, part }, captureId: r.id ?? "none", outcome: "failed", actor: "reconcile" });
        settled++;
      }
    } catch {
      // Try again on the next tick.
    }
  }
  return settled;
}

export interface TickSummary {
  reviewDeadlines: number;
  acceptanceWindows: number;
  recoveredChecks: number;
  recoveredCaptures: number;
  reauthorized: number;
  reconciled: number;
}

async function each(ids: string[], fn: (id: string) => Promise<void>): Promise<number> {
  let n = 0;
  for (const id of ids) {
    try {
      await fn(id);
      n++;
    } catch (err) {
      if (!(err instanceof IllegalTransitionError)) console.error("tick item failed", id, err instanceof Error ? err.message : err);
    }
  }
  return n;
}

/** Deadlines, stuck work, re-authorization and reconcile. Safe to run often and from several instances. */
export async function tick(deps: Deps): Promise<TickSummary> {
  const ids = async (sql: string) => (await deps.pool.query(sql)).rows.map((r) => r.id as string);

  const reviewDeadlines = await each(
    await ids(`SELECT id FROM milestones WHERE state = 'awaiting_client_approval' AND review_deadline_at <= now()`),
    async (id) => void (await applyAndRun(deps, id, { type: "review_deadline_passed" }, "system")),
  );

  const acceptanceWindows = await each(
    await ids(`SELECT id FROM milestones WHERE state = 'acceptance_window' AND acceptance_window_ends_at <= now()`),
    async (id) => void (await applyAndRun(deps, id, { type: "acceptance_window_ended" }, "system")),
  );

  const recoveredChecks = await each(
    await ids(`SELECT id FROM milestones WHERE state IN ('verifying', 'rechecking') AND updated_at < now() - interval '2 minutes'`),
    async (id) => {
      const m = await getMilestone(deps.pool, id);
      if (!m) return;
      await executeEffects(deps, id, { from: m.state, ctx: { state: m.state, gapRounds: m.gapRounds, noReplyRule: m.noReplyRule, failedPart: m.failedPart }, effects: ["run_checks"] });
    },
  );

  const recoveredCaptures = await each(
    await ids(`SELECT m.id FROM milestones m WHERE m.state IN ('capturing_part1', 'capturing_part2') AND m.updated_at < now() - interval '30 seconds'
                AND NOT EXISTS (SELECT 1 FROM captures c WHERE c.milestone_id = m.id AND c.part = (CASE WHEN m.state = 'capturing_part1' THEN 1 ELSE 2 END) AND c.status IN ('requested', 'confirmed'))`),
    async (id) => {
      const m = await getMilestone(deps.pool, id);
      if (m) await performCapture(deps, id, m.state === "capturing_part1" ? 1 : 2);
    },
  );

  const reauthorized = await each(
    await ids(`SELECT id FROM milestones WHERE state IN ('funded', 'verifying', 'gaps_returned', 'awaiting_client_approval')
                AND paypal_authorization_id IS NOT NULL AND reauthorized_at IS NULL AND honor_until <= now()`),
    async (id) => {
      const m = await getMilestone(deps.pool, id);
      if (!m?.authorizationId) return;
      try {
        const r = await deps.paypal.reauthorize({ authorizationId: m.authorizationId, amountCents: m.amountCents, currency: m.currency, requestId: `reauth-${id}` });
        await applyMilestoneEvent(deps.pool, id, { type: "reauthorized" }, "system", async (client) => {
          await client.query(`UPDATE milestones SET reauthorized_at = now(), authorization_expires_at = coalesce($2, authorization_expires_at) WHERE id = $1`, [id, r.expiresAt]);
        });
      } catch (err) {
        // Mark it so we do not retry every tick; the screen shows the warning.
        await deps.pool.query(`UPDATE milestones SET reauthorized_at = now() WHERE id = $1`, [id]);
        await logEvent(deps, id, "reauthorize.failed", "system", { error: err instanceof PaypalError ? err.issue : err instanceof Error ? err.message : "error" });
      }
    },
  );

  const reconciled = await reconcileCaptures(deps);
  return { reviewDeadlines, acceptanceWindows, recoveredChecks, recoveredCaptures, reauthorized, reconciled };
}

