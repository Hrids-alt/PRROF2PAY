import type { Pool } from "pg";
import { applyMilestoneEvent } from "./milestoneRepo";
import { IllegalTransitionError } from "./stateMachine";
import type { WebhookStore } from "./webhook";

export function createPgWebhookStore(pool: Pool): WebhookStore {
  return {
    async begin(eventId, eventType, payload) {
      const inserted = await pool.query(
        `INSERT INTO webhook_events (paypal_event_id, event_type, payload)
         VALUES ($1, $2, $3) ON CONFLICT (paypal_event_id) DO NOTHING RETURNING paypal_event_id`,
        [eventId, eventType, JSON.stringify(payload)],
      );
      if (inserted.rowCount === 1) return "new";
      const seen = await pool.query<{ processed_at: Date | null }>(
        `SELECT processed_at FROM webhook_events WHERE paypal_event_id = $1`,
        [eventId],
      );
      return seen.rows[0]?.processed_at ? "duplicate" : "retry";
    },

    async markProcessed(eventId) {
      await pool.query(
        `UPDATE webhook_events SET processed_at = now() WHERE paypal_event_id = $1 AND processed_at IS NULL`,
        [eventId],
      );
    },

    async applyCapture({ eventId, ref, captureId, outcome }) {
      const markDone = (client: { query: Pool["query"] }) =>
        client.query(`UPDATE webhook_events SET processed_at = now() WHERE paypal_event_id = $1`, [eventId]);

      try {
        await applyMilestoneEvent(
          pool,
          ref.milestoneId,
          outcome === "confirmed" ? { type: "capture_confirmed", part: ref.part } : { type: "capture_failed", part: ref.part },
          "paypal_webhook",
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
        // The milestone already moved on (for example a duplicate that slipped past `begin`).
        if (err instanceof IllegalTransitionError) {
          await markDone(pool);
          return "ignored";
        }
        throw err;
      }
    },
  };
}
