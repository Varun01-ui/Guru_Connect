-- @migration 018 M18 Teacher Subject Mapping
-- @table teacher_subjects: Subjects a teacher teaches.
CREATE TABLE teacher_subjects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  teacher_id uuid NOT NULL REFERENCES teachers(id) ON DELETE CASCADE, -- Teacher
  subject_id uuid NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT, -- Subject
  is_primary boolean NOT NULL DEFAULT false, -- Primary subject shown first on cards (max one per teacher)
  experience_years smallint CHECK (experience_years BETWEEN 0 AND 60), -- Years teaching this subject
  created_by uuid REFERENCES admins(id), -- Set when an admin added it
  created_at timestamptz NOT NULL DEFAULT now() -- Created
);
CREATE UNIQUE INDEX uq_teacher_subjects ON teacher_subjects (teacher_id, subject_id);
CREATE UNIQUE INDEX uq_teacher_subjects_primary ON teacher_subjects (teacher_id) WHERE is_primary;
CREATE INDEX idx_teacher_subjects_subject ON teacher_subjects (subject_id, teacher_id);
