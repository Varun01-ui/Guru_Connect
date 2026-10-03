-- @migration 008 M8 State Management
-- @table states: States and union territories within a country.
CREATE TABLE states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  country_id uuid NOT NULL REFERENCES countries(id) ON DELETE RESTRICT, -- Parent country
  name text NOT NULL, -- State name, e.g. Karnataka
  code text NOT NULL, -- Short code, e.g. KA (ISO 3166-2 suffix)
  type text NOT NULL DEFAULT 'state' CHECK (type IN ('state','union_territory')), -- Administrative type
  is_active boolean NOT NULL DEFAULT true, -- Hidden in the app when false
  sort_order integer NOT NULL DEFAULT 0, -- Manual ordering
  created_by uuid REFERENCES admins(id), -- Creator
  updated_by uuid REFERENCES admins(id), -- Last editor
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Last updated
  deleted_at timestamptz, -- Soft delete
  deleted_by uuid REFERENCES admins(id) -- Who deleted
);
CREATE UNIQUE INDEX uq_states_country_name ON states (country_id, lower(name)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_states_country_code ON states (country_id, code) WHERE deleted_at IS NULL;
CREATE INDEX idx_states_country_active ON states (country_id, is_active) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_states_updated BEFORE UPDATE ON states FOR EACH ROW EXECUTE FUNCTION set_updated_at();
