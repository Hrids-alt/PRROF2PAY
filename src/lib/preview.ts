/**
 * Step 8: the view-only preview. A signed link that expires in minutes, is claimed by the first
 * browser that opens it, and is tied to the signed-in client. Every open and view is logged.
 *
 * Honest limit: a client can still photograph or record the screen. The preview, the watermark
 * and the view log are a deterrent and evidence. The real protection is that full files unlock
 * only after PayPal confirms capture 1.
 */
import type { Deps } from "./deps";
import { logEvent } from "./effects";
import { AppError } from "./errors";
import { getMilestone, type Milestone } from "./read";
import type { Actor } from "./service";
import { newSessionId, signToken, verifyToken } from "./tokens";

export const PREVIEW_COOKIE = "p2p_pv";
export const LINK_MINUTES = 5;
export const SESSION_MINUTES = 30;

export async function createPreviewLink(deps: Deps, actor: Actor, milestoneId: string): Promise<{ path: string; expiresAt: Date }> {
  const m = await getMilestone(deps.pool, milestoneId);
  if (!m) throw new AppError(404, "Milestone not found");
  if (actor.role !== "client" || actor.id !== m.clientId) throw new AppError(403, "Only the client can open the preview");
  if (m.state !== "awaiting_client_approval") throw new AppError(409, "The preview is available while you are deciding whether to approve");

  const sid = newSessionId();
  await deps.pool.query(`INSERT INTO preview_sessions (sid, milestone_id, user_id) VALUES ($1, $2, $3)`, [sid, m.id, actor.id]);
  const exp = Math.floor(Date.now() / 1000) + LINK_MINUTES * 60;
  const token = signToken({ m: m.id, u: actor.id, s: sid, exp });
  await logEvent(deps, m.id, "preview.link_created", actor.name, { sid });
  return { path: `/api/preview/open?t=${encodeURIComponent(token)}`, expiresAt: new Date(exp * 1000) };
}

export interface OpenResult {
  milestoneId: string;
  sid: string;
  /** True when this browser just claimed the link and should receive the session cookie. */
  claimed: boolean;
}

export async function openPreview(deps: Deps, actor: Actor, token: string, cookieSid: string | undefined): Promise<OpenResult> {
  const p = verifyToken<{ m: string; u: string; s: string }>(token);
  if (!p) throw new AppError(403, "This preview link has expired. Open the milestone and ask for a new one.");
  if (p.u !== actor.id) throw new AppError(403, "This link was made for a different person");

  const claim = await deps.pool.query(`UPDATE preview_sessions SET claimed_at = now() WHERE sid = $1 AND user_id = $2 AND claimed_at IS NULL`, [p.s, actor.id]);
  if (claim.rowCount === 1) {
    await logEvent(deps, p.m, "preview.opened", actor.name, { sid: p.s });
    return { milestoneId: p.m, sid: p.s, claimed: true };
  }
  if (cookieSid === p.s) return { milestoneId: p.m, sid: p.s, claimed: false };
  await logEvent(deps, p.m, "preview.second_session_refused", actor.name, { sid: p.s });
  throw new AppError(403, "This preview link is already open in another session. Ask for a new link.");
}

export interface PreviewSession {
  sid: string;
  milestone: Milestone;
}

/** Validates the cookie session for the preview page and the heartbeat. Returns null when not allowed. */
export async function loadPreviewSession(deps: Deps, actor: Actor, sid: string | undefined, milestoneId: string): Promise<PreviewSession | null> {
  if (!sid) return null;
  const { rows } = await deps.pool.query(
    `SELECT 1 FROM preview_sessions WHERE sid = $1 AND milestone_id = $2 AND user_id = $3 AND claimed_at > now() - make_interval(mins => $4)`,
    [sid, milestoneId, actor.id, SESSION_MINUTES],
  );
  if (!rows[0]) return null;
  const m = await getMilestone(deps.pool, milestoneId);
  if (!m || m.state !== "awaiting_client_approval") return null;
  return { sid, milestone: m };
}

export async function logPreviewView(deps: Deps, actor: Actor, milestoneId: string, data: { sid: string; section: string; seconds: number }): Promise<void> {
  const seconds = Math.max(0, Math.min(3600, Math.round(data.seconds)));
  await logEvent(deps, milestoneId, "preview.viewed", actor.name, { sid: data.sid, section: data.section.slice(0, 60), seconds });
}
