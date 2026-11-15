-- Petali Cloud, schema version 4: Continue with Google (Petali 1.5.0 Phase 7). ADDITIVE ONLY: nothing of versions 1-3 is dropped, renamed, retyped
-- or rewritten; the new column has a default, so every existing account stays valid and keeps signing in with its password exactly as before.
--
--   external_identities  links a Petali account to an identity at an external provider. For Google the key is the OpenID Connect "sub" (the
--                        stable, never-reused account id), NEVER the email address: an email can change hands, a sub cannot.
--   users.password_usable  false for an account that was created through Google and has no password the user knows (its password_hash holds a hash
--                        of random bytes nobody has seen, so password sign-in cannot succeed). Existing accounts keep the default, true.
CREATE TABLE external_identities (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider       text        NOT NULL,
  subject        text        NOT NULL,
  email_at_link  text        NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_login_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT external_identities_provider CHECK (provider IN ('google')),
  CONSTRAINT external_identities_subject_length CHECK (char_length(subject) BETWEEN 1 AND 255)
);
CREATE UNIQUE INDEX external_identities_provider_subject_key ON external_identities (provider, subject);
CREATE UNIQUE INDEX external_identities_user_provider_key ON external_identities (user_id, provider);

ALTER TABLE users ADD COLUMN password_usable boolean NOT NULL DEFAULT true;
