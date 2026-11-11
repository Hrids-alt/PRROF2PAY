import type { MilestoneState } from "./stateMachine";

export const fmtMoney = (cents: number, currency = "USD") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);

export const fmtDate = (d: Date | string | null) =>
  d ? new Date(d).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC" : "—";

export const STATE_LABEL: Record<MilestoneState, string> = {
  draft: "Draft",
  awaiting_signatures: "Waiting for signatures",
  awaiting_funding: "Waiting for the client to reserve funds",
  funded: "Funds reserved: ready for evidence",
  verifying: "Checks running",
  gaps_returned: "Gaps sent back to the freelancer",
  failed_verification: "Not verified after 3 rounds",
  awaiting_client_approval: "Work verified: waiting for client approval",
  capturing_part1: "Collecting part 1: waiting for PayPal to confirm",
  capture_failed: "Payment failed",
  acceptance_window: "Acceptance window: files unlocked",
  rechecking: "Fresh check running",
  held_for_review: "Held for review",
  capturing_part2: "Collecting part 2: waiting for PayPal to confirm",
  closed: "Closed",
  cancelled: "Cancelled",
};

const STEPS = ["Post", "Sign", "Reserve", "Evidence", "Verify", "Approve", "Part 1", "Unlock", "Window", "Part 2", "Closed"];
export const STEP_NAMES = STEPS;

/** Index of the step the milestone is on, for the progress bar. */
export function stepIndex(s: MilestoneState): number {
  switch (s) {
    case "draft": return 0;
    case "awaiting_signatures": return 1;
    case "awaiting_funding": return 2;
    case "funded":
    case "gaps_returned": return 3;
    case "verifying":
    case "failed_verification": return 4;
    case "awaiting_client_approval": return 5;
    case "capturing_part1":
    case "capture_failed": return 6;
    case "acceptance_window":
    case "rechecking":
    case "held_for_review": return 8;
    case "capturing_part2": return 9;
    case "closed": return 10;
    case "cancelled": return -1;
  }
}

export const STATE_TONE: Partial<Record<MilestoneState, string>> = {
  closed: "bg-emerald-100 text-emerald-800",
  cancelled: "bg-zinc-200 text-zinc-700",
  capture_failed: "bg-red-100 text-red-800",
  failed_verification: "bg-red-100 text-red-800",
  held_for_review: "bg-amber-100 text-amber-800",
  awaiting_client_approval: "bg-indigo-100 text-indigo-800",
  acceptance_window: "bg-emerald-100 text-emerald-800",
};
export const stateTone = (s: MilestoneState) => STATE_TONE[s] ?? "bg-sky-100 text-sky-800";

export const VERDICT_LABEL: Record<string, string> = {
  verified: "Appears verified",
  not_demonstrated: "Not demonstrated",
  failed: "Failed",
  needs_human: "Needs a person",
};
export const VERDICT_TONE: Record<string, string> = {
  verified: "bg-emerald-100 text-emerald-800",
  not_demonstrated: "bg-amber-100 text-amber-800",
  failed: "bg-red-100 text-red-800",
  needs_human: "bg-violet-100 text-violet-800",
};

export const CHECK_LABEL: Record<string, string> = {
  http: "HTTP check",
  browser: "Browser flow",
  repo: "Repo fact",
  document: "Document rubric",
  needs_human: "Needs a person",
};

/** One readable line from a check's proof. Uses "appears", never "proves". */
export function proofSummary(proof: Record<string, unknown>): string {
  if (Array.isArray(proof.flaggedForHiddenInstructions)) {
    const f = proof.flaggedForHiddenInstructions as Array<{ file: string; findings: string[] }>;
    return `Possible hidden instructions to the verifier in ${f.map((x) => x.file).join(", ")} (${f.flatMap((x) => x.findings).join("; ")}). Not sent to the AI. A person must review it.`;
  }
  if (typeof proof.explanation === "string") return proof.explanation + (proof.cached ? " (same files as before)" : "");
  if (typeof proof.note === "string") return proof.note;
  if (typeof proof.error === "string") return `Could not complete: ${proof.error}`;
  if (typeof proof.status === "number") {
    const missing = Array.isArray(proof.missing) && proof.missing.length ? ` Missing text: ${(proof.missing as string[]).join(", ")}.` : "";
    return `${proof.url ?? "Page"} answered with status ${proof.status} (expected ${proof.expectedStatus}).${missing}`;
  }
  if (typeof proof.repo === "string") {
    const bits: string[] = [];
    if (proof.commitExists === false) bits.push("commit not found");
    if (Array.isArray(proof.missing) && proof.missing.length) bits.push(`missing: ${(proof.missing as string[]).join(", ")}`);
    if (Array.isArray(proof.lacking) && proof.lacking.length) bits.push((proof.lacking as string[]).join("; "));
    return bits.length ? `${proof.repo}: ${bits.join("; ")}` : `${proof.repo}: the files and commit appear to be there`;
  }
  if (Array.isArray(proof.log)) return (proof.log as string[]).slice(-2).join(" · ");
  return "";
}

export const EVENT_LABEL: Record<string, string> = {
  "milestone.post": "Job posted",
  "contract.signed": "Contract signed",
  "milestone.signed_by_both": "Both sides signed",
  "funding.order_created": "Reservation started with PayPal",
  "milestone.funds_authorized": "Funds reserved (PayPal holds the authorization)",
  "evidence.file_uploaded": "File added to the locked vault (hashed)",
  "milestone.evidence_submitted": "Evidence submitted: checks started",
  "verification.finished": "Checks finished",
  "milestone.verification_finished": "Verification result recorded",
  "preview.link_created": "View-only preview link created",
  "preview.opened": "Preview opened",
  "preview.viewed": "Preview viewed",
  "preview.second_session_refused": "Second preview session refused",
  "milestone.client_approved": "Client approved",
  "milestone.client_declined": "Client declined, naming a requirement",
  "milestone.review_deadline_passed": "Review deadline passed: the signed rule applied",
  "capture.requested": "Capture requested from PayPal",
  "capture.refused": "PayPal refused the capture",
  "capture.unknown_outcome": "PayPal did not answer: will check again",
  "milestone.capture_confirmed": "PayPal confirmed the capture",
  "milestone.capture_failed": "Capture failed",
  "milestone.acceptance_window_ended": "Acceptance window ended",
  "milestone.client_cited_failure": "Client cited a failing requirement",
  "milestone.recheck_finished": "Fresh check finished",
  "milestone.human_resolved": "Reviewer decided",
  "authorization.voided": "Reservation released back to the client",
  "milestone.reauthorized": "Reservation renewed",
  "reauthorize.failed": "Could not renew the reservation",
  "vault.file_downloaded": "File downloaded",
  "milestone.cancel": "Cancelled",
  "effect.failed": "A step failed and will be retried",
  "demo.deadline_fast_forwarded": "Demo: deadline moved to now",
};
