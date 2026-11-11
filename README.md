# Proof2Pay

A freelance job board where the client's money is reserved (PayPal authorization) before work starts, and released only when platform-run checks pass and the client approves. Finished files stay locked until the payment is captured.

Built for the PayPal AI Hackathon. Sandbox only. Not legal advice.

## Run it locally

```bash
npm ci
cp .env.example .env.local        # DATABASE_URL, SESSION_SECRET, APP_URL, PayPal sandbox keys
npm run migrate
npm run seed                      # demo users (@demo.test) and 3 open jobs
npm run dev
```

Sign in with "Sign in (demo)" and pick an account: `cleo`/`acme` are clients, `fiona`/`sam` are freelancers. This is a demo sign-in, not real authentication.

**Without PayPal or an AI key** (offline demo): `npm run fake` starts a stand-in for PayPal and the AI on port 4010 (it also sends the webhooks). Start the app with `PAYPAL_API_BASE=http://127.0.0.1:4010 AI_BASE_URL=http://127.0.0.1:4010 AI_API_KEY=x`. It is not PayPal; use real sandbox keys for the real demo.

## The flow

1. Client posts a job with checkable requirements (AI or rules help turn vague lines into checks). Freelancer signs the same contract hash.
2. Client reserves the money: a PayPal AUTHORIZE order paying the freelancer. Nothing is captured.
3. Freelancer uploads files and a live URL / repo. The platform runs the checks (HTTP, repo, document via AI judge, optional browser, needs-a-person). Gaps go back to the freelancer.
4. When checks pass, the client sees a view-only preview and decides. Approve captures part 1. Files unlock only after PayPal's webhook confirms the capture.
5. Acceptance window: the client can cite a failing requirement; otherwise part 2 is captured and the job closes. Every step is in the event log and the downloadable Evidence Pack.

Background loop (`TICK_SECONDS`) handles deadlines, re-authorizing the hold before the 29-day limit, stuck work, and lost webhooks (it replays captures with the same request id).

## Tests

```bash
npm test                # unit tests
npm run typecheck
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/proof2pay_test npm test   # adds the 19 end-to-end flow tests
```

## Deploy (Render)

`render.yaml` is a starting point. Use an always-on web instance (free ones sleep and miss webhooks) and a database that lasts past judging. Set `APP_URL` to the public URL, then in the PayPal developer dashboard add a webhook for `<APP_URL>/api/webhooks/paypal` (events `PAYMENT.CAPTURE.COMPLETED/DENIED/REFUNDED`) and put its id in `PAYPAL_WEBHOOK_ID`. Run `npm run seed` with `SEED_FREELANCER_PAYEE=<US sandbox business email>` so seeded jobs pay a real sandbox account. Use US sandbox accounts and USD: India-based sandbox accounts cannot take USD.

A Postman collection is in `postman_collection.json`.

## Honest limits

- Screen recording of the view-only preview cannot be prevented; it is watermarked and logged instead.
- Files are stored in Postgres (not S3). One milestone per job. No contract amendments. Demo sign-in only.
- The job board is a plain table. Repo checks read public repos through the GitHub API.
- Tested offline against a fake PayPal; the real-sandbox app flow, webhook on a public URL, and cloud browser checks still need a run on your side.

## Money rules the code enforces

- Money moves only through capture part 1 and capture part 2.
- The AI verdict never triggers a capture; it only moves a milestone to the client approval gate.
- The vault unlocks only when a verified webhook confirms capture part 1.
- The event log is append-only (enforced by a database trigger).
- Webhook captures are matched to a milestone by `invoice_id` = `p2p:<milestoneId>:<part>`. The capture call must set it.

## Day 1 kill tests (PayPal sandbox)

Needs: a PayPal developer account, one sandbox **Business** account (the freelancer), one sandbox **Personal** account (the buyer), and a REST app's sandbox client ID and secret.

```bash
PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... PAYEE_EMAIL=<freelancer sandbox business email> \
  node scripts/kill-tests.mjs
```

It prints an approval link. Open it, log in as the sandbox buyer and approve. The script then authorizes, captures twice, replays one capture, and prints PASS/FAIL for K1, K2, idempotency and the `invoice_id` the webhook relies on. Results are saved to `kill-tests-output.json` (gitignored). It refuses to run against anything that is not a sandbox URL.
