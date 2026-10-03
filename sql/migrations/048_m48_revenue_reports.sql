-- @migration 048 M48 Revenue Reports
-- @table report_exports: Asynchronous CSV/XLSX exports for all report modules. Files expire after 7 days.
CREATE TABLE report_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  report_type text NOT NULL CHECK (report_type IN ('revenue','transactions','subscriptions','teachers','teacher_performance','institutes','institute_ratings','leads','reviews','complaints','referrals','audit_logs')), -- Which report
  filters jsonb NOT NULL DEFAULT '{}'::jsonb, -- Filters used, e.g. {"from":"2026-09-01","to":"2026-09-30","city_id":"…"}
  format text NOT NULL DEFAULT 'csv' CHECK (format IN ('csv','xlsx')), -- Output format
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed','expired')), -- Job state
  row_count integer, -- Rows written
  file_id uuid REFERENCES files(id) ON DELETE SET NULL, -- Output file (private)
  error text, -- Failure reason
  requested_by uuid NOT NULL REFERENCES admins(id), -- Requester
  started_at timestamptz, -- Job start
  completed_at timestamptz, -- Job end
  expires_at timestamptz, -- Download link expiry
  created_at timestamptz NOT NULL DEFAULT now() -- Requested
);
CREATE INDEX idx_report_exports_requester ON report_exports (requested_by, created_at DESC);
CREATE INDEX idx_report_exports_status ON report_exports (status, created_at);
