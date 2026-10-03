-- @migration 043 M43 Complaint Management
CREATE SEQUENCE seq_case_number START 1001; -- generates complaints.case_number
-- @table complaints: Two-way safety reports: learners about teachers/institutes, teachers about parents/students.
CREATE TABLE complaints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  case_number text NOT NULL DEFAULT ('CS-' || nextval('seq_case_number')), -- e.g. CS-4471
  reporter_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT, -- Who reported
  reporter_type text NOT NULL CHECK (reporter_type IN ('parent','student','teacher','institute_staff')), -- Reporter role
  reported_type text NOT NULL CHECK (reported_type IN ('teacher','institute','parent','student')), -- Who is reported
  reported_user_id uuid REFERENCES app_users(id) ON DELETE RESTRICT, -- Reported account (teacher/parent/student)
  reported_institute_id uuid REFERENCES institutes(id) ON DELETE RESTRICT, -- Reported institute
  lead_id uuid REFERENCES leads(id) ON DELETE SET NULL, -- Related lead, if any
  complaint_type text NOT NULL CHECK (complaint_type IN ('fraud','misconduct','fake_information','harassment','other')), -- Type
  description text NOT NULL, -- What happened, 20–3,000 chars
  severity text NOT NULL DEFAULT 'medium' CHECK (severity IN ('low','medium','high','critical')), -- Set by triage rules, editable by admin
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_review','awaiting_info','escalated','resolved','dismissed')), -- Lifecycle
  assigned_admin_id uuid REFERENCES admins(id), -- Case owner
  resolution text CHECK (resolution IN ('no_action','warning_issued','content_removed','account_suspended','account_banned','refund_issued','referred_to_police')), -- Outcome
  resolution_note text, -- Explanation (internal)
  reporter_message text, -- Message sent to the reporter on closure
  is_upheld boolean, -- true when the complaint was valid; feeds the trust score
  sla_due_at timestamptz NOT NULL, -- Response due (critical 4h, high 24h, else 72h)
  resolved_at timestamptz, -- Closed
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Updated
  CONSTRAINT ck_complaints_target CHECK ((reported_type = 'institute') = (reported_institute_id IS NOT NULL) AND (reported_type = 'institute' OR reported_user_id IS NOT NULL))
);
CREATE UNIQUE INDEX uq_complaints_case ON complaints (case_number);
CREATE INDEX idx_complaints_queue ON complaints (status, severity, sla_due_at);
CREATE INDEX idx_complaints_reported_user ON complaints (reported_user_id, created_at DESC);
CREATE INDEX idx_complaints_reported_inst ON complaints (reported_institute_id, created_at DESC);
CREATE INDEX idx_complaints_assignee ON complaints (assigned_admin_id, status);
CREATE TRIGGER trg_complaints_updated BEFORE UPDATE ON complaints FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- @table complaint_actions: Case timeline: assignments, notes, warnings, suspensions, escalations.
CREATE TABLE complaint_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  complaint_id uuid NOT NULL REFERENCES complaints(id) ON DELETE CASCADE, -- Case
  action text NOT NULL CHECK (action IN ('created','assigned','note','info_requested','warning_issued','suspended','escalated','severity_changed','resolved','dismissed','reopened')), -- Event
  note text, -- Details
  is_internal boolean NOT NULL DEFAULT true, -- false = shown to reporter/reported
  metadata jsonb, -- e.g. {"from":"medium","to":"high"}
  admin_id uuid REFERENCES admins(id), -- Actor
  created_at timestamptz NOT NULL DEFAULT now() -- When
);
CREATE INDEX idx_complaint_actions_case ON complaint_actions (complaint_id, created_at);

-- @table complaint_attachments: Evidence files attached to a complaint.
CREATE TABLE complaint_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  complaint_id uuid NOT NULL REFERENCES complaints(id) ON DELETE CASCADE, -- Case
  file_id uuid NOT NULL REFERENCES files(id) ON DELETE RESTRICT, -- Private file
  uploaded_by_type text NOT NULL CHECK (uploaded_by_type IN ('app_user','admin')), -- Uploader kind
  created_at timestamptz NOT NULL DEFAULT now() -- Uploaded
);
CREATE INDEX idx_complaint_attachments_case ON complaint_attachments (complaint_id);
