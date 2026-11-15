-- Petali Cloud, schema version 3: device management (Petali 1.5.0 Phase 3). ADDITIVE ONLY: nothing of versions 1 and 2 is
-- dropped, renamed, retyped or rewritten, and every new column has a default or allows NULL, so existing rows stay valid.
--
--   name_customized    true once the USER renamed the device. From then on the app's automatic registration (which sends the
--                      computer's host name) can never overwrite the name again.
--   name_updated_at    client time of the last user rename (last writer wins, like account settings); NULL = never renamed.
--   history_purged_at  set when the user removed the device AND chose to delete its cloud history. A removed device whose
--                      history was NOT purged can still be restored from (claimed by a reinstalled computer).
-- Removal itself uses the existing devices.revoked_at column (a removed device is revoked, never hard-deleted).
ALTER TABLE devices ADD COLUMN name_customized   boolean     NOT NULL DEFAULT false;
ALTER TABLE devices ADD COLUMN name_updated_at   timestamptz;
ALTER TABLE devices ADD COLUMN history_purged_at timestamptz;
ALTER TABLE devices ADD CONSTRAINT devices_purged_requires_removed CHECK (history_purged_at IS NULL OR revoked_at IS NOT NULL);

-- Which signed-in session belongs to which device (sessions.device_id already exists since version 1 but was never filled).
-- Removing a device ends the sessions bound to it.
CREATE INDEX sessions_device_idx ON sessions (device_id) WHERE device_id IS NOT NULL AND revoked_at IS NULL;
