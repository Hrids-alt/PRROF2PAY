/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * End-to-end money flow against a real Postgres with a fake PayPal.
 * Runs only when TEST_DATABASE_URL points at a migrated database.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ContractInput } from "./contract";
import type { Deps } from "./deps";
import { reconcileCaptures, tick } from "./effects";
import type { Judge, JudgeOutput } from "./judge";
import { assertSafeUrl } from "./ssrf";
import type { PaypalClient } from "./paypal";
import { filesUnlocked, getCaptures, getEvents, getLatestVerdicts, getMilestone, getReputation } from "./read";
import { toAppError } from "./errors";
import * as svc from "./service";
import { handleWebhook } from "./webhook";
import { createPgWebhookStore } from "./webhookPgStore";

const url = process.env.TEST_DATABASE_URL;
const fixture = (n: string) => readFileSync(join(__dirname, "..", "..", "fixtures", n));

/** Stands in for PayPal: keeps authorizations and captures, and replays by PayPal-Request-Id. */
function fakePaypal(opts: { refuseCapture?: boolean; payee?: string | null } = {}) {
  const state = { orders: 0, auths: 0, captures: [] as any[], voided: [] as string[], reauth: [] as string[], captureCalls: 0, refuse: opts.refuseCapture ?? false };
  const byRequest = new Map<string, any>();
  const api = {
    async createAuthorizeOrder(a: any) {
      state.orders++;
      return { orderId: `ORDER-${state.orders}`, approveUrl: `https://pp.test/approve/${state.orders}`, args: a };
    },
    async authorizeOrder() {
      state.auths++;
      return { authorizationId: `AUTH-${state.auths}`, expiresAt: new Date(Date.now() + 29 * 86_400_000), payeeEmail: opts.payee === undefined ? null : opts.payee };
    },
    async capture(a: any) {
      state.captureCalls++;
      if (byRequest.has(a.requestId)) return byRequest.get(a.requestId);
      let r;
      if (state.refuse) r = { accepted: false, id: `CAP-X${state.captureCalls}`, status: "DECLINED", invoiceId: a.invoiceId, issue: "DECLINED" };
      else {
        r = { accepted: true, id: `CAP-${state.captures.length + 1}`, status: "COMPLETED", invoiceId: a.invoiceId, issue: null };
        state.captures.push({ ...a, id: r.id });
      }
      byRequest.set(a.requestId, r);
      return r;
    },
    async voidAuthorization(id: string) {
      state.voided.push(id);
    },
    async reauthorize(a: any) {
      state.reauth.push(a.authorizationId);
      return { expiresAt: new Date(Date.now() + 26 * 86_400_000) };
    },
  };
  return { api: api as unknown as PaypalClient, state, byRequest };
}

describe.skipIf(!url)("full flow", () => {
  let pool: pg.Pool;
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: url });
  });
  afterAll(async () => {
    await pool.end();
  });

  async function world(over: { paypal?: ReturnType<typeof fakePaypal>; judge?: Judge; fetchStatus?: number } = {}) {
    const clientId = randomUUID();
    const freelancerId = randomUUID();
    await pool.query(`INSERT INTO users (id, email, display_name, role) VALUES ($1, $2, 'Cleo Client', 'client')`, [clientId, `c-${clientId}@t.io`]);
    await pool.query(`INSERT INTO users (id, email, display_name, role, paypal_payee_email) VALUES ($1, $2, 'Fiona Freelancer', 'freelancer', 'free@biz.example.com')`, [freelancerId, `f-${freelancerId}@t.io`]);
    const paypal = over.paypal ?? fakePaypal();
    const judge: Judge = over.judge ?? vi.fn(async (i): Promise<JudgeOutput> => (i.evidenceText.includes("three plans") ? { verdict: "verified", proof: "Appears to show three plans.", quote: "three plans" } : { verdict: "not_demonstrated", proof: "Not shown.", quote: null }));
    const deps: Deps = {
      pool,
      paypal: paypal.api,
      judge,
      github: { commitExists: async () => true, getFile: async (_r, p) => ({ exists: p === "README.md", text: "# readme" }) },
      fetcher: async () => ({ status: over.fetchStatus ?? 200, headers: new Headers(), body: new TextEncoder().encode("<h1>Pricing</h1>"), finalUrl: "https://site.test/" }),
      browser: null,
      checkUrl: (u) => assertSafeUrl(u, { lookup: async () => ["93.184.216.34"] }),
      appUrl: "https://app.test",
    };
    const client = { id: clientId, role: "client" as const, name: "Cleo Client" };
    const freelancer = { id: freelancerId, role: "freelancer" as const, name: "Fiona Freelancer" };
    return { deps, paypal, client, freelancer };
  }

  const contract = (over: Partial<ContractInput> = {}): ContractInput => ({
    title: "Maple landing page", description: "Landing page for Maple & Co", amountCents: 10000, currency: "USD", part1Percent: 50,
    reviewWindowHours: 72, acceptanceWindowHours: 72, noReplyRule: "release", dueAt: null,
    requirements: [
      { text: "Home page responds with 200 and shows Pricing", checkType: "http", checkConfig: { path: "/", expectStatus: 200, contains: ["Pricing"] } },
      { text: "Brief describes three plans", checkType: "document", checkConfig: { rubric: "The brief lists three pricing plans" } },
      { text: "Repo has a README", checkType: "repo", checkConfig: { fileExists: ["README.md"] } },
    ],
    ...over,
  });

  async function toFunded(w: Awaited<ReturnType<typeof world>>, c = contract()) {
    const id = await svc.createJob(w.deps, w.client, c);
    await svc.signMilestone(w.deps, w.freelancer, id);
    expect((await getMilestone(pool, id))!.state).toBe("awaiting_funding");
    const { approveUrl } = await svc.startFunding(w.deps, w.client, id);
    expect(approveUrl).toMatch(/^https:\/\/pp\.test\/approve/);
    const m = await getMilestone(pool, id);
    await svc.completeFunding(w.deps, w.client, id, m!.orderId!);
    return id;
  }

  const submitGood = async (w: Awaited<ReturnType<typeof world>>, id: string) => {
    await svc.uploadFile(w.deps, w.freelancer, id, { name: "brief.md", mime: "text/markdown", bytes: fixture("clean-brief.md"), kind: "document" });
    await svc.uploadFile(w.deps, w.freelancer, id, { name: "site.zip", mime: "application/zip", bytes: new Uint8Array([80, 75, 3, 4, 1, 2, 3]), kind: "deliverable" });
    await svc.submitEvidence(w.deps, w.freelancer, id, { liveUrl: "https://site.test", repo: "https://github.com/acme/maple", commit: "abc1234" });
  };

  const webhook = (id: string, part: 1 | 2, captureId: string, type = "PAYMENT.CAPTURE.COMPLETED") =>
    handleWebhook({
      rawBody: JSON.stringify({ id: `evt-${randomUUID()}`, event_type: type, resource: { id: captureId, invoice_id: `p2p:${id}:${part}` } }),
      getHeader: () => "x",
      verify: async () => true,
      store: createPgWebhookStore(pool),
    });

  it("HAPPY PATH: post, sign, reserve, submit, verify, approve, capture 1, webhook unlock, window, capture 2, closed", async () => {
    const w = await world();
    const id = await toFunded(w);
    let m = (await getMilestone(pool, id))!;
    expect(m.state).toBe("funded");
    expect(m.authorizationId).toBe("AUTH-1");
    expect(m.honorUntil!.getTime()).toBeGreaterThan(Date.now() + 2.9 * 86_400_000);
    expect(w.paypal.state.captureCalls).toBe(0); // reserving moves no money

    await submitGood(w, id);
    m = (await getMilestone(pool, id))!;
    expect(m.state).toBe("awaiting_client_approval");
    expect(m.reviewDeadlineAt!.getTime()).toBeGreaterThan(Date.now() + 71 * 3_600_000);
    expect((await getLatestVerdicts(pool, id)).every((v) => v.verdict === "verified")).toBe(true);
    expect(w.paypal.state.captureCalls).toBe(0); // verification moves no money
    expect(filesUnlocked(m)).toBe(false);

    await svc.approve(w.deps, w.client, id);
    m = (await getMilestone(pool, id))!;
    expect(m.state).toBe("capturing_part1"); // PayPal said COMPLETED, but we wait for the webhook
    expect(m.vaultUnlockedAt).toBeNull();
    expect(filesUnlocked(m)).toBe(false);
    expect(w.paypal.state.captures).toHaveLength(1);
    expect(w.paypal.state.captures[0]).toMatchObject({ amountCents: 5000, finalCapture: false, invoiceId: `p2p:${id}:1`, currency: "USD" });

    expect(await webhook(id, 1, "CAP-1")).toEqual({ status: 200, body: "applied" });
    m = (await getMilestone(pool, id))!;
    expect(m.state).toBe("acceptance_window");
    expect(filesUnlocked(m)).toBe(true);

    await svc.fastForwardDeadline(w.deps, w.client, id);
    const t = await tick(w.deps);
    expect(t.acceptanceWindows).toBe(1);
    m = (await getMilestone(pool, id))!;
    expect(m.state).toBe("capturing_part2");
    expect(w.paypal.state.captures[1]).toMatchObject({ amountCents: 5000, finalCapture: true, invoiceId: `p2p:${id}:2` });

    await webhook(id, 2, "CAP-2");
    expect((await getMilestone(pool, id))!.state).toBe("closed");

    const caps = await getCaptures(pool, id);
    expect(caps.map((c) => [c.part, c.status, c.amountCents])).toEqual([[1, "confirmed", 5000], [2, "confirmed", 5000]]);
    expect(new Set(w.paypal.state.captures.map((c) => c.requestId)).size).toBe(2);

    const types = (await getEvents(pool, id)).map((e) => e.type);
    for (const t of ["milestone.post", "contract.signed", "milestone.funds_authorized", "milestone.evidence_submitted", "verification.finished", "milestone.client_approved", "milestone.capture_confirmed", "milestone.acceptance_window_ended"]) {
      expect(types).toContain(t);
    }
    expect((await getReputation(pool, w.freelancer.id)).closedMilestones).toBe(1);
  });

  it("the preview-time files stay locked for the client until capture 1 is confirmed", async () => {
    const w = await world();
    const id = await toFunded(w);
    await submitGood(w, id);
    await svc.approve(w.deps, w.client, id);
    const m = (await getMilestone(pool, id))!;
    expect(filesUnlocked(m)).toBe(false);
    expect(m.vaultUnlockedAt).toBeNull();
  });

  it("POISONED FILE: is flagged, the AI never sees it, and the milestone cannot reach the approval gate", async () => {
    const judge = vi.fn<Judge>(async () => ({ verdict: "verified", proof: "x", quote: "three plans" }));
    const w = await world({ judge });
    const id = await toFunded(w);
    await svc.uploadFile(w.deps, w.freelancer, id, { name: "brief.md", mime: "text/markdown", bytes: fixture("poisoned-brief.md"), kind: "document" });
    await svc.submitEvidence(w.deps, w.freelancer, id, { liveUrl: "https://site.test", repo: "acme/maple", commit: "abc1234" });

    const m = (await getMilestone(pool, id))!;
    expect(m.state).toBe("gaps_returned");
    expect(judge).not.toHaveBeenCalled();
    const verdicts = await getLatestVerdicts(pool, id);
    const doc = verdicts.find((v) => v.verdict === "needs_human")!;
    expect(JSON.stringify(doc.proof)).toMatch(/hidden instructions|instructions aimed at the verifier/);
    expect(w.paypal.state.captureCalls).toBe(0);
  });

  it("GAP LOOP: three rounds of gaps end in failed verification, and cancelling voids the hold", async () => {
    const w = await world({ fetchStatus: 500 });
    const id = await toFunded(w);
    for (let round = 1; round <= 3; round++) {
      await svc.uploadFile(w.deps, w.freelancer, id, { name: `b${round}.md`, mime: "text/markdown", bytes: fixture("clean-brief.md"), kind: "document" });
      await svc.submitEvidence(w.deps, w.freelancer, id, { liveUrl: "https://site.test", repo: "acme/maple" });
      const m = (await getMilestone(pool, id))!;
      expect(m.state).toBe(round < 3 ? "gaps_returned" : "failed_verification");
      expect(m.gapRounds).toBe(round);
    }
    await expect(svc.submitEvidence(w.deps, w.freelancer, id, { liveUrl: "https://site.test" })).rejects.toThrow(/Evidence can be submitted/);
    await svc.cancelMilestone(w.deps, w.client, id);
    expect((await getMilestone(pool, id))!.state).toBe("cancelled");
    expect(w.paypal.state.voided).toEqual(["AUTH-1"]);
    expect(w.paypal.state.captureCalls).toBe(0);
  });

  it("a decline must name a failing requirement, then re-runs the checks fresh", async () => {
    const w = await world();
    const id = await toFunded(w);
    await submitGood(w, id);
    await expect(svc.decline(w.deps, w.client, id, undefined)).rejects.toThrow(/Name the requirement/);
    await expect(svc.decline(w.deps, w.client, id, randomUUID())).rejects.toThrow(/Name the requirement/);
    const reqs = (await pool.query(`SELECT id FROM requirements WHERE milestone_id = $1 ORDER BY position LIMIT 1`, [id])).rows;
    const before = (await pool.query(`SELECT count(DISTINCT round) AS n FROM verdicts WHERE milestone_id = $1`, [id])).rows[0].n;
    await svc.decline(w.deps, w.client, id, reqs[0].id);
    const after = (await pool.query(`SELECT count(DISTINCT round) AS n FROM verdicts WHERE milestone_id = $1`, [id])).rows[0].n;
    expect(Number(after)).toBe(Number(before) + 1);
    expect((await getMilestone(pool, id))!.state).toBe("awaiting_client_approval"); // still verified: back to the gate
    expect(w.paypal.state.captureCalls).toBe(0);
  });

  it("only the right person can act", async () => {
    const w = await world();
    const other = await world();
    const id = await toFunded(w);
    await expect(svc.approve(w.deps, w.freelancer, id)).rejects.toThrow(/Only the client/);
    await expect(svc.approve(other.deps, other.client, id)).rejects.toThrow(/Only the client/);
    await expect(svc.submitEvidence(w.deps, w.client as any, id, { liveUrl: "https://x.test" })).rejects.toThrow(/Only the freelancer/);
    await expect(svc.submitEvidence(other.deps, other.freelancer, id, { liveUrl: "https://x.test" })).rejects.toThrow(/Only the freelancer/);
  });

  it("approving at the wrong stage is refused and moves no money", async () => {
    const w = await world();
    const id = await toFunded(w);
    const err = await svc.approve(w.deps, w.client, id).catch((e) => e);
    expect(toAppError(err)).toMatchObject({ status: 409, message: expect.stringMatching(/not available at this stage/) });
    expect(w.paypal.state.captureCalls).toBe(0);
  });

  it("a private-address live URL is refused before any check runs", async () => {
    const w = await world();
    const id = await toFunded(w);
    const a = await svc.submitEvidence(w.deps, w.freelancer, id, { liveUrl: "https://10.0.0.5/admin" }).catch((e) => e);
    expect(toAppError(a)).toMatchObject({ status: 422, message: expect.stringMatching(/not allowed.*not public/) });
    const b = await svc.submitEvidence(w.deps, w.freelancer, id, { liveUrl: "http://site.test" }).catch((e) => e);
    expect(toAppError(b)?.message).toMatch(/https/i);
    expect((await getMilestone(pool, id))!.state).toBe("funded");
  });

  it("CAPTURE REFUSED: shows the failed state, keeps files locked, and a new reservation retries", async () => {
    const paypal = fakePaypal({ refuseCapture: true });
    const w = await world({ paypal });
    const id = await toFunded(w);
    await submitGood(w, id);
    await svc.approve(w.deps, w.client, id);
    let m = (await getMilestone(pool, id))!;
    expect(m.state).toBe("capture_failed");
    expect(m.failedPart).toBe(1);
    expect(filesUnlocked(m)).toBe(false);
    expect((await getCaptures(pool, id))[0].status).toBe("failed");

    paypal.state.refuse = false;
    await svc.startFunding(w.deps, w.client, id);
    m = (await getMilestone(pool, id))!;
    await svc.completeFunding(w.deps, w.client, id, m.orderId!);
    m = (await getMilestone(pool, id))!;
    expect(m.state).toBe("capturing_part1");
    expect(paypal.state.captures).toHaveLength(1);
    const reqIds = (await pool.query(`SELECT paypal_request_id FROM captures WHERE milestone_id = $1`, [id])).rows.map((r) => r.paypal_request_id);
    expect(new Set(reqIds).size).toBe(2); // the retry used a new request id
    await webhook(id, 1, "CAP-1");
    expect(filesUnlocked((await getMilestone(pool, id))!)).toBe(true);
  });

  it("LOST WEBHOOK: the reconcile poller settles the capture from PayPal's own record, once", async () => {
    const w = await world();
    const id = await toFunded(w);
    await submitGood(w, id);
    await svc.approve(w.deps, w.client, id);
    expect((await getMilestone(pool, id))!.state).toBe("capturing_part1");
    expect(await reconcileCaptures(w.deps)).toBe(0); // too fresh
    await pool.query(`UPDATE captures SET created_at = now() - interval '5 minutes' WHERE milestone_id = $1`, [id]);
    const callsBefore = w.paypal.state.captures.length;
    expect(await reconcileCaptures(w.deps)).toBe(1);
    expect(w.paypal.state.captures.length).toBe(callsBefore); // replay by request id: no second charge
    expect((await getMilestone(pool, id))!.state).toBe("acceptance_window");
    expect(await reconcileCaptures(w.deps)).toBe(0);
  });

  it("a duplicate or replayed webhook does not move a milestone twice", async () => {
    const w = await world();
    const id = await toFunded(w);
    await submitGood(w, id);
    await svc.approve(w.deps, w.client, id);
    const eventBody = JSON.stringify({ id: "evt-fixed-" + id, event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "CAP-1", invoice_id: `p2p:${id}:1` } });
    const send = () => handleWebhook({ rawBody: eventBody, getHeader: () => "x", verify: async () => true, store: createPgWebhookStore(pool) });
    expect((await send()).body).toBe("applied");
    expect((await send()).body).toBe("duplicate");
    const n = (await pool.query(`SELECT count(*) FROM events WHERE milestone_id = $1 AND type = 'milestone.capture_confirmed'`, [id])).rows[0].count;
    expect(Number(n)).toBe(1);
  });

  it("NO REPLY by the deadline: 'release' captures part 1; 'return' voids the hold", async () => {
    for (const rule of ["release", "return"] as const) {
      const w = await world();
      const id = await toFunded(w, contract({ noReplyRule: rule }));
      await submitGood(w, id);
      await svc.fastForwardDeadline(w.deps, w.client, id);
      const t = await tick(w.deps);
      expect(t.reviewDeadlines).toBe(1);
      const m = (await getMilestone(pool, id))!;
      if (rule === "release") {
        expect(m.state).toBe("capturing_part1");
        expect(w.paypal.state.captures).toHaveLength(1);
      } else {
        expect(m.state).toBe("cancelled");
        expect(w.paypal.state.voided).toEqual(["AUTH-1"]);
        expect(w.paypal.state.captureCalls).toBe(0);
      }
    }
  });

  it("100/0 split: one final capture, then closes without a second PayPal call", async () => {
    const w = await world();
    const id = await toFunded(w, contract({ part1Percent: 100 }));
    await submitGood(w, id);
    await svc.approve(w.deps, w.client, id);
    expect(w.paypal.state.captures[0]).toMatchObject({ amountCents: 10000, finalCapture: true });
    await webhook(id, 1, "CAP-1");
    await svc.fastForwardDeadline(w.deps, w.client, id);
    await tick(w.deps);
    expect((await getMilestone(pool, id))!.state).toBe("closed");
    expect(w.paypal.state.captures).toHaveLength(1);
  });

  it("DISPUTE in the acceptance window: a failing citation holds the money for review", async () => {
    const w = await world();
    const id = await toFunded(w);
    await submitGood(w, id);
    await svc.approve(w.deps, w.client, id);
    await webhook(id, 1, "CAP-1");
    const req = (await pool.query(`SELECT id FROM requirements WHERE milestone_id = $1 AND check_type = 'http'`, [id])).rows[0].id;
    // The site now fails.
    (w.deps as any).fetcher = async () => ({ status: 500, headers: new Headers(), body: new Uint8Array(), finalUrl: "https://site.test/" });
    await svc.citeFailure(w.deps, w.client, id, req);
    expect((await getMilestone(pool, id))!.state).toBe("held_for_review");
    expect(w.paypal.state.captures).toHaveLength(1); // part 2 not captured
    await svc.resolveHold(w.deps, "platform reviewer", id, true);
    expect((await getMilestone(pool, id))!.state).toBe("capturing_part2");
    expect(w.paypal.state.captures).toHaveLength(2);
  });

  it("RE-AUTHORIZE after the 3-day honor period, once", async () => {
    const w = await world();
    const id = await toFunded(w);
    await pool.query(`UPDATE milestones SET honor_until = now() - interval '1 minute' WHERE id = $1`, [id]);
    expect((await tick(w.deps)).reauthorized).toBe(1);
    expect(w.paypal.state.reauth).toEqual(["AUTH-1"]);
    expect((await tick(w.deps)).reauthorized).toBe(0);
    expect((await getMilestone(pool, id))!.reauthorizedAt).not.toBeNull();
  });

  it("a hold PayPal made out to a different account is released, not accepted", async () => {
    const w = await world({ paypal: fakePaypal({ payee: "someone-else@biz.example.com" }) });
    const id = await svc.createJob(w.deps, w.client, contract());
    await svc.signMilestone(w.deps, w.freelancer, id);
    await svc.startFunding(w.deps, w.client, id);
    const m = (await getMilestone(pool, id))!;
    await expect(svc.completeFunding(w.deps, w.client, id, m.orderId!)).rejects.toThrow(/different account/);
    expect(w.paypal.state.voided).toEqual(["AUTH-1"]);
    expect((await getMilestone(pool, id))!.state).toBe("awaiting_funding");
  });

  it("a PayPal order from another milestone cannot fund this one", async () => {
    const w = await world();
    const id = await svc.createJob(w.deps, w.client, contract());
    await svc.signMilestone(w.deps, w.freelancer, id);
    await svc.startFunding(w.deps, w.client, id);
    await expect(svc.completeFunding(w.deps, w.client, id, "ORDER-OTHER")).rejects.toThrow(/does not belong/);
  });

  it("uploads are hashed, size-limited, and the contract cannot be signed twice into the next stage", async () => {
    const w = await world();
    const id = await toFunded(w);
    const bytes = new TextEncoder().encode("hello");
    const r = await svc.uploadFile(w.deps, w.freelancer, id, { name: "../../evil name.txt", mime: "text/plain", bytes, kind: "deliverable" });
    expect(r.sha256).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    const stored = (await pool.query(`SELECT name FROM vault_files WHERE id = $1`, [r.id])).rows[0].name;
    expect(stored).not.toContain("/");
    await expect(svc.uploadFile(w.deps, w.freelancer, id, { name: "big.bin", mime: "application/octet-stream", bytes: new Uint8Array(10 * 1024 * 1024 + 1), kind: "deliverable" })).rejects.toThrow(/10 MB/);
    await expect(svc.signMilestone(w.deps, w.client, id)).rejects.toThrow(/not waiting for signatures/);
  });
});
