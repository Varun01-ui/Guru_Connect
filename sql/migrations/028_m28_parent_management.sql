-- @migration 028 M28 Parent Management
CREATE SEQUENCE seq_parent_code START 50001; -- generates parents.public_code
-- @table parents: Parent profile, one per parent app account.
CREATE TABLE parents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT, -- Login identity
  public_code text NOT NULL DEFAULT ('GC-P' || nextval('seq_parent_code')), -- e.g. GC-P50121
  full_name text NOT NULL, -- Name
  email citext, -- Email
  phone text NOT NULL, -- E.164 phone
  state_id uuid REFERENCES states(id) ON DELETE RESTRICT, -- State
  city_id uuid REFERENCES cities(id) ON DELETE RESTRICT, -- City
  area_id uuid REFERENCES areas(id) ON DELETE RESTRICT, -- Area (optional)
  account_status text NOT NULL DEFAULT 'active' CHECK (account_status IN ('active','suspended')), -- Suspended parents cannot contact teachers
  suspension_reason text, -- Internal reason
  suspended_at timestamptz, -- When suspended
  suspended_by uuid REFERENCES admins(id), -- Who suspended
  referral_code_used text, -- Code entered at sign-up
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Updated
  deleted_at timestamptz, -- Soft delete
  deleted_by uuid REFERENCES admins(id) -- Admin who deleted, if an admin did
);
CREATE UNIQUE INDEX uq_parents_user ON parents (user_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_parents_public_code ON parents (public_code);
CREATE INDEX idx_parents_city ON parents (city_id, area_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_parents_name_trgm ON parents USING gin (full_name gin_trgm_ops);
CREATE TRIGGER trg_parents_updated BEFORE UPDATE ON parents FOR EACH ROW EXECUTE FUNCTION set_updated_at();
