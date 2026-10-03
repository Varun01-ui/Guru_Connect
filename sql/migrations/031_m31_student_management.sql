-- @migration 031 M31 Student Management
CREATE SEQUENCE seq_student_code START 50001; -- generates students.public_code
-- @table students: Student profile, one per student app account.
CREATE TABLE students (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT, -- Login identity
  public_code text NOT NULL DEFAULT ('GC-S' || nextval('seq_student_code')), -- e.g. GC-S50140
  full_name text NOT NULL, -- Name
  email citext, -- Email
  phone text NOT NULL, -- E.164 phone
  class_id uuid REFERENCES classes(id) ON DELETE RESTRICT, -- Current class
  board_id uuid REFERENCES boards(id) ON DELETE RESTRICT, -- Board
  school_name text, -- School or college
  parent_id uuid REFERENCES parents(id) ON DELETE SET NULL, -- Linked parent account, if any
  parent_link_status text NOT NULL DEFAULT 'none' CHECK (parent_link_status IN ('none','pending','confirmed')), -- Link requested by support or the student; confirmed by the parent in the app
  parent_name text, -- Optional parent name given at sign-up
  parent_phone text, -- Optional parent phone (E.164)
  parental_consent text NOT NULL DEFAULT 'not_required' CHECK (parental_consent IN ('not_required','pending','confirmed','declined')), -- Required for students below Class 9
  parental_consent_at timestamptz, -- When the parent confirmed by SMS link
  city_id uuid REFERENCES cities(id) ON DELETE RESTRICT, -- City
  area_id uuid REFERENCES areas(id) ON DELETE RESTRICT, -- Area
  account_status text NOT NULL DEFAULT 'active' CHECK (account_status IN ('active','suspended')), -- Account status
  suspension_reason text, -- Internal reason
  suspended_at timestamptz, -- When suspended
  suspended_by uuid REFERENCES admins(id), -- Who suspended
  referral_code_used text, -- Code entered at sign-up
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Updated
  deleted_at timestamptz, -- Soft delete
  deleted_by uuid REFERENCES admins(id) -- Admin who deleted
);
CREATE UNIQUE INDEX uq_students_user ON students (user_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_students_public_code ON students (public_code);
CREATE INDEX idx_students_class ON students (class_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_students_city ON students (city_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_students_name_trgm ON students USING gin (full_name gin_trgm_ops);
CREATE TRIGGER trg_students_updated BEFORE UPDATE ON students FOR EACH ROW EXECUTE FUNCTION set_updated_at();
