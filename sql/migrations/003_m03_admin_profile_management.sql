-- @migration 003 M3 Admin Profile Management
-- @table admin_profiles: Personal details for an admin, one-to-one with admins.
CREATE TABLE admin_profiles (
  admin_id uuid PRIMARY KEY REFERENCES admins(id) ON DELETE CASCADE, -- One-to-one with admins
  display_name text, -- Optional short name shown in the top bar
  phone text, -- E.164 phone number
  designation text, -- Job title, e.g. Verification Lead
  avatar_file_id uuid REFERENCES files(id), -- Profile image (public CDN file)
  timezone text NOT NULL DEFAULT 'Asia/Kolkata', -- IANA time zone used to display dates
  locale text NOT NULL DEFAULT 'en-IN', -- UI locale
  theme text NOT NULL DEFAULT 'system' CHECK (theme IN ('light','dark','system')), -- UI theme preference
  notification_prefs jsonb NOT NULL DEFAULT '{"email_digest":true,"queue_alerts":true}'::jsonb, -- Email/alert preferences
  updated_at timestamptz NOT NULL DEFAULT now() -- Last updated
);
CREATE TRIGGER trg_admin_profiles_updated BEFORE UPDATE ON admin_profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();
