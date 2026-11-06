/**
 * Milestone state machine (pure, no I/O).
 *
 * Rules the rest of the app relies on:
 *  - Money moves only through the effects `capture_part1` and `capture_part2`.
 *  - The AI verdict (`verification_finished`) never emits a capture effect. It can only
 *    move the milestone to the client approval gate.
 *  - Part 1 is captured only after the client approves (or the signed no-reply rule applies).
 *  - The vault unlocks only when a verified webhook confirms capture part 1.
 */

export const MAX_VERIFICATION_ROUNDS = 3;

export type MilestoneState =
  | "draft"
  | "awaiting_signatures"
  | "awaiting_funding"
  | "funded"
  | "verifying"
  | "gaps_returned"
  | "failed_verification"
  | "awaiting_client_approval"
  | "capturing_part1"
  | "capture_failed"
  | "acceptance_window"
  | "rechecking"
  | "held_for_review"
  | "capturing_part2"
  | "closed"
  | "cancelled";

export const ALL_STATES: MilestoneState[] = [
  "draft",
  "awaiting_signatures",
  "awaiting_funding",
  "funded",
  "verifying",
  "gaps_returned",
  "failed_verification",
  "awaiting_client_approval",
  "capturing_part1",
  "capture_failed",
  "acceptance_window",
  "rechecking",
  "held_for_review",
  "capturing_part2",
  "closed",
  "cancelled",
];

/** What the signed contract says happens when the client does not reply by the review deadline. */
export type NoReplyRule = "release" | "return";

export type Effect =
  | "run_checks"
  | "void_authorization"
  | "capture_part1"
  | "capture_part2"
  | "unlock_vault"
  | "close_milestone"
  | "notify_capture_failed";

export interface MilestoneContext {
  state: MilestoneState;
  /** Verification runs that ended with gaps (max MAX_VERIFICATION_ROUNDS). */
  gapRounds: number;
  noReplyRule: NoReplyRule;
  /** Which capture failed, while state is `capture_failed`. */
  failedPart: 1 | 2 | null;
}

export type MilestoneEvent =
  | { type: "post" }
  | { type: "signed_by_both" }
  | { type: "funds_authorized" }
  | { type: "reauthorized" }
  | { type: "evidence_submitted" }
  | { type: "verification_finished"; allVerified: boolean }
  | { type: "client_approved" }
  | { type: "client_declined"; failingRequirementId?: string }
  | { type: "review_deadline_passed" }
  | { type: "capture_confirmed"; part: 1 | 2 }
  | { type: "capture_failed"; part: 1 | 2 }
  | { type: "acceptance_window_ended" }
  | { type: "client_cited_failure"; failingRequirementId?: string }
  | { type: "recheck_finished"; passed: boolean }
  | { type: "human_resolved"; release: boolean }
  | { type: "cancel" };

export interface TransitionResult {
  ctx: MilestoneContext;
  effects: Effect[];
}

export class IllegalTransitionError extends Error {
  constructor(
    public readonly state: MilestoneState,
    public readonly eventType: MilestoneEvent["type"],
  ) {
    super(`Event "${eventType}" is not allowed in state "${state}"`);
    this.name = "IllegalTransitionError";
  }
}

/** The event is allowed in this state but its payload breaks a rule (for example, decline without naming a check). */
export class GuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardError";
  }
}

export function initialContext(noReplyRule: NoReplyRule = "release"): MilestoneContext {
  return { state: "draft", gapRounds: 0, noReplyRule, failedPart: null };
}

export function isTerminal(state: MilestoneState): boolean {
  return state === "closed" || state === "cancelled";
}

const VAULT_UNLOCKED_STATES: MilestoneState[] = [
  "acceptance_window",
  "rechecking",
  "held_for_review",
  "capturing_part2",
  "closed",
];

/** True when the freelancer's files may be released to the client. */
export function isVaultUnlocked(ctx: MilestoneContext): boolean {
  return (
    VAULT_UNLOCKED_STATES.includes(ctx.state) ||
    (ctx.state === "capture_failed" && ctx.failedPart === 2)
  );
}

/** States where a reservation exists, so cancelling must void it. */
const HAS_AUTHORIZATION: MilestoneState[] = [
  "funded",
  "verifying",
  "gaps_returned",
  "failed_verification",
  "awaiting_client_approval",
  "capture_failed",
];

/** States where the client's hold may be renewed without any other change. */
const REAUTHORIZE_OK: MilestoneState[] = [
  "funded",
  "verifying",
  "gaps_returned",
  "awaiting_client_approval",
];

function next(
  ctx: MilestoneContext,
  to: MilestoneState,
  effects: Effect[] = [],
  patch: Partial<MilestoneContext> = {},
): TransitionResult {
  return { ctx: { ...ctx, ...patch, state: to }, effects };
}

export function transition(ctx: MilestoneContext, ev: MilestoneEvent): TransitionResult {
  if (ev.type === "reauthorized" && REAUTHORIZE_OK.includes(ctx.state)) {
    return next(ctx, ctx.state);
  }

  switch (ctx.state) {
    case "draft":
      if (ev.type === "post") return next(ctx, "awaiting_signatures");
      if (ev.type === "cancel") return next(ctx, "cancelled");
      break;

    case "awaiting_signatures":
      if (ev.type === "signed_by_both") return next(ctx, "awaiting_funding");
      if (ev.type === "cancel") return next(ctx, "cancelled");
      break;

    case "awaiting_funding":
      if (ev.type === "funds_authorized") return next(ctx, "funded");
      if (ev.type === "cancel") return next(ctx, "cancelled");
      break;

    case "funded":
    case "gaps_returned":
      if (ev.type === "evidence_submitted") return next(ctx, "verifying", ["run_checks"]);
      if (ev.type === "cancel") return next(ctx, "cancelled", ["void_authorization"]);
      break;

    case "verifying":
      if (ev.type === "verification_finished") {
        if (ev.allVerified) return next(ctx, "awaiting_client_approval");
        const rounds = ctx.gapRounds + 1;
        if (rounds >= MAX_VERIFICATION_ROUNDS) {
          return next(ctx, "failed_verification", [], { gapRounds: rounds });
        }
        return next(ctx, "gaps_returned", [], { gapRounds: rounds });
      }
      break;

    case "failed_verification":
      if (ev.type === "cancel") return next(ctx, "cancelled", ["void_authorization"]);
      break;

    case "awaiting_client_approval":
      if (ev.type === "client_approved") return next(ctx, "capturing_part1", ["capture_part1"]);
      if (ev.type === "client_declined") {
        if (!ev.failingRequirementId) {
          throw new GuardError("A decline must name a failing requirement");
        }
        // Fresh re-run of the checks. Does not use up a freelancer round.
        return next(ctx, "verifying", ["run_checks"]);
      }
      if (ev.type === "review_deadline_passed") {
        return ctx.noReplyRule === "release"
          ? next(ctx, "capturing_part1", ["capture_part1"])
          : next(ctx, "cancelled", ["void_authorization"]);
      }
      // No `cancel` here: the client has seen verified work and cannot walk away from it.
      break;

    case "capturing_part1":
      if (ev.type === "capture_confirmed" && ev.part === 1) {
        return next(ctx, "acceptance_window", ["unlock_vault"]);
      }
      if (ev.type === "capture_failed" && ev.part === 1) {
        return next(ctx, "capture_failed", ["notify_capture_failed"], { failedPart: 1 });
      }
      break;

    case "capture_failed":
      if (ev.type === "funds_authorized" && ctx.failedPart) {
        return ctx.failedPart === 1
          ? next(ctx, "capturing_part1", ["capture_part1"], { failedPart: null })
          : next(ctx, "capturing_part2", ["capture_part2"], { failedPart: null });
      }
      // Once files are unlocked (part 2 failed) the client cannot cancel.
      if (ev.type === "cancel" && ctx.failedPart === 1) {
        return next(ctx, "cancelled", ["void_authorization"], { failedPart: null });
      }
      break;

    case "acceptance_window":
      if (ev.type === "acceptance_window_ended") {
        return next(ctx, "capturing_part2", ["capture_part2"]);
      }
      if (ev.type === "client_cited_failure") {
        if (!ev.failingRequirementId) {
          throw new GuardError("A dispute must name a failing requirement");
        }
        return next(ctx, "rechecking", ["run_checks"]);
      }
      break;

    case "rechecking":
      if (ev.type === "recheck_finished") {
        return ev.passed
          ? next(ctx, "capturing_part2", ["capture_part2"])
          : next(ctx, "held_for_review");
      }
      break;

    case "held_for_review":
      if (ev.type === "human_resolved") {
        return ev.release
          ? next(ctx, "capturing_part2", ["capture_part2"])
          : next(ctx, "closed", ["void_authorization", "close_milestone"]);
      }
      break;

    case "capturing_part2":
      if (ev.type === "capture_confirmed" && ev.part === 2) {
        return next(ctx, "closed", ["close_milestone"]);
      }
      if (ev.type === "capture_failed" && ev.part === 2) {
        return next(ctx, "capture_failed", ["notify_capture_failed"], { failedPart: 2 });
      }
      break;

    case "closed":
    case "cancelled":
      break;
  }

  throw new IllegalTransitionError(ctx.state, ev.type);
}

/** Whether the milestone had a PayPal reservation that cancelling should void. */
export function hasAuthorization(state: MilestoneState): boolean {
  return HAS_AUTHORIZATION.includes(state);
}
