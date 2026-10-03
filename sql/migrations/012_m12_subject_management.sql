-- @migration 012 M12 Subject Management
-- @table subjects: Subjects, exams and skills teachers can teach.
CREATE TABLE subjects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  name text NOT NULL, -- Display name, e.g. Physics
  slug text NOT NULL, -- URL slug, e.g. physics
  category text NOT NULL CHECK (category IN ('academic','competitive_exam','language','music_arts','coding_skills','other')), -- Grouping for filters
  parent_subject_id uuid REFERENCES subjects(id) ON DELETE RESTRICT, -- Optional parent, e.g. Organic Chemistry → Chemistry
  aliases text[] NOT NULL DEFAULT '{}', -- Search synonyms, e.g. {maths, math}
  icon_file_id uuid REFERENCES files(id), -- Optional icon shown in the app
  min_class_order smallint, -- Lowest classes.level_order this subject is offered for (NULL = any)
  max_class_order smallint, -- Highest classes.level_order (NULL = any)
  is_trending boolean NOT NULL DEFAULT false, -- Pinned in Trending subjects on the app home screen
  is_active boolean NOT NULL DEFAULT true, -- Hidden when false
  sort_order integer NOT NULL DEFAULT 0, -- Manual ordering
  created_by uuid REFERENCES admins(id), -- Creator
  updated_by uuid REFERENCES admins(id), -- Last editor
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Last updated
  deleted_at timestamptz, -- Soft delete
  deleted_by uuid REFERENCES admins(id), -- Who deleted
  CONSTRAINT ck_subjects_class_range CHECK (min_class_order IS NULL OR max_class_order IS NULL OR min_class_order <= max_class_order),
  CONSTRAINT ck_subjects_not_self_parent CHECK (parent_subject_id IS NULL OR parent_subject_id <> id)
);
CREATE UNIQUE INDEX uq_subjects_slug ON subjects (slug) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_subjects_name ON subjects (lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX idx_subjects_category ON subjects (category, is_active) WHERE deleted_at IS NULL;
CREATE INDEX idx_subjects_name_trgm ON subjects USING gin (name gin_trgm_ops);
CREATE INDEX idx_subjects_aliases ON subjects USING gin (aliases);
CREATE TRIGGER trg_subjects_updated BEFORE UPDATE ON subjects FOR EACH ROW EXECUTE FUNCTION set_updated_at();
