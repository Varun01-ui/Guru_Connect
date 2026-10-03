-- Extension migration (not part of the original 51-module spec): mobile OTP login for admins.
-- Uses admin_profiles.phone (Module 3) as the number an admin verifies against.
-- The `code` column is stored in plaintext deliberately: there is no SMS gateway wired up yet,
-- so the code is shown on screen and in GET /auth/otp/logs as a development-only stand-in for
-- an SMS provider. Replace with a hashed code + real gateway before production use.

CREATE TABLE admin_otp_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  phone text NOT NULL,
  code text NOT NULL,
  purpose text NOT NULL DEFAULT 'login' CHECK (purpose IN ('login')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'expired')),
  attempts smallint NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  verified_at timestamptz,
  requested_ip inet,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_admin_otp_codes_admin ON admin_otp_codes (admin_id, created_at DESC);
CREATE INDEX idx_admin_otp_codes_phone ON admin_otp_codes (phone, created_at DESC);
