-- Petali Cloud, schema version 2: cloud sync. ADDITIVE ONLY: no column or table of version 1 is dropped, renamed or rewritten.

-- A device is a Petali installation on one computer. client_device_id is chosen by the app (random UUID stored in
-- the app's data folder); the server id stays internal. epoch goes up when another computer takes the device over
-- (restore), which makes the old computer's later uploads fail instead of overwriting.
ALTER TABLE devices ADD COLUMN client_device_id text;
ALTER TABLE devices ADD COLUMN epoch           integer NOT NULL DEFAULT 1;
ALTER TABLE devices ADD COLUMN hardware        jsonb;
ALTER TABLE devices ADD COLUMN last_sync_at    timestamptz;
ALTER TABLE devices ADD CONSTRAINT devices_client_id_format CHECK (client_device_id IS NULL OR client_device_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
ALTER TABLE devices ADD CONSTRAINT devices_hardware_is_object CHECK (hardware IS NULL OR jsonb_typeof(hardware) = 'object');
CREATE UNIQUE INDEX devices_user_client_key ON devices (user_id, client_device_id) WHERE client_device_id IS NOT NULL;

CREATE SEQUENCE sync_change_seq;

-- One row per synchronised document. device_id NULL = account-wide document (settings), otherwise it belongs to that device.
CREATE TABLE sync_documents (
  id                 bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id            uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  device_id          uuid        REFERENCES devices (id) ON DELETE CASCADE,
  kind               text        NOT NULL,
  doc_key            text        NOT NULL,
  data               jsonb,
  deleted            boolean     NOT NULL DEFAULT false,
  data_hash          text        NOT NULL,
  size_bytes         integer     NOT NULL DEFAULT 0,
  client_updated_at  timestamptz NOT NULL,
  written_by_device  uuid        REFERENCES devices (id) ON DELETE SET NULL,
  change_seq         bigint      NOT NULL DEFAULT nextval('sync_change_seq'),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sync_documents_kind_length CHECK (char_length(kind) BETWEEN 1 AND 32),
  CONSTRAINT sync_documents_key_length CHECK (char_length(doc_key) BETWEEN 1 AND 120),
  CONSTRAINT sync_documents_deleted_has_no_data CHECK (NOT deleted OR data IS NULL)
);
CREATE UNIQUE INDEX sync_documents_identity_key ON sync_documents (user_id, (COALESCE(device_id, '00000000-0000-0000-0000-000000000000'::uuid)), kind, doc_key);
CREATE INDEX sync_documents_feed_idx ON sync_documents (user_id, change_seq);
CREATE INDEX sync_documents_device_idx ON sync_documents (user_id, device_id, kind);
CREATE TRIGGER sync_documents_touch BEFORE UPDATE ON sync_documents FOR EACH ROW EXECUTE FUNCTION petali_touch_updated_at();
