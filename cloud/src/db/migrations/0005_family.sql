-- Petali Cloud, schema version 5: Petali Family, Stage 1 "Family Foundation" (Petali 1.5.0). ADDITIVE ONLY: nothing of versions 1-4 is dropped,
-- renamed, retyped or rewritten; every statement below creates something new, so every existing account, device and sync document stays valid.
--
-- A family is a RELATIONSHIP between independent Petali ID accounts, never a shared account:
--   families                    the family itself (name, settings)
--   family_members              one row per account in a family; an account is in at most one family; exactly one member is the owner
--   family_member_permissions   explicit per-member grants / denials on top of the role's default permissions
--   family_member_privacy       what a member agrees to share with the family (private by default: no row = nothing shared)
--   family_invitations          invitations (hashed single-use token, expiry, status history)
--   family_devices              which of a member's OWN devices are linked into the family (the device row itself never moves)
--   family_device_transfers     the two-sided hand-over of a device from one member to another
--   family_audit_log            who did what to the family (survives the family: no foreign key on family_id)
--
-- Removing a member / leaving / dissolving a family deletes only rows of this migration. The users, devices, sessions and sync_documents of
-- version 1-4 are never touched by those operations.

CREATE TABLE families (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL,
  settings    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_by  uuid        REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT families_name_length CHECK (char_length(name) BETWEEN 1 AND 60),
  CONSTRAINT families_settings_is_object CHECK (jsonb_typeof(settings) = 'object')
);
CREATE TRIGGER families_touch BEFORE UPDATE ON families FOR EACH ROW EXECUTE FUNCTION petali_touch_updated_at();

CREATE TABLE family_members (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid        NOT NULL REFERENCES families (id) ON DELETE CASCADE,
  user_id     uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role        text        NOT NULL,
  is_owner    boolean     NOT NULL DEFAULT false,
  joined_at   timestamptz NOT NULL DEFAULT now(),
  invited_by  uuid        REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- The set of valid roles lives in the application (a role registry), so a future role needs no migration; the database only guards the shape.
  CONSTRAINT family_members_role_shape CHECK (role ~ '^[a-z][a-z_]{1,31}$'),
  CONSTRAINT family_members_owner_is_parent CHECK (NOT is_owner OR role = 'parent')
);
CREATE UNIQUE INDEX family_members_user_key ON family_members (user_id);                          -- an account belongs to at most one family
CREATE UNIQUE INDEX family_members_one_owner_key ON family_members (family_id) WHERE is_owner;    -- at most one owner per family
CREATE INDEX family_members_family_idx ON family_members (family_id);
CREATE TRIGGER family_members_touch BEFORE UPDATE ON family_members FOR EACH ROW EXECUTE FUNCTION petali_touch_updated_at();

-- A family can never be left without an owner (the owner is always a parent, so it can never be left without an administrator either).
-- Checked when the transaction commits, so an ownership transfer (two updates) and "create family + first member" (two inserts) are fine.
-- Deleting the whole family is fine too (the family row is gone by then). This is the database-level safety net; the service reports the friendly error first.
CREATE FUNCTION family_require_owner() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fid uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN fid := OLD.family_id; ELSE fid := NEW.family_id; END IF;
  IF EXISTS (SELECT 1 FROM families WHERE id = fid) AND NOT EXISTS (SELECT 1 FROM family_members WHERE family_id = fid AND is_owner) THEN
    RAISE EXCEPTION 'a family must always have an owner (transfer ownership first)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER family_members_require_owner AFTER INSERT OR UPDATE OR DELETE ON family_members
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION family_require_owner();

CREATE TABLE family_member_permissions (
  member_id   uuid        NOT NULL REFERENCES family_members (id) ON DELETE CASCADE,
  permission  text        NOT NULL,
  effect      text        NOT NULL,
  set_by      uuid        REFERENCES users (id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, permission),
  CONSTRAINT family_member_permissions_effect CHECK (effect IN ('grant', 'deny')),
  CONSTRAINT family_member_permissions_shape CHECK (permission ~ '^[A-Za-z][A-Za-z.]{1,63}$')
);

CREATE TABLE family_member_privacy (
  member_id       uuid        PRIMARY KEY REFERENCES family_members (id) ON DELETE CASCADE,
  schema_version  integer     NOT NULL DEFAULT 1,
  sharing         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT family_member_privacy_is_object CHECK (jsonb_typeof(sharing) = 'object')
);

CREATE TABLE family_invitations (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id                 uuid        NOT NULL REFERENCES families (id) ON DELETE CASCADE,
  invited_by                uuid        REFERENCES users (id) ON DELETE SET NULL,
  invitee_user_id           uuid        REFERENCES users (id) ON DELETE CASCADE,
  invitee_email_normalized  text,
  role                      text        NOT NULL,
  token_hash                text        NOT NULL,          -- SHA-256 of the invitation code; the code itself is never stored
  status                    text        NOT NULL DEFAULT 'pending',
  expires_at                timestamptz NOT NULL,
  email_sent_at             timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  responded_at              timestamptz,
  responded_by              uuid        REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT family_invitations_role_shape CHECK (role ~ '^[a-z][a-z_]{1,31}$'),
  CONSTRAINT family_invitations_status CHECK (status IN ('pending', 'accepted', 'declined', 'revoked', 'expired')),
  CONSTRAINT family_invitations_has_invitee CHECK (invitee_user_id IS NOT NULL OR invitee_email_normalized IS NOT NULL),
  CONSTRAINT family_invitations_responded CHECK ((status = 'pending') = (responded_at IS NULL))
);
CREATE UNIQUE INDEX family_invitations_token_key ON family_invitations (token_hash);
CREATE UNIQUE INDEX family_invitations_pending_user_key ON family_invitations (family_id, invitee_user_id) WHERE status = 'pending' AND invitee_user_id IS NOT NULL;
CREATE UNIQUE INDEX family_invitations_pending_email_key ON family_invitations (family_id, invitee_email_normalized) WHERE status = 'pending' AND invitee_email_normalized IS NOT NULL;
CREATE INDEX family_invitations_invitee_idx ON family_invitations (invitee_user_id, status) WHERE invitee_user_id IS NOT NULL;
CREATE INDEX family_invitations_email_idx ON family_invitations (invitee_email_normalized, status) WHERE invitee_email_normalized IS NOT NULL;
CREATE INDEX family_invitations_family_idx ON family_invitations (family_id, created_at DESC);

-- A device stays a row of "devices" owned by exactly one account. This table only says "its owner shows it to this family".
-- The trigger keeps the three ids consistent: the member must belong to the family and must be the account that owns the (not removed) device.
CREATE TABLE family_devices (
  device_id  uuid        PRIMARY KEY REFERENCES devices (id) ON DELETE CASCADE,
  family_id  uuid        NOT NULL REFERENCES families (id) ON DELETE CASCADE,
  member_id  uuid        NOT NULL REFERENCES family_members (id) ON DELETE CASCADE,
  linked_by  uuid        REFERENCES users (id) ON DELETE SET NULL,
  linked_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX family_devices_family_idx ON family_devices (family_id);
CREATE INDEX family_devices_member_idx ON family_devices (member_id);
CREATE FUNCTION family_devices_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM family_members m JOIN devices d ON d.user_id = m.user_id
                 WHERE m.id = NEW.member_id AND m.family_id = NEW.family_id AND d.id = NEW.device_id AND d.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'a family device must be an active device of the member that links it' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER family_devices_consistent BEFORE INSERT OR UPDATE ON family_devices FOR EACH ROW EXECUTE FUNCTION family_devices_check();

CREATE TABLE family_device_transfers (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid        NOT NULL REFERENCES families (id) ON DELETE CASCADE,
  device_id       uuid        NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  from_member_id  uuid        NOT NULL REFERENCES family_members (id) ON DELETE CASCADE,
  to_member_id    uuid        NOT NULL REFERENCES family_members (id) ON DELETE CASCADE,
  status          text        NOT NULL DEFAULT 'pending',
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  responded_at    timestamptz,
  CONSTRAINT family_device_transfers_status CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled', 'expired')),
  CONSTRAINT family_device_transfers_distinct CHECK (from_member_id <> to_member_id),
  CONSTRAINT family_device_transfers_responded CHECK ((status = 'pending') = (responded_at IS NULL))
);
CREATE UNIQUE INDEX family_device_transfers_pending_key ON family_device_transfers (device_id) WHERE status = 'pending';
CREATE INDEX family_device_transfers_family_idx ON family_device_transfers (family_id, created_at DESC);
CREATE INDEX family_device_transfers_to_idx ON family_device_transfers (to_member_id) WHERE status = 'pending';
CREATE INDEX family_device_transfers_from_idx ON family_device_transfers (from_member_id) WHERE status = 'pending';

-- Audit trail of sensitive family operations. family_id is deliberately NOT a foreign key: the history outlives a dissolved family.
-- It holds ids and short machine-readable details only: never emails, tokens, invitation codes or personal usage data.
-- audience 'family' = visible to members who may read the audit; 'actor' = visible only to the account that did it (e.g. its own privacy changes).
CREATE TABLE family_audit_log (
  id             bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  family_id      uuid        NOT NULL,
  actor_user_id  uuid        REFERENCES users (id) ON DELETE SET NULL,
  target_user_id uuid        REFERENCES users (id) ON DELETE SET NULL,
  action         text        NOT NULL,
  audience       text        NOT NULL DEFAULT 'family',
  detail         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  ip_address     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT family_audit_log_action CHECK (char_length(action) BETWEEN 1 AND 64),
  CONSTRAINT family_audit_log_audience CHECK (audience IN ('family', 'actor')),
  CONSTRAINT family_audit_log_detail_is_object CHECK (jsonb_typeof(detail) = 'object')
);
CREATE INDEX family_audit_log_family_idx ON family_audit_log (family_id, id DESC);
CREATE INDEX family_audit_log_created_idx ON family_audit_log (created_at);
