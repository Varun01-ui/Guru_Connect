-- @migration 007 M7 Country Management
-- @table countries: Countries the platform can operate in. India is seeded; others stay inactive until launch.
CREATE TABLE countries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  name text NOT NULL, -- Country name, e.g. India
  iso2 char(2) NOT NULL, -- ISO 3166-1 alpha-2, e.g. IN
  iso3 char(3) NOT NULL, -- ISO 3166-1 alpha-3, e.g. IND
  phone_code text NOT NULL, -- Dialling code with plus, e.g. +91
  currency_code char(3) NOT NULL, -- ISO 4217, e.g. INR
  is_active boolean NOT NULL DEFAULT true, -- Inactive countries are hidden in the app
  sort_order integer NOT NULL DEFAULT 0, -- Manual ordering in dropdowns
  created_by uuid REFERENCES admins(id), -- Creator
  updated_by uuid REFERENCES admins(id), -- Last editor
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Last updated
  deleted_at timestamptz, -- Soft delete
  deleted_by uuid REFERENCES admins(id) -- Who deleted
);
CREATE UNIQUE INDEX uq_countries_iso2 ON countries (iso2) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_countries_name ON countries (lower(name)) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_countries_updated BEFORE UPDATE ON countries FOR EACH ROW EXECUTE FUNCTION set_updated_at();
