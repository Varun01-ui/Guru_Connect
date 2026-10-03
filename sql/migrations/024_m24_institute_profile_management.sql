-- @migration 024 M24 Institute Profile Management
-- @table institute_batches: Courses and batches an institute runs, shown on its public profile.
CREATE TABLE institute_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  institute_id uuid NOT NULL REFERENCES institutes(id) ON DELETE CASCADE, -- Institute
  name text NOT NULL, -- e.g. JEE 2027 · Class 12
  subject_ids uuid[] NOT NULL DEFAULT '{}', -- Subjects covered (validated against subjects in the API)
  class_id uuid REFERENCES classes(id) ON DELETE RESTRICT, -- Target class
  teaching_mode_id uuid REFERENCES teaching_modes(id) ON DELETE RESTRICT, -- Mode
  schedule_text text, -- e.g. Weekdays 4–7 PM
  seats_total integer CHECK (seats_total >= 0), -- Capacity
  seats_available integer CHECK (seats_available >= 0), -- Remaining seats
  fee_paise bigint CHECK (fee_paise >= 0), -- Course fee
  fee_period text CHECK (fee_period IN ('one_time','monthly','quarterly','yearly')), -- Fee period
  starts_on date, -- Start date
  is_active boolean NOT NULL DEFAULT true, -- Shown on profile
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Updated
  deleted_at timestamptz, -- Soft delete
  CONSTRAINT ck_institute_batches_seats CHECK (seats_total IS NULL OR seats_available IS NULL OR seats_available <= seats_total)
);
CREATE INDEX idx_institute_batches_inst ON institute_batches (institute_id) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_institute_batches_updated BEFORE UPDATE ON institute_batches FOR EACH ROW EXECUTE FUNCTION set_updated_at();
