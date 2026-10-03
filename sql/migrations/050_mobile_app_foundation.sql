-- GuruConnect mobile app (/api/v1/app) foundation tables — every table the M00–M54 mobile app spec
-- needs, applied in one batch (as it is one file in the source spec pack). Sourced verbatim from
-- D:\GuruMobile\sql\mobile_only.sql (the GuruConnect Mobile SRS pack) — apply, don't redesign; if a
-- column is wrong, fix it there too so the two packs don't drift. Apply after migrations 000–049.
-- Internal `@migration NNN` comments below are that pack's own module numbering, not this file's.

-- @migration 100 M00 Mobile app foundation (devices, notification inbox, notification preferences)
ALTER TABLE files ALTER COLUMN storage_provider SET DEFAULT 'r2';
ALTER TABLE app_users ADD COLUMN preferred_language text NOT NULL DEFAULT 'en' CHECK (preferred_language IN ('en','hi','kn','ta','te','mr','bn')); -- App language chosen by the user
ALTER TABLE app_users ADD COLUMN profile_photo_file_id uuid REFERENCES files(id) ON DELETE SET NULL; -- Avatar for parents, students and institute staff (teachers use teachers.profile_photo_file_id)
ALTER TABLE app_users ADD COLUMN signup_source text CHECK (signup_source IN ('organic','referral','campaign','admin_created','deep_link')); -- How the account was acquired

-- @table user_devices: Every app install a user has signed in on, with its FCM token. One row per (user, install).
CREATE TABLE user_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE, -- Owner
  install_id uuid NOT NULL, -- Random id generated on first launch and kept in secure storage
  platform text NOT NULL CHECK (platform IN ('android','ios')), -- OS
  os_version text, -- e.g. 14
  app_version text NOT NULL, -- Semver of the build, e.g. 1.2.0
  build_number integer, -- Store build number
  device_model text, -- e.g. SM-A546E
  fcm_token text, -- Firebase Cloud Messaging token; NULL when push permission denied
  push_permission text NOT NULL DEFAULT 'not_determined' CHECK (push_permission IN ('granted','denied','not_determined','provisional')), -- OS permission state
  locale text, -- e.g. en-IN
  timezone text NOT NULL DEFAULT 'Asia/Kolkata', -- IANA timezone
  last_seen_at timestamptz NOT NULL DEFAULT now(), -- Last API call from this install
  token_updated_at timestamptz, -- When fcm_token last changed
  revoked_at timestamptz, -- Set on logout / token UNREGISTERED
  created_at timestamptz NOT NULL DEFAULT now(), -- First sign-in on this install
  updated_at timestamptz NOT NULL DEFAULT now() -- Updated
);
CREATE UNIQUE INDEX uq_user_devices_install ON user_devices (user_id, install_id);
CREATE UNIQUE INDEX uq_user_devices_token ON user_devices (fcm_token) WHERE fcm_token IS NOT NULL AND revoked_at IS NULL;
CREATE INDEX idx_user_devices_user_active ON user_devices (user_id) WHERE revoked_at IS NULL;
CREATE TRIGGER trg_user_devices_updated BEFORE UPDATE ON user_devices FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- @table user_notifications: The in-app notification inbox for every user: transactional events and copies of admin campaigns.
CREATE TABLE user_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE, -- Recipient
  category text NOT NULL CHECK (category IN ('account','verification','leads','demos','reviews','payments','subscription','referral','complaints','recommendations','announcements')), -- Preference bucket
  event_type text NOT NULL, -- Machine event, e.g. teacher.approved, lead.received, review.published
  title text NOT NULL, -- Max 65 chars
  body text NOT NULL, -- Max 240 chars
  image_url text, -- Optional rich image (CDN URL)
  deep_link text, -- App route opened on tap, e.g. gc://leads/<id>
  data jsonb NOT NULL DEFAULT '{}'::jsonb, -- Extra payload, e.g. {"leadId":"…"}
  campaign_id uuid REFERENCES notifications(id) ON DELETE SET NULL, -- Set when the item comes from an admin campaign
  dedupe_key text, -- Prevents duplicates when an event is retried, e.g. lead.received:<leadId>
  push_status text NOT NULL DEFAULT 'pending' CHECK (push_status IN ('pending','sent','failed','skipped_pref','skipped_quiet_hours','no_device')), -- Push outcome
  read_at timestamptz, -- Opened in the inbox or via push tap
  expires_at timestamptz, -- Hidden after this (e.g. time-limited offers)
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  deleted_at timestamptz -- Soft delete (user swiped away)
);
CREATE UNIQUE INDEX uq_user_notifications_dedupe ON user_notifications (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX idx_user_notifications_inbox ON user_notifications (user_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_user_notifications_unread ON user_notifications (user_id) WHERE read_at IS NULL AND deleted_at IS NULL;

-- @table user_notification_preferences: Per-category push/email switches. Missing row = defaults (push on, email off).
CREATE TABLE user_notification_preferences (
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE, -- Owner
  category text NOT NULL CHECK (category IN ('account','verification','leads','demos','reviews','payments','subscription','referral','complaints','recommendations','announcements')), -- Bucket
  push_enabled boolean NOT NULL DEFAULT true, -- Send push for this category
  email_enabled boolean NOT NULL DEFAULT false, -- Send email for this category
  quiet_hours_start time, -- Local start of do-not-disturb, e.g. 22:00
  quiet_hours_end time, -- Local end, e.g. 07:00
  updated_at timestamptz NOT NULL DEFAULT now(), -- Updated
  PRIMARY KEY (user_id, category)
);
CREATE TRIGGER trg_user_notification_preferences_updated BEFORE UPDATE ON user_notification_preferences FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- @migration 104 M04 Login (OTP, sessions, sign-in identities)
-- @table otp_challenges: One-time codes sent by SMS or email for login, sign-up, contact changes and account deletion.
CREATE TABLE otp_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key; returned to the app as challengeId
  channel text NOT NULL CHECK (channel IN ('sms','email','whatsapp')), -- Delivery channel
  destination text NOT NULL, -- E.164 phone or lower-case email
  purpose text NOT NULL CHECK (purpose IN ('login','signup','change_phone','change_email','reset_password','delete_account','parent_consent')), -- Why the code was sent
  code_hash text NOT NULL, -- HMAC-SHA256 of the 6-digit code (never stored in plain text)
  user_id uuid REFERENCES app_users(id) ON DELETE CASCADE, -- Known user, if any
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5), -- Wrong-code attempts
  resend_count smallint NOT NULL DEFAULT 0, -- Resends of this challenge
  provider_message_id text, -- SMS/email provider id for delivery tracking
  ip_address inet, -- Requesting IP
  install_id uuid, -- Requesting install
  expires_at timestamptz NOT NULL, -- created_at + 5 minutes
  verified_at timestamptz, -- Successful verification
  consumed_at timestamptz, -- Used to issue a session or token (single use)
  created_at timestamptz NOT NULL DEFAULT now() -- Sent
);
CREATE INDEX idx_otp_challenges_dest ON otp_challenges (destination, created_at DESC);
CREATE INDEX idx_otp_challenges_expiry ON otp_challenges (expires_at) WHERE consumed_at IS NULL;

-- @table app_sessions: Refresh-token sessions for app users, one per signed-in install. Refresh tokens rotate on every use.
CREATE TABLE app_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Session id (sid claim in the JWT)
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE, -- Owner
  device_id uuid REFERENCES user_devices(id) ON DELETE SET NULL, -- Install the session belongs to
  refresh_token_hash text NOT NULL, -- SHA-256 of the current refresh token
  token_family uuid NOT NULL, -- Rotation family; reuse of an old token revokes the family
  auth_method text NOT NULL CHECK (auth_method IN ('otp','password','google','email_otp')), -- How the session started
  ip_address inet, -- IP at creation
  user_agent text, -- App user agent, e.g. GuruConnect/1.2.0 (Android 14)
  last_used_at timestamptz NOT NULL DEFAULT now(), -- Last refresh
  expires_at timestamptz NOT NULL, -- Absolute expiry (created_at + 60 days, sliding 30 days)
  revoked_at timestamptz, -- Logout, reuse detection, password change, account deletion
  revoked_reason text CHECK (revoked_reason IN ('logout','logout_all','reuse_detected','password_changed','account_suspended','account_deleted','expired','admin')), -- Why revoked
  created_at timestamptz NOT NULL DEFAULT now() -- Signed in
);
CREATE UNIQUE INDEX uq_app_sessions_token ON app_sessions (refresh_token_hash);
CREATE INDEX idx_app_sessions_user_active ON app_sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_app_sessions_family ON app_sessions (token_family);

-- @table user_auth_identities: Sign-in methods linked to an account: phone OTP, email + password, Google.
CREATE TABLE user_auth_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE, -- Owner
  provider text NOT NULL CHECK (provider IN ('phone','password','google')), -- Method
  provider_subject text NOT NULL, -- E.164 phone, lower-case email, or Google `sub`
  email citext, -- Email reported by Google / used for password login
  password_hash text, -- Argon2id hash (provider = password only)
  password_updated_at timestamptz, -- Last password change
  failed_attempts smallint NOT NULL DEFAULT 0, -- Consecutive wrong passwords
  locked_until timestamptz, -- Lockout after 5 wrong passwords (15 minutes)
  last_used_at timestamptz, -- Last successful sign-in with this method
  created_at timestamptz NOT NULL DEFAULT now(), -- Linked
  updated_at timestamptz NOT NULL DEFAULT now(), -- Updated
  deleted_at timestamptz, -- Unlinked (soft delete)
  CONSTRAINT ck_user_auth_identities_password CHECK ((provider = 'password') = (password_hash IS NOT NULL))
);
CREATE UNIQUE INDEX uq_user_auth_identities_subject ON user_auth_identities (provider, provider_subject) WHERE deleted_at IS NULL;
CREATE INDEX idx_user_auth_identities_user ON user_auth_identities (user_id) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_user_auth_identities_updated BEFORE UPDATE ON user_auth_identities FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE UNIQUE INDEX uq_app_users_phone_live ON app_users (phone) WHERE phone IS NOT NULL AND deleted_at IS NULL;

-- @migration 114 M14 Teacher registration (qualifications)
-- @table teacher_qualifications: Degrees and certifications a teacher lists during registration and in the profile builder.
CREATE TABLE teacher_qualifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  teacher_id uuid NOT NULL REFERENCES teachers(id) ON DELETE CASCADE, -- Owner
  level text NOT NULL CHECK (level IN ('secondary','senior_secondary','diploma','graduate','postgraduate','doctorate','professional','certification')), -- Level
  degree text NOT NULL, -- e.g. M.Sc. Physics, B.Ed.
  institution text NOT NULL, -- University / board / body
  year_completed smallint CHECK (year_completed BETWEEN 1960 AND 2100), -- Year
  grade text, -- e.g. 78% / 8.4 CGPA (optional)
  document_id uuid REFERENCES teacher_documents(id) ON DELETE SET NULL, -- Supporting certificate (Module 15)
  is_highest boolean NOT NULL DEFAULT false, -- Shown on cards; mirrors teachers.highest_qualification
  sort_order smallint NOT NULL DEFAULT 0, -- Display order
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Updated
  deleted_at timestamptz -- Soft delete
);
CREATE INDEX idx_teacher_qualifications_teacher ON teacher_qualifications (teacher_id, sort_order) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_teacher_qualifications_highest ON teacher_qualifications (teacher_id) WHERE is_highest AND deleted_at IS NULL;
CREATE TRIGGER trg_teacher_qualifications_updated BEFORE UPDATE ON teacher_qualifications FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- @migration 117 M17 Teacher profile builder (fee structure)
-- @table teacher_fee_plans: A teacher's fee structure: price per class group, subject and mode, per hour, per month or per course.
CREATE TABLE teacher_fee_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  teacher_id uuid NOT NULL REFERENCES teachers(id) ON DELETE CASCADE, -- Owner
  label text NOT NULL, -- e.g. Class 11–12 Physics · Online
  subject_id uuid REFERENCES subjects(id) ON DELETE RESTRICT, -- NULL = all subjects the teacher teaches
  class_from_id uuid REFERENCES classes(id) ON DELETE RESTRICT, -- Lowest class covered
  class_to_id uuid REFERENCES classes(id) ON DELETE RESTRICT, -- Highest class covered
  teaching_mode_id uuid REFERENCES teaching_modes(id) ON DELETE RESTRICT, -- NULL = any mode
  fee_unit text NOT NULL CHECK (fee_unit IN ('per_hour','per_month','per_course')), -- Billing unit
  amount_paise bigint NOT NULL CHECK (amount_paise BETWEEN 5000 AND 50000000), -- ₹50 to ₹5,00,000
  sessions_per_week smallint CHECK (sessions_per_week BETWEEN 1 AND 14), -- For per_month plans
  session_minutes smallint CHECK (session_minutes BETWEEN 30 AND 240), -- Length of one session
  notes text, -- e.g. Includes weekly test, max 200 chars
  is_active boolean NOT NULL DEFAULT true, -- Hidden when false
  sort_order smallint NOT NULL DEFAULT 0, -- Display order
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Updated
  deleted_at timestamptz -- Soft delete
);
CREATE INDEX idx_teacher_fee_plans_teacher ON teacher_fee_plans (teacher_id, sort_order) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_teacher_fee_plans_updated BEFORE UPDATE ON teacher_fee_plans FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- @migration 119 M19 Teacher availability
-- @table teacher_availability: Weekly recurring time windows when a teacher can take classes or demos (IST).
CREATE TABLE teacher_availability (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  teacher_id uuid NOT NULL REFERENCES teachers(id) ON DELETE CASCADE, -- Owner
  day_of_week smallint NOT NULL CHECK (day_of_week BETWEEN 1 AND 7), -- ISO day: 1 = Monday … 7 = Sunday
  start_time time NOT NULL, -- Local start, e.g. 16:00
  end_time time NOT NULL, -- Local end, e.g. 20:00
  teaching_mode_id uuid REFERENCES teaching_modes(id) ON DELETE RESTRICT, -- NULL = any mode
  accepts_demos boolean NOT NULL DEFAULT true, -- Demo slots can be booked in this window
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Updated
  deleted_at timestamptz, -- Soft delete
  CONSTRAINT ck_teacher_availability_window CHECK (end_time > start_time AND end_time - start_time >= interval '30 minutes')
);
CREATE INDEX idx_teacher_availability_teacher ON teacher_availability (teacher_id, day_of_week, start_time) WHERE deleted_at IS NULL;
CREATE INDEX idx_teacher_availability_search ON teacher_availability (day_of_week, start_time, end_time) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_teacher_availability_updated BEFORE UPDATE ON teacher_availability FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- @table teacher_time_off: Dates when a teacher is unavailable (holidays, exams). Blocks demo booking and shows "Away" on the profile.
CREATE TABLE teacher_time_off (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  teacher_id uuid NOT NULL REFERENCES teachers(id) ON DELETE CASCADE, -- Owner
  starts_on date NOT NULL, -- First day off
  ends_on date NOT NULL, -- Last day off (inclusive)
  reason text, -- Private note, max 120 chars
  pause_leads boolean NOT NULL DEFAULT false, -- Stop new leads during the period
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  deleted_at timestamptz, -- Soft delete
  CONSTRAINT ck_teacher_time_off_range CHECK (ends_on >= starts_on AND ends_on - starts_on <= 90)
);
CREATE INDEX idx_teacher_time_off_teacher ON teacher_time_off (teacher_id, starts_on) WHERE deleted_at IS NULL;

-- @migration 123 M23 Institute dashboard (views and daily stats)
-- @table institute_profile_views: Raw institute profile views from the app (one per viewer per institute per day).
CREATE TABLE institute_profile_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  institute_id uuid NOT NULL REFERENCES institutes(id) ON DELETE CASCADE, -- Viewed institute
  viewer_user_id uuid REFERENCES app_users(id) ON DELETE SET NULL, -- Viewer (NULL for shared-link visitors)
  source text NOT NULL CHECK (source IN ('search','recommendation','dashboard','favorites','share_link','notification','other')), -- Entry point
  city_id uuid REFERENCES cities(id) ON DELETE SET NULL, -- Viewer's city
  viewed_on date NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Kolkata')::date, -- IST day, for de-duplication
  viewed_at timestamptz NOT NULL DEFAULT now() -- Time
);
CREATE UNIQUE INDEX uq_institute_profile_views_daily ON institute_profile_views (institute_id, viewer_user_id, viewed_on) WHERE viewer_user_id IS NOT NULL;
CREATE INDEX idx_institute_profile_views_inst ON institute_profile_views (institute_id, viewed_at DESC);

-- @table institute_daily_stats: Per-institute daily counters for the institute dashboard (written by the nightly job, today refreshed every 15 minutes).
CREATE TABLE institute_daily_stats (
  institute_id uuid NOT NULL REFERENCES institutes(id) ON DELETE CASCADE, -- Institute
  stat_date date NOT NULL, -- IST day
  profile_views integer NOT NULL DEFAULT 0, -- Unique viewers
  search_impressions integer NOT NULL DEFAULT 0, -- Times shown in search results
  leads integer NOT NULL DEFAULT 0, -- Enquiries received
  leads_responded integer NOT NULL DEFAULT 0, -- Enquiries answered within 24 h
  campus_visits integer NOT NULL DEFAULT 0, -- Demo / visit requests
  favorites_added integer NOT NULL DEFAULT 0, -- Added to favourites
  shares integer NOT NULL DEFAULT 0, -- Profile shares
  computed_at timestamptz NOT NULL DEFAULT now(), -- Last computed
  PRIMARY KEY (institute_id, stat_date)
);

-- @migration 127 M27 Teacher search (search history)
-- @table user_search_history: Searches made by a user, used for "Recent searches" and as a recommendation signal. Kept 180 days.
CREATE TABLE user_search_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE, -- Searcher
  target text NOT NULL CHECK (target IN ('teacher','institute')), -- What was searched
  query_text text, -- Free text, max 100 chars
  filters jsonb NOT NULL DEFAULT '{}'::jsonb, -- Normalised filters, e.g. {"subjectIds":[…],"classId":"…","cityId":"…"}
  child_id uuid REFERENCES parent_children(id) ON DELETE SET NULL, -- Child the parent searched for, if chosen
  result_count integer NOT NULL DEFAULT 0, -- Results returned
  clicked_teacher_id uuid REFERENCES teachers(id) ON DELETE SET NULL, -- First result opened
  clicked_institute_id uuid REFERENCES institutes(id) ON DELETE SET NULL, -- First result opened
  created_at timestamptz NOT NULL DEFAULT now(), -- Searched
  deleted_at timestamptz -- Cleared by the user (soft delete)
);
CREATE INDEX idx_user_search_history_user ON user_search_history (user_id, created_at DESC) WHERE deleted_at IS NULL;

-- @migration 129 M29 Advanced filters (saved searches)
-- @table saved_searches: Named filter sets a user saved, with optional alerts when new matching teachers are approved.
CREATE TABLE saved_searches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE, -- Owner
  name text NOT NULL, -- e.g. Physics · Class 12 · Koramangala
  target text NOT NULL CHECK (target IN ('teacher','institute')), -- Search type
  filters jsonb NOT NULL, -- Same shape as the search API filters
  alert_enabled boolean NOT NULL DEFAULT false, -- Notify when new matches appear
  last_alerted_at timestamptz, -- Last alert sent (max one per day)
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Updated
  deleted_at timestamptz -- Soft delete
);
CREATE INDEX idx_saved_searches_user ON saved_searches (user_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_saved_searches_alerts ON saved_searches (target) WHERE alert_enabled AND deleted_at IS NULL;
CREATE TRIGGER trg_saved_searches_updated BEFORE UPDATE ON saved_searches FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- @migration 130 M30 Recommendation engine (dismissals and impressions)
-- @table recommendation_dismissals: Teachers or institutes a user marked "Not interested" so they stop being recommended.
CREATE TABLE recommendation_dismissals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE, -- User
  child_id uuid REFERENCES parent_children(id) ON DELETE CASCADE, -- Scope to one child (NULL = all)
  teacher_id uuid REFERENCES teachers(id) ON DELETE CASCADE, -- Dismissed teacher
  institute_id uuid REFERENCES institutes(id) ON DELETE CASCADE, -- Dismissed institute
  reason text CHECK (reason IN ('too_far','too_expensive','wrong_subject','not_relevant','other')), -- Optional reason
  created_at timestamptz NOT NULL DEFAULT now(), -- When
  CONSTRAINT ck_recommendation_dismissals_target CHECK ((teacher_id IS NULL) <> (institute_id IS NULL))
);
CREATE INDEX idx_recommendation_dismissals_user ON recommendation_dismissals (user_id);

-- @table recommendation_impressions: Recommendations shown to a user (sampled 100% at launch) to measure click-through and avoid showing the same card too often.
CREATE TABLE recommendation_impressions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE, -- Viewer
  child_id uuid REFERENCES parent_children(id) ON DELETE SET NULL, -- Child the list was for
  teacher_id uuid REFERENCES teachers(id) ON DELETE CASCADE, -- Recommended teacher
  institute_id uuid REFERENCES institutes(id) ON DELETE CASCADE, -- Recommended institute
  rail text NOT NULL CHECK (rail IN ('recommended_teachers','recommended_institutes','nearby','top_rated','verified','for_you')), -- Dashboard section
  position smallint NOT NULL, -- 1-based position in the rail
  score numeric(6,3) NOT NULL, -- Engine score at the time
  algo_version text NOT NULL, -- e.g. rules-v1
  clicked_at timestamptz, -- Card opened
  shown_at timestamptz NOT NULL DEFAULT now() -- Shown
);
CREATE INDEX idx_recommendation_impressions_user ON recommendation_impressions (user_id, shown_at DESC);

-- @migration 133 M33 Profile sharing
-- @table profile_shares: Each time a user shares a teacher or institute profile, with a short code for attribution.
CREATE TABLE profile_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  short_code text NOT NULL, -- 8-char code in the link, e.g. https://gcnt.in/s/k7Qm2xPa
  sharer_user_id uuid REFERENCES app_users(id) ON DELETE SET NULL, -- Who shared (NULL if signed out)
  teacher_id uuid REFERENCES teachers(id) ON DELETE CASCADE, -- Shared teacher
  institute_id uuid REFERENCES institutes(id) ON DELETE CASCADE, -- Shared institute
  channel text NOT NULL CHECK (channel IN ('whatsapp','copy_link','sms','other')), -- Chosen share target
  opens integer NOT NULL DEFAULT 0, -- Link opens
  installs integer NOT NULL DEFAULT 0, -- Installs attributed
  created_at timestamptz NOT NULL DEFAULT now(), -- Shared
  CONSTRAINT ck_profile_shares_target CHECK ((teacher_id IS NULL) <> (institute_id IS NULL))
);
CREATE UNIQUE INDEX uq_profile_shares_code ON profile_shares (short_code);
CREATE INDEX idx_profile_shares_teacher ON profile_shares (teacher_id, created_at DESC);
CREATE INDEX idx_profile_shares_institute ON profile_shares (institute_id, created_at DESC);

-- @migration 137 M37 Contact teacher (lead messages)
-- @table lead_messages: In-app messages between the requester and the teacher / institute on a lead. Text only in v1.
CREATE TABLE lead_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE, -- Conversation
  sender_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT, -- Author
  sender_role text NOT NULL CHECK (sender_role IN ('requester','teacher','institute_staff','system')), -- Side of the conversation
  body text NOT NULL, -- 1–1,000 chars
  client_message_id uuid NOT NULL, -- Generated by the app; makes sending idempotent offline
  contains_contact_info boolean NOT NULL DEFAULT false, -- Phone/UPI/email detected before contact unlock (masked for the receiver)
  is_flagged boolean NOT NULL DEFAULT false, -- Reported by the receiver
  read_at timestamptz, -- Read by the other side
  created_at timestamptz NOT NULL DEFAULT now(), -- Sent
  deleted_at timestamptz -- Soft delete by sender within 10 minutes
);
CREATE UNIQUE INDEX uq_lead_messages_client ON lead_messages (sender_user_id, client_message_id);
CREATE INDEX idx_lead_messages_lead ON lead_messages (lead_id, created_at);

-- @migration 140 M40 Favorite teachers (favourites)
-- @table user_favorites: Teachers and institutes a user saved to their favourites.
CREATE TABLE user_favorites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE, -- Owner
  target_type text NOT NULL CHECK (target_type IN ('teacher','institute')), -- Kind
  teacher_id uuid REFERENCES teachers(id) ON DELETE CASCADE, -- Saved teacher
  institute_id uuid REFERENCES institutes(id) ON DELETE CASCADE, -- Saved institute
  child_id uuid REFERENCES parent_children(id) ON DELETE SET NULL, -- Optional: saved for which child
  note text, -- Private note, max 200 chars
  created_at timestamptz NOT NULL DEFAULT now(), -- Saved
  deleted_at timestamptz, -- Removed (soft delete)
  CONSTRAINT ck_user_favorites_target CHECK ((target_type = 'teacher' AND teacher_id IS NOT NULL AND institute_id IS NULL) OR (target_type = 'institute' AND institute_id IS NOT NULL AND teacher_id IS NULL))
);
CREATE UNIQUE INDEX uq_user_favorites_teacher ON user_favorites (user_id, teacher_id) WHERE teacher_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX uq_user_favorites_institute ON user_favorites (user_id, institute_id) WHERE institute_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_user_favorites_user ON user_favorites (user_id, target_type, created_at DESC) WHERE deleted_at IS NULL;

-- @migration 146 M46 Referral system (wallet)
-- @table wallet_ledger: Append-only ledger of GuruConnect wallet credits and debits (referral rewards, use at checkout, reversals). Balance = sum(amount_paise).
CREATE TABLE wallet_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT, -- Wallet owner
  amount_paise bigint NOT NULL CHECK (amount_paise <> 0), -- Positive = credit, negative = debit
  entry_type text NOT NULL CHECK (entry_type IN ('referral_reward','referee_bonus','checkout_redemption','redemption_refund','reversal','expiry','admin_adjustment')), -- Why
  referral_id uuid REFERENCES referrals(id) ON DELETE RESTRICT, -- Source referral
  transaction_id uuid REFERENCES transactions(id) ON DELETE RESTRICT, -- Related payment / payout record
  description text NOT NULL, -- Shown in the app, e.g. Reward: Priya joined with your code
  expires_at timestamptz, -- Credits expire 365 days after issue
  idempotency_key text NOT NULL, -- e.g. referral_reward:<referralId>
  created_at timestamptz NOT NULL DEFAULT now() -- Posted
);
CREATE UNIQUE INDEX uq_wallet_ledger_idem ON wallet_ledger (idempotency_key);
CREATE INDEX idx_wallet_ledger_user ON wallet_ledger (user_id, created_at DESC);

-- @migration 149 M49 Report user (blocks)
-- @table user_blocks: Users one user has blocked. Blocked users can't contact, message or review the blocker.
CREATE TABLE user_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  blocker_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE, -- Who blocked
  blocked_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE, -- Who is blocked
  complaint_id uuid REFERENCES complaints(id) ON DELETE SET NULL, -- Report filed at the same time, if any
  created_at timestamptz NOT NULL DEFAULT now(), -- Blocked
  deleted_at timestamptz, -- Unblocked (soft delete)
  CONSTRAINT ck_user_blocks_self CHECK (blocker_user_id <> blocked_user_id)
);
CREATE UNIQUE INDEX uq_user_blocks_pair ON user_blocks (blocker_user_id, blocked_user_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_user_blocks_blocked ON user_blocks (blocked_user_id) WHERE deleted_at IS NULL;

-- @migration 152 M52 Privacy settings (privacy and consents)
-- @table user_privacy_settings: What a user shows to others and allows the platform to do with their data.
CREATE TABLE user_privacy_settings (
  user_id uuid PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE, -- Owner
  show_last_name boolean NOT NULL DEFAULT false, -- Reviews show "Lakshmi V." when false
  show_area_to_teachers boolean NOT NULL DEFAULT true, -- Teachers see the area on leads
  show_profile_in_search boolean NOT NULL DEFAULT true, -- Teachers/institutes: listed in search (false = paused listing)
  allow_whatsapp_contact boolean NOT NULL DEFAULT true, -- Show a WhatsApp button once contact is unlocked
  allow_personalised_recommendations boolean NOT NULL DEFAULT true, -- Use search history and children for recommendations
  allow_marketing_notifications boolean NOT NULL DEFAULT true, -- Announcements and offers
  allow_analytics boolean NOT NULL DEFAULT true, -- Product analytics events
  updated_at timestamptz NOT NULL DEFAULT now() -- Updated
);
CREATE TRIGGER trg_user_privacy_settings_updated BEFORE UPDATE ON user_privacy_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- @table user_consents: Record of every consent given or withdrawn (terms, privacy policy, parental consent, marketing), as required by the DPDP Act 2023.
CREATE TABLE user_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE, -- Data principal
  consent_type text NOT NULL CHECK (consent_type IN ('terms','privacy_policy','marketing','personalisation','parental_consent','data_processing_minor')), -- What
  document_version text NOT NULL, -- e.g. privacy-2026-09
  granted boolean NOT NULL, -- true = given, false = withdrawn
  method text NOT NULL CHECK (method IN ('checkbox','otp','toggle','email_link')), -- How it was captured
  guardian_phone text, -- For parental consent: verified guardian phone
  ip_address inet, -- IP
  install_id uuid, -- Install
  created_at timestamptz NOT NULL DEFAULT now() -- When
);
CREATE INDEX idx_user_consents_user ON user_consents (user_id, consent_type, created_at DESC);

-- @migration 153 M53 Help and support
-- @table faqs: Help-centre questions and answers shown in the app, by audience.
CREATE TABLE faqs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  audience text NOT NULL DEFAULT 'all' CHECK (audience IN ('all','parent','student','teacher','institute')), -- Who sees it
  category text NOT NULL CHECK (category IN ('getting_started','account','payments','verification','leads_demos','reviews','safety','privacy')), -- Section
  question text NOT NULL, -- Max 160 chars
  answer_md text NOT NULL, -- Markdown answer, max 3,000 chars
  sort_order smallint NOT NULL DEFAULT 0, -- Order within category
  is_published boolean NOT NULL DEFAULT true, -- Hidden when false
  helpful_yes integer NOT NULL DEFAULT 0, -- "Was this helpful?" yes votes
  helpful_no integer NOT NULL DEFAULT 0, -- No votes
  created_by uuid REFERENCES admins(id), -- Author
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Updated
  deleted_at timestamptz -- Soft delete
);
CREATE INDEX idx_faqs_audience ON faqs (audience, category, sort_order) WHERE is_published AND deleted_at IS NULL;
CREATE INDEX idx_faqs_search ON faqs USING gin (to_tsvector('english', question || ' ' || answer_md));
CREATE TRIGGER trg_faqs_updated BEFORE UPDATE ON faqs FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE SEQUENCE seq_ticket_number START 10001; -- generates support_tickets.ticket_number
-- @table support_tickets: Support requests raised from the app (not safety reports — those are complaints).
CREATE TABLE support_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  ticket_number text NOT NULL DEFAULT ('ST-' || nextval('seq_ticket_number')), -- e.g. ST-10001
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT, -- Requester
  category text NOT NULL CHECK (category IN ('account','payment','verification','technical','lead_demo','feedback','other')), -- Topic
  subject text NOT NULL, -- 5–120 chars
  transaction_id uuid REFERENCES transactions(id) ON DELETE SET NULL, -- Related payment, if any
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','awaiting_user','in_progress','resolved','closed')), -- Lifecycle
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')), -- Set by rules (payment issues = high)
  assigned_admin_id uuid REFERENCES admins(id), -- Support owner
  app_version text, -- Diagnostics captured on create
  device_info jsonb, -- {"platform":"android","os":"14","model":"…"}
  first_response_at timestamptz, -- First admin reply
  resolved_at timestamptz, -- Resolved
  rating smallint CHECK (rating BETWEEN 1 AND 5), -- User satisfaction after resolution
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Updated
  deleted_at timestamptz -- Soft delete
);
CREATE UNIQUE INDEX uq_support_tickets_number ON support_tickets (ticket_number);
CREATE INDEX idx_support_tickets_user ON support_tickets (user_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_support_tickets_queue ON support_tickets (status, priority, created_at) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_support_tickets_updated BEFORE UPDATE ON support_tickets FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- @table support_ticket_messages: Conversation on a support ticket between the user and support staff.
CREATE TABLE support_ticket_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  ticket_id uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE, -- Ticket
  author_type text NOT NULL CHECK (author_type IN ('app_user','admin','system')), -- Side
  author_id uuid, -- app_users.id or admins.id
  body text NOT NULL, -- 1–3,000 chars
  attachment_file_ids uuid[] NOT NULL DEFAULT '{}', -- Up to 3 private screenshots (files)
  client_message_id uuid, -- Idempotency for app-sent messages
  created_at timestamptz NOT NULL DEFAULT now() -- Sent
);
CREATE INDEX idx_support_ticket_messages_ticket ON support_ticket_messages (ticket_id, created_at);
CREATE UNIQUE INDEX uq_support_ticket_messages_client ON support_ticket_messages (ticket_id, client_message_id) WHERE client_message_id IS NOT NULL;

-- @migration 154 M54 Delete account
-- @table account_deletion_requests: Account deletion requests with a 30-day grace period before data is erased or anonymised.
CREATE TABLE account_deletion_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT, -- Account
  reason_code text NOT NULL CHECK (reason_code IN ('found_teacher','not_useful','privacy','too_many_notifications','duplicate_account','other')), -- Why
  reason_text text, -- Optional details, max 500 chars
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','cancelled','processing','completed','blocked')), -- Lifecycle
  blocked_reason text, -- e.g. open complaint against the user, pending payout
  scheduled_for timestamptz NOT NULL, -- created_at + 30 days
  cancelled_at timestamptz, -- User signed back in and cancelled
  completed_at timestamptz, -- Erasure finished
  erasure_report jsonb, -- Tables and row counts erased / anonymised / retained (legal hold)
  created_at timestamptz NOT NULL DEFAULT now(), -- Requested
  updated_at timestamptz NOT NULL DEFAULT now() -- Updated
);
CREATE UNIQUE INDEX uq_account_deletion_live ON account_deletion_requests (user_id) WHERE status IN ('scheduled','processing');
CREATE INDEX idx_account_deletion_due ON account_deletion_requests (scheduled_for) WHERE status = 'scheduled';
CREATE TRIGGER trg_account_deletion_requests_updated BEFORE UPDATE ON account_deletion_requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();
