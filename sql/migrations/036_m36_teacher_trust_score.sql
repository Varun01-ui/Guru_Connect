-- @migration 036 M36 Teacher Trust Score
-- @table trust_score_weights: Versioned factor weights. Exactly one active version; weights must add up to 100.
CREATE TABLE trust_score_weights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  version integer NOT NULL, -- Version number
  weights jsonb NOT NULL, -- {"aadhaar":20,"pan":10,"certificates":20,"reviews":25,"complaints":15,"profile_completeness":10}
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','superseded')), -- Lifecycle
  change_reason text, -- Why weights changed
  created_by uuid REFERENCES admins(id), -- Creator
  activated_at timestamptz, -- When activated
  created_at timestamptz NOT NULL DEFAULT now() -- Created
);
CREATE UNIQUE INDEX uq_trust_score_weights_version ON trust_score_weights (version);
CREATE UNIQUE INDEX uq_trust_score_weights_active ON trust_score_weights (status) WHERE status = 'active';

-- @table trust_scores: Current trust score per teacher with its factor breakdown.
CREATE TABLE trust_scores (
  teacher_id uuid PRIMARY KEY REFERENCES teachers(id) ON DELETE CASCADE, -- One row per teacher
  score numeric(5,2) NOT NULL CHECK (score BETWEEN 0 AND 100), -- Final 0–100 score shown to users
  computed_score numeric(5,2) NOT NULL CHECK (computed_score BETWEEN 0 AND 100), -- Score from the formula before any override
  aadhaar_score smallint NOT NULL DEFAULT 0 CHECK (aadhaar_score BETWEEN 0 AND 100), -- Factor 0–100
  pan_score smallint NOT NULL DEFAULT 0 CHECK (pan_score BETWEEN 0 AND 100), -- Factor 0–100
  certificate_score smallint NOT NULL DEFAULT 0 CHECK (certificate_score BETWEEN 0 AND 100), -- Factor 0–100
  review_score smallint NOT NULL DEFAULT 0 CHECK (review_score BETWEEN 0 AND 100), -- Factor 0–100 (Bayesian-smoothed rating)
  complaint_score smallint NOT NULL DEFAULT 100 CHECK (complaint_score BETWEEN 0 AND 100), -- Factor 0–100 (100 = no upheld complaints)
  completeness_score smallint NOT NULL DEFAULT 0 CHECK (completeness_score BETWEEN 0 AND 100), -- Factor 0–100
  weights_version integer NOT NULL, -- trust_score_weights.version used
  inputs jsonb NOT NULL DEFAULT '{}'::jsonb, -- Raw inputs, e.g. {"published_reviews":42,"avg_rating":4.8,"upheld_complaints_12m":0}
  is_overridden boolean NOT NULL DEFAULT false, -- Admin override active
  override_score numeric(5,2) CHECK (override_score BETWEEN 0 AND 100), -- Manual score
  override_reason text, -- Required with an override
  override_expires_at timestamptz, -- Override ends automatically
  overridden_by uuid REFERENCES admins(id), -- Who overrode
  is_frozen boolean NOT NULL DEFAULT false, -- Frozen during an investigation; recalculation is skipped
  calculated_at timestamptz NOT NULL DEFAULT now(), -- Last calculation
  updated_at timestamptz NOT NULL DEFAULT now() -- Updated
);
CREATE INDEX idx_trust_scores_score ON trust_scores (score DESC);
CREATE TRIGGER trg_trust_scores_updated BEFORE UPDATE ON trust_scores FOR EACH ROW EXECUTE FUNCTION set_updated_at();
