-- @migration 044 M44 Banner Management
-- @table banners: Promotional banners in the mobile app.
CREATE TABLE banners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  title text NOT NULL, -- Headline, max 60 chars
  subtitle text, -- Supporting line, max 90 chars
  image_file_id uuid NOT NULL REFERENCES files(id) ON DELETE RESTRICT, -- 1080×480 image (public)
  placement text NOT NULL CHECK (placement IN ('home_top','home_middle','search_inline','teacher_dashboard','institute_dashboard','onboarding')), -- Where it shows
  audience text NOT NULL DEFAULT 'all' CHECK (audience IN ('all','parents','students','teachers','institutes')), -- Who sees it
  city_ids uuid[] NOT NULL DEFAULT '{}', -- Empty = all cities
  deep_link text, -- App route or https URL opened on tap
  priority smallint NOT NULL DEFAULT 0, -- Higher shows first
  starts_at timestamptz NOT NULL, -- Visible from
  ends_at timestamptz, -- Visible until (NULL = until paused)
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','active','paused','expired')), -- Lifecycle
  impressions bigint NOT NULL DEFAULT 0, -- Aggregated impressions
  clicks bigint NOT NULL DEFAULT 0, -- Aggregated clicks
  created_by uuid REFERENCES admins(id), -- Creator
  updated_by uuid REFERENCES admins(id), -- Last editor
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Updated
  deleted_at timestamptz, -- Soft delete
  deleted_by uuid REFERENCES admins(id), -- Who deleted
  CONSTRAINT ck_banners_window CHECK (ends_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX idx_banners_serving ON banners (placement, audience, priority DESC) WHERE status = 'active' AND deleted_at IS NULL;
CREATE INDEX idx_banners_status ON banners (status, starts_at) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_banners_updated BEFORE UPDATE ON banners FOR EACH ROW EXECUTE FUNCTION set_updated_at();
