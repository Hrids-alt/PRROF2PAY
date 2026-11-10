-- Day 2/3: signatures, locked vault, preview sessions, authorization timing.

ALTER TABLE milestones
  ADD COLUMN review_window_hours integer NOT NULL DEFAULT 72 CHECK (review_window_hours > 0),
  ADD COLUMN authorized_at       timestamptz,
  -- PayPal's 3-day honor period. After it, re-authorize once to keep the hold.
  ADD COLUMN honor_until         timestamptz,
  ADD COLUMN reauthorized_at     timestamptz;

-- One row per person per contract version. Both rows with the same hash = signed.
CREATE TABLE signatures (
  milestone_id     uuid NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id),
  contract_version integer NOT NULL,
  contract_hash    text NOT NULL,
  signed_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (milestone_id, user_id, contract_version)
);

-- Locked deliverables and documents. Bytes are hashed before anything reads them.
CREATE TABLE vault_files (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  milestone_id  uuid NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
  uploaded_by   uuid NOT NULL REFERENCES users(id),
  name          text NOT NULL,
  mime          text NOT NULL,
  size_bytes    integer NOT NULL CHECK (size_bytes >= 0),
  sha256        text NOT NULL,
  data          bytea NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vault_files_milestone_idx ON vault_files (milestone_id);

-- A signed preview link is claimed by the first browser that opens it.
CREATE TABLE preview_sessions (
  sid           text PRIMARY KEY,
  milestone_id  uuid NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  claimed_at    timestamptz
);
