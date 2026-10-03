-- @migration 019 M19 Teacher Class Mapping
-- @table teacher_classes: Classes (and optionally boards) a teacher covers.
CREATE TABLE teacher_classes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  teacher_id uuid NOT NULL REFERENCES teachers(id) ON DELETE CASCADE, -- Teacher
  class_id uuid NOT NULL REFERENCES classes(id) ON DELETE RESTRICT, -- Class
  board_id uuid REFERENCES boards(id) ON DELETE RESTRICT, -- Board; NULL = any board
  created_by uuid REFERENCES admins(id), -- Set when an admin added it
  created_at timestamptz NOT NULL DEFAULT now() -- Created
);
CREATE UNIQUE INDEX uq_teacher_classes ON teacher_classes (teacher_id, class_id, COALESCE(board_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX idx_teacher_classes_class ON teacher_classes (class_id, teacher_id);
