/**
 * The one place a capture result changes a milestone. Used by the webhook handler (primary)
 * and by the reconcile poller (safety net for a lost webhook). Both read PayPal's own word
 * that a capture completed or was denied; neither trusts the freelancer or the client.
 */
import type { Pool } from "pg";
import { applyMilestoneEvent } from "./milestoneRepo";
import { IllegalTransitionError } from "./stateMachine";
import type { CaptureOutcome, CaptureRef } from "./webhook";

export async function applyCaptureOutcome(
  pool: Pool,
  args: { ref: CaptureRef; captureId: string; outcome: CaptureOutcome; actor: string; eventId?: string },
): Promise<"applied" | "ignored"> {
  const { ref, captureId, outcome, actor, eventId } = args;
  const markDone = async (q: { query: Pool["query"] }) => {
    if (eventId) await q.query(`UPDATE webhook_events SET processed_at = now() WHERE paypal_event_id = $1`, [eventId]);
  };
  try {
    await applyMilestoneEvent(
      pool,
      ref.milestoneId,
      outcome === "confirmed" ? { type: "capture_confirmed", part: ref.part } : { type: "capture_failed", part: ref.part },
      actor,
      async (client) => {
        await client.query(
          `UPDATE captures
              SET status = $3, paypal_capture_id = $4,
                  confirmed_at = CASE WHEN $3 = 'confirmed' THEN now() ELSE confirmed_at END
            WHERE milestone_id = $1 AND part = $2 AND status = 'requested'`,
          [ref.milestoneId, ref.part, outcome, captureId],
        );
        await markDone(client);
      },
    );
    return "applied";
  } catch (err) {
    if (err instanceof IllegalTransitionError) {
      await markDone(pool);
      return "ignored";
    }
    throw err;
  }
}
