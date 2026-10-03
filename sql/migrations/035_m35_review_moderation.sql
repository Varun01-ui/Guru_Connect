-- @migration 035 M35 Review Moderation
-- @table review_flags: Reports raised against a review by users or teachers.
CREATE TABLE review_flags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  review_type text NOT NULL CHECK (review_type IN ('teacher','institute')), -- Which review table
  review_id uuid NOT NULL, -- teacher_reviews.id or institute_reviews.id (polymorphic; integrity enforced in the service)
  reporter_user_id uuid REFERENCES app_users(id) ON DELETE SET NULL, -- Who reported
  reason text NOT NULL CHECK (reason IN ('fake','abusive','personal_details','off_topic','spam','other')), -- Reason
  details text, -- Optional details
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','upheld','dismissed')), -- Outcome
  resolved_by uuid REFERENCES admins(id), -- Moderator
  resolved_at timestamptz, -- When resolved
  created_at timestamptz NOT NULL DEFAULT now() -- Created
);
CREATE UNIQUE INDEX uq_review_flags_reporter ON review_flags (review_type, review_id, reporter_user_id) WHERE reporter_user_id IS NOT NULL;
CREATE INDEX idx_review_flags_open ON review_flags (status, created_at) WHERE status = 'open';
CREATE INDEX idx_review_flags_review ON review_flags (review_type, review_id);

-- @table review_moderation_logs: Every moderation decision on reviews and replies.
CREATE TABLE review_moderation_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  review_type text NOT NULL CHECK (review_type IN ('teacher','institute')), -- Which review table
  review_id uuid NOT NULL, -- Review id
  target text NOT NULL DEFAULT 'review' CHECK (target IN ('review','reply')), -- Review text or the reply
  action text NOT NULL CHECK (action IN ('approved','rejected','flagged','unflagged','hidden','restored','auto_flagged','auto_approved')), -- Decision
  from_status text, -- Before
  to_status text, -- After
  reason_code text, -- e.g. CONTACT_DETAILS
  note text, -- Moderator note
  admin_id uuid REFERENCES admins(id), -- NULL for automated actions
  created_at timestamptz NOT NULL DEFAULT now() -- When
);
CREATE INDEX idx_review_moderation_logs_review ON review_moderation_logs (review_type, review_id, created_at DESC);
