-- @migration 047 M47 Dashboard Analytics
-- @table daily_platform_stats: One row per day with platform totals, written by the nightly analytics job and refreshed hourly for today.
CREATE TABLE daily_platform_stats (
  stat_date date PRIMARY KEY, -- Day (Asia/Kolkata)
  teachers_total integer NOT NULL DEFAULT 0, -- Teachers (not deleted) at end of day
  teachers_verified integer NOT NULL DEFAULT 0, -- Approved teachers
  teachers_pending integer NOT NULL DEFAULT 0, -- In the approval queue
  institutes_total integer NOT NULL DEFAULT 0, -- Institutes
  institutes_verified integer NOT NULL DEFAULT 0, -- Approved institutes
  parents_total integer NOT NULL DEFAULT 0, -- Parents
  students_total integer NOT NULL DEFAULT 0, -- Students
  new_teachers integer NOT NULL DEFAULT 0, -- Sign-ups that day
  new_parents integer NOT NULL DEFAULT 0, -- Sign-ups that day
  new_students integer NOT NULL DEFAULT 0, -- Sign-ups that day
  new_institutes integer NOT NULL DEFAULT 0, -- Sign-ups that day
  active_subscriptions integer NOT NULL DEFAULT 0, -- Trial + active + grace at end of day
  revenue_paise bigint NOT NULL DEFAULT 0, -- Captured minus refunded that day
  leads_created integer NOT NULL DEFAULT 0, -- Leads that day
  demos_completed integer NOT NULL DEFAULT 0, -- Demos completed
  reviews_published integer NOT NULL DEFAULT 0, -- Reviews published
  complaints_opened integer NOT NULL DEFAULT 0, -- Complaints opened
  avg_trust_score numeric(5,2), -- Average over approved teachers
  city_breakdown jsonb NOT NULL DEFAULT '{}'::jsonb, -- {"<city_id>":{"parents":…,"students":…,"teachers":…}}
  computed_at timestamptz NOT NULL DEFAULT now() -- Last computed
);
