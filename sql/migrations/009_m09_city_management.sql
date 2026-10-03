-- @migration 009 M9 City Management
-- @table cities: Cities where teachers and institutes can be listed.
CREATE TABLE cities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  state_id uuid NOT NULL REFERENCES states(id) ON DELETE RESTRICT, -- Parent state
  name text NOT NULL, -- City name, e.g. Bengaluru
  slug text NOT NULL, -- URL slug, e.g. bengaluru (used in deep links and SEO pages)
  latitude numeric(9,6) CHECK (latitude BETWEEN -90 AND 90), -- City centre latitude
  longitude numeric(9,6) CHECK (longitude BETWEEN -180 AND 180), -- City centre longitude
  tier smallint CHECK (tier IN (1,2,3)), -- Market tier, used for pricing and featured slots
  is_serviceable boolean NOT NULL DEFAULT false, -- true = shown as a launch city in search
  is_active boolean NOT NULL DEFAULT true, -- Hidden everywhere when false
  sort_order integer NOT NULL DEFAULT 0, -- Manual ordering
  created_by uuid REFERENCES admins(id), -- Creator
  updated_by uuid REFERENCES admins(id), -- Last editor
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Last updated
  deleted_at timestamptz, -- Soft delete
  deleted_by uuid REFERENCES admins(id) -- Who deleted
);
CREATE UNIQUE INDEX uq_cities_state_name ON cities (state_id, lower(name)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_cities_slug ON cities (slug) WHERE deleted_at IS NULL;
CREATE INDEX idx_cities_state_active ON cities (state_id, is_active) WHERE deleted_at IS NULL;
CREATE INDEX idx_cities_name_trgm ON cities USING gin (name gin_trgm_ops);
CREATE TRIGGER trg_cities_updated BEFORE UPDATE ON cities FOR EACH ROW EXECUTE FUNCTION set_updated_at();
