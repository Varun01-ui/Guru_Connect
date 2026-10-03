-- @migration 021 M21 Teacher Analytics
-- @table teacher_profile_views: Raw profile-view events from the app. High volume; partition by month when it exceeds ~50M rows.
CREATE TABLE teacher_profile_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  teacher_id uuid NOT NULL REFERENCES teachers(id) ON DELETE CASCADE, -- Teacher viewed
  viewer_user_id uuid REFERENCES app_users(id) ON DELETE SET NULL, -- Viewer, NULL for signed-out views
  source text NOT NULL DEFAULT 'search' CHECK (source IN ('search','home_featured','home_recommended','nearby','shared_link','institute_page','other')), -- Where the view came from
  city_id uuid REFERENCES cities(id), -- Viewer city at the time
  viewed_at timestamptz NOT NULL DEFAULT now() -- When
);
CREATE INDEX idx_teacher_profile_views_teacher ON teacher_profile_views (teacher_id, viewed_at DESC);

-- @table teacher_daily_stats: Daily roll-up per teacher, written by a nightly job. All analytics screens read from here.
CREATE TABLE teacher_daily_stats (
  teacher_id uuid NOT NULL REFERENCES teachers(id) ON DELETE CASCADE, -- Teacher
  stat_date date NOT NULL, -- Day (Asia/Kolkata)
  profile_views integer NOT NULL DEFAULT 0, -- Views that day
  unique_viewers integer NOT NULL DEFAULT 0, -- Distinct signed-in viewers
  lead_requests integer NOT NULL DEFAULT 0, -- Leads created
  demo_requests integer NOT NULL DEFAULT 0, -- Demo requests created
  demos_completed integer NOT NULL DEFAULT 0, -- Demos marked completed
  reviews_published integer NOT NULL DEFAULT 0, -- Reviews published
  rating_sum integer NOT NULL DEFAULT 0, -- Sum of star ratings published that day (average = rating_sum / reviews_published)
  updated_at timestamptz NOT NULL DEFAULT now(), -- Last recomputed
  PRIMARY KEY (teacher_id, stat_date)
);
CREATE INDEX idx_teacher_daily_stats_date ON teacher_daily_stats (stat_date);
