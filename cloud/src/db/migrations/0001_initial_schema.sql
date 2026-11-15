-- Petali Cloud, schema version 1: accounts, Petali IDs, sessions, account settings, future device ownership.
--
-- Conventions
--   * every table has a UUID primary key (internal, never shown to users) and created_at / updated_at,
--   * ownership is always a user_id foreign key; deleting a user cascades to everything they own,
--   * the Petali ID is the PUBLIC identifier; it is unique and cannot be changed once written.

CREATE FUNCTION petali_touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE FUNCTION petali_protect_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.petali_id IS DISTINCT FROM OLD.petali_id THEN
    RAISE EXCEPTION 'petali_id is permanent and cannot be changed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'id and created_at cannot be changed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TABLE users (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  petali_id             text        NOT NULL,
  email                 text        NOT NULL,                  -- as the user typed it (trimmed), for display
  email_normalized      text        NOT NULL,                  -- trimmed + NFKC + lower-case: the unique key
  password_hash         text        NOT NULL,                  -- argon2id, self-describing (parameters inside)
  display_name          text,
  email_verified_at     timestamptz,                           -- NULL until a verification flow exists (later phase)
  email_changed_at      timestamptz,
  password_changed_at   timestamptz NOT NULL DEFAULT now(),
  deletion_requested_at timestamptz,                           -- account deletion is only PREPARED in phase 1
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_petali_id_format CHECK (petali_id ~ '^PTL-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$'),
  CONSTRAINT users_email_length CHECK (char_length(email) BETWEEN 3 AND 254),
  CONSTRAINT users_email_normalized_matches CHECK (email_normalized = lower(email_normalized) AND char_length(email_normalized) BETWEEN 3 AND 254),
  CONSTRAINT users_display_name_length CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 50)
);
CREATE UNIQUE INDEX users_petali_id_key ON users (petali_id);
CREATE UNIQUE INDEX users_email_normalized_key ON users (email_normalized);
CREATE TRIGGER users_touch BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION petali_touch_updated_at();
CREATE TRIGGER users_protect_identity BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION petali_protect_identity();

-- Future device ownership (phase 3). No API uses it yet; the ownership rule is fixed now: a device belongs to exactly
-- one user and goes away with that user.
CREATE TABLE devices (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name          text        NOT NULL,
  platform      text,
  app_version   text,
  last_seen_at  timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT devices_name_length CHECK (char_length(name) BETWEEN 1 AND 80)
);
CREATE INDEX devices_user_id_idx ON devices (user_id);
CREATE TRIGGER devices_touch BEFORE UPDATE ON devices FOR EACH ROW EXECUTE FUNCTION petali_touch_updated_at();

-- One row per signed-in client = one refresh-token "family". The refresh token itself is never stored, only its SHA-256.
CREATE TABLE sessions (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  device_id              uuid        REFERENCES devices (id) ON DELETE SET NULL,
  refresh_hash           text        NOT NULL,                 -- hash of the CURRENT refresh token
  previous_refresh_hash  text,                                 -- hash of the token it replaced (reuse detection)
  device_label           text,                                 -- what the client calls itself, e.g. "Petali 1.5.0 on Windows"
  user_agent             text,
  ip_address             text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  last_used_at           timestamptz NOT NULL DEFAULT now(),
  expires_at             timestamptz NOT NULL,                 -- idle expiry, moved forward on every rotation (capped by max age)
  max_expires_at         timestamptz NOT NULL,                 -- absolute end of life
  revoked_at             timestamptz,
  revoked_reason         text,
  CONSTRAINT sessions_revoked_pair CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);
CREATE UNIQUE INDEX sessions_refresh_hash_key ON sessions (refresh_hash);
CREATE INDEX sessions_previous_refresh_hash_idx ON sessions (previous_refresh_hash) WHERE previous_refresh_hash IS NOT NULL;
CREATE INDEX sessions_user_active_idx ON sessions (user_id, last_used_at DESC) WHERE revoked_at IS NULL;
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

-- Cloud-side account preferences (NOT the local app settings, which stay on the PC). Versioned JSON so later
-- phases can add keys without a migration; the API validates every key it accepts.
CREATE TABLE account_settings (
  user_id         uuid        PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  schema_version  integer     NOT NULL DEFAULT 1,
  settings        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT account_settings_is_object CHECK (jsonb_typeof(settings) = 'object')
);
CREATE TRIGGER account_settings_touch BEFORE UPDATE ON account_settings FOR EACH ROW EXECUTE FUNCTION petali_touch_updated_at();

-- Security activity shown to the account owner (sign-ins, password / email changes, revoked sessions).
CREATE TABLE security_events (
  id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type        text        NOT NULL,
  session_id  uuid,                                            -- informational, deliberately not a foreign key
  ip_address  text,
  user_agent  text,
  detail      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT security_events_type CHECK (type IN (
    'register', 'login', 'login_failed', 'logout', 'refresh_reuse_detected', 'password_changed', 'email_changed',
    'session_revoked', 'sessions_revoked', 'deletion_requested', 'deletion_cancelled', 'settings_changed'))
);
CREATE INDEX security_events_user_idx ON security_events (user_id, created_at DESC, id DESC);
CREATE INDEX security_events_created_idx ON security_events (created_at);

-- Brute-force protection that works across several server instances. Keyed by a hash of the (normalized) email,
-- so unknown addresses are throttled exactly like real ones and nothing reveals which accounts exist.
CREATE TABLE login_throttle (
  key_hash      text        PRIMARY KEY,
  failures      integer     NOT NULL DEFAULT 0,
  locked_until  timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_throttle_updated_idx ON login_throttle (updated_at);
