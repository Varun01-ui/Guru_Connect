-- @migration 042 M42 Referral Management
-- @table referral_codes: One personal referral code per app user.
CREATE TABLE referral_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  user_id uuid REFERENCES app_users(id) ON DELETE CASCADE, -- Owner; NULL for admin campaign codes
  code text NOT NULL, -- Upper-case code, e.g. LAKSHMI50
  program_code text NOT NULL CHECK (program_code IN ('LEARNER_REFERRAL','TEACHER_REFERRAL','INSTITUTE_REFERRAL')), -- Program
  campaign_name text, -- For admin-created campaign codes
  usage_limit integer CHECK (usage_limit IS NULL OR usage_limit > 0), -- Max sign-ups (campaign codes)
  expires_at timestamptz, -- Campaign expiry
  is_active boolean NOT NULL DEFAULT true, -- Disabled codes stop working
  created_by uuid REFERENCES admins(id), -- Admin creator (campaign codes)
  created_at timestamptz NOT NULL DEFAULT now() -- Created
);
CREATE UNIQUE INDEX uq_referral_codes_code ON referral_codes (upper(code));
CREATE UNIQUE INDEX uq_referral_codes_user_program ON referral_codes (user_id, program_code) WHERE user_id IS NOT NULL;

-- @table referrals: One row per referred user, tracking qualification, fraud checks and reward payout.
CREATE TABLE referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  referral_code_id uuid NOT NULL REFERENCES referral_codes(id) ON DELETE RESTRICT, -- Code used
  referrer_user_id uuid REFERENCES app_users(id) ON DELETE SET NULL, -- Who invited (NULL for campaign codes)
  referee_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT, -- Who joined
  referral_setting_id uuid NOT NULL REFERENCES referral_settings(id) ON DELETE RESTRICT, -- Rules version applied
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','qualified','on_hold','rewarded','rejected','expired','reversed')), -- Lifecycle
  qualified_at timestamptz, -- Qualifying event time
  qualifying_transaction_id uuid REFERENCES transactions(id) ON DELETE SET NULL, -- Payment that qualified it
  reward_amount_paise bigint NOT NULL DEFAULT 0 CHECK (reward_amount_paise >= 0), -- Referrer reward
  referee_reward_paise bigint NOT NULL DEFAULT 0 CHECK (referee_reward_paise >= 0), -- Referee reward/discount
  reward_release_at timestamptz, -- End of hold period
  reward_transaction_id uuid REFERENCES transactions(id) ON DELETE SET NULL, -- Payout record
  fraud_score numeric(4,3) CHECK (fraud_score BETWEEN 0 AND 1), -- Automated risk score
  fraud_flags text[] NOT NULL DEFAULT '{}', -- e.g. {same_device, burst_signups, disposable_number}
  reviewed_by uuid REFERENCES admins(id), -- Admin who reviewed a held referral
  reviewed_at timestamptz, -- Review time
  rejection_reason text, -- Why rejected / reversed
  created_at timestamptz NOT NULL DEFAULT now(), -- Created (referee signed up)
  updated_at timestamptz NOT NULL DEFAULT now() -- Updated
);
CREATE UNIQUE INDEX uq_referrals_referee ON referrals (referee_user_id);
CREATE INDEX idx_referrals_referrer ON referrals (referrer_user_id, created_at DESC);
CREATE INDEX idx_referrals_status ON referrals (status, created_at DESC);
CREATE INDEX idx_referrals_release ON referrals (reward_release_at) WHERE status = 'qualified';
CREATE TRIGGER trg_referrals_updated BEFORE UPDATE ON referrals FOR EACH ROW EXECUTE FUNCTION set_updated_at();
