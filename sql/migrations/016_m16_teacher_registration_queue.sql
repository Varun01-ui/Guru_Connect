-- @migration 016 M16 Teacher Registration Queue
CREATE SEQUENCE seq_teacher_code START 10001; -- generates teachers.public_code
-- @table teachers: Teacher profile and verification state. One row per teacher app account.
CREATE TABLE teachers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT, -- Login identity
  public_code text NOT NULL DEFAULT ('GC-T' || nextval('seq_teacher_code')), -- Human-friendly id shown in the portal, e.g. GC-T10241
  full_name text NOT NULL, -- Name as on Aadhaar
  gender text CHECK (gender IN ('female','male','other','undisclosed')), -- Gender
  date_of_birth date, -- Must make the teacher at least 18
  email citext, -- Contact email
  phone text NOT NULL, -- E.164 mobile number
  profile_photo_file_id uuid REFERENCES files(id), -- Public profile photo
  category_id uuid REFERENCES teacher_categories(id) ON DELETE RESTRICT, -- Primary teacher category
  highest_qualification text, -- e.g. M.Sc. Physics
  experience_years smallint CHECK (experience_years BETWEEN 0 AND 60), -- Years of teaching experience
  bio text, -- About the teacher, max 2,000 chars
  languages text[] NOT NULL DEFAULT '{}', -- Languages spoken, e.g. {English, Hindi}
  fee_per_hour_paise bigint CHECK (fee_per_hour_paise IS NULL OR fee_per_hour_paise >= 0), -- Indicative hourly fee
  demo_available boolean NOT NULL DEFAULT true, -- Offers a free demo class
  verification_status text NOT NULL DEFAULT 'draft' CHECK (verification_status IN ('draft','pending','under_review','reupload_requested','approved','rejected')), -- Registration workflow state
  account_status text NOT NULL DEFAULT 'active' CHECK (account_status IN ('active','suspended')), -- Suspended teachers are hidden from search and cannot receive leads
  is_verified_badge boolean NOT NULL DEFAULT false, -- Blue Verified badge on the profile
  badge_granted_at timestamptz, -- When the badge was granted
  badge_granted_by uuid REFERENCES admins(id), -- Who granted it
  is_featured boolean NOT NULL DEFAULT false, -- Featured rail placement
  featured_until timestamptz, -- Paid or manual featured expiry
  is_premium boolean NOT NULL DEFAULT false, -- Premium listing (search boost)
  premium_until timestamptz, -- Premium expiry
  registration_transaction_id uuid, -- Registration fee payment (FK added in migration 040)
  submitted_at timestamptz, -- When the teacher submitted for review
  reviewed_by uuid REFERENCES admins(id), -- Admin currently assigned / last reviewer
  approved_at timestamptz, -- Approval time
  rejected_at timestamptz, -- Rejection time
  rejection_reason_code text, -- e.g. DOC_UNREADABLE, NAME_MISMATCH, FORGED_DOCUMENT
  rejection_note text, -- Explanation sent to the teacher
  suspended_at timestamptz, -- Suspension time
  suspension_reason text, -- Internal reason for suspension
  profile_completeness smallint NOT NULL DEFAULT 0 CHECK (profile_completeness BETWEEN 0 AND 100), -- Percentage, recalculated on profile change
  trust_score numeric(5,2), -- Cached from trust_scores for fast sorting
  rating_avg numeric(3,2), -- Cached average of published reviews
  rating_count integer NOT NULL DEFAULT 0, -- Cached count of published reviews
  created_by uuid REFERENCES admins(id), -- Set when an admin created the teacher manually
  updated_by uuid REFERENCES admins(id), -- Last admin editor
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Last updated
  deleted_at timestamptz, -- Soft delete
  deleted_by uuid REFERENCES admins(id) -- Who deleted
);
CREATE UNIQUE INDEX uq_teachers_user ON teachers (user_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_teachers_public_code ON teachers (public_code);
CREATE INDEX idx_teachers_queue ON teachers (verification_status, submitted_at) WHERE deleted_at IS NULL;
CREATE INDEX idx_teachers_listing ON teachers (account_status, verification_status, trust_score DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_teachers_category ON teachers (category_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_teachers_name_trgm ON teachers USING gin (full_name gin_trgm_ops);
CREATE INDEX idx_teachers_featured ON teachers (featured_until) WHERE is_featured AND deleted_at IS NULL;
CREATE TRIGGER trg_teachers_updated BEFORE UPDATE ON teachers FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- @table teacher_documents: Every uploaded verification document version. Only one current version per teacher and type.
CREATE TABLE teacher_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  teacher_id uuid NOT NULL REFERENCES teachers(id) ON DELETE RESTRICT, -- Owner
  doc_type text NOT NULL CHECK (doc_type IN ('aadhaar','pan','education_certificate','professional_certificate','experience_letter','photo')), -- Document type
  file_id uuid NOT NULL REFERENCES files(id) ON DELETE RESTRICT, -- Private stored file
  title text, -- e.g. B.Ed., Bangalore University 2010 (for certificates)
  doc_number_masked text, -- Masked number shown in the UI, e.g. XXXX XXXX 2978
  doc_number_hash text, -- HMAC-SHA256 of the normalised number, used to detect duplicate accounts
  version smallint NOT NULL DEFAULT 1, -- Upload count for this type
  is_current boolean NOT NULL DEFAULT true, -- false once a newer upload replaces it
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','approved','rejected','reupload_requested')), -- Review state
  review_note text, -- Reason shown to the teacher on reject / re-upload
  reviewed_by uuid REFERENCES admins(id), -- Reviewer
  reviewed_at timestamptz, -- Review time
  created_at timestamptz NOT NULL DEFAULT now(), -- Uploaded
  updated_at timestamptz NOT NULL DEFAULT now() -- Last updated
);
CREATE INDEX idx_teacher_documents_teacher ON teacher_documents (teacher_id, doc_type) WHERE is_current;
CREATE UNIQUE INDEX uq_teacher_documents_current_identity ON teacher_documents (teacher_id, doc_type) WHERE is_current AND doc_type IN ('aadhaar','pan','photo');
CREATE INDEX idx_teacher_documents_hash ON teacher_documents (doc_type, doc_number_hash) WHERE doc_number_hash IS NOT NULL;
CREATE INDEX idx_teacher_documents_pending ON teacher_documents (status, created_at) WHERE is_current AND status = 'submitted';
CREATE TRIGGER trg_teacher_documents_updated BEFORE UPDATE ON teacher_documents FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- @table teacher_verification_logs: Timeline of every verification event for a teacher, shown in the review screen.
CREATE TABLE teacher_verification_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  teacher_id uuid NOT NULL REFERENCES teachers(id) ON DELETE CASCADE, -- Teacher
  document_id uuid REFERENCES teacher_documents(id) ON DELETE SET NULL, -- Document the event relates to, if any
  action text NOT NULL CHECK (action IN ('submitted','resubmitted','assigned','document_approved','document_rejected','reupload_requested','note_added','approved','rejected','badge_granted','badge_revoked','suspended','activated','auto_check')), -- Event type
  from_status text, -- Teacher verification_status before
  to_status text, -- Teacher verification_status after
  note text, -- Internal note or reason
  is_internal boolean NOT NULL DEFAULT true, -- false = note is also shown to the teacher
  metadata jsonb, -- Extra data, e.g. automated check results {"face_match":0.96}
  admin_id uuid REFERENCES admins(id), -- NULL for teacher or system events
  created_at timestamptz NOT NULL DEFAULT now() -- When
);
CREATE INDEX idx_teacher_verification_logs_teacher ON teacher_verification_logs (teacher_id, created_at DESC);
