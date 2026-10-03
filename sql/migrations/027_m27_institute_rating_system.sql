-- @migration 027 M27 Institute Rating System
-- @table institute_ratings: Evaluations by GuruConnect admins. The latest submitted version is current and drives the public rating.
CREATE TABLE institute_ratings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  institute_id uuid NOT NULL REFERENCES institutes(id) ON DELETE CASCADE, -- Institute
  version integer NOT NULL, -- 1, 2, 3… per institute (re-evaluations)
  evaluation_method text NOT NULL CHECK (evaluation_method IN ('site_visit','video_walkthrough','document_only')), -- How it was evaluated
  visit_at timestamptz, -- When the visit happened
  infrastructure_score numeric(3,1) NOT NULL CHECK (infrastructure_score BETWEEN 0 AND 10), -- Classrooms, safety, labs, accessibility, hygiene
  faculty_quality_score numeric(3,1) NOT NULL CHECK (faculty_quality_score BETWEEN 0 AND 10), -- Qualifications, experience, teacher trust, demo audit
  student_feedback_score numeric(3,1) NOT NULL CHECK (student_feedback_score BETWEEN 0 AND 10), -- Derived from published reviews, adjustable by admin
  trustworthiness_score numeric(3,1) NOT NULL CHECK (trustworthiness_score BETWEEN 0 AND 10), -- Documents, complaint history, fee transparency
  criteria jsonb NOT NULL DEFAULT '{}'::jsonb, -- Sub-scores, e.g. {"infrastructure":{"classrooms":9,"safety":8}}
  suggested_rating numeric(2,1) NOT NULL CHECK (suggested_rating BETWEEN 1 AND 5), -- Computed by the formula
  overall_rating numeric(2,1) NOT NULL CHECK (overall_rating BETWEEN 1 AND 5 AND overall_rating * 2 = round(overall_rating * 2)), -- Final rating in half steps, chosen by the admin
  override_reason text, -- Required when overall differs from suggested by more than 0.5
  notes text, -- Reviewer notes (internal)
  public_summary text, -- Optional line shown on the profile
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','superseded')), -- draft is editable; submitted is final
  is_current boolean NOT NULL DEFAULT false, -- The rating shown publicly
  rated_by uuid NOT NULL REFERENCES admins(id), -- Evaluator
  submitted_at timestamptz, -- When finalised
  next_review_due date, -- Re-evaluation date (default +12 months)
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now() -- Updated
);
CREATE UNIQUE INDEX uq_institute_ratings_version ON institute_ratings (institute_id, version);
CREATE UNIQUE INDEX uq_institute_ratings_current ON institute_ratings (institute_id) WHERE is_current;
CREATE INDEX idx_institute_ratings_due ON institute_ratings (next_review_due) WHERE is_current;
CREATE TRIGGER trg_institute_ratings_updated BEFORE UPDATE ON institute_ratings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
