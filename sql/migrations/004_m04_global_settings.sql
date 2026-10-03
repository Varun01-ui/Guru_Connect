-- @migration 004 M4 Global Settings
-- @table system_settings: Typed key–value settings that change platform behaviour without a deploy.
CREATE TABLE system_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  key text NOT NULL, -- Dotted key, e.g. platform.name, support.email, app.min_android_version
  group_name text NOT NULL, -- UI group: general, contact, legal, app_versions, limits
  value jsonb NOT NULL, -- Value wrapped in JSON, e.g. "GuruConnect", 3, true
  value_type text NOT NULL CHECK (value_type IN ('string','number','boolean','url','email','phone','semver','json')), -- Drives validation and the input control
  label text NOT NULL, -- Label in the settings form
  description text, -- Help text under the input
  is_public boolean NOT NULL DEFAULT false, -- true = exposed to the mobile app via GET /public/settings
  is_editable boolean NOT NULL DEFAULT true, -- false = read-only in the UI (managed by deploys)
  updated_by uuid REFERENCES admins(id), -- Last editor
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now() -- Last updated
);
CREATE UNIQUE INDEX uq_system_settings_key ON system_settings (key);
CREATE INDEX idx_system_settings_group ON system_settings (group_name);
CREATE TRIGGER trg_system_settings_updated BEFORE UPDATE ON system_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
