-- @migration 034 M34 Institute Reviews
-- @table institute_reviews: Reviews of institutes by parents and students.
CREATE TABLE institute_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  institute_id uuid NOT NULL REFERENCES institutes(id) ON DELETE CASCADE, -- Institute reviewed
  author_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT, -- Reviewer
  author_type text NOT NULL CHECK (author_type IN ('parent','student')), -- Reviewer role
  rating smallint NOT NULL CHECK (rating BETWEEN 1 AND 5), -- Overall stars
  aspect_ratings jsonb NOT NULL DEFAULT '{}'::jsonb, -- Optional 1–5 per aspect, e.g. {"teaching":5,"infrastructure":4,"value":4}
  comment text NOT NULL, -- Review text, 30–1,500 chars
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','published','rejected','flagged','hidden')), -- Moderation state
  spam_score numeric(4,3) CHECK (spam_score BETWEEN 0 AND 1), -- Automated spam probability
  auto_flags text[] NOT NULL DEFAULT '{}', -- Automated flags
  is_verified_interaction boolean NOT NULL DEFAULT false, -- Reviewer had a lead or campus visit
  institute_reply text, -- Public reply by the institute manager
  institute_replied_at timestamptz, -- Reply time
  reply_status text CHECK (reply_status IN ('pending','published','rejected')), -- Reply moderation
  edited_at timestamptz, -- Last author edit
  moderated_by uuid REFERENCES admins(id), -- Last moderator
  moderated_at timestamptz, -- Last moderation time
  rejection_reason_code text, -- Reason code
  published_at timestamptz, -- First published
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Updated
  deleted_at timestamptz -- Soft delete
);
CREATE UNIQUE INDEX uq_institute_reviews_author ON institute_reviews (institute_id, author_user_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_institute_reviews_queue ON institute_reviews (status, created_at) WHERE deleted_at IS NULL;
CREATE INDEX idx_institute_reviews_inst ON institute_reviews (institute_id, status, published_at DESC) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_institute_reviews_updated BEFORE UPDATE ON institute_reviews FOR EACH ROW EXECUTE FUNCTION set_updated_at();
