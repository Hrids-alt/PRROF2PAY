import { describe, expect, it } from "vitest";
import {
  ALL_STATES,
  GuardError,
  IllegalTransitionError,
  MAX_VERIFICATION_ROUNDS,
  initialContext,
  isTerminal,
  isVaultUnlocked,
  transition,
  type Effect,
  type MilestoneContext,
  type MilestoneEvent,
  type MilestoneState,
} from "./stateMachine";

function run(events: MilestoneEvent[], start = initialContext()) {
  let ctx = start;
  const allEffects: Effect[] = [];
  for (const ev of events) {
    const r = transition(ctx, ev);
    ctx = r.ctx;
    allEffects.push(...r.effects);
  }
  return { ctx, effects: allEffects };
}

const toFunded: MilestoneEvent[] = [
  { type: "post" },
  { type: "signed_by_both" },
  { type: "funds_authorized" },
];

const toApprovalGate: MilestoneEvent[] = [
  ...toFunded,
  { type: "evidence_submitted" },
  { type: "verification_finished", allVerified: true },
];

function at(state: MilestoneState, extra: Partial<MilestoneContext> = {}): MilestoneContext {
  return { ...initialContext(), state, ...extra };
}

describe("happy path", () => {
  it("goes from draft to closed with exactly two captures", () => {
    const { ctx, effects } = run([
      ...toApprovalGate,
      { type: "client_approved" },
      { type: "capture_confirmed", part: 1 },
      { type: "acceptance_window_ended" },
      { type: "capture_confirmed", part: 2 },
    ]);
    expect(ctx.state).toBe("closed");
    expect(effects).toEqual([
      "run_checks",
      "capture_part1",
      "unlock_vault",
      "capture_part2",
      "close_milestone",
    ]);
  });
});

describe("verification loop", () => {
  it("returns gaps and lets the freelancer resubmit", () => {
    const { ctx } = run([
      ...toFunded,
      { type: "evidence_submitted" },
      { type: "verification_finished", allVerified: false },
    ]);
    expect(ctx.state).toBe("gaps_returned");
    expect(ctx.gapRounds).toBe(1);
    expect(transition(ctx, { type: "evidence_submitted" }).ctx.state).toBe("verifying");
  });

  it(`fails after ${MAX_VERIFICATION_ROUNDS} rounds with gaps, then cancel voids the hold`, () => {
    let ctx = run(toFunded).ctx;
    for (let i = 0; i < MAX_VERIFICATION_ROUNDS; i++) {
      ctx = transition(ctx, { type: "evidence_submitted" }).ctx;
      ctx = transition(ctx, { type: "verification_finished", allVerified: false }).ctx;
    }
    expect(ctx.state).toBe("failed_verification");
    const r = transition(ctx, { type: "cancel" });
    expect(r.ctx.state).toBe("cancelled");
    expect(r.effects).toEqual(["void_authorization"]);
  });

  it("never emits a capture effect from a verification result", () => {
    for (const allVerified of [true, false]) {
      const r = transition(at("verifying"), { type: "verification_finished", allVerified });
      expect(r.effects.some((e) => e.startsWith("capture_"))).toBe(false);
    }
  });
});

describe("client approval gate", () => {
  it("moves to capture part 1 on approval", () => {
    const r = transition(at("awaiting_client_approval"), { type: "client_approved" });
    expect(r.ctx.state).toBe("capturing_part1");
    expect(r.effects).toEqual(["capture_part1"]);
  });

  it("rejects a decline that names no failing requirement", () => {
    expect(() => transition(at("awaiting_client_approval"), { type: "client_declined" })).toThrow(
      GuardError,
    );
  });

  it("re-runs checks on a named decline without using a freelancer round", () => {
    const r = transition(at("awaiting_client_approval", { gapRounds: 1 }), {
      type: "client_declined",
      failingRequirementId: "req-2",
    });
    expect(r.ctx.state).toBe("verifying");
    expect(r.ctx.gapRounds).toBe(1);
    expect(r.effects).toEqual(["run_checks"]);
  });

  it("applies the signed no-reply rule: release", () => {
    const r = transition(at("awaiting_client_approval", { noReplyRule: "release" }), {
      type: "review_deadline_passed",
    });
    expect(r.ctx.state).toBe("capturing_part1");
    expect(r.effects).toEqual(["capture_part1"]);
  });

  it("applies the signed no-reply rule: return", () => {
    const r = transition(at("awaiting_client_approval", { noReplyRule: "return" }), {
      type: "review_deadline_passed",
    });
    expect(r.ctx.state).toBe("cancelled");
    expect(r.effects).toEqual(["void_authorization"]);
  });

  it("does not let the client cancel after seeing verified work", () => {
    expect(() => transition(at("awaiting_client_approval"), { type: "cancel" })).toThrow(
      IllegalTransitionError,
    );
  });
});

describe("capture and unlock", () => {
  it("unlocks the vault only on the webhook confirmation of part 1", () => {
    const capturing = at("capturing_part1");
    expect(isVaultUnlocked(capturing)).toBe(false);
    const r = transition(capturing, { type: "capture_confirmed", part: 1 });
    expect(r.effects).toContain("unlock_vault");
    expect(isVaultUnlocked(r.ctx)).toBe(true);
  });

  it("rejects a confirmation for the wrong part", () => {
    expect(() => transition(at("capturing_part1"), { type: "capture_confirmed", part: 2 })).toThrow(
      IllegalTransitionError,
    );
    expect(() => transition(at("capturing_part2"), { type: "capture_confirmed", part: 1 })).toThrow(
      IllegalTransitionError,
    );
  });

  it("keeps files locked when capture 1 fails and recaptures after a new reservation", () => {
    const failed = transition(at("capturing_part1"), { type: "capture_failed", part: 1 });
    expect(failed.ctx.state).toBe("capture_failed");
    expect(failed.effects).toEqual(["notify_capture_failed"]);
    expect(isVaultUnlocked(failed.ctx)).toBe(false);

    const retry = transition(failed.ctx, { type: "funds_authorized" });
    expect(retry.ctx.state).toBe("capturing_part1");
    expect(retry.effects).toEqual(["capture_part1"]);
  });

  it("lets the client cancel after a failed capture 1, but not after a failed capture 2", () => {
    const f1 = transition(at("capturing_part1"), { type: "capture_failed", part: 1 }).ctx;
    expect(transition(f1, { type: "cancel" }).effects).toEqual(["void_authorization"]);

    const f2 = transition(at("capturing_part2"), { type: "capture_failed", part: 2 }).ctx;
    expect(isVaultUnlocked(f2)).toBe(true);
    expect(() => transition(f2, { type: "cancel" })).toThrow(IllegalTransitionError);
  });
});

describe("acceptance window", () => {
  it("rechecks when the client cites a failing requirement, then captures part 2 on pass", () => {
    const cited = transition(at("acceptance_window"), {
      type: "client_cited_failure",
      failingRequirementId: "req-1",
    });
    expect(cited.ctx.state).toBe("rechecking");
    const passed = transition(cited.ctx, { type: "recheck_finished", passed: true });
    expect(passed.ctx.state).toBe("capturing_part2");
    expect(passed.effects).toEqual(["capture_part2"]);
  });

  it("holds part 2 for human review when the recheck fails", () => {
    const r = transition(at("rechecking"), { type: "recheck_finished", passed: false });
    expect(r.ctx.state).toBe("held_for_review");
    expect(r.effects).toEqual([]);
  });

  it("requires a named requirement to dispute", () => {
    expect(() => transition(at("acceptance_window"), { type: "client_cited_failure" })).toThrow(
      GuardError,
    );
  });

  it("lets a human release or void the held part 2", () => {
    expect(transition(at("held_for_review"), { type: "human_resolved", release: true }).effects).toEqual([
      "capture_part2",
    ]);
    expect(transition(at("held_for_review"), { type: "human_resolved", release: false }).effects).toEqual([
      "void_authorization",
      "close_milestone",
    ]);
  });
});

describe("cancel and reauthorize", () => {
  it("cancel before funding has nothing to void", () => {
    for (const s of ["draft", "awaiting_signatures", "awaiting_funding"] as const) {
      const r = transition(at(s), { type: "cancel" });
      expect(r.ctx.state).toBe("cancelled");
      expect(r.effects).toEqual([]);
    }
  });

  it("cancel after funding voids the hold", () => {
    const r = transition(at("funded"), { type: "cancel" });
    expect(r.effects).toEqual(["void_authorization"]);
  });

  it("reauthorizing keeps the state", () => {
    const r = transition(at("awaiting_client_approval"), { type: "reauthorized" });
    expect(r.ctx.state).toBe("awaiting_client_approval");
    expect(r.effects).toEqual([]);
  });

  it("terminal states accept nothing", () => {
    for (const s of ["closed", "cancelled"] as const) {
      expect(isTerminal(s)).toBe(true);
      expect(() => transition(at(s), { type: "cancel" })).toThrow(IllegalTransitionError);
    }
  });
});

describe("random walk invariants", () => {
  // Small deterministic PRNG so failures are reproducible.
  function rng(seed: number) {
    let s = seed;
    return () => {
      s = (s * 1664525 + 1013904223) % 4294967296;
      return s / 4294967296;
    };
  }

  const events: MilestoneEvent[] = [
    { type: "post" },
    { type: "signed_by_both" },
    { type: "funds_authorized" },
    { type: "reauthorized" },
    { type: "evidence_submitted" },
    { type: "verification_finished", allVerified: true },
    { type: "verification_finished", allVerified: false },
    { type: "client_approved" },
    { type: "client_declined", failingRequirementId: "r1" },
    { type: "client_declined" },
    { type: "review_deadline_passed" },
    { type: "capture_confirmed", part: 1 },
    { type: "capture_confirmed", part: 2 },
    { type: "capture_failed", part: 1 },
    { type: "capture_failed", part: 2 },
    { type: "acceptance_window_ended" },
    { type: "client_cited_failure", failingRequirementId: "r1" },
    { type: "recheck_finished", passed: true },
    { type: "recheck_finished", passed: false },
    { type: "human_resolved", release: true },
    { type: "human_resolved", release: false },
    { type: "cancel" },
  ];

  it("never unlocks the vault or captures part 2 before part 1 is confirmed, and part 1 only follows approval", () => {
    const rand = rng(42);
    for (let walk = 0; walk < 3000; walk++) {
      let ctx = initialContext(rand() < 0.5 ? "release" : "return");
      let part1Confirmed = false;
      let approvedOrDeadline = false;

      for (let step = 0; step < 60; step++) {
        const ev = events[Math.floor(rand() * events.length)];
        let result;
        try {
          result = transition(ctx, ev);
        } catch (e) {
          if (e instanceof IllegalTransitionError || e instanceof GuardError) continue;
          throw e;
        }

        if (ev.type === "client_approved" || ev.type === "review_deadline_passed") {
          approvedOrDeadline = approvedOrDeadline || result.effects.includes("capture_part1");
        }
        if (result.effects.includes("capture_part1")) {
          expect(approvedOrDeadline).toBe(true);
        }
        if (ev.type === "capture_confirmed" && ev.part === 1) part1Confirmed = true;
        if (result.effects.includes("capture_part2")) expect(part1Confirmed).toBe(true);
        if (ev.type === "verification_finished") {
          expect(result.effects.some((e) => e.startsWith("capture_"))).toBe(false);
        }

        ctx = result.ctx;
        expect(ALL_STATES).toContain(ctx.state);
        if (isVaultUnlocked(ctx)) expect(part1Confirmed).toBe(true);
        if (isTerminal(ctx.state)) break;
      }
    }
  });
});
