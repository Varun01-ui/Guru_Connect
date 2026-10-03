-- @migration 014 M14 Teaching Mode Management
-- @table teaching_modes: How classes are delivered, e.g. Online, Offline at teacher's place, Home tuition, Hybrid.
CREATE TABLE teaching_modes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  name text NOT NULL, -- Display name, e.g. Home tuition
  code text NOT NULL, -- Stable code: ONLINE, OFFLINE, HOME_TUITION, HYBRID, BATCH
  description text, -- Help text shown to teachers
  requires_location boolean NOT NULL DEFAULT true, -- false for ONLINE (no city/area needed)
  is_active boolean NOT NULL DEFAULT true, -- Hidden when false
  sort_order integer NOT NULL DEFAULT 0, -- Manual ordering
  created_by uuid REFERENCES admins(id), -- Creator
  updated_by uuid REFERENCES admins(id), -- Last editor
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Last updated
  deleted_at timestamptz, -- Soft delete
  deleted_by uuid REFERENCES admins(id) -- Who deleted
);
CREATE UNIQUE INDEX uq_teaching_modes_code ON teaching_modes (code) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_teaching_modes_name ON teaching_modes (lower(name)) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_teaching_modes_updated BEFORE UPDATE ON teaching_modes FOR EACH ROW EXECUTE FUNCTION set_updated_at();
