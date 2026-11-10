/**
 * Runs every requirement of a milestone against the current evidence and stores one verdict
 * per requirement. This function only produces verdicts: it cannot move money. The caller turns
 * the outcome into a `verification_finished` event, which can only lead to the client approval gate.
 */
import type { Deps } from "./deps";
import { canonicalJson, sha256Hex } from "./contract";
import { runCheck, type VaultText } from "./checks";
import type { Verdict } from "./judge";
import { getRequirements } from "./read";

const TEXT_EXT = /\.(md|txt|csv|json|html?|xml|css|js|ts|py|yml|yaml)$/i;
const MAX_TEXT_BYTES = 200_000;

export function isTextFile(name: string, mime: string): boolean {
  return mime.startsWith("text/") || mime === "application/json" || mime === "application/xml" || TEXT_EXT.test(name);
}

export interface VerificationResult {
  requirementId: string;
  verdict: Verdict;
  proof: Record<string, unknown>;
  cached: boolean;
}

export interface VerificationOutcome {
  round: number;
  allVerified: boolean;
  results: VerificationResult[];
}

export async function loadEvidenceForChecks(deps: Deps, milestoneId: string) {
  const ev = await deps.pool.query(
    `SELECT kind, url, repo_full_name, commit_sha FROM evidence
      WHERE milestone_id = $1 AND kind IN ('live_url', 'repo') ORDER BY round, created_at`,
    [milestoneId],
  );
  let liveUrl: string | null = null;
  let repo: { fullName: string; commitSha: string | null } | null = null;
  for (const r of ev.rows) {
    if (r.kind === "live_url") liveUrl = r.url;
    if (r.kind === "repo") repo = { fullName: r.repo_full_name, commitSha: r.commit_sha };
  }

  const fileRows = await deps.pool.query(
    `SELECT id, name, mime, sha256, data FROM vault_files WHERE milestone_id = $1 ORDER BY created_at`,
    [milestoneId],
  );
  // A later upload with the same name replaces the earlier one.
  const byName = new Map<string, VaultText>();
  for (const f of fileRows.rows) {
    const data = f.data as Buffer;
    byName.set(f.name, {
      id: f.id,
      name: f.name,
      mime: f.mime,
      sha256: f.sha256,
      text: isTextFile(f.name, f.mime) ? data.subarray(0, MAX_TEXT_BYTES).toString("utf8") : null,
    });
  }
  return { liveUrl, repo, files: [...byName.values()] };
}

export async function runVerification(deps: Deps, milestoneId: string, opts: { fresh: boolean }): Promise<VerificationOutcome> {
  const requirements = await getRequirements(deps.pool, milestoneId);
  const evidence = await loadEvidenceForChecks(deps, milestoneId);
  const round = Number((await deps.pool.query(`SELECT coalesce(max(round), 0) + 1 AS n FROM verdicts WHERE milestone_id = $1`, [milestoneId])).rows[0].n);

  const results: VerificationResult[] = [];
  for (const req of requirements) {
    const evidenceHash = sha256Hex(
      canonicalJson({
        requirement: req.text,
        type: req.checkType,
        config: req.checkConfig,
        liveUrl: evidence.liveUrl,
        repo: evidence.repo,
        files: evidence.files.map((f) => ({ name: f.name, sha256: f.sha256 })),
      }),
    );

    // Only document verdicts are cached: they are the expensive AI calls and depend only on file hashes.
    // Live URLs and repos can change between runs, so those checks always run again.
    let cachedHit: { verdict: Verdict; proof: Record<string, unknown> } | null = null;
    if (!opts.fresh && req.checkType === "document") {
      const hit = await deps.pool.query(
        `SELECT verdict, proof FROM verdicts WHERE requirement_id = $1 AND evidence_hash = $2 AND verdict IN ('verified', 'failed')
          ORDER BY created_at DESC LIMIT 1`,
        [req.id, evidenceHash],
      );
      if (hit.rows[0]) cachedHit = { verdict: hit.rows[0].verdict, proof: hit.rows[0].proof };
    }

    const outcome =
      cachedHit ??
      (await runCheck(req.checkType, req.checkConfig, req.text, {
        liveUrl: evidence.liveUrl,
        repo: evidence.repo,
        files: evidence.files,
        fetcher: deps.fetcher,
        github: deps.github,
        judge: deps.judge,
        browser: deps.browser,
      }));

    const proof = cachedHit ? { ...outcome.proof, cached: true } : outcome.proof;
    await deps.pool.query(
      `INSERT INTO verdicts (milestone_id, requirement_id, round, verdict, proof, evidence_hash) VALUES ($1, $2, $3, $4, $5, $6)`,
      [milestoneId, req.id, round, outcome.verdict, JSON.stringify(proof), evidenceHash],
    );
    results.push({ requirementId: req.id, verdict: outcome.verdict, proof, cached: cachedHit !== null });
  }

  const allVerified = results.length > 0 && results.every((r) => r.verdict === "verified");
  await deps.pool.query(`INSERT INTO events (milestone_id, type, actor, data) VALUES ($1, 'verification.finished', 'platform', $2)`, [
    milestoneId,
    JSON.stringify({ round, allVerified, verdicts: results.map((r) => ({ requirementId: r.requirementId, verdict: r.verdict, cached: r.cached })) }),
  ]);
  return { round, allVerified, results };
}
