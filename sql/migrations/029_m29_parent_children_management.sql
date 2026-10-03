-- @migration 029 M29 Parent Children Management
-- @table parent_children: Children a parent is finding teachers for. Drives per-child recommendations.
CREATE TABLE parent_children (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  parent_id uuid NOT NULL REFERENCES parents(id) ON DELETE CASCADE, -- Parent
  child_name text NOT NULL, -- First name only (data minimisation for minors)
  class_id uuid NOT NULL REFERENCES classes(id) ON DELETE RESTRICT, -- Class the child studies in
  board_id uuid REFERENCES boards(id) ON DELETE RESTRICT, -- Board
  preferred_mode_id uuid REFERENCES teaching_modes(id) ON DELETE RESTRICT, -- Preferred teaching mode; NULL = any
  school_name text, -- Optional school
  sort_order smallint NOT NULL DEFAULT 0, -- Order in the child switcher
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Updated
  deleted_at timestamptz -- Soft delete
);
CREATE INDEX idx_parent_children_parent ON parent_children (parent_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_parent_children_class ON parent_children (class_id) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_parent_children_updated BEFORE UPDATE ON parent_children FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- @table parent_child_subjects: Subjects needed for a child.
CREATE TABLE parent_child_subjects (
  child_id uuid NOT NULL REFERENCES parent_children(id) ON DELETE CASCADE, -- Child
  subject_id uuid NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT, -- Subject needed
  PRIMARY KEY (child_id, subject_id)
);
CREATE INDEX idx_parent_child_subjects_subject ON parent_child_subjects (subject_id);

-- @table parent_child_teacher_categories: Types of teacher the parent wants for a child (Home Tutor, Competitive Exam Faculty, …).
CREATE TABLE parent_child_teacher_categories (
  child_id uuid NOT NULL REFERENCES parent_children(id) ON DELETE CASCADE, -- Child
  category_id uuid NOT NULL REFERENCES teacher_categories(id) ON DELETE RESTRICT, -- Teacher category wanted
  PRIMARY KEY (child_id, category_id)
);
