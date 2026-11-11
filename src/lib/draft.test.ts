import { describe, expect, it, vi } from "vitest";
import { sanitizeConfig } from "./contract";
import { cleanDraft, draftRequirements } from "./draft";

describe("sanitizeConfig", () => {
  it("keeps known keys and drops everything else", () => {
    expect(sanitizeConfig("http", { path: "/x", expectStatus: 200, contains: ["a", 5, ""], evil: "x", url: "http://insecure" })).toEqual({ path: "/x", expectStatus: 200, contains: ["a"] });
    expect(sanitizeConfig("http", { path: "x", expectStatus: 99 })).toEqual({});
    expect(sanitizeConfig("repo", { fileExists: ["README.md", "../etc/passwd", "/abs"], fileContains: [{ path: "a", text: "b" }, { path: "../x", text: "y" }] })).toEqual({ fileExists: ["README.md"], fileContains: [{ path: "a", text: "b" }] });
    expect(sanitizeConfig("document", { rubric: "  has plans  ", other: 1 })).toEqual({ rubric: "has plans" });
    expect(sanitizeConfig("needs_human", { a: 1 })).toEqual({});
    expect(sanitizeConfig("browser", { steps: [{ action: "run", code: "x" }] })).toEqual({});
    expect(sanitizeConfig("browser", { steps: [{ action: "goto", path: "/" }] })).toEqual({ steps: [{ action: "goto", path: "/" }] });
    expect(sanitizeConfig("http", "nonsense")).toEqual({});
  });
});

describe("draftRequirements", () => {
  it("uses the rule-based draft when no AI key is set", async () => {
    const r = await draftRequirements(["The repo has a README", "Looks nice"], {});
    expect(r.source).toBe("rules");
    expect(r.requirements.map((x) => x.checkType)).toEqual(["repo", "needs_human"]);
  });
  const reply = (text: string, status = 200) => vi.fn(async () => new Response(JSON.stringify({ content: [{ type: "text", text }] }), { status })) as unknown as typeof fetch;
  it("uses the AI draft, cleaned, when it is well formed", async () => {
    const f = reply('Sure: [{"text":"Home page returns 200","checkType":"http","checkConfig":{"path":"/","expectStatus":200,"junk":1}},{"text":"Feels premium","checkType":"magic","checkConfig":{"x":1}}]');
    const r = await draftRequirements(["x"], { AI_API_KEY: "k" }, f);
    expect(r.source).toBe("ai");
    expect(r.requirements[0]).toEqual({ text: "Home page returns 200", checkType: "http", checkConfig: { path: "/", expectStatus: 200 } });
    expect(r.requirements[1].checkType).toBe("needs_human");
  });
  it("falls back on a bad reply or an HTTP error", async () => {
    expect((await draftRequirements(["The repo has tests"], { AI_API_KEY: "k" }, reply("nope"))).source).toBe("rules");
    expect((await draftRequirements(["The repo has tests"], { AI_API_KEY: "k" }, reply("", 500))).source).toBe("rules");
  });
  it("cleanDraft rejects non-arrays and empty text", () => {
    expect(cleanDraft({})).toBeNull();
    expect(cleanDraft([{ text: " " }])).toBeNull();
  });
});
