-- @migration 026 M26 Institute Teacher Management
-- @table institute_teachers: Teachers listed under an institute. Added, edited and removed only by an institute manager (or an admin).
CREATE TABLE institute_teachers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  institute_id uuid NOT NULL REFERENCES institutes(id) ON DELETE CASCADE, -- Institute
  teacher_id uuid REFERENCES teachers(id) ON DELETE SET NULL, -- Linked GuruConnect teacher profile, if the teacher has one
  full_name text NOT NULL, -- Name as on Aadhaar
  phone text NOT NULL, -- E.164 phone, used for the ID-check SMS invite
  qualification text, -- e.g. M.Sc. Chemistry
  experience_years smallint CHECK (experience_years BETWEEN 0 AND 60), -- Experience
  photo_file_id uuid REFERENCES files(id), -- Photo
  schedule_text text, -- e.g. Weekdays 4–7 PM
  status text NOT NULL DEFAULT 'id_pending' CHECK (status IN ('id_pending','active','removed')), -- id_pending until Aadhaar/PAN verified
  is_visible boolean NOT NULL DEFAULT true, -- Shown on the institute's public profile
  added_by_manager_id uuid REFERENCES institute_managers(id) ON DELETE SET NULL, -- Manager who added
  added_by_admin_id uuid REFERENCES admins(id), -- Admin who added (support override)
  removed_at timestamptz, -- When removed
  removed_reason text, -- Why removed
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now() -- Updated
);
CREATE UNIQUE INDEX uq_institute_teachers_phone ON institute_teachers (institute_id, phone) WHERE status <> 'removed';
CREATE INDEX idx_institute_teachers_inst ON institute_teachers (institute_id, status);
CREATE INDEX idx_institute_teachers_teacher ON institute_teachers (teacher_id) WHERE teacher_id IS NOT NULL;
CREATE TRIGGER trg_institute_teachers_updated BEFORE UPDATE ON institute_teachers FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- @table institute_teacher_subjects: Subjects assigned to an institute teacher.
CREATE TABLE institute_teacher_subjects (
  institute_teacher_id uuid NOT NULL REFERENCES institute_teachers(id) ON DELETE CASCADE, -- Institute teacher
  subject_id uuid NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT, -- Subject
  PRIMARY KEY (institute_teacher_id, subject_id)
);

-- @table institute_teacher_classes: Classes assigned to an institute teacher.
CREATE TABLE institute_teacher_classes (
  institute_teacher_id uuid NOT NULL REFERENCES institute_teachers(id) ON DELETE CASCADE, -- Institute teacher
  class_id uuid NOT NULL REFERENCES classes(id) ON DELETE RESTRICT, -- Class
  PRIMARY KEY (institute_teacher_id, class_id)
);
