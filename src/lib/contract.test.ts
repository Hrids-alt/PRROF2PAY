import { describe, expect, it } from "vitest";
import { ContractError, contractHash, draftRequirementsHeuristic, splitAmounts, validateContract, type ContractInput } from "./contract";
import { signToken, verifyToken } from "./tokens";

const base: ContractInput = {
  title: "Landing page", description: "d", amountCents: 10000, currency: "USD", part1Percent: 50,
  reviewWindowHours: 72, acceptanceWindowHours: 72, noReplyRule: "release", dueAt: null,
  requirements: [{ text: "Home page returns 200", checkType: "http", checkConfig: { path: "/", expectStatus: 200 } }],
};

describe("validateContract", () => {
  it("accepts a normal contract", () => expect(() => validateContract(base)).not.toThrow());
  it.each([
    ["empty title", { title: " " }],
    ["tiny amount", { amountCents: 50 }],
    ["percent 0", { part1Percent: 0 }],
    ["percent 101", { part1Percent: 101 }],
    ["no requirements", { requirements: [] }],
    ["bad currency", { currency: "usd" }],
    ["bad due date", { dueAt: "soon" }],
    ["review window 0", { reviewWindowHours: 0 }],
  ])("rejects %s", (_n, patch) => expect(() => validateContract({ ...base, ...patch })).toThrow(ContractError));
  it("rejects an unknown check type", () =>
    expect(() => validateContract({ ...base, requirements: [{ text: "x", checkType: "magic" as never, checkConfig: {} }] })).toThrow(/unknown check type/));
});

describe("contractHash", () => {
  it("is stable for the same contract regardless of key order", () => {
    const a = contractHash(base, 1);
    const b = contractHash({ ...base, requirements: [{ checkConfig: { expectStatus: 200, path: "/" }, checkType: "http", text: "Home page returns 200" }] }, 1);
    expect(a).toBe(b);
  });
  it("changes when any term, requirement or the version changes", () => {
    const h = contractHash(base, 1);
    expect(contractHash({ ...base, amountCents: 10001 }, 1)).not.toBe(h);
    expect(contractHash({ ...base, part1Percent: 70 }, 1)).not.toBe(h);
    expect(contractHash({ ...base, requirements: [{ ...base.requirements[0], text: "Home page returns 201" }] }, 1)).not.toBe(h);
    expect(contractHash({ ...base, requirements: [{ ...base.requirements[0], checkConfig: { path: "/x" } }] }, 1)).not.toBe(h);
    expect(contractHash(base, 2)).not.toBe(h);
  });
});

describe("splitAmounts", () => {
  it("splits and always adds back to the total", () => {
    expect(splitAmounts(10000, 50)).toEqual({ part1Cents: 5000, part2Cents: 5000 });
    expect(splitAmounts(10001, 50)).toEqual({ part1Cents: 5001, part2Cents: 5000 });
    expect(splitAmounts(10000, 100)).toEqual({ part1Cents: 10000, part2Cents: 0 });
    for (const [t, p] of [[333, 33], [9999, 70], [101, 1]] as const) {
      const s = splitAmounts(t, p);
      expect(s.part1Cents + s.part2Cents).toBe(t);
    }
  });
});

describe("draftRequirementsHeuristic", () => {
  it("maps lines to check types and leaves the rest for a human", () => {
    const r = draftRequirementsHeuristic(["The repo has a README", "Site responds with status 200", "A written summary document", "Looks nice", ""]);
    expect(r.map((x) => x.checkType)).toEqual(["repo", "http", "document", "needs_human"]);
    expect(r[0].checkConfig).toEqual({ fileExists: ["README.md"] });
  });
});

describe("tokens", () => {
  const key = "k".repeat(32);
  it("round-trips and rejects tampering, wrong key and expiry", () => {
    const t = signToken({ a: 1, exp: Math.floor(Date.now() / 1000) + 60 }, key);
    expect(verifyToken<{ a: number }>(t, key)?.a).toBe(1);
    const [body, mac] = t.split(".");
    expect(verifyToken(`${Buffer.from('{"a":2,"exp":9999999999}').toString("base64url")}.${mac}`, key)).toBeNull();
    expect(verifyToken(`${body}.${mac}x`, key)).toBeNull();
    expect(verifyToken(t, "z".repeat(32))).toBeNull();
    expect(verifyToken(t, key, Date.now() + 120_000)).toBeNull();
    expect(verifyToken("garbage", key)).toBeNull();
  });
});
