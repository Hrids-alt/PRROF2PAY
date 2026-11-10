/**
 * The check runner. Each requirement has a check type; this file turns one requirement plus the
 * evidence into one verdict with the proof used. Runs from our side: HTTP from our servers
 * (SSRF-guarded), repo facts from the GitHub API, documents through the AI judge after the
 * hidden-instruction filter. Submitted code is never run.
 */
import { parseSteps, type BrowserRunner } from "./browser";
import { scanEvidence } from "./evidenceFilter";
import type { GithubClient } from "./github";
import type { Judge, Verdict } from "./judge";
import type { SafeFetchResult } from "./ssrf";
import type { CheckType } from "./contract";

export interface VaultText {
  id: string;
  name: string;
  mime: string;
  sha256: string;
  /** null when the file is not readable text. */
  text: string | null;
}

export interface CheckContext {
  liveUrl: string | null;
  repo: { fullName: string; commitSha: string | null } | null;
  files: VaultText[];
  fetcher: (url: string) => Promise<SafeFetchResult>;
  github: GithubClient;
  judge: Judge;
  browser: BrowserRunner | null;
}

export interface CheckResult {
  verdict: Verdict;
  proof: Record<string, unknown>;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

async function httpCheck(config: Record<string, unknown>, ctx: CheckContext): Promise<CheckResult> {
  const explicit = typeof config.url === "string" ? config.url : null;
  if (!ctx.liveUrl && !explicit) return { verdict: "not_demonstrated", proof: { note: "No live URL was submitted" } };
  let target: string;
  try {
    target = explicit ?? new URL(typeof config.path === "string" ? config.path : "/", ctx.liveUrl as string).toString();
  } catch {
    return { verdict: "failed", proof: { note: "The check's path is not valid" } };
  }
  const expectStatus = typeof config.expectStatus === "number" ? config.expectStatus : 200;
  try {
    const res = await ctx.fetcher(target);
    const body = new TextDecoder().decode(res.body);
    const contains = strings(config.contains);
    const notContains = strings(config.notContains);
    const missing = contains.filter((c) => !body.includes(c));
    const forbidden = notContains.filter((c) => body.includes(c));
    const ok = res.status === expectStatus && missing.length === 0 && forbidden.length === 0;
    return {
      verdict: ok ? "verified" : "failed",
      proof: { url: res.finalUrl, status: res.status, expectedStatus: expectStatus, missing, forbidden, bytes: res.body.byteLength },
    };
  } catch (err) {
    return { verdict: "failed", proof: { url: target, error: err instanceof Error ? err.message : "request failed" } };
  }
}

async function repoCheck(config: Record<string, unknown>, ctx: CheckContext): Promise<CheckResult> {
  if (!ctx.repo) return { verdict: "not_demonstrated", proof: { note: "No repository was submitted" } };
  const { fullName, commitSha } = ctx.repo;
  const proof: Record<string, unknown> = { repo: fullName, commit: commitSha };

  if (commitSha) {
    const exists = await ctx.github.commitExists(fullName, commitSha);
    proof.commitExists = exists;
    if (!exists) return { verdict: "failed", proof };
  }

  const files = strings(config.fileExists);
  const missing: string[] = [];
  for (const f of files) {
    if (!(await ctx.github.getFile(fullName, f, commitSha)).exists) missing.push(f);
  }
  const contains = Array.isArray(config.fileContains) ? (config.fileContains as Array<{ path?: unknown; text?: unknown }>) : [];
  const lacking: string[] = [];
  for (const c of contains) {
    if (typeof c.path !== "string" || typeof c.text !== "string") continue;
    const f = await ctx.github.getFile(fullName, c.path, commitSha);
    if (!f.exists || !f.text?.includes(c.text)) lacking.push(`${c.path} lacks "${c.text}"`);
  }
  proof.filesChecked = files;
  proof.missing = missing;
  proof.lacking = lacking;
  if (!commitSha && files.length === 0 && contains.length === 0) {
    return { verdict: "needs_human", proof: { ...proof, note: "The check names nothing to look for and no commit was given" } };
  }
  return { verdict: missing.length === 0 && lacking.length === 0 ? "verified" : "failed", proof };
}

async function documentCheck(requirement: string, config: Record<string, unknown>, ctx: CheckContext): Promise<CheckResult> {
  if (ctx.files.length === 0) return { verdict: "not_demonstrated", proof: { note: "No document was uploaded" } };
  const readable = ctx.files.filter((f) => f.text !== null);
  if (readable.length === 0) {
    return {
      verdict: "needs_human",
      proof: { note: "The uploaded files are not readable text, so the AI cannot judge them", files: ctx.files.map((f) => ({ name: f.name, sha256: f.sha256 })) },
    };
  }

  const flagged = readable
    .map((f) => ({ name: f.name, sha256: f.sha256, ...scanEvidence(f.text as string) }))
    .filter((f) => f.flagged);
  if (flagged.length > 0) {
    return {
      verdict: "needs_human",
      proof: {
        flaggedForHiddenInstructions: flagged.map((f) => ({ file: f.name, sha256: f.sha256, findings: f.findings })),
        note: "The document appears to contain instructions aimed at the verifier. It was not sent to the AI. A person must review it.",
      },
    };
  }

  const rubric = typeof config.rubric === "string" && config.rubric ? config.rubric : requirement;
  const evidenceText = readable.map((f) => `--- ${f.name} ---\n${f.text}`).join("\n\n");
  const out = await ctx.judge({ requirement, rubric, evidenceName: readable.map((f) => f.name).join(", "), evidenceText });
  return {
    verdict: out.verdict,
    proof: { explanation: out.proof, quote: out.quote, files: readable.map((f) => ({ name: f.name, sha256: f.sha256 })) },
  };
}

async function browserCheck(config: Record<string, unknown>, ctx: CheckContext): Promise<CheckResult> {
  if (!ctx.liveUrl) return { verdict: "not_demonstrated", proof: { note: "No live URL was submitted" } };
  const steps = parseSteps(config.steps);
  if (!steps) return { verdict: "needs_human", proof: { note: "The browser steps in this check are missing or invalid" } };
  if (!ctx.browser) return { verdict: "needs_human", proof: { note: "The cloud browser is not configured on this server" } };
  const r = await ctx.browser.run(ctx.liveUrl, steps);
  return { verdict: r.ok ? "verified" : "failed", proof: { log: r.log, failedStep: r.failedStep, reason: r.reason } };
}

export async function runCheck(
  checkType: CheckType,
  config: Record<string, unknown>,
  requirement: string,
  ctx: CheckContext,
): Promise<CheckResult> {
  try {
    switch (checkType) {
      case "http":
        return await httpCheck(config, ctx);
      case "repo":
        return await repoCheck(config, ctx);
      case "document":
        return await documentCheck(requirement, config, ctx);
      case "browser":
        return await browserCheck(config, ctx);
      case "needs_human":
        return { verdict: "needs_human", proof: { note: "No machine check exists for this requirement, so a person must review it" } };
    }
  } catch (err) {
    // A crashing check must never read as a pass.
    return { verdict: "needs_human", proof: { note: "The check could not run", error: err instanceof Error ? err.message : "unknown error" } };
  }
}
