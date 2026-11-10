/** Read models: what the screens and the Evidence Pack show. */
import type { Pool } from "pg";
import type { CheckType } from "./contract";
import { isVaultUnlocked, type MilestoneState, type NoReplyRule } from "./stateMachine";
import type { Verdict } from "./judge";

type Q = Pick<Pool, "query">;

export interface Milestone {
  id: string;
  jobId: string;
  clientId: string;
  freelancerId: string | null;
  title: string;
  description: string;
  amountCents: number;
  currency: string;
  part1Percent: number;
  state: MilestoneState;
  gapRounds: number;
  noReplyRule: NoReplyRule;
  failedPart: 1 | 2 | null;
  reviewWindowHours: number;
  acceptanceWindowHours: number;
  reviewDeadlineAt: Date | null;
  acceptanceWindowEndsAt: Date | null;
  dueAt: Date | null;
  orderId: string | null;
  authorizationId: string | null;
  authorizedAt: Date | null;
  honorUntil: Date | null;
  authorizationExpiresAt: Date | null;
  reauthorizedAt: Date | null;
  contractVersion: number;
  contractHash: string | null;
  vaultUnlockedAt: Date | null;
  updatedAt: Date;
  createdAt: Date;
}

export async function getMilestone(q: Q, id: string): Promise<Milestone | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { rows } = await q.query(
    `SELECT m.*, j.client_id, j.description AS job_description
       FROM milestones m JOIN jobs j ON j.id = m.job_id WHERE m.id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    jobId: r.job_id,
    clientId: r.client_id,
    freelancerId: r.freelancer_id,
    title: r.title,
    description: r.job_description,
    amountCents: r.amount_cents,
    currency: r.currency.trim(),
    part1Percent: r.part1_percent,
    state: r.state,
    gapRounds: r.gap_rounds,
    noReplyRule: r.no_reply_rule,
    failedPart: r.failed_part,
    reviewWindowHours: r.review_window_hours,
    acceptanceWindowHours: r.acceptance_window_hours,
    reviewDeadlineAt: r.review_deadline_at,
    acceptanceWindowEndsAt: r.acceptance_window_ends_at,
    dueAt: r.due_at,
    orderId: r.paypal_order_id,
    authorizationId: r.paypal_authorization_id,
    authorizedAt: r.authorized_at,
    honorUntil: r.honor_until,
    authorizationExpiresAt: r.authorization_expires_at,
    reauthorizedAt: r.reauthorized_at,
    contractVersion: r.contract_version,
    contractHash: r.contract_hash,
    vaultUnlockedAt: r.vault_unlocked_at,
    updatedAt: r.updated_at,
    createdAt: r.created_at,
  };
}

/** Both checks: the state machine says unlocked AND a webhook-confirmed unlock was recorded. */
export function filesUnlocked(m: Milestone): boolean {
  return m.vaultUnlockedAt !== null && isVaultUnlocked({ state: m.state, gapRounds: m.gapRounds, noReplyRule: m.noReplyRule, failedPart: m.failedPart });
}

export interface RequirementRow {
  id: string;
  position: number;
  text: string;
  checkType: CheckType;
  checkConfig: Record<string, unknown>;
}

export async function getRequirements(q: Q, milestoneId: string): Promise<RequirementRow[]> {
  const { rows } = await q.query(
    `SELECT id, position, text, check_type, check_config FROM requirements WHERE milestone_id = $1 ORDER BY position`,
    [milestoneId],
  );
  return rows.map((r) => ({ id: r.id, position: r.position, text: r.text, checkType: r.check_type, checkConfig: r.check_config }));
}

export interface VerdictRow {
  requirementId: string;
  round: number;
  verdict: Verdict;
  proof: Record<string, unknown>;
  createdAt: Date;
}

/** The verdicts of the most recent verification run. */
export async function getLatestVerdicts(q: Q, milestoneId: string): Promise<VerdictRow[]> {
  const { rows } = await q.query(
    `SELECT requirement_id, round, verdict, proof, created_at FROM verdicts
      WHERE milestone_id = $1 AND round = (SELECT max(round) FROM verdicts WHERE milestone_id = $1)`,
    [milestoneId],
  );
  return rows.map((r) => ({ requirementId: r.requirement_id, round: r.round, verdict: r.verdict, proof: r.proof, createdAt: r.created_at }));
}

export interface EventRow {
  id: number;
  type: string;
  actor: string;
  data: Record<string, unknown>;
  createdAt: Date;
}

export async function getEvents(q: Q, milestoneId: string): Promise<EventRow[]> {
  const { rows } = await q.query(`SELECT id, type, actor, data, created_at FROM events WHERE milestone_id = $1 ORDER BY id`, [milestoneId]);
  return rows.map((r) => ({ id: Number(r.id), type: r.type, actor: r.actor, data: r.data, createdAt: r.created_at }));
}

export interface FileRow {
  id: string;
  name: string;
  mime: string;
  sizeBytes: number;
  sha256: string;
  createdAt: Date;
}

export async function getFiles(q: Q, milestoneId: string): Promise<FileRow[]> {
  const { rows } = await q.query(
    `SELECT id, name, mime, size_bytes, sha256, created_at FROM vault_files WHERE milestone_id = $1 ORDER BY created_at`,
    [milestoneId],
  );
  return rows.map((r) => ({ id: r.id, name: r.name, mime: r.mime, sizeBytes: r.size_bytes, sha256: r.sha256, createdAt: r.created_at }));
}

export interface EvidenceRow {
  id: string;
  round: number;
  kind: string;
  url: string | null;
  repoFullName: string | null;
  commitSha: string | null;
  sha256: string | null;
  createdAt: Date;
}

export async function getEvidence(q: Q, milestoneId: string): Promise<EvidenceRow[]> {
  const { rows } = await q.query(
    `SELECT id, round, kind, url, repo_full_name, commit_sha, sha256, created_at FROM evidence WHERE milestone_id = $1 ORDER BY round, created_at`,
    [milestoneId],
  );
  return rows.map((r) => ({ id: r.id, round: r.round, kind: r.kind, url: r.url, repoFullName: r.repo_full_name, commitSha: r.commit_sha, sha256: r.sha256, createdAt: r.created_at }));
}

export interface CaptureRow {
  id: string;
  part: 1 | 2;
  amountCents: number;
  status: "requested" | "confirmed" | "failed";
  paypalCaptureId: string | null;
  createdAt: Date;
  confirmedAt: Date | null;
}

export async function getCaptures(q: Q, milestoneId: string): Promise<CaptureRow[]> {
  const { rows } = await q.query(
    `SELECT id, part, amount_cents, status, paypal_capture_id, created_at, confirmed_at FROM captures WHERE milestone_id = $1 ORDER BY created_at`,
    [milestoneId],
  );
  return rows.map((r) => ({ id: r.id, part: r.part, amountCents: r.amount_cents, status: r.status, paypalCaptureId: r.paypal_capture_id, createdAt: r.created_at, confirmedAt: r.confirmed_at }));
}

export interface SignatureRow {
  userId: string;
  contractVersion: number;
  contractHash: string;
  signedAt: Date;
}

export async function getSignatures(q: Q, milestoneId: string): Promise<SignatureRow[]> {
  const { rows } = await q.query(
    `SELECT user_id, contract_version, contract_hash, signed_at FROM signatures WHERE milestone_id = $1 ORDER BY signed_at`,
    [milestoneId],
  );
  return rows.map((r) => ({ userId: r.user_id, contractVersion: r.contract_version, contractHash: r.contract_hash, signedAt: r.signed_at }));
}

export interface UserRow {
  id: string;
  email: string;
  displayName: string;
  role: "client" | "freelancer";
  paypalPayeeEmail: string | null;
}

export async function getUser(q: Q, id: string): Promise<UserRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { rows } = await q.query(`SELECT id, email, display_name, role, paypal_payee_email FROM users WHERE id = $1`, [id]);
  const r = rows[0];
  return r ? { id: r.id, email: r.email, displayName: r.display_name, role: r.role, paypalPayeeEmail: r.paypal_payee_email } : null;
}

export async function listUsers(q: Q): Promise<UserRow[]> {
  const { rows } = await q.query(`SELECT id, email, display_name, role, paypal_payee_email FROM users ORDER BY role, display_name`);
  return rows.map((r) => ({ id: r.id, email: r.email, displayName: r.display_name, role: r.role, paypalPayeeEmail: r.paypal_payee_email }));
}

export interface BoardRow {
  id: string;
  title: string;
  amountCents: number;
  currency: string;
  state: MilestoneState;
  clientName: string;
  freelancerId: string | null;
  clientId: string;
  createdAt: Date;
}

export async function listBoard(q: Q): Promise<BoardRow[]> {
  const { rows } = await q.query(
    `SELECT m.id, m.title, m.amount_cents, m.currency, m.state, m.freelancer_id, m.created_at, j.client_id, u.display_name AS client_name
       FROM milestones m JOIN jobs j ON j.id = m.job_id JOIN users u ON u.id = j.client_id
      ORDER BY m.created_at DESC LIMIT 100`,
  );
  return rows.map((r) => ({
    id: r.id, title: r.title, amountCents: r.amount_cents, currency: r.currency.trim(), state: r.state,
    clientName: r.client_name, freelancerId: r.freelancer_id, clientId: r.client_id, createdAt: r.created_at,
  }));
}

/** Counts come from the event log and closed milestones, never from ratings typed by a person. */
export interface Reputation {
  closedMilestones: number;
  firstTimeVerified: number;
  declines: number;
  disputes: number;
  enoughHistory: boolean;
}

export async function getReputation(q: Q, userId: string): Promise<Reputation> {
  const { rows } = await q.query(
    `WITH mine AS (
       SELECT m.id, m.state FROM milestones m JOIN jobs j ON j.id = m.job_id
        WHERE m.freelancer_id = $1 OR j.client_id = $1)
     SELECT
       (SELECT count(*) FROM mine WHERE state = 'closed') AS closed,
       (SELECT count(*) FROM mine m WHERE state = 'closed' AND NOT EXISTS
          (SELECT 1 FROM events e WHERE e.milestone_id = m.id AND e.type = 'milestone.client_declined')
        AND (SELECT gap_rounds FROM milestones WHERE id = m.id) = 0) AS first_time,
       (SELECT count(*) FROM events e JOIN mine ON mine.id = e.milestone_id WHERE e.type = 'milestone.client_declined') AS declines,
       (SELECT count(*) FROM events e JOIN mine ON mine.id = e.milestone_id WHERE e.type = 'milestone.client_cited_failure') AS disputes`,
    [userId],
  );
  const r = rows[0];
  const closed = Number(r.closed);
  return { closedMilestones: closed, firstTimeVerified: Number(r.first_time), declines: Number(r.declines), disputes: Number(r.disputes), enoughHistory: closed >= 3 };
}
