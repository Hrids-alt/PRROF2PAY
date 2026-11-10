import type { Pool } from "pg";
import { applyCaptureOutcome } from "./captureOutcome";
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

    applyCapture({ eventId, ref, captureId, outcome }) {
      return applyCaptureOutcome(pool, { ref, captureId, outcome, actor: "paypal_webhook", eventId });
    },
  };
}
