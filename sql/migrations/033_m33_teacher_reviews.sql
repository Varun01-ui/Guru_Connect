-- @migration 033 M33 Teacher Reviews
-- @table teacher_reviews: Reviews of teachers by parents and students. Only published reviews count toward ratings and trust.
CREATE TABLE teacher_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  teacher_id uuid NOT NULL REFERENCES teachers(id) ON DELETE CASCADE, -- Teacher reviewed
  author_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT, -- Reviewer
  author_type text NOT NULL CHECK (author_type IN ('parent','student')), -- Reviewer role at the time
  child_id uuid REFERENCES parent_children(id) ON DELETE SET NULL, -- Child the parent is reviewing for
  rating smallint NOT NULL CHECK (rating BETWEEN 1 AND 5), -- Stars
  comment text NOT NULL, -- Review text, 30–1,500 chars
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','published','rejected','flagged','hidden')), -- Moderation state
  spam_score numeric(4,3) CHECK (spam_score BETWEEN 0 AND 1), -- Automated spam probability
  auto_flags text[] NOT NULL DEFAULT '{}', -- e.g. {contact_info, repeated_text, rating_burst}
  is_verified_interaction boolean NOT NULL DEFAULT false, -- Reviewer had a completed lead or demo with the teacher
  teacher_reply text, -- Public reply by the teacher
  teacher_replied_at timestamptz, -- Reply time
  reply_status text CHECK (reply_status IN ('pending','published','rejected')), -- Replies are moderated too
  edited_at timestamptz, -- Last edit by the author (edits send the review back to pending)
  moderated_by uuid REFERENCES admins(id), -- Last moderator
  moderated_at timestamptz, -- Last moderation time
  rejection_reason_code text, -- e.g. CONTACT_DETAILS, ABUSIVE, NOT_A_TEACHING_EXPERIENCE
  published_at timestamptz, -- First published
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Updated
  deleted_at timestamptz -- Soft delete (author deleted it or account deleted)
);
CREATE UNIQUE INDEX uq_teacher_reviews_author ON teacher_reviews (teacher_id, author_user_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_teacher_reviews_queue ON teacher_reviews (status, created_at) WHERE deleted_at IS NULL;
CREATE INDEX idx_teacher_reviews_teacher ON teacher_reviews (teacher_id, status, published_at DESC) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_teacher_reviews_updated BEFORE UPDATE ON teacher_reviews FOR EACH ROW EXECUTE FUNCTION set_updated_at();
