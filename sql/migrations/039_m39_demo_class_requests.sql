-- @migration 039 M39 Demo Class Requests
-- @table demo_requests: Free demo class bookings and their outcome.
CREATE TABLE demo_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE, -- Parent lead (lead_type = demo)
  teacher_id uuid REFERENCES teachers(id) ON DELETE RESTRICT, -- Teacher giving the demo
  institute_id uuid REFERENCES institutes(id) ON DELETE RESTRICT, -- Institute giving the demo / campus visit
  requester_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT, -- Learner or parent
  child_id uuid REFERENCES parent_children(id) ON DELETE SET NULL, -- Child attending
  teaching_mode_id uuid REFERENCES teaching_modes(id) ON DELETE RESTRICT, -- Online / home / at teacher's place
  requested_start_at timestamptz NOT NULL, -- Slot the requester picked
  confirmed_start_at timestamptz, -- Slot the teacher confirmed
  duration_minutes smallint NOT NULL DEFAULT 45 CHECK (duration_minutes BETWEEN 15 AND 120), -- Length
  meeting_link text, -- Online class link (https)
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','confirmed','reschedule_proposed','completed','cancelled','no_show','expired')), -- Lifecycle
  cancelled_by text CHECK (cancelled_by IN ('requester','teacher','institute','admin','system')), -- Who cancelled
  cancel_reason text, -- Why cancelled
  outcome text CHECK (outcome IN ('enrolled','not_enrolled','undecided')), -- Result reported after the demo
  reminder_sent_at timestamptz, -- 1-hour reminder push sent
  completed_at timestamptz, -- Marked completed
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Updated
  CONSTRAINT ck_demo_requests_target CHECK (teacher_id IS NOT NULL OR institute_id IS NOT NULL)
);
CREATE UNIQUE INDEX uq_demo_requests_lead ON demo_requests (lead_id);
CREATE INDEX idx_demo_requests_teacher_time ON demo_requests (teacher_id, confirmed_start_at) WHERE status IN ('requested','confirmed','reschedule_proposed');
CREATE INDEX idx_demo_requests_status ON demo_requests (status, requested_start_at);
CREATE TRIGGER trg_demo_requests_updated BEFORE UPDATE ON demo_requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();
