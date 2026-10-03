-- @migration 011 M11 Class Management
-- @table classes: Grades and levels learners study at, from Class 1 to competitive exam preparation.
CREATE TABLE classes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  name text NOT NULL, -- Display name, e.g. Class 10
  code text NOT NULL, -- Stable code, e.g. CLASS_10, UG, COMPETITIVE
  stage text NOT NULL CHECK (stage IN ('pre_primary','primary','middle','secondary','senior_secondary','undergraduate','postgraduate','competitive','adult')), -- Grouping used in filters and recommendations
  level_order smallint NOT NULL, -- Numeric order for range matching (Class 1 = 1 … Class 12 = 12, UG = 13, Competitive = 14)
  is_active boolean NOT NULL DEFAULT true, -- Hidden when false
  created_by uuid REFERENCES admins(id), -- Creator
  updated_by uuid REFERENCES admins(id), -- Last editor
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Last updated
  deleted_at timestamptz, -- Soft delete
  deleted_by uuid REFERENCES admins(id) -- Who deleted
);
CREATE UNIQUE INDEX uq_classes_code ON classes (code) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_classes_name ON classes (lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX idx_classes_order ON classes (level_order) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_classes_updated BEFORE UPDATE ON classes FOR EACH ROW EXECUTE FUNCTION set_updated_at();
