-- @migration 005 M5 Dynamic Payment Configuration
-- @table payment_configurations: One row per version of each fee. The app charges whichever version is active at payment time.
CREATE TABLE payment_configurations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key (one per version)
  fee_code text NOT NULL CHECK (fee_code IN ('TEACHER_REGISTRATION','INSTITUTE_REGISTRATION','PARENT_SUBSCRIPTION_MONTHLY','PARENT_SUBSCRIPTION_YEARLY','STUDENT_SUBSCRIPTION_MONTHLY','STUDENT_SUBSCRIPTION_YEARLY','PREMIUM_TEACHER','FEATURED_TEACHER','CONTACT_UNLOCK')), -- Which fee this row prices
  version integer NOT NULL CHECK (version > 0), -- 1, 2, 3… per fee_code
  name text NOT NULL, -- Display name shown to users, e.g. Parent Membership (Monthly)
  description text, -- Short description shown on the pricing screen
  is_enabled boolean NOT NULL DEFAULT true, -- false = fee switched off; the app hides the purchase and skips the payment step
  amount_paise bigint NOT NULL CHECK (amount_paise >= 0), -- Price in paise (₹499 = 49900)
  currency char(3) NOT NULL DEFAULT 'INR', -- ISO 4217 currency
  gst_inclusive boolean NOT NULL DEFAULT true, -- true = amount already includes GST
  gst_rate_bps integer NOT NULL DEFAULT 1800 CHECK (gst_rate_bps BETWEEN 0 AND 2800), -- GST in basis points (18% = 1800)
  billing_period text NOT NULL CHECK (billing_period IN ('one_time','monthly','quarterly','yearly','per_30_days','per_use')), -- How often it is charged
  validity_days integer CHECK (validity_days IS NULL OR validity_days > 0), -- Access length after payment (NULL for per_use)
  trial_days integer NOT NULL DEFAULT 0 CHECK (trial_days BETWEEN 0 AND 90), -- Free trial before first charge (subscriptions only)
  effective_from timestamptz NOT NULL, -- When this version starts applying
  effective_to timestamptz, -- Set automatically when a newer version becomes effective
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','active','superseded','cancelled')), -- Lifecycle of the version
  change_reason text, -- Required note explaining the change
  published_by uuid REFERENCES admins(id), -- Admin who published
  published_at timestamptz, -- When published
  created_by uuid REFERENCES admins(id), -- Creator of the draft
  updated_by uuid REFERENCES admins(id), -- Last editor
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Last updated
  CONSTRAINT ck_payment_config_period CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE UNIQUE INDEX uq_payment_config_version ON payment_configurations (fee_code, version);
CREATE UNIQUE INDEX uq_payment_config_one_active ON payment_configurations (fee_code) WHERE status = 'active';
CREATE UNIQUE INDEX uq_payment_config_one_draft ON payment_configurations (fee_code) WHERE status = 'draft';
CREATE INDEX idx_payment_config_lookup ON payment_configurations (fee_code, effective_from DESC) WHERE status IN ('active','scheduled');
CREATE TRIGGER trg_payment_configurations_updated BEFORE UPDATE ON payment_configurations FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- @table payment_configuration_history: Immutable change log for payment configurations (create, edit, publish, cancel, activate, supersede).
CREATE TABLE payment_configuration_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  payment_configuration_id uuid NOT NULL REFERENCES payment_configurations(id) ON DELETE RESTRICT, -- Version that changed
  fee_code text NOT NULL, -- Denormalised for fast filtering
  action text NOT NULL CHECK (action IN ('created','updated','published','scheduled','activated','superseded','cancelled','enabled','disabled')), -- What happened
  old_values jsonb, -- Fields before the change
  new_values jsonb, -- Fields after the change
  reason text, -- Admin's reason
  changed_by uuid REFERENCES admins(id), -- NULL when the scheduler activated a version
  created_at timestamptz NOT NULL DEFAULT now() -- When
);
CREATE INDEX idx_payment_config_history_fee ON payment_configuration_history (fee_code, created_at DESC);
CREATE INDEX idx_payment_config_history_config ON payment_configuration_history (payment_configuration_id, created_at DESC);
