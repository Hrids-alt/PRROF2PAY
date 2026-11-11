import { createHash } from "node:crypto";
import { parseSteps } from "./browser";

export const CHECK_TYPES = ["http", "browser", "repo", "document", "needs_human"] as const;
export type CheckType = (typeof CHECK_TYPES)[number];

export interface RequirementInput {
  text: string;
  checkType: CheckType;
  checkConfig: Record<string, unknown>;
}

export class ContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractError";
  }
}

export interface ContractInput {
  title: string;
  description: string;
  amountCents: number;
  currency: string;
  part1Percent: number;
  reviewWindowHours: number;
  acceptanceWindowHours: number;
  noReplyRule: "release" | "return";
  dueAt: string | null;
  requirements: RequirementInput[];
}

/** Throws ContractError with a message that is safe to show the person. */
export function validateContract(c: ContractInput): void {
  if (!c.title.trim() || c.title.length > 140) throw new ContractError("Title is required (max 140 characters)");
  if (!Number.isInteger(c.amountCents) || c.amountCents < 100) throw new ContractError("Amount must be at least 1.00");
  if (c.amountCents > 5_000_000) throw new ContractError("Amount is too large for the sandbox demo");
  if (!/^[A-Z]{3}$/.test(c.currency)) throw new ContractError("Currency must be a 3-letter code");
  if (!Number.isInteger(c.part1Percent) || c.part1Percent < 1 || c.part1Percent > 100) {
    throw new ContractError("Part 1 percentage must be between 1 and 100");
  }
  if (!Number.isInteger(c.reviewWindowHours) || c.reviewWindowHours < 1 || c.reviewWindowHours > 24 * 14) {
    throw new ContractError("Review window must be between 1 hour and 14 days");
  }
  if (!Number.isInteger(c.acceptanceWindowHours) || c.acceptanceWindowHours < 1 || c.acceptanceWindowHours > 24 * 14) {
    throw new ContractError("Acceptance window must be between 1 hour and 14 days");
  }
  if (c.dueAt !== null && Number.isNaN(Date.parse(c.dueAt))) throw new ContractError("Due date is not a valid date");
  if (c.requirements.length < 1 || c.requirements.length > 12) {
    throw new ContractError("Add between 1 and 12 requirements");
  }
  for (const [i, r] of c.requirements.entries()) {
    if (!r.text.trim() || r.text.length > 500) throw new ContractError(`Requirement ${i + 1}: text is required (max 500 characters)`);
    if (!CHECK_TYPES.includes(r.checkType)) throw new ContractError(`Requirement ${i + 1}: unknown check type`);
  }
}

/** JSON with sorted keys, so the same contract always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** What both people sign. Changing any term, requirement or check changes the hash. */
export function contractHash(c: ContractInput, version: number): string {
  return sha256Hex(
    canonicalJson({
      version,
      title: c.title.trim(),
      description: c.description.trim(),
      amountCents: c.amountCents,
      currency: c.currency,
      part1Percent: c.part1Percent,
      reviewWindowHours: c.reviewWindowHours,
      acceptanceWindowHours: c.acceptanceWindowHours,
      noReplyRule: c.noReplyRule,
      dueAt: c.dueAt,
      requirements: c.requirements.map((r) => ({ text: r.text.trim(), checkType: r.checkType, checkConfig: r.checkConfig })),
    }),
  );
}

export function splitAmounts(totalCents: number, part1Percent: number): { part1Cents: number; part2Cents: number } {
  const part1Cents = Math.round((totalCents * part1Percent) / 100);
  return { part1Cents, part2Cents: totalCents - part1Cents };
}

/**
 * Turns vague lines into checkable requirements without a model: a fallback for when AI is not configured.
 * Anything it cannot map to a machine check becomes "needs_human", which the report says plainly.
 */
export function draftRequirementsHeuristic(lines: string[]): RequirementInput[] {
  return lines
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 12)
    .map((text) => {
      const lower = text.toLowerCase();
      if (/\b(repo|repository|github|commit|readme|license|tests?)\b/.test(lower)) {
        const files = /readme/.test(lower) ? ["README.md"] : /license/.test(lower) ? ["LICENSE"] : [];
        return { text, checkType: "repo" as const, checkConfig: files.length ? { fileExists: files } : {} };
      }
      if (/\b(page|site|website|url|endpoint|api|responds?|loads?|status|200)\b/.test(lower)) {
        return { text, checkType: "http" as const, checkConfig: { path: "/", expectStatus: 200 } };
      }
      if (/\b(document|report|pdf|doc|brief|copy|article|section|summary|write-?up)\b/.test(lower)) {
        return { text, checkType: "document" as const, checkConfig: { rubric: text } };
      }
      return { text, checkType: "needs_human" as const, checkConfig: {} };
    });
}

const strArr = (v: unknown, maxItems: number, maxLen: number): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= maxLen).slice(0, maxItems) : [];

/** Keeps only the settings each check type understands, so stored configs are always well-formed. */
export function sanitizeConfig(type: CheckType, raw: unknown): Record<string, unknown> {
  const c = (typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  switch (type) {
    case "http": {
      if (typeof c.path === "string" && c.path.startsWith("/") && c.path.length <= 200) out.path = c.path;
      if (typeof c.url === "string" && /^https:\/\//i.test(c.url) && c.url.length <= 300) out.url = c.url;
      if (typeof c.expectStatus === "number" && Number.isInteger(c.expectStatus) && c.expectStatus >= 100 && c.expectStatus <= 599) out.expectStatus = c.expectStatus;
      const contains = strArr(c.contains, 10, 100);
      const notContains = strArr(c.notContains, 10, 100);
      if (contains.length) out.contains = contains;
      if (notContains.length) out.notContains = notContains;
      return out;
    }
    case "repo": {
      const files = strArr(c.fileExists, 10, 150).filter((f) => !f.includes("..") && !f.startsWith("/"));
      if (files.length) out.fileExists = files;
      if (Array.isArray(c.fileContains)) {
        const fc = c.fileContains
          .filter((x): x is { path: string; text: string } => typeof x?.path === "string" && typeof x?.text === "string" && !x.path.includes("..") && x.text.length <= 100)
          .slice(0, 5)
          .map((x) => ({ path: x.path, text: x.text }));
        if (fc.length) out.fileContains = fc;
      }
      return out;
    }
    case "document":
      if (typeof c.rubric === "string" && c.rubric.trim()) out.rubric = c.rubric.trim().slice(0, 500);
      return out;
    case "browser": {
      const steps = parseSteps(c.steps);
      if (steps) out.steps = steps;
      return out;
    }
    default:
      return out;
  }
}
