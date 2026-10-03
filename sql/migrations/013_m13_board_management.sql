-- @migration 013 M13 Board Management
-- @table boards: Education boards and curricula, e.g. CBSE, ICSE, state boards, IB.
CREATE TABLE boards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  name text NOT NULL, -- Full name, e.g. Central Board of Secondary Education
  short_name text NOT NULL, -- Short name shown in chips, e.g. CBSE
  type text NOT NULL CHECK (type IN ('national','state','international','university','other')), -- Board type
  state_id uuid REFERENCES states(id) ON DELETE RESTRICT, -- Required for state boards, NULL otherwise
  is_active boolean NOT NULL DEFAULT true, -- Hidden when false
  sort_order integer NOT NULL DEFAULT 0, -- Manual ordering
  created_by uuid REFERENCES admins(id), -- Creator
  updated_by uuid REFERENCES admins(id), -- Last editor
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Last updated
  deleted_at timestamptz, -- Soft delete
  deleted_by uuid REFERENCES admins(id), -- Who deleted
  CONSTRAINT ck_boards_state CHECK ((type = 'state') = (state_id IS NOT NULL))
);
CREATE UNIQUE INDEX uq_boards_short_name ON boards (lower(short_name)) WHERE deleted_at IS NULL;
CREATE INDEX idx_boards_type ON boards (type, is_active) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_boards_updated BEFORE UPDATE ON boards FOR EACH ROW EXECUTE FUNCTION set_updated_at();
