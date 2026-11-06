-- Proof2Pay initial schema.
-- Money moves only through the `captures` table (parts 1 and 2). Nothing else records a payment.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  display_name  text NOT NULL,
  role          text NOT NULL CHECK (role IN ('client', 'freelancer')),
  -- Sandbox business account that should receive the money (test K1 on Day 1).
  paypal_payee_email text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE jobs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    uuid NOT NULL REFERENCES users(id),
  title        text NOT NULL,
  description  text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE milestones (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                    uuid NOT NULL REFERENCES jobs(id),
  freelancer_id             uuid REFERENCES users(id),
  title                     text NOT NULL,
  amount_cents              integer NOT NULL CHECK (amount_cents > 0),
  currency                  char(3) NOT NULL DEFAULT 'USD',
  -- Share captured at step 9. The rest is captured at step 12. 70/30 or 100/0 also work.
  part1_percent             integer NOT NULL DEFAULT 50 CHECK (part1_percent BETWEEN 1 AND 100),
  state                     text NOT NULL DEFAULT 'draft' CHECK (state IN (
                              'draft', 'awaiting_signatures', 'awaiting_funding', 'funded',
                              'verifying', 'gaps_returned', 'failed_verification',
                              'awaiting_client_approval', 'capturing_part1', 'capture_failed',
                              'acceptance_window', 'rechecking', 'held_for_review',
                              'capturing_part2', 'closed', 'cancelled')),
  gap_rounds                integer NOT NULL DEFAULT 0 CHECK (gap_rounds >= 0),
  no_reply_rule             text NOT NULL DEFAULT 'release' CHECK (no_reply_rule IN ('release', 'return')),
  failed_part               smallint CHECK (failed_part IN (1, 2)),
  due_at                    timestamptz,
  review_deadline_at        timestamptz,
  acceptance_window_hours   integer NOT NULL DEFAULT 72 CHECK (acceptance_window_hours > 0),
  acceptance_window_ends_at timestamptz,
  paypal_order_id           text,
  paypal_authorization_id   text,
  authorization_expires_at  timestamptz,
  contract_version          integer NOT NULL DEFAULT 1,
  contract_hash             text,
  vault_unlocked_at         timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX milestones_state_idx ON milestones (state);
CREATE INDEX milestones_auth_expiry_idx ON milestones (authorization_expires_at)
  WHERE paypal_authorization_id IS NOT NULL;

CREATE TABLE requirements (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  milestone_id            uuid NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
  position                integer NOT NULL,
  text                    text NOT NULL,
  check_type              text NOT NULL CHECK (check_type IN ('http', 'browser', 'repo', 'document', 'needs_human')),
  check_config            jsonb NOT NULL DEFAULT '{}'::jsonb,
  signed_by_client_at     timestamptz,
  signed_by_freelancer_at timestamptz,
  UNIQUE (milestone_id, position)
);

CREATE TABLE evidence (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  milestone_id  uuid NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
  round         integer NOT NULL CHECK (round >= 1),
  kind          text NOT NULL CHECK (kind IN ('live_url', 'repo', 'document', 'deliverable', 'screenshot')),
  url           text,
  repo_full_name text,
  commit_sha    text,
  storage_key   text,
  -- Files are hashed before any check runs, so later swaps are detectable.
  sha256        text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX evidence_milestone_idx ON evidence (milestone_id, round);

CREATE TABLE verdicts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  milestone_id    uuid NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
  requirement_id  uuid NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  round           integer NOT NULL CHECK (round >= 1),
  verdict         text NOT NULL CHECK (verdict IN ('verified', 'not_demonstrated', 'failed', 'needs_human')),
  proof           jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Verdicts are cached by evidence hash.
  evidence_hash   text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX verdicts_cache_idx ON verdicts (requirement_id, evidence_hash);

CREATE TABLE captures (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  milestone_id           uuid NOT NULL REFERENCES milestones(id),
  part                   smallint NOT NULL CHECK (part IN (1, 2)),
  amount_cents           integer NOT NULL CHECK (amount_cents > 0),
  -- Sent as PayPal-Request-Id. PayPal keeps these for 45 days.
  paypal_request_id      text NOT NULL UNIQUE,
  paypal_capture_id      text,
  status                 text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'confirmed', 'failed')),
  created_at             timestamptz NOT NULL DEFAULT now(),
  confirmed_at           timestamptz,
  -- A capture part happens at most once per attempt chain: retries reuse the failed row's slot only after it is marked failed.
  UNIQUE (milestone_id, part, paypal_request_id)
);
-- At most one live (requested or confirmed) capture per milestone part.
CREATE UNIQUE INDEX captures_one_live_per_part
  ON captures (milestone_id, part) WHERE status IN ('requested', 'confirmed');

CREATE TABLE webhook_events (
  paypal_event_id  text PRIMARY KEY,
  event_type       text NOT NULL,
  payload          jsonb NOT NULL,
  received_at      timestamptz NOT NULL DEFAULT now(),
  processed_at     timestamptz
);

-- Append-only log. Reputation counts, view logs and the Evidence Pack are built from this.
CREATE TABLE events (
  id            bigserial PRIMARY KEY,
  milestone_id  uuid REFERENCES milestones(id),
  type          text NOT NULL,
  actor         text NOT NULL,
  data          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_milestone_idx ON events (milestone_id, id);

CREATE FUNCTION events_block_changes() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'events is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER events_no_update BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION events_block_changes();
