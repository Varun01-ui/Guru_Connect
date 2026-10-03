-- @migration 001 M1 Authentication System
-- @table admins: Admin web portal accounts. Every admin action is attributed to a row here.
CREATE TABLE admins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  email citext NOT NULL, -- Login email, unique among non-deleted admins
  password_hash text NOT NULL, -- Argon2id hash (never returned by any API)
  full_name text NOT NULL, -- Display name, 2–100 chars
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('invited','active','locked','disabled')), -- invited = must set password; locked = too many failed logins; disabled = access removed
  is_super_admin boolean NOT NULL DEFAULT false, -- Bypasses permission checks; at least one active super admin must always exist
  failed_login_count smallint NOT NULL DEFAULT 0, -- Consecutive failed logins; reset on success
  locked_until timestamptz, -- Login blocked until this time after 5 failures
  last_login_at timestamptz, -- Last successful login
  last_login_ip inet, -- IP of the last successful login
  password_changed_at timestamptz NOT NULL DEFAULT now(), -- Used to invalidate tokens issued before a password change
  mfa_enabled boolean NOT NULL DEFAULT false, -- Reserved for TOTP (future)
  created_by uuid REFERENCES admins(id), -- Admin who created this account
  updated_by uuid REFERENCES admins(id), -- Admin who last updated this account
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Last updated
  deleted_at timestamptz, -- Soft delete
  deleted_by uuid REFERENCES admins(id) -- Admin who deleted this account
);
CREATE UNIQUE INDEX uq_admins_email ON admins (email) WHERE deleted_at IS NULL;
CREATE INDEX idx_admins_status ON admins (status) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_admins_updated BEFORE UPDATE ON admins FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- @table admin_sessions: One row per signed-in device. Holds the hashed refresh token used to mint new access tokens.
CREATE TABLE admin_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Session id; also the "sid" claim in access tokens
  admin_id uuid NOT NULL REFERENCES admins(id) ON DELETE CASCADE, -- Session owner
  refresh_token_hash text NOT NULL, -- SHA-256 of the current refresh token (the raw token is only in the httpOnly cookie)
  token_family uuid NOT NULL DEFAULT gen_random_uuid(), -- Rotation family; reuse of an old token revokes the whole family
  previous_token_hash text, -- Hash of the token that was rotated out, used for reuse detection
  ip_address inet, -- IP at sign-in
  user_agent text, -- Browser user agent at sign-in
  device_label text, -- Parsed label, e.g. "Chrome on Windows"
  last_used_at timestamptz NOT NULL DEFAULT now(), -- Last refresh
  expires_at timestamptz NOT NULL, -- Absolute expiry (7 days, or 30 with "keep me signed in")
  revoked_at timestamptz, -- Set on logout, password change or forced sign-out
  revoked_reason text CHECK (revoked_reason IN ('logout','logout_all','password_changed','token_reuse','admin_forced','expired','account_disabled')), -- Why it was revoked
  created_at timestamptz NOT NULL DEFAULT now() -- Sign-in time
);
CREATE UNIQUE INDEX uq_admin_sessions_token ON admin_sessions (refresh_token_hash);
CREATE INDEX idx_admin_sessions_admin_active ON admin_sessions (admin_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_admin_sessions_prev_token ON admin_sessions (previous_token_hash) WHERE previous_token_hash IS NOT NULL;

-- @table password_reset_tokens: Single-use, 30-minute tokens for the forgot-password and invite flows.
CREATE TABLE password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  admin_id uuid NOT NULL REFERENCES admins(id) ON DELETE CASCADE, -- Account being reset
  token_hash text NOT NULL, -- SHA-256 of the emailed token
  purpose text NOT NULL DEFAULT 'reset' CHECK (purpose IN ('reset','invite')), -- invite tokens live 72 hours
  expires_at timestamptz NOT NULL, -- Expiry
  used_at timestamptz, -- Set when consumed; a used token can never be reused
  requested_ip inet, -- IP that requested the reset
  created_at timestamptz NOT NULL DEFAULT now() -- Created
);
CREATE UNIQUE INDEX uq_password_reset_tokens_hash ON password_reset_tokens (token_hash);
CREATE INDEX idx_password_reset_tokens_admin ON password_reset_tokens (admin_id, created_at DESC);
