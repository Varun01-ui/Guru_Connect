-- @migration 045 M45 Blog Management
-- @table blogs: Articles and guides shown in the app and on the website.
CREATE TABLE blogs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  title text NOT NULL, -- Title, max 120 chars
  slug text NOT NULL, -- URL slug, unique
  excerpt text, -- Summary, max 300 chars
  content_md text NOT NULL, -- Body in Markdown (sanitised on render)
  cover_file_id uuid REFERENCES files(id) ON DELETE SET NULL, -- Cover image
  category text NOT NULL CHECK (category IN ('parent_guides','exam_prep','teacher_tips','platform_news','success_stories')), -- Category
  tags text[] NOT NULL DEFAULT '{}', -- Tags
  audience text NOT NULL DEFAULT 'all' CHECK (audience IN ('all','parents','students','teachers','institutes')), -- Target audience
  class_ids uuid[] NOT NULL DEFAULT '{}', -- Classes it is relevant to (used for per-child content)
  author_admin_id uuid REFERENCES admins(id), -- Author
  author_display_name text, -- Byline override, e.g. Guest · A. Iyer
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','in_review','scheduled','published','archived')), -- Lifecycle
  published_at timestamptz, -- Publish time (future = scheduled)
  seo_title text, -- Max 60 chars
  seo_description text, -- Max 160 chars
  reading_minutes smallint, -- Computed from word count
  view_count bigint NOT NULL DEFAULT 0, -- Aggregated views
  created_by uuid REFERENCES admins(id), -- Creator
  updated_by uuid REFERENCES admins(id), -- Last editor
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Updated
  deleted_at timestamptz, -- Soft delete
  deleted_by uuid REFERENCES admins(id) -- Who deleted
);
CREATE UNIQUE INDEX uq_blogs_slug ON blogs (slug) WHERE deleted_at IS NULL;
CREATE INDEX idx_blogs_published ON blogs (status, published_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_blogs_classes ON blogs USING gin (class_ids);
CREATE INDEX idx_blogs_search ON blogs USING gin (to_tsvector('english', title || ' ' || coalesce(excerpt,'')));
CREATE TRIGGER trg_blogs_updated BEFORE UPDATE ON blogs FOR EACH ROW EXECUTE FUNCTION set_updated_at();
