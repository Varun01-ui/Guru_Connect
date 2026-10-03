-- @migration 040 M40 Transactions
CREATE SEQUENCE seq_transaction_code START 7000001; -- generates transactions.public_code
-- @table transactions: Every payment attempt through Razorpay, plus refunds and reward payouts. Amounts in paise.
CREATE TABLE transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  public_code text NOT NULL DEFAULT ('TXN-' || nextval('seq_transaction_code')), -- e.g. TXN-7702137 (shown to users and support)
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT, -- Payer or payee
  payer_type text NOT NULL CHECK (payer_type IN ('parent','student','teacher','institute')), -- Payer role
  institute_id uuid REFERENCES institutes(id) ON DELETE RESTRICT, -- Set for institute payments
  purpose text NOT NULL CHECK (purpose IN ('teacher_registration','institute_registration','subscription','premium_listing','featured_listing','contact_unlock','referral_payout')), -- What was bought / paid out
  direction text NOT NULL DEFAULT 'credit' CHECK (direction IN ('credit','debit')), -- credit = money in to GuruConnect; debit = payout
  payment_configuration_id uuid REFERENCES payment_configurations(id) ON DELETE RESTRICT, -- Price version charged (NULL for payouts)
  fee_code text, -- Snapshot of fee_code
  amount_paise bigint NOT NULL CHECK (amount_paise >= 0), -- Total charged incl. GST
  base_amount_paise bigint NOT NULL CHECK (base_amount_paise >= 0), -- Amount before GST
  gst_paise bigint NOT NULL DEFAULT 0 CHECK (gst_paise >= 0), -- GST component
  discount_paise bigint NOT NULL DEFAULT 0 CHECK (discount_paise >= 0), -- Referral / promo discount applied
  currency char(3) NOT NULL DEFAULT 'INR', -- Currency
  status text NOT NULL DEFAULT 'created' CHECK (status IN ('created','authorized','captured','failed','refund_pending','refunded','partially_refunded','cancelled')), -- Lifecycle
  gateway text NOT NULL DEFAULT 'razorpay' CHECK (gateway IN ('razorpay','manual','wallet')), -- Processor
  gateway_order_id text, -- Razorpay order_xxx
  gateway_payment_id text, -- Razorpay pay_xxx
  method text CHECK (method IN ('upi','card','netbanking','wallet','emi','manual')), -- Payment method
  failure_code text, -- Gateway error code
  failure_reason text, -- Gateway error description
  refunded_amount_paise bigint NOT NULL DEFAULT 0 CHECK (refunded_amount_paise >= 0), -- Total refunded
  invoice_number text, -- GST invoice number, e.g. GC/2026-27/000412
  captured_at timestamptz, -- When money was captured
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb, -- Extra context, e.g. {"subscription_id":"…","lead_id":"…"}
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Updated
  CONSTRAINT ck_transactions_refund CHECK (refunded_amount_paise <= amount_paise)
);
CREATE UNIQUE INDEX uq_transactions_public_code ON transactions (public_code);
CREATE UNIQUE INDEX uq_transactions_gateway_order ON transactions (gateway_order_id) WHERE gateway_order_id IS NOT NULL;
CREATE UNIQUE INDEX uq_transactions_gateway_payment ON transactions (gateway_payment_id) WHERE gateway_payment_id IS NOT NULL;
CREATE UNIQUE INDEX uq_transactions_invoice ON transactions (invoice_number) WHERE invoice_number IS NOT NULL;
CREATE INDEX idx_transactions_user ON transactions (user_id, created_at DESC);
CREATE INDEX idx_transactions_status_created ON transactions (status, created_at DESC);
CREATE INDEX idx_transactions_purpose_captured ON transactions (purpose, captured_at) WHERE status IN ('captured','partially_refunded','refunded');
CREATE TRIGGER trg_transactions_updated BEFORE UPDATE ON transactions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE teachers ADD CONSTRAINT fk_teachers_registration_txn FOREIGN KEY (registration_transaction_id) REFERENCES transactions(id) ON DELETE SET NULL;
ALTER TABLE institutes ADD CONSTRAINT fk_institutes_registration_txn FOREIGN KEY (registration_transaction_id) REFERENCES transactions(id) ON DELETE SET NULL;
ALTER TABLE leads ADD CONSTRAINT fk_leads_unlock_txn FOREIGN KEY (unlock_transaction_id) REFERENCES transactions(id) ON DELETE SET NULL;

-- @table refunds: Refund requests and their gateway processing.
CREATE TABLE refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  transaction_id uuid NOT NULL REFERENCES transactions(id) ON DELETE RESTRICT, -- Original payment
  amount_paise bigint NOT NULL CHECK (amount_paise > 0), -- Amount to refund
  reason_code text NOT NULL CHECK (reason_code IN ('teacher_rejected','institute_rejected','duplicate_charge','service_not_started','user_request','goodwill','other')), -- Why
  reason_note text, -- Details
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','processing','processed','denied','failed')), -- Lifecycle
  gateway_refund_id text, -- Razorpay rfnd_xxx
  requested_by_type text NOT NULL CHECK (requested_by_type IN ('app_user','admin','system')), -- Who asked
  requested_by_id uuid, -- Requester id
  decided_by uuid REFERENCES admins(id), -- Approver / denier
  decided_at timestamptz, -- Decision time
  denial_reason text, -- Shown to the user
  processed_at timestamptz, -- Gateway confirmed
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now() -- Updated
);
CREATE UNIQUE INDEX uq_refunds_gateway ON refunds (gateway_refund_id) WHERE gateway_refund_id IS NOT NULL;
CREATE INDEX idx_refunds_status ON refunds (status, created_at);
CREATE INDEX idx_refunds_transaction ON refunds (transaction_id);
CREATE TRIGGER trg_refunds_updated BEFORE UPDATE ON refunds FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- @table payment_webhook_events: Raw Razorpay webhooks, stored before processing so every event is processed exactly once.
CREATE TABLE payment_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  gateway text NOT NULL DEFAULT 'razorpay', -- Source
  event_id text NOT NULL, -- Gateway event id (x-razorpay-event-id)
  event_type text NOT NULL, -- e.g. payment.captured, refund.processed
  payload jsonb NOT NULL, -- Full body
  signature_valid boolean NOT NULL, -- HMAC check result
  processed_at timestamptz, -- NULL until processed
  processing_error text, -- Last error
  attempts smallint NOT NULL DEFAULT 0, -- Processing attempts
  received_at timestamptz NOT NULL DEFAULT now() -- Received
);
CREATE UNIQUE INDEX uq_payment_webhook_events ON payment_webhook_events (gateway, event_id);
CREATE INDEX idx_payment_webhook_unprocessed ON payment_webhook_events (received_at) WHERE processed_at IS NULL;
