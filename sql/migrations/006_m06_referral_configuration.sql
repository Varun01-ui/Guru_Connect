-- @migration 006 M6 Referral Configuration
-- @table referral_settings: Versioned rules for each referral program. One active version per program.
CREATE TABLE referral_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key (one per version)
  program_code text NOT NULL CHECK (program_code IN ('LEARNER_REFERRAL','TEACHER_REFERRAL','INSTITUTE_REFERRAL')), -- Which program
  version integer NOT NULL CHECK (version > 0), -- Version number per program
  is_enabled boolean NOT NULL DEFAULT true, -- Program on/off; when off, codes still resolve but earn nothing
  referrer_reward_paise bigint NOT NULL DEFAULT 0 CHECK (referrer_reward_paise >= 0), -- Credited to the person who invited
  referee_reward_paise bigint NOT NULL DEFAULT 0 CHECK (referee_reward_paise >= 0), -- Discount or credit for the new user
  reward_type text NOT NULL DEFAULT 'wallet_credit' CHECK (reward_type IN ('wallet_credit','discount','cashback')), -- How rewards are delivered
  qualifying_event text NOT NULL CHECK (qualifying_event IN ('signup','first_payment','teacher_approved','institute_approved')), -- Event that makes a referral count
  min_payment_paise bigint NOT NULL DEFAULT 0 CHECK (min_payment_paise >= 0), -- Minimum first payment for payment-based programs
  max_rewards_per_referrer integer CHECK (max_rewards_per_referrer IS NULL OR max_rewards_per_referrer > 0), -- Lifetime cap per referrer (NULL = no cap)
  max_rewards_per_month integer CHECK (max_rewards_per_month IS NULL OR max_rewards_per_month > 0), -- Monthly cap per referrer
  reward_hold_days integer NOT NULL DEFAULT 7 CHECK (reward_hold_days BETWEEN 0 AND 90), -- Days a reward stays pending for fraud checks / refunds
  code_expiry_days integer CHECK (code_expiry_days IS NULL OR code_expiry_days > 0), -- Days a referee has to sign up after first opening the link
  block_same_device boolean NOT NULL DEFAULT true, -- Reject if referrer and referee share a device fingerprint
  block_same_payment_method boolean NOT NULL DEFAULT true, -- Reject if they share a payment instrument
  terms_text text, -- Terms shown on the referral screen
  effective_from timestamptz NOT NULL DEFAULT now(), -- When this version applies
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','superseded')), -- Version lifecycle
  change_reason text, -- Why it changed
  created_by uuid REFERENCES admins(id), -- Creator
  updated_by uuid REFERENCES admins(id), -- Last editor
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now() -- Last updated
);
CREATE UNIQUE INDEX uq_referral_settings_version ON referral_settings (program_code, version);
CREATE UNIQUE INDEX uq_referral_settings_one_active ON referral_settings (program_code) WHERE status = 'active';
CREATE UNIQUE INDEX uq_referral_settings_one_draft ON referral_settings (program_code) WHERE status = 'draft';
CREATE TRIGGER trg_referral_settings_updated BEFORE UPDATE ON referral_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
