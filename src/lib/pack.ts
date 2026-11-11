/** Step 13: the Evidence Pack. Everything that happened, with a hash over the whole thing. */
import type { Deps } from "./deps";
import { canonicalJson, sha256Hex } from "./contract";
import { getCaptures, getEvents, getEvidence, getFiles, getMilestone, getRequirements, getSignatures } from "./read";

export async function buildEvidencePack(deps: Deps, milestoneId: string): Promise<Record<string, unknown> | null> {
  const m = await getMilestone(deps.pool, milestoneId);
  if (!m) return null;
  const [requirements, signatures, evidence, files, captures, events] = await Promise.all([
    getRequirements(deps.pool, m.id),
    getSignatures(deps.pool, m.id),
    getEvidence(deps.pool, m.id),
    getFiles(deps.pool, m.id),
    getCaptures(deps.pool, m.id),
    getEvents(deps.pool, m.id),
  ]);
  const verdicts = (await deps.pool.query(`SELECT requirement_id, round, verdict, proof, evidence_hash, created_at FROM verdicts WHERE milestone_id = $1 ORDER BY round, created_at`, [m.id])).rows;
  const names = new Map((await deps.pool.query(`SELECT id, display_name, role FROM users WHERE id = ANY($1)`, [[m.clientId, m.freelancerId].filter(Boolean)])).rows.map((r) => [r.id, `${r.display_name} (${r.role})`]));

  const body = {
    notice:
      "Generated from the platform event log. Wording: evidence appears to show; it does not prove. PayPal holds the authorization and moves the money; Proof2Pay does not hold funds. Sandbox demo, not legal advice.",
    milestone: {
      id: m.id, title: m.title, description: m.description, state: m.state, amountCents: m.amountCents, currency: m.currency,
      part1Percent: m.part1Percent, noReplyRule: m.noReplyRule, contractVersion: m.contractVersion, contractHash: m.contractHash,
      vaultUnlockedAt: m.vaultUnlockedAt, client: names.get(m.clientId) ?? m.clientId, freelancer: m.freelancerId ? names.get(m.freelancerId) ?? m.freelancerId : null,
    },
    requirements,
    signatures: signatures.map((s) => ({ ...s, signer: names.get(s.userId) ?? s.userId })),
    evidence,
    files: files.map((f) => ({ name: f.name, sha256: f.sha256, sizeBytes: f.sizeBytes, uploadedAt: f.createdAt })),
    verdicts,
    captures,
    events,
  };
  return { ...body, packSha256: sha256Hex(canonicalJson(JSON.parse(JSON.stringify(body)))) };
}
