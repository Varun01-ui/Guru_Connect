-- @migration 023 M23 Institute Verification
-- @table institute_verification_logs: Timeline of institute verification events.
CREATE TABLE institute_verification_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  institute_id uuid NOT NULL REFERENCES institutes(id) ON DELETE CASCADE, -- Institute
  document_id uuid REFERENCES institute_documents(id) ON DELETE SET NULL, -- Related document
  action text NOT NULL CHECK (action IN ('submitted','resubmitted','document_approved','document_rejected','docs_requested','visit_scheduled','visit_completed','evaluation_saved','approved','rejected','badge_granted','badge_revoked','suspended','activated','note_added')), -- Event
  from_status text, -- Status before
  to_status text, -- Status after
  note text, -- Note or reason
  is_internal boolean NOT NULL DEFAULT true, -- false = visible to the institute manager
  metadata jsonb, -- e.g. {"visit_at":"2026-09-29T05:30:00Z","method":"site_visit"}
  admin_id uuid REFERENCES admins(id), -- Actor
  created_at timestamptz NOT NULL DEFAULT now() -- When
);
CREATE INDEX idx_institute_verification_logs_inst ON institute_verification_logs (institute_id, created_at DESC);
