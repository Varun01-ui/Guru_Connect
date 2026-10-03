-- @migration 041 M41 Subscription Payments
-- @table subscriptions: Paid access periods for parents, students, teachers and institutes, including trials.
CREATE TABLE subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT, -- Subscriber account
  subscriber_type text NOT NULL CHECK (subscriber_type IN ('parent','student','teacher','institute')), -- Role
  institute_id uuid REFERENCES institutes(id) ON DELETE RESTRICT, -- For institute registrations
  fee_code text NOT NULL, -- Plan, e.g. PARENT_SUBSCRIPTION_YEARLY, TEACHER_REGISTRATION
  payment_configuration_id uuid REFERENCES payment_configurations(id) ON DELETE RESTRICT, -- Price version at purchase (NULL for trials)
  price_paise bigint NOT NULL DEFAULT 0 CHECK (price_paise >= 0), -- Price locked for this period
  status text NOT NULL CHECK (status IN ('trial','active','grace','expired','cancelled','free_access')), -- free_access = fee switched off by admin
  trial_ends_at timestamptz, -- End of free trial
  starts_at timestamptz NOT NULL, -- Period start
  ends_at timestamptz, -- Period end (NULL for free_access)
  auto_renew boolean NOT NULL DEFAULT false, -- UPI Autopay / card mandate active
  gateway_subscription_id text, -- Razorpay sub_xxx when auto-renew
  last_transaction_id uuid REFERENCES transactions(id) ON DELETE SET NULL, -- Most recent payment
  renewal_reminder_sent_at timestamptz, -- 7-day reminder sent
  cancelled_at timestamptz, -- Cancellation time
  cancel_reason text, -- Why
  cancelled_by_type text CHECK (cancelled_by_type IN ('user','admin','system')), -- Who cancelled
  granted_by uuid REFERENCES admins(id), -- Admin who granted/extended manually (complimentary access)
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Updated
  CONSTRAINT ck_subscriptions_period CHECK (ends_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX idx_subscriptions_user ON subscriptions (user_id, created_at DESC);
CREATE UNIQUE INDEX uq_subscriptions_one_live ON subscriptions (user_id, subscriber_type) WHERE status IN ('trial','active','grace','free_access');
CREATE INDEX idx_subscriptions_expiry ON subscriptions (ends_at) WHERE status IN ('trial','active','grace');
CREATE INDEX idx_subscriptions_type_status ON subscriptions (subscriber_type, status);
CREATE TRIGGER trg_subscriptions_updated BEFORE UPDATE ON subscriptions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
