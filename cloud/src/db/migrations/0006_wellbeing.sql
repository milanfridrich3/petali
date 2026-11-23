-- Petali Cloud, schema version 6: Petali Family, Stage 3 "Digital Wellbeing" (Petali 1.5.0). ADDITIVE ONLY: nothing of versions 1-5 is altered.
--
-- family_wellbeing_rules  one row per rule of one family member (the SUBJECT: the person whose computer evaluates it).
--   kind    'limit'    daily usage limit (total Active Work, one category or one application; optionally only some computers)
--           'schedule' time window on selected weekdays in which usage is not intended (evaluated in the computer's LOCAL time)
--           'break'    break reminder settings (at most one per member)
--   config  the validated rule body (the application validates the shape per kind; the database guards only that it is an object)
--   status  'active'   the member has it (created by the member, or accepted by the member)
--           'pending'  proposed by another member (needs wellbeing.manage) and not yet accepted by the subject: it is NEVER delivered to a computer
--   pending_config / pending_by   a proposed CHANGE of an active rule; the active config stays in force until the subject accepts it
--   proposed_by NULL = created by the subject; otherwise the account that proposed it (consent-based: nobody can switch rules on for somebody else)
-- Removing a member / leaving / dissolving the family removes the rules (ON DELETE CASCADE). The synced usage documents are untouched.

CREATE TABLE family_wellbeing_rules (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid        NOT NULL REFERENCES families (id) ON DELETE CASCADE,
  member_id       uuid        NOT NULL REFERENCES family_members (id) ON DELETE CASCADE,
  kind            text        NOT NULL,
  config          jsonb       NOT NULL,
  status          text        NOT NULL DEFAULT 'active',
  proposed_by     uuid        REFERENCES users (id) ON DELETE SET NULL,
  pending_config  jsonb,
  pending_by      uuid        REFERENCES users (id) ON DELETE SET NULL,
  version         integer     NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT family_wellbeing_rules_kind CHECK (kind IN ('limit', 'schedule', 'break')),
  CONSTRAINT family_wellbeing_rules_status CHECK (status IN ('active', 'pending')),
  CONSTRAINT family_wellbeing_rules_config_object CHECK (jsonb_typeof(config) = 'object'),
  CONSTRAINT family_wellbeing_rules_pending_object CHECK (pending_config IS NULL OR jsonb_typeof(pending_config) = 'object'),
  CONSTRAINT family_wellbeing_rules_pending_status CHECK (status = 'active' OR pending_config IS NULL)
);
CREATE INDEX family_wellbeing_rules_member_idx ON family_wellbeing_rules (member_id, kind);
CREATE INDEX family_wellbeing_rules_family_idx ON family_wellbeing_rules (family_id);
CREATE UNIQUE INDEX family_wellbeing_rules_one_break_key ON family_wellbeing_rules (member_id, status) WHERE kind = 'break';
CREATE TRIGGER family_wellbeing_rules_touch BEFORE UPDATE ON family_wellbeing_rules FOR EACH ROW EXECUTE FUNCTION petali_touch_updated_at();

-- A rule's subject must belong to the rule's family (the same family the member row says).
CREATE FUNCTION family_wellbeing_rules_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM family_members WHERE id = NEW.member_id AND family_id = NEW.family_id) THEN
    RAISE EXCEPTION 'the rule subject is not a member of the rule family' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER family_wellbeing_rules_family_check BEFORE INSERT ON family_wellbeing_rules FOR EACH ROW EXECUTE FUNCTION family_wellbeing_rules_check();
