/**
 * The actions people take. Every function checks who is acting and what state the milestone is in,
 * then changes state only through the state machine (`applyAndRun`). No function here calls
 * PayPal's capture directly.
 */
import { randomUUID } from "node:crypto";
import type { Deps } from "./deps";
import {
  contractHash,
  sha256Hex,
  validateContract,
  type ContractInput,
} from "./contract";
import { applyAndRun, logEvent } from "./effects";
import { AppError } from "./errors";
import { isValidRepo, isValidSha } from "./github";
import { PaypalError } from "./paypal";
import { getMilestone, getRequirements, getSignatures, getUser, type Milestone } from "./read";

export interface Actor {
  id: string;
  role: "client" | "freelancer";
  name: string;
}

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const HONOR_PERIOD_DAYS = 3;
const MAX_HOLD_DAYS = 29;

async function mustGet(deps: Deps, id: string): Promise<Milestone> {
  const m = await getMilestone(deps.pool, id);
  if (!m) throw new AppError(404, "Milestone not found");
  return m;
}

function mustBeClient(m: Milestone, a: Actor) {
  if (a.role !== "client" || a.id !== m.clientId) throw new AppError(403, "Only the client of this job can do that");
}

function mustBeFreelancer(m: Milestone, a: Actor) {
  if (a.role !== "freelancer" || a.id !== m.freelancerId) throw new AppError(403, "Only the freelancer on this job can do that");
}

// ---------------------------------------------------------------- steps 1-2: post and sign

export async function createJob(deps: Deps, actor: Actor, input: ContractInput): Promise<string> {
  if (actor.role !== "client") throw new AppError(403, "Only clients can post jobs");
  validateContract(input);

  const client = await deps.pool.connect();
  let milestoneId: string;
  try {
    await client.query("BEGIN");
    const job = await client.query(`INSERT INTO jobs (client_id, title, description) VALUES ($1, $2, $3) RETURNING id`, [actor.id, input.title.trim(), input.description.trim()]);
    const hash = contractHash(input, 1);
    const ms = await client.query(
      `INSERT INTO milestones (job_id, title, amount_cents, currency, part1_percent, no_reply_rule, review_window_hours,
                               acceptance_window_hours, due_at, contract_version, contract_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, $10) RETURNING id`,
      [job.rows[0].id, input.title.trim(), input.amountCents, input.currency, input.part1Percent, input.noReplyRule, input.reviewWindowHours, input.acceptanceWindowHours, input.dueAt, hash],
    );
    milestoneId = ms.rows[0].id;
    for (const [i, r] of input.requirements.entries()) {
      await client.query(`INSERT INTO requirements (milestone_id, position, text, check_type, check_config) VALUES ($1, $2, $3, $4, $5)`, [milestoneId, i + 1, r.text.trim(), r.checkType, JSON.stringify(r.checkConfig)]);
    }
    // Posting is the client's signature on the final check list.
    await client.query(`INSERT INTO signatures (milestone_id, user_id, contract_version, contract_hash) VALUES ($1, $2, 1, $3)`, [milestoneId, actor.id, hash]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  await applyAndRun(deps, milestoneId, { type: "post" }, actor.name);
  await logEvent(deps, milestoneId, "contract.signed", actor.name, { role: "client", version: 1 });
  return milestoneId;
}

export async function signMilestone(deps: Deps, actor: Actor, milestoneId: string): Promise<void> {
  const m = await mustGet(deps, milestoneId);
  if (m.state !== "awaiting_signatures") throw new AppError(409, "This contract is not waiting for signatures");

  if (actor.role === "freelancer") {
    if (m.freelancerId && m.freelancerId !== actor.id) throw new AppError(409, "Another freelancer already accepted this job");
    const me = await getUser(deps.pool, actor.id);
    if (!me?.paypalPayeeEmail) throw new AppError(422, "Add your PayPal sandbox business email first, so we know where to send the money");
    await deps.pool.query(`UPDATE milestones SET freelancer_id = $2 WHERE id = $1 AND freelancer_id IS NULL`, [m.id, actor.id]);
  } else {
    mustBeClient(m, actor);
  }

  await deps.pool.query(
    `INSERT INTO signatures (milestone_id, user_id, contract_version, contract_hash) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
    [m.id, actor.id, m.contractVersion, m.contractHash],
  );
  await logEvent(deps, m.id, "contract.signed", actor.name, { role: actor.role, version: m.contractVersion, hash: m.contractHash });

  const sigs = await getSignatures(deps.pool, m.id);
  const signed = new Set(sigs.filter((s) => s.contractVersion === m.contractVersion && s.contractHash === m.contractHash).map((s) => s.userId));
  const fresh = await mustGet(deps, m.id);
  if (fresh.freelancerId && signed.has(fresh.clientId) && signed.has(fresh.freelancerId)) {
    try {
      await applyAndRun(deps, m.id, { type: "signed_by_both" }, "system");
    } catch {
      // The other signer got there first.
    }
  }
}

export async function setPayeeEmail(deps: Deps, actor: Actor, email: string): Promise<void> {
  if (actor.role !== "freelancer") throw new AppError(403, "Only freelancers receive money");
  const e = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || e.length > 200) throw new AppError(422, "That does not look like an email address");
  await deps.pool.query(`UPDATE users SET paypal_payee_email = $2 WHERE id = $1`, [actor.id, e]);
}

// ---------------------------------------------------------------- step 3: reserve funds

export async function startFunding(deps: Deps, actor: Actor, milestoneId: string): Promise<{ approveUrl: string }> {
  const m = await mustGet(deps, milestoneId);
  mustBeClient(m, actor);
  if (m.state !== "awaiting_funding" && m.state !== "capture_failed") throw new AppError(409, "This milestone is not waiting for funds");
  if (m.state === "capture_failed" && m.failedPart !== 1) throw new AppError(409, "Files are already unlocked; the remaining payment is retried by the platform");
  const freelancer = m.freelancerId ? await getUser(deps.pool, m.freelancerId) : null;
  if (!freelancer?.paypalPayeeEmail) throw new AppError(409, "The freelancer has no payout email yet");

  try {
    const order = await deps.paypal.createAuthorizeOrder({
      requestId: `order-${m.id}-${randomUUID()}`,
      referenceId: m.id,
      amountCents: m.amountCents,
      currency: m.currency,
      payeeEmail: freelancer.paypalPayeeEmail,
      description: `Proof2Pay: ${m.title}`,
      returnUrl: `${deps.appUrl}/api/paypal/return?m=${m.id}`,
      cancelUrl: `${deps.appUrl}/m/${m.id}`,
    });
    await deps.pool.query(`UPDATE milestones SET paypal_order_id = $2, updated_at = now() WHERE id = $1`, [m.id, order.orderId]);
    await logEvent(deps, m.id, "funding.order_created", actor.name, { orderId: order.orderId });
    return { approveUrl: order.approveUrl };
  } catch (err) {
    if (err instanceof PaypalError) throw new AppError(502, `PayPal could not create the reservation (${err.issue})`);
    throw err;
  }
}

/** The client came back from PayPal. Turns the approved order into the hold. */
export async function completeFunding(deps: Deps, actor: Actor, milestoneId: string, orderIdFromReturn: string): Promise<void> {
  const m = await mustGet(deps, milestoneId);
  mustBeClient(m, actor);
  if (!m.orderId || m.orderId !== orderIdFromReturn) throw new AppError(409, "That PayPal order does not belong to this milestone");
  if (m.authorizationId && m.authorizedAt && m.state !== "awaiting_funding" && m.state !== "capture_failed") return; // already done
  if (m.state !== "awaiting_funding" && m.state !== "capture_failed") throw new AppError(409, "This milestone is not waiting for funds");

  let auth;
  try {
    auth = await deps.paypal.authorizeOrder(m.orderId, `authz-${m.orderId}`);
  } catch (err) {
    if (err instanceof PaypalError) throw new AppError(502, `PayPal could not reserve the funds (${err.issue})`);
    throw err;
  }

  const freelancer = m.freelancerId ? await getUser(deps.pool, m.freelancerId) : null;
  if (auth.payeeEmail && freelancer?.paypalPayeeEmail && auth.payeeEmail.toLowerCase() !== freelancer.paypalPayeeEmail.toLowerCase()) {
    await deps.paypal.voidAuthorization(auth.authorizationId).catch(() => undefined);
    throw new AppError(409, "PayPal reserved the money for a different account than the freelancer's, so the hold was released");
  }

  const now = Date.now();
  const expires = auth.expiresAt ?? new Date(now + MAX_HOLD_DAYS * 86_400_000);
  await applyAndRun(deps, m.id, { type: "funds_authorized" }, actor.name, {}, async (client) => {
    await client.query(
      `UPDATE milestones SET paypal_authorization_id = $2, authorized_at = now(), honor_until = now() + make_interval(days => $3),
              authorization_expires_at = $4, reauthorized_at = NULL WHERE id = $1`,
      [m.id, auth.authorizationId, HONOR_PERIOD_DAYS, expires],
    );
  });
}

// ---------------------------------------------------------------- step 4: evidence

function currentRound(m: Milestone): number {
  return m.gapRounds + 1;
}

export async function uploadFile(
  deps: Deps,
  actor: Actor,
  milestoneId: string,
  file: { name: string; mime: string; bytes: Uint8Array; kind: "document" | "deliverable" },
): Promise<{ id: string; sha256: string }> {
  const m = await mustGet(deps, milestoneId);
  mustBeFreelancer(m, actor);
  if (m.state !== "funded" && m.state !== "gaps_returned") throw new AppError(409, "Files can be added once the money is reserved and before a check run");
  if (file.bytes.byteLength === 0) throw new AppError(422, "That file is empty");
  if (file.bytes.byteLength > MAX_FILE_BYTES) throw new AppError(413, "Files can be at most 10 MB");

  // Hashed before anything reads it, so a later swap is detectable.
  const sha256 = sha256Hex(file.bytes);
  const name = file.name.replace(/[^\w.\- ()]/g, "_").slice(0, 120) || "file";
  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");
    const row = await client.query(
      `INSERT INTO vault_files (milestone_id, uploaded_by, name, mime, size_bytes, sha256, data) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [m.id, actor.id, name, file.mime.slice(0, 100), file.bytes.byteLength, sha256, Buffer.from(file.bytes)],
    );
    await client.query(`INSERT INTO evidence (milestone_id, round, kind, storage_key, sha256) VALUES ($1, $2, $3, $4, $5)`, [m.id, currentRound(m), file.kind, row.rows[0].id, sha256]);
    await client.query(`INSERT INTO events (milestone_id, type, actor, data) VALUES ($1, 'evidence.file_uploaded', $2, $3)`, [m.id, actor.name, JSON.stringify({ name, sha256, bytes: file.bytes.byteLength, kind: file.kind })]);
    await client.query("COMMIT");
    return { id: row.rows[0].id, sha256 };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function submitEvidence(
  deps: Deps,
  actor: Actor,
  milestoneId: string,
  input: { liveUrl?: string; repo?: string; commit?: string },
): Promise<void> {
  const m = await mustGet(deps, milestoneId);
  mustBeFreelancer(m, actor);
  if (m.state !== "funded" && m.state !== "gaps_returned") throw new AppError(409, "Evidence can be submitted once the money is reserved");

  const liveUrl = input.liveUrl?.trim() || null;
  const repo = input.repo?.trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/, "").replace(/\/$/, "") || null;
  const commit = input.commit?.trim() || null;
  if (liveUrl) await deps.checkUrl(liveUrl); // HTTPS only, public addresses only
  if (repo && !isValidRepo(repo)) throw new AppError(422, "Repository must look like owner/name");
  if (commit && !isValidSha(commit)) throw new AppError(422, "Commit must be a 7 to 40 character hex hash");
  if (commit && !repo) throw new AppError(422, "A commit needs a repository");

  const files = await deps.pool.query(`SELECT 1 FROM vault_files WHERE milestone_id = $1 LIMIT 1`, [m.id]);
  if (!liveUrl && !repo && !files.rowCount) throw new AppError(422, "Add a live URL, a repository or a file first");

  const round = currentRound(m);
  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");
    if (liveUrl) await client.query(`INSERT INTO evidence (milestone_id, round, kind, url) VALUES ($1, $2, 'live_url', $3)`, [m.id, round, liveUrl]);
    if (repo) await client.query(`INSERT INTO evidence (milestone_id, round, kind, repo_full_name, commit_sha) VALUES ($1, $2, 'repo', $3, $4)`, [m.id, round, repo, commit]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  await applyAndRun(deps, m.id, { type: "evidence_submitted" }, actor.name);
}

// ---------------------------------------------------------------- step 8: approval gate

export async function approve(deps: Deps, actor: Actor, milestoneId: string): Promise<void> {
  const m = await mustGet(deps, milestoneId);
  mustBeClient(m, actor);
  await applyAndRun(deps, m.id, { type: "client_approved" }, actor.name);
}

export async function decline(deps: Deps, actor: Actor, milestoneId: string, failingRequirementId: string | undefined): Promise<void> {
  const m = await mustGet(deps, milestoneId);
  mustBeClient(m, actor);
  const reqs = await getRequirements(deps.pool, m.id);
  if (!failingRequirementId || !reqs.some((r) => r.id === failingRequirementId)) {
    throw new AppError(422, "Name the requirement you believe is failing. A decline needs a reason the platform can check.");
  }
  await applyAndRun(deps, m.id, { type: "client_declined", failingRequirementId }, actor.name, { focusRequirementId: failingRequirementId });
}

export async function citeFailure(deps: Deps, actor: Actor, milestoneId: string, failingRequirementId: string | undefined): Promise<void> {
  const m = await mustGet(deps, milestoneId);
  mustBeClient(m, actor);
  const reqs = await getRequirements(deps.pool, m.id);
  if (!failingRequirementId || !reqs.some((r) => r.id === failingRequirementId)) {
    throw new AppError(422, "Name the requirement that is failing");
  }
  await applyAndRun(deps, m.id, { type: "client_cited_failure", failingRequirementId }, actor.name, { focusRequirementId: failingRequirementId });
}

/** Release held funds or return them: only a named platform reviewer may do this (demo: either party can ask the platform). */
export async function resolveHold(deps: Deps, reviewer: string, milestoneId: string, release: boolean): Promise<void> {
  await applyAndRun(deps, milestoneId, { type: "human_resolved", release }, reviewer);
}

export async function cancelMilestone(deps: Deps, actor: Actor, milestoneId: string): Promise<void> {
  const m = await mustGet(deps, milestoneId);
  mustBeClient(m, actor);
  await applyAndRun(deps, m.id, { type: "cancel" }, actor.name);
}

/** Demo helper: moves the next deadline to now so the video does not wait days. Same code path as a real deadline. */
export async function fastForwardDeadline(deps: Deps, actor: Actor, milestoneId: string): Promise<void> {
  const m = await mustGet(deps, milestoneId);
  if (m.clientId !== actor.id && m.freelancerId !== actor.id) throw new AppError(403, "Not your milestone");
  if (m.state === "awaiting_client_approval") {
    await deps.pool.query(`UPDATE milestones SET review_deadline_at = now() WHERE id = $1`, [m.id]);
  } else if (m.state === "acceptance_window") {
    await deps.pool.query(`UPDATE milestones SET acceptance_window_ends_at = now() WHERE id = $1`, [m.id]);
  } else {
    throw new AppError(409, "There is no deadline to move at this stage");
  }
  await logEvent(deps, m.id, "demo.deadline_fast_forwarded", actor.name, { state: m.state });
}

