-- @migration 038 M38 Lead Management
CREATE SEQUENCE seq_lead_code START 100001; -- generates leads.public_code
-- @table leads: Enquiries and call-back requests from parents/students to a teacher or institute.
CREATE TABLE leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  public_code text NOT NULL DEFAULT ('LD-' || nextval('seq_lead_code')), -- e.g. LD-240981
  lead_type text NOT NULL CHECK (lead_type IN ('inquiry','callback','demo')), -- demo leads also have a demo_requests row
  target_type text NOT NULL CHECK (target_type IN ('teacher','institute')), -- Who receives it
  teacher_id uuid REFERENCES teachers(id) ON DELETE RESTRICT, -- Target teacher
  institute_id uuid REFERENCES institutes(id) ON DELETE RESTRICT, -- Target institute
  requester_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT, -- Who asked
  requester_type text NOT NULL CHECK (requester_type IN ('parent','student')), -- Requester role
  child_id uuid REFERENCES parent_children(id) ON DELETE SET NULL, -- Child the request is for
  subject_id uuid REFERENCES subjects(id) ON DELETE RESTRICT, -- Subject asked about
  class_id uuid REFERENCES classes(id) ON DELETE RESTRICT, -- Class
  message text, -- Requester message, max 1,000 chars
  preferred_callback_window text, -- e.g. Today 6–8 PM
  source text NOT NULL DEFAULT 'profile' CHECK (source IN ('profile','search','recommendation','featured','compare','institute_page','other')), -- Where it started
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','viewed','contacted','converted','declined','closed','spam')), -- Lifecycle
  contact_unlocked boolean NOT NULL DEFAULT false, -- Requester phone shared with the teacher
  unlock_transaction_id uuid, -- Paid contact unlock (FK added in migration 040)
  assigned_institute_teacher_id uuid REFERENCES institute_teachers(id) ON DELETE SET NULL, -- Institute leads: teacher the manager assigned
  first_response_at timestamptz, -- First reply or status change by the receiver (response-rate metric)
  closed_at timestamptz, -- When closed/converted/declined
  decline_reason text, -- Reason given by the teacher
  admin_note text, -- Internal note from support
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Updated
  deleted_at timestamptz, -- Soft delete
  CONSTRAINT ck_leads_target CHECK ((target_type = 'teacher' AND teacher_id IS NOT NULL AND institute_id IS NULL) OR (target_type = 'institute' AND institute_id IS NOT NULL AND teacher_id IS NULL))
);
CREATE UNIQUE INDEX uq_leads_public_code ON leads (public_code);
CREATE INDEX idx_leads_teacher ON leads (teacher_id, status, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_leads_institute ON leads (institute_id, status, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_leads_requester ON leads (requester_user_id, created_at DESC);
CREATE INDEX idx_leads_status_created ON leads (status, created_at DESC) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_leads_updated BEFORE UPDATE ON leads FOR EACH ROW EXECUTE FUNCTION set_updated_at();
