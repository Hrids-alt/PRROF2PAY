# Proof2Pay

A freelance job board where the client's money is reserved (PayPal authorization) before work starts, and released only when platform-run checks pass and the client approves. Finished files stay locked until the payment is captured.

Built for the PayPal AI Hackathon. Sandbox only. Not legal advice.

## Run it locally

```bash
npm ci
cp .env.example .env.local        # fill in DATABASE_URL and PayPal sandbox credentials
DATABASE_URL=... node scripts/migrate.mjs
npm run dev
```

## Tests

```bash
npm test                # unit tests (no database needed)
npm run typecheck

# Integration tests need a migrated Postgres:
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/proof2pay_test npm test
```

## What exists so far (Day 1)

| Piece | File |
| --- | --- |
| Milestone state machine (pure, no I/O) | `src/lib/stateMachine.ts` |
| Transactions that apply transitions and log events | `src/lib/milestoneRepo.ts` |
| SSRF guard and `safeFetch` | `src/lib/ssrf.ts` |
| PayPal webhook handler (signature check, idempotency) | `src/lib/webhook.ts`, `src/lib/webhookPgStore.ts` |
| Webhook route | `src/app/api/webhooks/paypal/route.ts` |
| Postgres schema | `db/migrations/001_init.sql` |

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
