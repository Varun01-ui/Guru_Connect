-- @migration 037 M37 Trust Score History
-- @table trust_score_logs: Every change to a teacher's trust score and what caused it.
CREATE TABLE trust_score_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  teacher_id uuid NOT NULL REFERENCES teachers(id) ON DELETE CASCADE, -- Teacher
  old_score numeric(5,2), -- Before (NULL for the first calculation)
  new_score numeric(5,2) NOT NULL, -- After
  breakdown jsonb NOT NULL, -- Factor scores after the change
  trigger_type text NOT NULL CHECK (trigger_type IN ('document_decision','review_published','review_removed','complaint_resolved','profile_updated','weights_changed','manual_override','override_expired','override_removed','scheduled','freeze','unfreeze')), -- What caused it
  trigger_ref_id uuid, -- Id of the review / complaint / document that caused it
  weights_version integer NOT NULL, -- Weights used
  note text, -- Reason for manual actions
  admin_id uuid REFERENCES admins(id), -- NULL for automatic recalculation
  created_at timestamptz NOT NULL DEFAULT now() -- When
);
CREATE INDEX idx_trust_score_logs_teacher ON trust_score_logs (teacher_id, created_at DESC);
CREATE INDEX idx_trust_score_logs_trigger ON trust_score_logs (trigger_type, created_at DESC);
