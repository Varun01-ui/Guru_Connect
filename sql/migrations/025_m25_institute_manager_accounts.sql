-- @migration 025 M25 Institute Manager Accounts
-- @table institute_managers: App accounts that act for an institute. Exactly one active primary manager; counsellors can only handle leads.
CREATE TABLE institute_managers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  institute_id uuid NOT NULL REFERENCES institutes(id) ON DELETE CASCADE, -- Institute
  user_id uuid REFERENCES app_users(id) ON DELETE RESTRICT, -- Linked app account (NULL until an invite is accepted)
  full_name text NOT NULL, -- Name
  email citext, -- Email
  phone text NOT NULL, -- E.164 phone
  designation text, -- e.g. Centre Head
  staff_role text NOT NULL DEFAULT 'manager' CHECK (staff_role IN ('manager','counsellor')), -- manager = full control incl. teachers; counsellor = leads only
  is_primary boolean NOT NULL DEFAULT false, -- The accountable owner; exactly one active per institute
  status text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','active','disabled')), -- Account state
  invited_at timestamptz, -- Invite sent
  accepted_at timestamptz, -- Invite accepted
  disabled_at timestamptz, -- Disabled
  disabled_reason text, -- Why
  created_by uuid REFERENCES admins(id), -- Admin who created/replaced it (NULL when self-registered)
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Updated
  CONSTRAINT ck_institute_managers_primary_is_manager CHECK (NOT is_primary OR staff_role = 'manager')
);
CREATE UNIQUE INDEX uq_institute_managers_primary ON institute_managers (institute_id) WHERE is_primary AND status <> 'disabled';
CREATE UNIQUE INDEX uq_institute_managers_user ON institute_managers (institute_id, user_id) WHERE user_id IS NOT NULL AND status <> 'disabled';
CREATE INDEX idx_institute_managers_phone ON institute_managers (phone);
CREATE TRIGGER trg_institute_managers_updated BEFORE UPDATE ON institute_managers FOR EACH ROW EXECUTE FUNCTION set_updated_at();
