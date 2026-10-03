-- GuruConnect Admin Portal — full PostgreSQL 16 schema (all migrations in order)

-- @migration 000 M0 Platform foundation (extensions, helpers, audit logs, files, app users)
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Keeps updated_at current on every UPDATE. Attach with: CREATE TRIGGER trg_<table>_updated BEFORE UPDATE ON <table> FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- @table audit_logs: Append-only record of every admin action and security event. Never updated or deleted by the application.
CREATE TABLE audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  actor_type text NOT NULL CHECK (actor_type IN ('admin','system','app_user')), -- Who performed the action
  actor_id uuid, -- admins.id / app_users.id; NULL for system jobs (no FK so logs survive deletions)
  actor_email citext, -- Snapshot of the actor's email at the time of the action
  action text NOT NULL, -- Dotted event name, e.g. teacher.approved, payment_config.published
  module text NOT NULL, -- Module slug, e.g. teachers, payment_config
  entity_type text, -- Table or aggregate name, e.g. teachers
  entity_id uuid, -- Primary key of the affected row
  old_values jsonb, -- Changed fields before the action (sensitive fields removed)
  new_values jsonb, -- Changed fields after the action (sensitive fields removed)
  reason text, -- Free-text reason entered by the admin, when the action requires one
  ip_address inet, -- Client IP from X-Forwarded-For (first trusted hop)
  user_agent text, -- Client user agent, truncated to 512 chars
  request_id uuid, -- Correlation id from the X-Request-Id header
  created_at timestamptz NOT NULL DEFAULT now() -- When the action happened
);
CREATE INDEX idx_audit_logs_created_at ON audit_logs (created_at DESC);
CREATE INDEX idx_audit_logs_entity ON audit_logs (entity_type, entity_id, created_at DESC);
CREATE INDEX idx_audit_logs_actor ON audit_logs (actor_id, created_at DESC);
CREATE INDEX idx_audit_logs_module_action ON audit_logs (module, action, created_at DESC);

-- @table files: Metadata for every uploaded object stored in S3 / Cloudflare R2. Binary content never touches PostgreSQL.
CREATE TABLE files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  storage_provider text NOT NULL DEFAULT 's3' CHECK (storage_provider IN ('s3','r2')), -- Object store in use
  bucket text NOT NULL, -- Bucket name
  object_key text NOT NULL, -- Full object key, e.g. teachers/<uuid>/aadhaar/<uuid>.pdf
  original_name text NOT NULL, -- File name as uploaded (sanitised, max 255)
  mime_type text NOT NULL, -- Validated MIME type
  size_bytes bigint NOT NULL CHECK (size_bytes > 0), -- File size in bytes
  checksum_sha256 text, -- Hex SHA-256 reported by the client and verified after upload
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','public')), -- private = signed URLs only (documents); public = CDN (banners, blog images)
  purpose text NOT NULL, -- Why it was uploaded, e.g. teacher_document, banner_image, admin_avatar
  uploaded_by_type text NOT NULL CHECK (uploaded_by_type IN ('admin','app_user','system')), -- Uploader kind
  uploaded_by_id uuid, -- Uploader id (polymorphic, no FK)
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','uploaded','quarantined','deleted')), -- pending until the upload is confirmed and virus-scanned
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Last updated
  deleted_at timestamptz -- Soft delete; object is removed from storage by a cleanup job after 30 days
);
CREATE UNIQUE INDEX uq_files_object ON files (bucket, object_key);
CREATE INDEX idx_files_purpose ON files (purpose, created_at DESC);
CREATE TRIGGER trg_files_updated BEFORE UPDATE ON files FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- @table app_users: Login identity for every mobile app account (parent, student, teacher, institute staff). Role profiles hang off this table.
CREATE TABLE app_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  user_type text NOT NULL CHECK (user_type IN ('parent','student','teacher','institute_staff')), -- Primary role chosen at sign-up
  phone text, -- E.164 mobile number, e.g. +919845014210
  phone_verified_at timestamptz, -- Set after OTP verification
  email citext, -- Email address
  email_verified_at timestamptz, -- Set after email verification
  full_name text NOT NULL, -- Display name
  auth_provider text NOT NULL DEFAULT 'otp' CHECK (auth_provider IN ('otp','password','google','apple')), -- First sign-in method
  account_status text NOT NULL DEFAULT 'active' CHECK (account_status IN ('active','suspended','banned','deactivated')), -- Suspended and banned users cannot sign in
  suspended_reason text, -- Shown to support staff, not to the user
  suspended_at timestamptz, -- When suspended
  last_active_at timestamptz, -- Last authenticated request (updated at most every 5 minutes)
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Last updated
  deleted_at timestamptz -- Soft delete (account deletion request); PII is anonymised by a job after 30 days
);
CREATE UNIQUE INDEX uq_app_users_phone ON app_users (phone) WHERE deleted_at IS NULL AND phone IS NOT NULL;
CREATE UNIQUE INDEX uq_app_users_email ON app_users (email) WHERE deleted_at IS NULL AND email IS NOT NULL;
CREATE INDEX idx_app_users_type_status ON app_users (user_type, account_status) WHERE deleted_at IS NULL;
CREATE INDEX idx_app_users_name_trgm ON app_users USING gin (full_name gin_trgm_ops);
CREATE TRIGGER trg_app_users_updated BEFORE UPDATE ON app_users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- @migration 001 M1 Authentication System
-- @table admins: Admin web portal accounts. Every admin action is attributed to a row here.
CREATE TABLE admins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  email citext NOT NULL, -- Login email, unique among non-deleted admins
  password_hash text NOT NULL, -- Argon2id hash (never returned by any API)
  full_name text NOT NULL, -- Display name, 2–100 chars
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('invited','active','locked','disabled')), -- invited = must set password; locked = too many failed logins; disabled = access removed
  is_super_admin boolean NOT NULL DEFAULT false, -- Bypasses permission checks; at least one active super admin must always exist
  failed_login_count smallint NOT NULL DEFAULT 0, -- Consecutive failed logins; reset on success
  locked_until timestamptz, -- Login blocked until this time after 5 failures
  last_login_at timestamptz, -- Last successful login
  last_login_ip inet, -- IP of the last successful login
  password_changed_at timestamptz NOT NULL DEFAULT now(), -- Used to invalidate tokens issued before a password change
  mfa_enabled boolean NOT NULL DEFAULT false, -- Reserved for TOTP (future)
  created_by uuid REFERENCES admins(id), -- Admin who created this account
  updated_by uuid REFERENCES admins(id), -- Admin who last updated this account
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Last updated
  deleted_at timestamptz, -- Soft delete
  deleted_by uuid REFERENCES admins(id) -- Admin who deleted this account
);
CREATE UNIQUE INDEX uq_admins_email ON admins (email) WHERE deleted_at IS NULL;
CREATE INDEX idx_admins_status ON admins (status) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_admins_updated BEFORE UPDATE ON admins FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- @table admin_sessions: One row per signed-in device. Holds the hashed refresh token used to mint new access tokens.
CREATE TABLE admin_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Session id; also the "sid" claim in access tokens
  admin_id uuid NOT NULL REFERENCES admins(id) ON DELETE CASCADE, -- Session owner
  refresh_token_hash text NOT NULL, -- SHA-256 of the current refresh token (the raw token is only in the httpOnly cookie)
  token_family uuid NOT NULL DEFAULT gen_random_uuid(), -- Rotation family; reuse of an old token revokes the whole family
  previous_token_hash text, -- Hash of the token that was rotated out, used for reuse detection
  ip_address inet, -- IP at sign-in
  user_agent text, -- Browser user agent at sign-in
  device_label text, -- Parsed label, e.g. "Chrome on Windows"
  last_used_at timestamptz NOT NULL DEFAULT now(), -- Last refresh
  expires_at timestamptz NOT NULL, -- Absolute expiry (7 days, or 30 with "keep me signed in")
  revoked_at timestamptz, -- Set on logout, password change or forced sign-out
  revoked_reason text CHECK (revoked_reason IN ('logout','logout_all','password_changed','token_reuse','admin_forced','expired','account_disabled')), -- Why it was revoked
  created_at timestamptz NOT NULL DEFAULT now() -- Sign-in time
);
CREATE UNIQUE INDEX uq_admin_sessions_token ON admin_sessions (refresh_token_hash);
CREATE INDEX idx_admin_sessions_admin_active ON admin_sessions (admin_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_admin_sessions_prev_token ON admin_sessions (previous_token_hash) WHERE previous_token_hash IS NOT NULL;

-- @table password_reset_tokens: Single-use, 30-minute tokens for the forgot-password and invite flows.
CREATE TABLE password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  admin_id uuid NOT NULL REFERENCES admins(id) ON DELETE CASCADE, -- Account being reset
  token_hash text NOT NULL, -- SHA-256 of the emailed token
  purpose text NOT NULL DEFAULT 'reset' CHECK (purpose IN ('reset','invite')), -- invite tokens live 72 hours
  expires_at timestamptz NOT NULL, -- Expiry
  used_at timestamptz, -- Set when consumed; a used token can never be reused
  requested_ip inet, -- IP that requested the reset
  created_at timestamptz NOT NULL DEFAULT now() -- Created
);
CREATE UNIQUE INDEX uq_password_reset_tokens_hash ON password_reset_tokens (token_hash);
CREATE INDEX idx_password_reset_tokens_admin ON password_reset_tokens (admin_id, created_at DESC);

-- @migration 002 M2 Roles & Permissions
-- @table roles: Named bundles of permissions. System roles are seeded and cannot be deleted.
CREATE TABLE roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  code text NOT NULL, -- Stable machine name, e.g. super_admin, finance_admin
  name text NOT NULL, -- Display name, e.g. Finance Admin
  description text, -- What this role is for
  is_system boolean NOT NULL DEFAULT false, -- Seeded roles; name/permissions of super_admin are immutable
  created_by uuid REFERENCES admins(id), -- Creator
  updated_by uuid REFERENCES admins(id), -- Last editor
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Last updated
  deleted_at timestamptz, -- Soft delete (custom roles only, and only when no admin holds it)
  deleted_by uuid REFERENCES admins(id) -- Who deleted it
);
CREATE UNIQUE INDEX uq_roles_code ON roles (code) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_roles_name ON roles (lower(name)) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_roles_updated BEFORE UPDATE ON roles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- @table permissions: Catalogue of permission keys. Seeded from code; admins cannot create permissions.
CREATE TABLE permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  key text NOT NULL, -- Dotted key checked by the API, e.g. teachers.approve
  module text NOT NULL, -- Module slug used to group the permission matrix UI
  description text NOT NULL, -- What the permission allows
  is_sensitive boolean NOT NULL DEFAULT false, -- Sensitive permissions (payments, roles, document unmasking) are highlighted in the UI
  created_at timestamptz NOT NULL DEFAULT now() -- Created
);
CREATE UNIQUE INDEX uq_permissions_key ON permissions (key);
CREATE INDEX idx_permissions_module ON permissions (module);

-- @table role_permissions: Which permissions each role grants.
CREATE TABLE role_permissions (
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE, -- Role
  permission_id uuid NOT NULL REFERENCES permissions(id) ON DELETE CASCADE, -- Permission granted
  granted_by uuid REFERENCES admins(id), -- Admin who granted it
  granted_at timestamptz NOT NULL DEFAULT now(), -- When granted
  PRIMARY KEY (role_id, permission_id)
);
CREATE INDEX idx_role_permissions_permission ON role_permissions (permission_id);

-- @table admin_roles: Which roles each admin holds. An admin may hold several roles; effective permissions are the union.
CREATE TABLE admin_roles (
  admin_id uuid NOT NULL REFERENCES admins(id) ON DELETE CASCADE, -- Admin
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE RESTRICT, -- Role held
  assigned_by uuid REFERENCES admins(id), -- Who assigned it
  assigned_at timestamptz NOT NULL DEFAULT now(), -- When assigned
  PRIMARY KEY (admin_id, role_id)
);
CREATE INDEX idx_admin_roles_role ON admin_roles (role_id);

-- @migration 003 M3 Admin Profile Management
-- @table admin_profiles: Personal details for an admin, one-to-one with admins.
CREATE TABLE admin_profiles (
  admin_id uuid PRIMARY KEY REFERENCES admins(id) ON DELETE CASCADE, -- One-to-one with admins
  display_name text, -- Optional short name shown in the top bar
  phone text, -- E.164 phone number
  designation text, -- Job title, e.g. Verification Lead
  avatar_file_id uuid REFERENCES files(id), -- Profile image (public CDN file)
  timezone text NOT NULL DEFAULT 'Asia/Kolkata', -- IANA time zone used to display dates
  locale text NOT NULL DEFAULT 'en-IN', -- UI locale
  theme text NOT NULL DEFAULT 'system' CHECK (theme IN ('light','dark','system')), -- UI theme preference
  notification_prefs jsonb NOT NULL DEFAULT '{"email_digest":true,"queue_alerts":true}'::jsonb, -- Email/alert preferences
  updated_at timestamptz NOT NULL DEFAULT now() -- Last updated
);
CREATE TRIGGER trg_admin_profiles_updated BEFORE UPDATE ON admin_profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- @migration 004 M4 Global Settings
-- @table system_settings: Typed key–value settings that change platform behaviour without a deploy.
CREATE TABLE system_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  key text NOT NULL, -- Dotted key, e.g. platform.name, support.email, app.min_android_version
  group_name text NOT NULL, -- UI group: general, contact, legal, app_versions, limits
  value jsonb NOT NULL, -- Value wrapped in JSON, e.g. "GuruConnect", 3, true
  value_type text NOT NULL CHECK (value_type IN ('string','number','boolean','url','email','phone','semver','json')), -- Drives validation and the input control
  label text NOT NULL, -- Label in the settings form
  description text, -- Help text under the input
  is_public boolean NOT NULL DEFAULT false, -- true = exposed to the mobile app via GET /public/settings
  is_editable boolean NOT NULL DEFAULT true, -- false = read-only in the UI (managed by deploys)
  updated_by uuid REFERENCES admins(id), -- Last editor
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now() -- Last updated
);
CREATE UNIQUE INDEX uq_system_settings_key ON system_settings (key);
CREATE INDEX idx_system_settings_group ON system_settings (group_name);
CREATE TRIGGER trg_system_settings_updated BEFORE UPDATE ON system_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- @migration 005 M5 Dynamic Payment Configuration
-- @table payment_configurations: One row per version of each fee. The app charges whichever version is active at payment time.
CREATE TABLE payment_configurations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key (one per version)
  fee_code text NOT NULL CHECK (fee_code IN ('TEACHER_REGISTRATION','INSTITUTE_REGISTRATION','PARENT_SUBSCRIPTION_MONTHLY','PARENT_SUBSCRIPTION_YEARLY','STUDENT_SUBSCRIPTION_MONTHLY','STUDENT_SUBSCRIPTION_YEARLY','PREMIUM_TEACHER','FEATURED_TEACHER','CONTACT_UNLOCK')), -- Which fee this row prices
  version integer NOT NULL CHECK (version > 0), -- 1, 2, 3… per fee_code
  name text NOT NULL, -- Display name shown to users, e.g. Parent Membership (Monthly)
  description text, -- Short description shown on the pricing screen
  is_enabled boolean NOT NULL DEFAULT true, -- false = fee switched off; the app hides the purchase and skips the payment step
  amount_paise bigint NOT NULL CHECK (amount_paise >= 0), -- Price in paise (₹499 = 49900)
  currency char(3) NOT NULL DEFAULT 'INR', -- ISO 4217 currency
  gst_inclusive boolean NOT NULL DEFAULT true, -- true = amount already includes GST
  gst_rate_bps integer NOT NULL DEFAULT 1800 CHECK (gst_rate_bps BETWEEN 0 AND 2800), -- GST in basis points (18% = 1800)
  billing_period text NOT NULL CHECK (billing_period IN ('one_time','monthly','quarterly','yearly','per_30_days','per_use')), -- How often it is charged
  validity_days integer CHECK (validity_days IS NULL OR validity_days > 0), -- Access length after payment (NULL for per_use)
  trial_days integer NOT NULL DEFAULT 0 CHECK (trial_days BETWEEN 0 AND 90), -- Free trial before first charge (subscriptions only)
  effective_from timestamptz NOT NULL, -- When this version starts applying
  effective_to timestamptz, -- Set automatically when a newer version becomes effective
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','active','superseded','cancelled')), -- Lifecycle of the version
  change_reason text, -- Required note explaining the change
  published_by uuid REFERENCES admins(id), -- Admin who published
  published_at timestamptz, -- When published
  created_by uuid REFERENCES admins(id), -- Creator of the draft
  updated_by uuid REFERENCES admins(id), -- Last editor
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Last updated
  CONSTRAINT ck_payment_config_period CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE UNIQUE INDEX uq_payment_config_version ON payment_configurations (fee_code, version);
CREATE UNIQUE INDEX uq_payment_config_one_active ON payment_configurations (fee_code) WHERE status = 'active';
CREATE UNIQUE INDEX uq_payment_config_one_draft ON payment_configurations (fee_code) WHERE status = 'draft';
CREATE INDEX idx_payment_config_lookup ON payment_configurations (fee_code, effective_from DESC) WHERE status IN ('active','scheduled');
CREATE TRIGGER trg_payment_configurations_updated BEFORE UPDATE ON payment_configurations FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- @table payment_configuration_history: Immutable change log for payment configurations (create, edit, publish, cancel, activate, supersede).
CREATE TABLE payment_configuration_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  payment_configuration_id uuid NOT NULL REFERENCES payment_configurations(id) ON DELETE RESTRICT, -- Version that changed
  fee_code text NOT NULL, -- Denormalised for fast filtering
  action text NOT NULL CHECK (action IN ('created','updated','published','scheduled','activated','superseded','cancelled','enabled','disabled')), -- What happened
  old_values jsonb, -- Fields before the change
  new_values jsonb, -- Fields after the change
  reason text, -- Admin's reason
  changed_by uuid REFERENCES admins(id), -- NULL when the scheduler activated a version
  created_at timestamptz NOT NULL DEFAULT now() -- When
);
CREATE INDEX idx_payment_config_history_fee ON payment_configuration_history (fee_code, created_at DESC);
CREATE INDEX idx_payment_config_history_config ON payment_configuration_history (payment_configuration_id, created_at DESC);

-- @migration 006 M6 Referral Configuration
-- @table referral_settings: Versioned rules for each referral program. One active version per program.
CREATE TABLE referral_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key (one per version)
  program_code text NOT NULL CHECK (program_code IN ('LEARNER_REFERRAL','TEACHER_REFERRAL','INSTITUTE_REFERRAL')), -- Which program
  version integer NOT NULL CHECK (version > 0), -- Version number per program
  is_enabled boolean NOT NULL DEFAULT true, -- Program on/off; when off, codes still resolve but earn nothing
  referrer_reward_paise bigint NOT NULL DEFAULT 0 CHECK (referrer_reward_paise >= 0), -- Credited to the person who invited
  referee_reward_paise bigint NOT NULL DEFAULT 0 CHECK (referee_reward_paise >= 0), -- Discount or credit for the new user
  reward_type text NOT NULL DEFAULT 'wallet_credit' CHECK (reward_type IN ('wallet_credit','discount','cashback')), -- How rewards are delivered
  qualifying_event text NOT NULL CHECK (qualifying_event IN ('signup','first_payment','teacher_approved','institute_approved')), -- Event that makes a referral count
  min_payment_paise bigint NOT NULL DEFAULT 0 CHECK (min_payment_paise >= 0), -- Minimum first payment for payment-based programs
  max_rewards_per_referrer integer CHECK (max_rewards_per_referrer IS NULL OR max_rewards_per_referrer > 0), -- Lifetime cap per referrer (NULL = no cap)
  max_rewards_per_month integer CHECK (max_rewards_per_month IS NULL OR max_rewards_per_month > 0), -- Monthly cap per referrer
  reward_hold_days integer NOT NULL DEFAULT 7 CHECK (reward_hold_days BETWEEN 0 AND 90), -- Days a reward stays pending for fraud checks / refunds
  code_expiry_days integer CHECK (code_expiry_days IS NULL OR code_expiry_days > 0), -- Days a referee has to sign up after first opening the link
  block_same_device boolean NOT NULL DEFAULT true, -- Reject if referrer and referee share a device fingerprint
  block_same_payment_method boolean NOT NULL DEFAULT true, -- Reject if they share a payment instrument
  terms_text text, -- Terms shown on the referral screen
  effective_from timestamptz NOT NULL DEFAULT now(), -- When this version applies
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','superseded')), -- Version lifecycle
  change_reason text, -- Why it changed
  created_by uuid REFERENCES admins(id), -- Creator
  updated_by uuid REFERENCES admins(id), -- Last editor
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now() -- Last updated
);
CREATE UNIQUE INDEX uq_referral_settings_version ON referral_settings (program_code, version);
CREATE UNIQUE INDEX uq_referral_settings_one_active ON referral_settings (program_code) WHERE status = 'active';
CREATE UNIQUE INDEX uq_referral_settings_one_draft ON referral_settings (program_code) WHERE status = 'draft';
CREATE TRIGGER trg_referral_settings_updated BEFORE UPDATE ON referral_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- @migration 007 M7 Country Management
-- @table countries: Countries the platform can operate in. India is seeded; others stay inactive until launch.
CREATE TABLE countries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  name text NOT NULL, -- Country name, e.g. India
  iso2 char(2) NOT NULL, -- ISO 3166-1 alpha-2, e.g. IN
  iso3 char(3) NOT NULL, -- ISO 3166-1 alpha-3, e.g. IND
  phone_code text NOT NULL, -- Dialling code with plus, e.g. +91
  currency_code char(3) NOT NULL, -- ISO 4217, e.g. INR
  is_active boolean NOT NULL DEFAULT true, -- Inactive countries are hidden in the app
  sort_order integer NOT NULL DEFAULT 0, -- Manual ordering in dropdowns
  created_by uuid REFERENCES admins(id), -- Creator
  updated_by uuid REFERENCES admins(id), -- Last editor
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Last updated
  deleted_at timestamptz, -- Soft delete
  deleted_by uuid REFERENCES admins(id) -- Who deleted
);
CREATE UNIQUE INDEX uq_countries_iso2 ON countries (iso2) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_countries_name ON countries (lower(name)) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_countries_updated BEFORE UPDATE ON countries FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- @migration 008 M8 State Management
-- @table states: States and union territories within a country.
CREATE TABLE states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  country_id uuid NOT NULL REFERENCES countries(id) ON DELETE RESTRICT, -- Parent country
  name text NOT NULL, -- State name, e.g. Karnataka
  code text NOT NULL, -- Short code, e.g. KA (ISO 3166-2 suffix)
  type text NOT NULL DEFAULT 'state' CHECK (type IN ('state','union_territory')), -- Administrative type
  is_active boolean NOT NULL DEFAULT true, -- Hidden in the app when false
  sort_order integer NOT NULL DEFAULT 0, -- Manual ordering
  created_by uuid REFERENCES admins(id), -- Creator
  updated_by uuid REFERENCES admins(id), -- Last editor
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Last updated
  deleted_at timestamptz, -- Soft delete
  deleted_by uuid REFERENCES admins(id) -- Who deleted
);
CREATE UNIQUE INDEX uq_states_country_name ON states (country_id, lower(name)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_states_country_code ON states (country_id, code) WHERE deleted_at IS NULL;
CREATE INDEX idx_states_country_active ON states (country_id, is_active) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_states_updated BEFORE UPDATE ON states FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- @migration 009 M9 City Management
-- @table cities: Cities where teachers and institutes can be listed.
CREATE TABLE cities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  state_id uuid NOT NULL REFERENCES states(id) ON DELETE RESTRICT, -- Parent state
  name text NOT NULL, -- City name, e.g. Bengaluru
  slug text NOT NULL, -- URL slug, e.g. bengaluru (used in deep links and SEO pages)
  latitude numeric(9,6) CHECK (latitude BETWEEN -90 AND 90), -- City centre latitude
  longitude numeric(9,6) CHECK (longitude BETWEEN -180 AND 180), -- City centre longitude
  tier smallint CHECK (tier IN (1,2,3)), -- Market tier, used for pricing and featured slots
  is_serviceable boolean NOT NULL DEFAULT false, -- true = shown as a launch city in search
  is_active boolean NOT NULL DEFAULT true, -- Hidden everywhere when false
  sort_order integer NOT NULL DEFAULT 0, -- Manual ordering
  created_by uuid REFERENCES admins(id), -- Creator
  updated_by uuid REFERENCES admins(id), -- Last editor
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Last updated
  deleted_at timestamptz, -- Soft delete
  deleted_by uuid REFERENCES admins(id) -- Who deleted
);
CREATE UNIQUE INDEX uq_cities_state_name ON cities (state_id, lower(name)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_cities_slug ON cities (slug) WHERE deleted_at IS NULL;
CREATE INDEX idx_cities_state_active ON cities (state_id, is_active) WHERE deleted_at IS NULL;
CREATE INDEX idx_cities_name_trgm ON cities USING gin (name gin_trgm_ops);
CREATE TRIGGER trg_cities_updated BEFORE UPDATE ON cities FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- @migration 010 M10 Area Management
-- @table areas: Localities within a city, used for "nearby" search and teacher coverage.
CREATE TABLE areas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  city_id uuid NOT NULL REFERENCES cities(id) ON DELETE RESTRICT, -- Parent city
  name text NOT NULL, -- Area name, e.g. Koramangala
  slug text NOT NULL, -- Slug unique within the city
  pincodes text[] NOT NULL DEFAULT '{}', -- 6-digit Indian PIN codes covered
  latitude numeric(9,6) CHECK (latitude BETWEEN -90 AND 90), -- Area centre latitude
  longitude numeric(9,6) CHECK (longitude BETWEEN -180 AND 180), -- Area centre longitude
  is_active boolean NOT NULL DEFAULT true, -- Hidden when false
  sort_order integer NOT NULL DEFAULT 0, -- Manual ordering
  created_by uuid REFERENCES admins(id), -- Creator
  updated_by uuid REFERENCES admins(id), -- Last editor
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Last updated
  deleted_at timestamptz, -- Soft delete
  deleted_by uuid REFERENCES admins(id) -- Who deleted
);
CREATE UNIQUE INDEX uq_areas_city_name ON areas (city_id, lower(name)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_areas_city_slug ON areas (city_id, slug) WHERE deleted_at IS NULL;
CREATE INDEX idx_areas_city_active ON areas (city_id, is_active) WHERE deleted_at IS NULL;
CREATE INDEX idx_areas_pincodes ON areas USING gin (pincodes);
CREATE INDEX idx_areas_name_trgm ON areas USING gin (name gin_trgm_ops);
CREATE TRIGGER trg_areas_updated BEFORE UPDATE ON areas FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- @migration 011 M11 Class Management
-- @table classes: Grades and levels learners study at, from Class 1 to competitive exam preparation.
CREATE TABLE classes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  name text NOT NULL, -- Display name, e.g. Class 10
  code text NOT NULL, -- Stable code, e.g. CLASS_10, UG, COMPETITIVE
  stage text NOT NULL CHECK (stage IN ('pre_primary','primary','middle','secondary','senior_secondary','undergraduate','postgraduate','competitive','adult')), -- Grouping used in filters and recommendations
  level_order smallint NOT NULL, -- Numeric order for range matching (Class 1 = 1 … Class 12 = 12, UG = 13, Competitive = 14)
  is_active boolean NOT NULL DEFAULT true, -- Hidden when false
  created_by uuid REFERENCES admins(id), -- Creator
  updated_by uuid REFERENCES admins(id), -- Last editor
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Last updated
  deleted_at timestamptz, -- Soft delete
  deleted_by uuid REFERENCES admins(id) -- Who deleted
);
CREATE UNIQUE INDEX uq_classes_code ON classes (code) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_classes_name ON classes (lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX idx_classes_order ON classes (level_order) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_classes_updated BEFORE UPDATE ON classes FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- @migration 012 M12 Subject Management
-- @table subjects: Subjects, exams and skills teachers can teach.
CREATE TABLE subjects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  name text NOT NULL, -- Display name, e.g. Physics
  slug text NOT NULL, -- URL slug, e.g. physics
  category text NOT NULL CHECK (category IN ('academic','competitive_exam','language','music_arts','coding_skills','other')), -- Grouping for filters
  parent_subject_id uuid REFERENCES subjects(id) ON DELETE RESTRICT, -- Optional parent, e.g. Organic Chemistry → Chemistry
  aliases text[] NOT NULL DEFAULT '{}', -- Search synonyms, e.g. {maths, math}
  icon_file_id uuid REFERENCES files(id), -- Optional icon shown in the app
  min_class_order smallint, -- Lowest classes.level_order this subject is offered for (NULL = any)
  max_class_order smallint, -- Highest classes.level_order (NULL = any)
  is_trending boolean NOT NULL DEFAULT false, -- Pinned in Trending subjects on the app home screen
  is_active boolean NOT NULL DEFAULT true, -- Hidden when false
  sort_order integer NOT NULL DEFAULT 0, -- Manual ordering
  created_by uuid REFERENCES admins(id), -- Creator
  updated_by uuid REFERENCES admins(id), -- Last editor
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Last updated
  deleted_at timestamptz, -- Soft delete
  deleted_by uuid REFERENCES admins(id), -- Who deleted
  CONSTRAINT ck_subjects_class_range CHECK (min_class_order IS NULL OR max_class_order IS NULL OR min_class_order <= max_class_order),
  CONSTRAINT ck_subjects_not_self_parent CHECK (parent_subject_id IS NULL OR parent_subject_id <> id)
);
CREATE UNIQUE INDEX uq_subjects_slug ON subjects (slug) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_subjects_name ON subjects (lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX idx_subjects_category ON subjects (category, is_active) WHERE deleted_at IS NULL;
CREATE INDEX idx_subjects_name_trgm ON subjects USING gin (name gin_trgm_ops);
CREATE INDEX idx_subjects_aliases ON subjects USING gin (aliases);
CREATE TRIGGER trg_subjects_updated BEFORE UPDATE ON subjects FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- @migration 013 M13 Board Management
-- @table boards: Education boards and curricula, e.g. CBSE, ICSE, state boards, IB.
CREATE TABLE boards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  name text NOT NULL, -- Full name, e.g. Central Board of Secondary Education
  short_name text NOT NULL, -- Short name shown in chips, e.g. CBSE
  type text NOT NULL CHECK (type IN ('national','state','international','university','other')), -- Board type
  state_id uuid REFERENCES states(id) ON DELETE RESTRICT, -- Required for state boards, NULL otherwise
  is_active boolean NOT NULL DEFAULT true, -- Hidden when false
  sort_order integer NOT NULL DEFAULT 0, -- Manual ordering
  created_by uuid REFERENCES admins(id), -- Creator
  updated_by uuid REFERENCES admins(id), -- Last editor
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Last updated
  deleted_at timestamptz, -- Soft delete
  deleted_by uuid REFERENCES admins(id), -- Who deleted
  CONSTRAINT ck_boards_state CHECK ((type = 'state') = (state_id IS NOT NULL))
);
CREATE UNIQUE INDEX uq_boards_short_name ON boards (lower(short_name)) WHERE deleted_at IS NULL;
CREATE INDEX idx_boards_type ON boards (type, is_active) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_boards_updated BEFORE UPDATE ON boards FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- @migration 014 M14 Teaching Mode Management
-- @table teaching_modes: How classes are delivered, e.g. Online, Offline at teacher's place, Home tuition, Hybrid.
CREATE TABLE teaching_modes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  name text NOT NULL, -- Display name, e.g. Home tuition
  code text NOT NULL, -- Stable code: ONLINE, OFFLINE, HOME_TUITION, HYBRID, BATCH
  description text, -- Help text shown to teachers
  requires_location boolean NOT NULL DEFAULT true, -- false for ONLINE (no city/area needed)
  is_active boolean NOT NULL DEFAULT true, -- Hidden when false
  sort_order integer NOT NULL DEFAULT 0, -- Manual ordering
  created_by uuid REFERENCES admins(id), -- Creator
  updated_by uuid REFERENCES admins(id), -- Last editor
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Last updated
  deleted_at timestamptz, -- Soft delete
  deleted_by uuid REFERENCES admins(id) -- Who deleted
);
CREATE UNIQUE INDEX uq_teaching_modes_code ON teaching_modes (code) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_teaching_modes_name ON teaching_modes (lower(name)) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_teaching_modes_updated BEFORE UPDATE ON teaching_modes FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- @migration 015 M15 Teacher Category Management
-- @table teacher_categories: Types of teacher shown as categories and used in parent preferences, e.g. Home Tutor, Coaching Faculty.
CREATE TABLE teacher_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  name text NOT NULL, -- Display name, e.g. Competitive Exam Faculty
  slug text NOT NULL, -- URL slug
  description text, -- Shown on the category page
  icon_file_id uuid REFERENCES files(id), -- Category icon
  is_active boolean NOT NULL DEFAULT true, -- Hidden when false
  sort_order integer NOT NULL DEFAULT 0, -- Order on the app home grid
  created_by uuid REFERENCES admins(id), -- Creator
  updated_by uuid REFERENCES admins(id), -- Last editor
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Last updated
  deleted_at timestamptz, -- Soft delete
  deleted_by uuid REFERENCES admins(id) -- Who deleted
);
CREATE UNIQUE INDEX uq_teacher_categories_slug ON teacher_categories (slug) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_teacher_categories_name ON teacher_categories (lower(name)) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_teacher_categories_updated BEFORE UPDATE ON teacher_categories FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- @migration 016 M16 Teacher Registration Queue
CREATE SEQUENCE seq_teacher_code START 10001; -- generates teachers.public_code
-- @table teachers: Teacher profile and verification state. One row per teacher app account.
CREATE TABLE teachers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT, -- Login identity
  public_code text NOT NULL DEFAULT ('GC-T' || nextval('seq_teacher_code')), -- Human-friendly id shown in the portal, e.g. GC-T10241
  full_name text NOT NULL, -- Name as on Aadhaar
  gender text CHECK (gender IN ('female','male','other','undisclosed')), -- Gender
  date_of_birth date, -- Must make the teacher at least 18
  email citext, -- Contact email
  phone text NOT NULL, -- E.164 mobile number
  profile_photo_file_id uuid REFERENCES files(id), -- Public profile photo
  category_id uuid REFERENCES teacher_categories(id) ON DELETE RESTRICT, -- Primary teacher category
  highest_qualification text, -- e.g. M.Sc. Physics
  experience_years smallint CHECK (experience_years BETWEEN 0 AND 60), -- Years of teaching experience
  bio text, -- About the teacher, max 2,000 chars
  languages text[] NOT NULL DEFAULT '{}', -- Languages spoken, e.g. {English, Hindi}
  fee_per_hour_paise bigint CHECK (fee_per_hour_paise IS NULL OR fee_per_hour_paise >= 0), -- Indicative hourly fee
  demo_available boolean NOT NULL DEFAULT true, -- Offers a free demo class
  verification_status text NOT NULL DEFAULT 'draft' CHECK (verification_status IN ('draft','pending','under_review','reupload_requested','approved','rejected')), -- Registration workflow state
  account_status text NOT NULL DEFAULT 'active' CHECK (account_status IN ('active','suspended')), -- Suspended teachers are hidden from search and cannot receive leads
  is_verified_badge boolean NOT NULL DEFAULT false, -- Blue Verified badge on the profile
  badge_granted_at timestamptz, -- When the badge was granted
  badge_granted_by uuid REFERENCES admins(id), -- Who granted it
  is_featured boolean NOT NULL DEFAULT false, -- Featured rail placement
  featured_until timestamptz, -- Paid or manual featured expiry
  is_premium boolean NOT NULL DEFAULT false, -- Premium listing (search boost)
  premium_until timestamptz, -- Premium expiry
  registration_transaction_id uuid, -- Registration fee payment (FK added in migration 040)
  submitted_at timestamptz, -- When the teacher submitted for review
  reviewed_by uuid REFERENCES admins(id), -- Admin currently assigned / last reviewer
  approved_at timestamptz, -- Approval time
  rejected_at timestamptz, -- Rejection time
  rejection_reason_code text, -- e.g. DOC_UNREADABLE, NAME_MISMATCH, FORGED_DOCUMENT
  rejection_note text, -- Explanation sent to the teacher
  suspended_at timestamptz, -- Suspension time
  suspension_reason text, -- Internal reason for suspension
  profile_completeness smallint NOT NULL DEFAULT 0 CHECK (profile_completeness BETWEEN 0 AND 100), -- Percentage, recalculated on profile change
  trust_score numeric(5,2), -- Cached from trust_scores for fast sorting
  rating_avg numeric(3,2), -- Cached average of published reviews
  rating_count integer NOT NULL DEFAULT 0, -- Cached count of published reviews
  created_by uuid REFERENCES admins(id), -- Set when an admin created the teacher manually
  updated_by uuid REFERENCES admins(id), -- Last admin editor
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Last updated
  deleted_at timestamptz, -- Soft delete
  deleted_by uuid REFERENCES admins(id) -- Who deleted
);
CREATE UNIQUE INDEX uq_teachers_user ON teachers (user_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_teachers_public_code ON teachers (public_code);
CREATE INDEX idx_teachers_queue ON teachers (verification_status, submitted_at) WHERE deleted_at IS NULL;
CREATE INDEX idx_teachers_listing ON teachers (account_status, verification_status, trust_score DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_teachers_category ON teachers (category_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_teachers_name_trgm ON teachers USING gin (full_name gin_trgm_ops);
CREATE INDEX idx_teachers_featured ON teachers (featured_until) WHERE is_featured AND deleted_at IS NULL;
CREATE TRIGGER trg_teachers_updated BEFORE UPDATE ON teachers FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- @table teacher_documents: Every uploaded verification document version. Only one current version per teacher and type.
CREATE TABLE teacher_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  teacher_id uuid NOT NULL REFERENCES teachers(id) ON DELETE RESTRICT, -- Owner
  doc_type text NOT NULL CHECK (doc_type IN ('aadhaar','pan','education_certificate','professional_certificate','experience_letter','photo')), -- Document type
  file_id uuid NOT NULL REFERENCES files(id) ON DELETE RESTRICT, -- Private stored file
  title text, -- e.g. B.Ed., Bangalore University 2010 (for certificates)
  doc_number_masked text, -- Masked number shown in the UI, e.g. XXXX XXXX 2978
  doc_number_hash text, -- HMAC-SHA256 of the normalised number, used to detect duplicate accounts
  version smallint NOT NULL DEFAULT 1, -- Upload count for this type
  is_current boolean NOT NULL DEFAULT true, -- false once a newer upload replaces it
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','approved','rejected','reupload_requested')), -- Review state
  review_note text, -- Reason shown to the teacher on reject / re-upload
  reviewed_by uuid REFERENCES admins(id), -- Reviewer
  reviewed_at timestamptz, -- Review time
  created_at timestamptz NOT NULL DEFAULT now(), -- Uploaded
  updated_at timestamptz NOT NULL DEFAULT now() -- Last updated
);
CREATE INDEX idx_teacher_documents_teacher ON teacher_documents (teacher_id, doc_type) WHERE is_current;
CREATE UNIQUE INDEX uq_teacher_documents_current_identity ON teacher_documents (teacher_id, doc_type) WHERE is_current AND doc_type IN ('aadhaar','pan','photo');
CREATE INDEX idx_teacher_documents_hash ON teacher_documents (doc_type, doc_number_hash) WHERE doc_number_hash IS NOT NULL;
CREATE INDEX idx_teacher_documents_pending ON teacher_documents (status, created_at) WHERE is_current AND status = 'submitted';
CREATE TRIGGER trg_teacher_documents_updated BEFORE UPDATE ON teacher_documents FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- @table teacher_verification_logs: Timeline of every verification event for a teacher, shown in the review screen.
CREATE TABLE teacher_verification_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  teacher_id uuid NOT NULL REFERENCES teachers(id) ON DELETE CASCADE, -- Teacher
  document_id uuid REFERENCES teacher_documents(id) ON DELETE SET NULL, -- Document the event relates to, if any
  action text NOT NULL CHECK (action IN ('submitted','resubmitted','assigned','document_approved','document_rejected','reupload_requested','note_added','approved','rejected','badge_granted','badge_revoked','suspended','activated','auto_check')), -- Event type
  from_status text, -- Teacher verification_status before
  to_status text, -- Teacher verification_status after
  note text, -- Internal note or reason
  is_internal boolean NOT NULL DEFAULT true, -- false = note is also shown to the teacher
  metadata jsonb, -- Extra data, e.g. automated check results {"face_match":0.96}
  admin_id uuid REFERENCES admins(id), -- NULL for teacher or system events
  created_at timestamptz NOT NULL DEFAULT now() -- When
);
CREATE INDEX idx_teacher_verification_logs_teacher ON teacher_verification_logs (teacher_id, created_at DESC);

-- @migration 018 M18 Teacher Subject Mapping
-- @table teacher_subjects: Subjects a teacher teaches.
CREATE TABLE teacher_subjects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  teacher_id uuid NOT NULL REFERENCES teachers(id) ON DELETE CASCADE, -- Teacher
  subject_id uuid NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT, -- Subject
  is_primary boolean NOT NULL DEFAULT false, -- Primary subject shown first on cards (max one per teacher)
  experience_years smallint CHECK (experience_years BETWEEN 0 AND 60), -- Years teaching this subject
  created_by uuid REFERENCES admins(id), -- Set when an admin added it
  created_at timestamptz NOT NULL DEFAULT now() -- Created
);
CREATE UNIQUE INDEX uq_teacher_subjects ON teacher_subjects (teacher_id, subject_id);
CREATE UNIQUE INDEX uq_teacher_subjects_primary ON teacher_subjects (teacher_id) WHERE is_primary;
CREATE INDEX idx_teacher_subjects_subject ON teacher_subjects (subject_id, teacher_id);

-- @migration 019 M19 Teacher Class Mapping
-- @table teacher_classes: Classes (and optionally boards) a teacher covers.
CREATE TABLE teacher_classes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  teacher_id uuid NOT NULL REFERENCES teachers(id) ON DELETE CASCADE, -- Teacher
  class_id uuid NOT NULL REFERENCES classes(id) ON DELETE RESTRICT, -- Class
  board_id uuid REFERENCES boards(id) ON DELETE RESTRICT, -- Board; NULL = any board
  created_by uuid REFERENCES admins(id), -- Set when an admin added it
  created_at timestamptz NOT NULL DEFAULT now() -- Created
);
CREATE UNIQUE INDEX uq_teacher_classes ON teacher_classes (teacher_id, class_id, COALESCE(board_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX idx_teacher_classes_class ON teacher_classes (class_id, teacher_id);

-- @migration 020 M20 Teacher Location Mapping
-- @table teacher_locations: Cities and areas a teacher serves, with travel radius for home tuition.
CREATE TABLE teacher_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  teacher_id uuid NOT NULL REFERENCES teachers(id) ON DELETE CASCADE, -- Teacher
  city_id uuid NOT NULL REFERENCES cities(id) ON DELETE RESTRICT, -- City served
  area_id uuid REFERENCES areas(id) ON DELETE RESTRICT, -- Area; NULL = whole city
  is_primary boolean NOT NULL DEFAULT false, -- Home base shown on the profile (max one)
  travel_radius_km smallint CHECK (travel_radius_km BETWEEN 0 AND 50), -- How far the teacher travels for home tuition
  address_line text, -- Teaching address for "at teacher's place" (never shown publicly in full)
  latitude numeric(9,6), -- Geocoded latitude of the address or area
  longitude numeric(9,6), -- Geocoded longitude
  created_by uuid REFERENCES admins(id), -- Set when an admin added it
  created_at timestamptz NOT NULL DEFAULT now() -- Created
);
CREATE UNIQUE INDEX uq_teacher_locations ON teacher_locations (teacher_id, city_id, COALESCE(area_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE UNIQUE INDEX uq_teacher_locations_primary ON teacher_locations (teacher_id) WHERE is_primary;
CREATE INDEX idx_teacher_locations_city_area ON teacher_locations (city_id, area_id);

-- @table teacher_teaching_modes: Teaching modes a teacher offers (Online, Home tuition, …).
CREATE TABLE teacher_teaching_modes (
  teacher_id uuid NOT NULL REFERENCES teachers(id) ON DELETE CASCADE, -- Teacher
  teaching_mode_id uuid NOT NULL REFERENCES teaching_modes(id) ON DELETE RESTRICT, -- Mode offered
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  PRIMARY KEY (teacher_id, teaching_mode_id)
);
CREATE INDEX idx_teacher_teaching_modes_mode ON teacher_teaching_modes (teaching_mode_id);

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

-- @migration 022 M22 Institute Registration Queue
CREATE SEQUENCE seq_institute_code START 2001; -- generates institutes.public_code
-- @table institutes: Coaching centres, tuition centres, schools and academies. Rated by GuruConnect after verification.
CREATE TABLE institutes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  public_code text NOT NULL DEFAULT ('GC-I' || nextval('seq_institute_code')), -- Human-friendly id, e.g. GC-I2101
  name text NOT NULL, -- Institute name
  slug text NOT NULL, -- URL slug for the public page
  institute_type text NOT NULL CHECK (institute_type IN ('coaching_centre','tuition_centre','school','music_school','coding_academy','language_institute','sports_academy','other')), -- Type
  established_year smallint CHECK (established_year BETWEEN 1800 AND 2100), -- Year founded
  registration_number text, -- Shop & Establishment / Trust / Society registration number
  gstin text, -- 15-char GSTIN, optional
  email citext, -- Official email
  phone text NOT NULL, -- Official phone (E.164)
  website text, -- https URL
  address_line text NOT NULL, -- Street address
  city_id uuid NOT NULL REFERENCES cities(id) ON DELETE RESTRICT, -- City
  area_id uuid REFERENCES areas(id) ON DELETE RESTRICT, -- Area
  pincode text CHECK (pincode ~ '^[1-9][0-9]{5}$'), -- 6-digit PIN
  latitude numeric(9,6), -- Geocoded latitude
  longitude numeric(9,6), -- Geocoded longitude
  about text, -- Description, max 3,000 chars
  logo_file_id uuid REFERENCES files(id), -- Logo
  cover_file_id uuid REFERENCES files(id), -- Cover photo
  facilities text[] NOT NULL DEFAULT '{}', -- Claimed facilities, e.g. {ac_classrooms, cctv, library}
  classrooms smallint CHECK (classrooms >= 0), -- Number of classrooms
  seating_capacity integer CHECK (seating_capacity >= 0), -- Total seats
  student_count integer CHECK (student_count >= 0), -- Approximate current students
  fee_min_paise bigint, -- Lowest course fee
  fee_max_paise bigint, -- Highest course fee
  verification_status text NOT NULL DEFAULT 'draft' CHECK (verification_status IN ('draft','pending','under_review','docs_requested','visit_scheduled','evaluation_done','approved','rejected')), -- Workflow state
  account_status text NOT NULL DEFAULT 'active' CHECK (account_status IN ('active','suspended')), -- Suspended institutes are hidden
  is_verified_badge boolean NOT NULL DEFAULT false, -- Verified Institute badge
  overall_rating numeric(2,1) CHECK (overall_rating BETWEEN 1 AND 5), -- Current GuruConnect rating (cached from institute_ratings)
  infrastructure_score numeric(3,1) CHECK (infrastructure_score BETWEEN 0 AND 10), -- Cached from the current rating
  faculty_score numeric(3,1) CHECK (faculty_score BETWEEN 0 AND 10), -- Cached from the current rating
  user_rating_avg numeric(3,2), -- Cached average of published institute reviews
  user_rating_count integer NOT NULL DEFAULT 0, -- Cached count of published reviews
  is_premium boolean NOT NULL DEFAULT false, -- Premium listing
  premium_until timestamptz, -- Premium expiry
  registration_transaction_id uuid, -- Registration fee payment (FK added in migration 040)
  submitted_at timestamptz, -- Submitted for review
  approved_at timestamptz, -- Approved
  approved_by uuid REFERENCES admins(id), -- Approver
  rejected_at timestamptz, -- Rejected
  rejection_reason_code text, -- e.g. FAKE_REGISTRATION, ADDRESS_NOT_FOUND
  rejection_note text, -- Message to the institute
  created_by uuid REFERENCES admins(id), -- Admin creator (manual onboarding)
  updated_by uuid REFERENCES admins(id), -- Last admin editor
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Last updated
  deleted_at timestamptz, -- Soft delete
  deleted_by uuid REFERENCES admins(id), -- Who deleted
  CONSTRAINT ck_institutes_fee_range CHECK (fee_min_paise IS NULL OR fee_max_paise IS NULL OR fee_min_paise <= fee_max_paise)
);
CREATE UNIQUE INDEX uq_institutes_public_code ON institutes (public_code);
CREATE UNIQUE INDEX uq_institutes_slug ON institutes (slug) WHERE deleted_at IS NULL;
CREATE INDEX idx_institutes_queue ON institutes (verification_status, submitted_at) WHERE deleted_at IS NULL;
CREATE INDEX idx_institutes_city ON institutes (city_id, area_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_institutes_name_trgm ON institutes USING gin (name gin_trgm_ops);
CREATE TRIGGER trg_institutes_updated BEFORE UPDATE ON institutes FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- @table institute_documents: Institute verification documents and campus photos, versioned like teacher documents.
CREATE TABLE institute_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  institute_id uuid NOT NULL REFERENCES institutes(id) ON DELETE RESTRICT, -- Owner
  doc_type text NOT NULL CHECK (doc_type IN ('registration_certificate','pan','gst_certificate','manager_aadhaar','campus_photo','fire_safety_noc','other')), -- Type
  file_id uuid NOT NULL REFERENCES files(id) ON DELETE RESTRICT, -- Stored file
  caption text, -- e.g. Classroom A (for campus photos)
  doc_number_masked text, -- Masked number for display
  version smallint NOT NULL DEFAULT 1, -- Upload count for this type
  is_current boolean NOT NULL DEFAULT true, -- false once replaced
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','approved','rejected','reupload_requested')), -- Review state
  review_note text, -- Reason shown to the institute manager
  reviewed_by uuid REFERENCES admins(id), -- Reviewer
  reviewed_at timestamptz, -- Review time
  created_at timestamptz NOT NULL DEFAULT now(), -- Uploaded
  updated_at timestamptz NOT NULL DEFAULT now() -- Last updated
);
CREATE INDEX idx_institute_documents_institute ON institute_documents (institute_id, doc_type) WHERE is_current;
CREATE TRIGGER trg_institute_documents_updated BEFORE UPDATE ON institute_documents FOR EACH ROW EXECUTE FUNCTION set_updated_at();

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

-- @migration 025 M25 Institute Manager Accounts
-- @table institute_managers: App accounts that act for an institute. Exactly one active primary manager; counsellors can only handle leads.
CREATE TABLE institute_managers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  institute_id uuid NOT NULL REFERENCES institutes(id) ON DELETE CASCADE, -- Institute
  user_id uuid REFERENCES app_users(id) ON DELETE RESTRICT, -- Linked app account (NULL until an invite is accepted)
  full_name text NOT NULL, -- Name
  email citext, -- Email
  phone text NOT NULL, -- E.164 phone
  designation text, -- e.g. Centre Head
  staff_role text NOT NULL DEFAULT 'manager' CHECK (staff_role IN ('manager','counsellor')), -- manager = full control incl. teachers; counsellor = leads only
  is_primary boolean NOT NULL DEFAULT false, -- The accountable owner; exactly one active per institute
  status text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','active','disabled')), -- Account state
  invited_at timestamptz, -- Invite sent
  accepted_at timestamptz, -- Invite accepted
  disabled_at timestamptz, -- Disabled
  disabled_reason text, -- Why
  created_by uuid REFERENCES admins(id), -- Admin who created/replaced it (NULL when self-registered)
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Updated
  CONSTRAINT ck_institute_managers_primary_is_manager CHECK (NOT is_primary OR staff_role = 'manager')
);
CREATE UNIQUE INDEX uq_institute_managers_primary ON institute_managers (institute_id) WHERE is_primary AND status <> 'disabled';
CREATE UNIQUE INDEX uq_institute_managers_user ON institute_managers (institute_id, user_id) WHERE user_id IS NOT NULL AND status <> 'disabled';
CREATE INDEX idx_institute_managers_phone ON institute_managers (phone);
CREATE TRIGGER trg_institute_managers_updated BEFORE UPDATE ON institute_managers FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- @migration 026 M26 Institute Teacher Management
-- @table institute_teachers: Teachers listed under an institute. Added, edited and removed only by an institute manager (or an admin).
CREATE TABLE institute_teachers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  institute_id uuid NOT NULL REFERENCES institutes(id) ON DELETE CASCADE, -- Institute
  teacher_id uuid REFERENCES teachers(id) ON DELETE SET NULL, -- Linked GuruConnect teacher profile, if the teacher has one
  full_name text NOT NULL, -- Name as on Aadhaar
  phone text NOT NULL, -- E.164 phone, used for the ID-check SMS invite
  qualification text, -- e.g. M.Sc. Chemistry
  experience_years smallint CHECK (experience_years BETWEEN 0 AND 60), -- Experience
  photo_file_id uuid REFERENCES files(id), -- Photo
  schedule_text text, -- e.g. Weekdays 4–7 PM
  status text NOT NULL DEFAULT 'id_pending' CHECK (status IN ('id_pending','active','removed')), -- id_pending until Aadhaar/PAN verified
  is_visible boolean NOT NULL DEFAULT true, -- Shown on the institute's public profile
  added_by_manager_id uuid REFERENCES institute_managers(id) ON DELETE SET NULL, -- Manager who added
  added_by_admin_id uuid REFERENCES admins(id), -- Admin who added (support override)
  removed_at timestamptz, -- When removed
  removed_reason text, -- Why removed
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now() -- Updated
);
CREATE UNIQUE INDEX uq_institute_teachers_phone ON institute_teachers (institute_id, phone) WHERE status <> 'removed';
CREATE INDEX idx_institute_teachers_inst ON institute_teachers (institute_id, status);
CREATE INDEX idx_institute_teachers_teacher ON institute_teachers (teacher_id) WHERE teacher_id IS NOT NULL;
CREATE TRIGGER trg_institute_teachers_updated BEFORE UPDATE ON institute_teachers FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- @table institute_teacher_subjects: Subjects assigned to an institute teacher.
CREATE TABLE institute_teacher_subjects (
  institute_teacher_id uuid NOT NULL REFERENCES institute_teachers(id) ON DELETE CASCADE, -- Institute teacher
  subject_id uuid NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT, -- Subject
  PRIMARY KEY (institute_teacher_id, subject_id)
);

-- @table institute_teacher_classes: Classes assigned to an institute teacher.
CREATE TABLE institute_teacher_classes (
  institute_teacher_id uuid NOT NULL REFERENCES institute_teachers(id) ON DELETE CASCADE, -- Institute teacher
  class_id uuid NOT NULL REFERENCES classes(id) ON DELETE RESTRICT, -- Class
  PRIMARY KEY (institute_teacher_id, class_id)
);

-- @migration 027 M27 Institute Rating System
-- @table institute_ratings: Evaluations by GuruConnect admins. The latest submitted version is current and drives the public rating.
CREATE TABLE institute_ratings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  institute_id uuid NOT NULL REFERENCES institutes(id) ON DELETE CASCADE, -- Institute
  version integer NOT NULL, -- 1, 2, 3… per institute (re-evaluations)
  evaluation_method text NOT NULL CHECK (evaluation_method IN ('site_visit','video_walkthrough','document_only')), -- How it was evaluated
  visit_at timestamptz, -- When the visit happened
  infrastructure_score numeric(3,1) NOT NULL CHECK (infrastructure_score BETWEEN 0 AND 10), -- Classrooms, safety, labs, accessibility, hygiene
  faculty_quality_score numeric(3,1) NOT NULL CHECK (faculty_quality_score BETWEEN 0 AND 10), -- Qualifications, experience, teacher trust, demo audit
  student_feedback_score numeric(3,1) NOT NULL CHECK (student_feedback_score BETWEEN 0 AND 10), -- Derived from published reviews, adjustable by admin
  trustworthiness_score numeric(3,1) NOT NULL CHECK (trustworthiness_score BETWEEN 0 AND 10), -- Documents, complaint history, fee transparency
  criteria jsonb NOT NULL DEFAULT '{}'::jsonb, -- Sub-scores, e.g. {"infrastructure":{"classrooms":9,"safety":8}}
  suggested_rating numeric(2,1) NOT NULL CHECK (suggested_rating BETWEEN 1 AND 5), -- Computed by the formula
  overall_rating numeric(2,1) NOT NULL CHECK (overall_rating BETWEEN 1 AND 5 AND overall_rating * 2 = round(overall_rating * 2)), -- Final rating in half steps, chosen by the admin
  override_reason text, -- Required when overall differs from suggested by more than 0.5
  notes text, -- Reviewer notes (internal)
  public_summary text, -- Optional line shown on the profile
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','superseded')), -- draft is editable; submitted is final
  is_current boolean NOT NULL DEFAULT false, -- The rating shown publicly
  rated_by uuid NOT NULL REFERENCES admins(id), -- Evaluator
  submitted_at timestamptz, -- When finalised
  next_review_due date, -- Re-evaluation date (default +12 months)
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now() -- Updated
);
CREATE UNIQUE INDEX uq_institute_ratings_version ON institute_ratings (institute_id, version);
CREATE UNIQUE INDEX uq_institute_ratings_current ON institute_ratings (institute_id) WHERE is_current;
CREATE INDEX idx_institute_ratings_due ON institute_ratings (next_review_due) WHERE is_current;
CREATE TRIGGER trg_institute_ratings_updated BEFORE UPDATE ON institute_ratings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- @migration 028 M28 Parent Management
CREATE SEQUENCE seq_parent_code START 50001; -- generates parents.public_code
-- @table parents: Parent profile, one per parent app account.
CREATE TABLE parents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT, -- Login identity
  public_code text NOT NULL DEFAULT ('GC-P' || nextval('seq_parent_code')), -- e.g. GC-P50121
  full_name text NOT NULL, -- Name
  email citext, -- Email
  phone text NOT NULL, -- E.164 phone
  state_id uuid REFERENCES states(id) ON DELETE RESTRICT, -- State
  city_id uuid REFERENCES cities(id) ON DELETE RESTRICT, -- City
  area_id uuid REFERENCES areas(id) ON DELETE RESTRICT, -- Area (optional)
  account_status text NOT NULL DEFAULT 'active' CHECK (account_status IN ('active','suspended')), -- Suspended parents cannot contact teachers
  suspension_reason text, -- Internal reason
  suspended_at timestamptz, -- When suspended
  suspended_by uuid REFERENCES admins(id), -- Who suspended
  referral_code_used text, -- Code entered at sign-up
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Updated
  deleted_at timestamptz, -- Soft delete
  deleted_by uuid REFERENCES admins(id) -- Admin who deleted, if an admin did
);
CREATE UNIQUE INDEX uq_parents_user ON parents (user_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_parents_public_code ON parents (public_code);
CREATE INDEX idx_parents_city ON parents (city_id, area_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_parents_name_trgm ON parents USING gin (full_name gin_trgm_ops);
CREATE TRIGGER trg_parents_updated BEFORE UPDATE ON parents FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- @migration 029 M29 Parent Children Management
-- @table parent_children: Children a parent is finding teachers for. Drives per-child recommendations.
CREATE TABLE parent_children (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  parent_id uuid NOT NULL REFERENCES parents(id) ON DELETE CASCADE, -- Parent
  child_name text NOT NULL, -- First name only (data minimisation for minors)
  class_id uuid NOT NULL REFERENCES classes(id) ON DELETE RESTRICT, -- Class the child studies in
  board_id uuid REFERENCES boards(id) ON DELETE RESTRICT, -- Board
  preferred_mode_id uuid REFERENCES teaching_modes(id) ON DELETE RESTRICT, -- Preferred teaching mode; NULL = any
  school_name text, -- Optional school
  sort_order smallint NOT NULL DEFAULT 0, -- Order in the child switcher
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Updated
  deleted_at timestamptz -- Soft delete
);
CREATE INDEX idx_parent_children_parent ON parent_children (parent_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_parent_children_class ON parent_children (class_id) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_parent_children_updated BEFORE UPDATE ON parent_children FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- @table parent_child_subjects: Subjects needed for a child.
CREATE TABLE parent_child_subjects (
  child_id uuid NOT NULL REFERENCES parent_children(id) ON DELETE CASCADE, -- Child
  subject_id uuid NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT, -- Subject needed
  PRIMARY KEY (child_id, subject_id)
);
CREATE INDEX idx_parent_child_subjects_subject ON parent_child_subjects (subject_id);

-- @table parent_child_teacher_categories: Types of teacher the parent wants for a child (Home Tutor, Competitive Exam Faculty, …).
CREATE TABLE parent_child_teacher_categories (
  child_id uuid NOT NULL REFERENCES parent_children(id) ON DELETE CASCADE, -- Child
  category_id uuid NOT NULL REFERENCES teacher_categories(id) ON DELETE RESTRICT, -- Teacher category wanted
  PRIMARY KEY (child_id, category_id)
);

-- @migration 031 M31 Student Management
CREATE SEQUENCE seq_student_code START 50001; -- generates students.public_code
-- @table students: Student profile, one per student app account.
CREATE TABLE students (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT, -- Login identity
  public_code text NOT NULL DEFAULT ('GC-S' || nextval('seq_student_code')), -- e.g. GC-S50140
  full_name text NOT NULL, -- Name
  email citext, -- Email
  phone text NOT NULL, -- E.164 phone
  class_id uuid REFERENCES classes(id) ON DELETE RESTRICT, -- Current class
  board_id uuid REFERENCES boards(id) ON DELETE RESTRICT, -- Board
  school_name text, -- School or college
  parent_id uuid REFERENCES parents(id) ON DELETE SET NULL, -- Linked parent account, if any
  parent_link_status text NOT NULL DEFAULT 'none' CHECK (parent_link_status IN ('none','pending','confirmed')), -- Link requested by support or the student; confirmed by the parent in the app
  parent_name text, -- Optional parent name given at sign-up
  parent_phone text, -- Optional parent phone (E.164)
  parental_consent text NOT NULL DEFAULT 'not_required' CHECK (parental_consent IN ('not_required','pending','confirmed','declined')), -- Required for students below Class 9
  parental_consent_at timestamptz, -- When the parent confirmed by SMS link
  city_id uuid REFERENCES cities(id) ON DELETE RESTRICT, -- City
  area_id uuid REFERENCES areas(id) ON DELETE RESTRICT, -- Area
  account_status text NOT NULL DEFAULT 'active' CHECK (account_status IN ('active','suspended')), -- Account status
  suspension_reason text, -- Internal reason
  suspended_at timestamptz, -- When suspended
  suspended_by uuid REFERENCES admins(id), -- Who suspended
  referral_code_used text, -- Code entered at sign-up
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Updated
  deleted_at timestamptz, -- Soft delete
  deleted_by uuid REFERENCES admins(id) -- Admin who deleted
);
CREATE UNIQUE INDEX uq_students_user ON students (user_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_students_public_code ON students (public_code);
CREATE INDEX idx_students_class ON students (class_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_students_city ON students (city_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_students_name_trgm ON students USING gin (full_name gin_trgm_ops);
CREATE TRIGGER trg_students_updated BEFORE UPDATE ON students FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- @migration 033 M33 Teacher Reviews
-- @table teacher_reviews: Reviews of teachers by parents and students. Only published reviews count toward ratings and trust.
CREATE TABLE teacher_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  teacher_id uuid NOT NULL REFERENCES teachers(id) ON DELETE CASCADE, -- Teacher reviewed
  author_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT, -- Reviewer
  author_type text NOT NULL CHECK (author_type IN ('parent','student')), -- Reviewer role at the time
  child_id uuid REFERENCES parent_children(id) ON DELETE SET NULL, -- Child the parent is reviewing for
  rating smallint NOT NULL CHECK (rating BETWEEN 1 AND 5), -- Stars
  comment text NOT NULL, -- Review text, 30–1,500 chars
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','published','rejected','flagged','hidden')), -- Moderation state
  spam_score numeric(4,3) CHECK (spam_score BETWEEN 0 AND 1), -- Automated spam probability
  auto_flags text[] NOT NULL DEFAULT '{}', -- e.g. {contact_info, repeated_text, rating_burst}
  is_verified_interaction boolean NOT NULL DEFAULT false, -- Reviewer had a completed lead or demo with the teacher
  teacher_reply text, -- Public reply by the teacher
  teacher_replied_at timestamptz, -- Reply time
  reply_status text CHECK (reply_status IN ('pending','published','rejected')), -- Replies are moderated too
  edited_at timestamptz, -- Last edit by the author (edits send the review back to pending)
  moderated_by uuid REFERENCES admins(id), -- Last moderator
  moderated_at timestamptz, -- Last moderation time
  rejection_reason_code text, -- e.g. CONTACT_DETAILS, ABUSIVE, NOT_A_TEACHING_EXPERIENCE
  published_at timestamptz, -- First published
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Updated
  deleted_at timestamptz -- Soft delete (author deleted it or account deleted)
);
CREATE UNIQUE INDEX uq_teacher_reviews_author ON teacher_reviews (teacher_id, author_user_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_teacher_reviews_queue ON teacher_reviews (status, created_at) WHERE deleted_at IS NULL;
CREATE INDEX idx_teacher_reviews_teacher ON teacher_reviews (teacher_id, status, published_at DESC) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_teacher_reviews_updated BEFORE UPDATE ON teacher_reviews FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- @migration 034 M34 Institute Reviews
-- @table institute_reviews: Reviews of institutes by parents and students.
CREATE TABLE institute_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  institute_id uuid NOT NULL REFERENCES institutes(id) ON DELETE CASCADE, -- Institute reviewed
  author_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT, -- Reviewer
  author_type text NOT NULL CHECK (author_type IN ('parent','student')), -- Reviewer role
  rating smallint NOT NULL CHECK (rating BETWEEN 1 AND 5), -- Overall stars
  aspect_ratings jsonb NOT NULL DEFAULT '{}'::jsonb, -- Optional 1–5 per aspect, e.g. {"teaching":5,"infrastructure":4,"value":4}
  comment text NOT NULL, -- Review text, 30–1,500 chars
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','published','rejected','flagged','hidden')), -- Moderation state
  spam_score numeric(4,3) CHECK (spam_score BETWEEN 0 AND 1), -- Automated spam probability
  auto_flags text[] NOT NULL DEFAULT '{}', -- Automated flags
  is_verified_interaction boolean NOT NULL DEFAULT false, -- Reviewer had a lead or campus visit
  institute_reply text, -- Public reply by the institute manager
  institute_replied_at timestamptz, -- Reply time
  reply_status text CHECK (reply_status IN ('pending','published','rejected')), -- Reply moderation
  edited_at timestamptz, -- Last author edit
  moderated_by uuid REFERENCES admins(id), -- Last moderator
  moderated_at timestamptz, -- Last moderation time
  rejection_reason_code text, -- Reason code
  published_at timestamptz, -- First published
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Updated
  deleted_at timestamptz -- Soft delete
);
CREATE UNIQUE INDEX uq_institute_reviews_author ON institute_reviews (institute_id, author_user_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_institute_reviews_queue ON institute_reviews (status, created_at) WHERE deleted_at IS NULL;
CREATE INDEX idx_institute_reviews_inst ON institute_reviews (institute_id, status, published_at DESC) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_institute_reviews_updated BEFORE UPDATE ON institute_reviews FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- @migration 035 M35 Review Moderation
-- @table review_flags: Reports raised against a review by users or teachers.
CREATE TABLE review_flags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  review_type text NOT NULL CHECK (review_type IN ('teacher','institute')), -- Which review table
  review_id uuid NOT NULL, -- teacher_reviews.id or institute_reviews.id (polymorphic; integrity enforced in the service)
  reporter_user_id uuid REFERENCES app_users(id) ON DELETE SET NULL, -- Who reported
  reason text NOT NULL CHECK (reason IN ('fake','abusive','personal_details','off_topic','spam','other')), -- Reason
  details text, -- Optional details
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','upheld','dismissed')), -- Outcome
  resolved_by uuid REFERENCES admins(id), -- Moderator
  resolved_at timestamptz, -- When resolved
  created_at timestamptz NOT NULL DEFAULT now() -- Created
);
CREATE UNIQUE INDEX uq_review_flags_reporter ON review_flags (review_type, review_id, reporter_user_id) WHERE reporter_user_id IS NOT NULL;
CREATE INDEX idx_review_flags_open ON review_flags (status, created_at) WHERE status = 'open';
CREATE INDEX idx_review_flags_review ON review_flags (review_type, review_id);

-- @table review_moderation_logs: Every moderation decision on reviews and replies.
CREATE TABLE review_moderation_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  review_type text NOT NULL CHECK (review_type IN ('teacher','institute')), -- Which review table
  review_id uuid NOT NULL, -- Review id
  target text NOT NULL DEFAULT 'review' CHECK (target IN ('review','reply')), -- Review text or the reply
  action text NOT NULL CHECK (action IN ('approved','rejected','flagged','unflagged','hidden','restored','auto_flagged','auto_approved')), -- Decision
  from_status text, -- Before
  to_status text, -- After
  reason_code text, -- e.g. CONTACT_DETAILS
  note text, -- Moderator note
  admin_id uuid REFERENCES admins(id), -- NULL for automated actions
  created_at timestamptz NOT NULL DEFAULT now() -- When
);
CREATE INDEX idx_review_moderation_logs_review ON review_moderation_logs (review_type, review_id, created_at DESC);

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

-- @migration 038 M38 Lead Management
CREATE SEQUENCE seq_lead_code START 100001; -- generates leads.public_code
-- @table leads: Enquiries and call-back requests from parents/students to a teacher or institute.
CREATE TABLE leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  public_code text NOT NULL DEFAULT ('LD-' || nextval('seq_lead_code')), -- e.g. LD-240981
  lead_type text NOT NULL CHECK (lead_type IN ('inquiry','callback','demo')), -- demo leads also have a demo_requests row
  target_type text NOT NULL CHECK (target_type IN ('teacher','institute')), -- Who receives it
  teacher_id uuid REFERENCES teachers(id) ON DELETE RESTRICT, -- Target teacher
  institute_id uuid REFERENCES institutes(id) ON DELETE RESTRICT, -- Target institute
  requester_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT, -- Who asked
  requester_type text NOT NULL CHECK (requester_type IN ('parent','student')), -- Requester role
  child_id uuid REFERENCES parent_children(id) ON DELETE SET NULL, -- Child the request is for
  subject_id uuid REFERENCES subjects(id) ON DELETE RESTRICT, -- Subject asked about
  class_id uuid REFERENCES classes(id) ON DELETE RESTRICT, -- Class
  message text, -- Requester message, max 1,000 chars
  preferred_callback_window text, -- e.g. Today 6–8 PM
  source text NOT NULL DEFAULT 'profile' CHECK (source IN ('profile','search','recommendation','featured','compare','institute_page','other')), -- Where it started
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','viewed','contacted','converted','declined','closed','spam')), -- Lifecycle
  contact_unlocked boolean NOT NULL DEFAULT false, -- Requester phone shared with the teacher
  unlock_transaction_id uuid, -- Paid contact unlock (FK added in migration 040)
  assigned_institute_teacher_id uuid REFERENCES institute_teachers(id) ON DELETE SET NULL, -- Institute leads: teacher the manager assigned
  first_response_at timestamptz, -- First reply or status change by the receiver (response-rate metric)
  closed_at timestamptz, -- When closed/converted/declined
  decline_reason text, -- Reason given by the teacher
  admin_note text, -- Internal note from support
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Updated
  deleted_at timestamptz, -- Soft delete
  CONSTRAINT ck_leads_target CHECK ((target_type = 'teacher' AND teacher_id IS NOT NULL AND institute_id IS NULL) OR (target_type = 'institute' AND institute_id IS NOT NULL AND teacher_id IS NULL))
);
CREATE UNIQUE INDEX uq_leads_public_code ON leads (public_code);
CREATE INDEX idx_leads_teacher ON leads (teacher_id, status, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_leads_institute ON leads (institute_id, status, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_leads_requester ON leads (requester_user_id, created_at DESC);
CREATE INDEX idx_leads_status_created ON leads (status, created_at DESC) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_leads_updated BEFORE UPDATE ON leads FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- @migration 039 M39 Demo Class Requests
-- @table demo_requests: Free demo class bookings and their outcome.
CREATE TABLE demo_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE, -- Parent lead (lead_type = demo)
  teacher_id uuid REFERENCES teachers(id) ON DELETE RESTRICT, -- Teacher giving the demo
  institute_id uuid REFERENCES institutes(id) ON DELETE RESTRICT, -- Institute giving the demo / campus visit
  requester_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT, -- Learner or parent
  child_id uuid REFERENCES parent_children(id) ON DELETE SET NULL, -- Child attending
  teaching_mode_id uuid REFERENCES teaching_modes(id) ON DELETE RESTRICT, -- Online / home / at teacher's place
  requested_start_at timestamptz NOT NULL, -- Slot the requester picked
  confirmed_start_at timestamptz, -- Slot the teacher confirmed
  duration_minutes smallint NOT NULL DEFAULT 45 CHECK (duration_minutes BETWEEN 15 AND 120), -- Length
  meeting_link text, -- Online class link (https)
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','confirmed','reschedule_proposed','completed','cancelled','no_show','expired')), -- Lifecycle
  cancelled_by text CHECK (cancelled_by IN ('requester','teacher','institute','admin','system')), -- Who cancelled
  cancel_reason text, -- Why cancelled
  outcome text CHECK (outcome IN ('enrolled','not_enrolled','undecided')), -- Result reported after the demo
  reminder_sent_at timestamptz, -- 1-hour reminder push sent
  completed_at timestamptz, -- Marked completed
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Updated
  CONSTRAINT ck_demo_requests_target CHECK (teacher_id IS NOT NULL OR institute_id IS NOT NULL)
);
CREATE UNIQUE INDEX uq_demo_requests_lead ON demo_requests (lead_id);
CREATE INDEX idx_demo_requests_teacher_time ON demo_requests (teacher_id, confirmed_start_at) WHERE status IN ('requested','confirmed','reschedule_proposed');
CREATE INDEX idx_demo_requests_status ON demo_requests (status, requested_start_at);
CREATE TRIGGER trg_demo_requests_updated BEFORE UPDATE ON demo_requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- @migration 040 M40 Transactions
CREATE SEQUENCE seq_transaction_code START 7000001; -- generates transactions.public_code
-- @table transactions: Every payment attempt through Razorpay, plus refunds and reward payouts. Amounts in paise.
CREATE TABLE transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  public_code text NOT NULL DEFAULT ('TXN-' || nextval('seq_transaction_code')), -- e.g. TXN-7702137 (shown to users and support)
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT, -- Payer or payee
  payer_type text NOT NULL CHECK (payer_type IN ('parent','student','teacher','institute')), -- Payer role
  institute_id uuid REFERENCES institutes(id) ON DELETE RESTRICT, -- Set for institute payments
  purpose text NOT NULL CHECK (purpose IN ('teacher_registration','institute_registration','subscription','premium_listing','featured_listing','contact_unlock','referral_payout')), -- What was bought / paid out
  direction text NOT NULL DEFAULT 'credit' CHECK (direction IN ('credit','debit')), -- credit = money in to GuruConnect; debit = payout
  payment_configuration_id uuid REFERENCES payment_configurations(id) ON DELETE RESTRICT, -- Price version charged (NULL for payouts)
  fee_code text, -- Snapshot of fee_code
  amount_paise bigint NOT NULL CHECK (amount_paise >= 0), -- Total charged incl. GST
  base_amount_paise bigint NOT NULL CHECK (base_amount_paise >= 0), -- Amount before GST
  gst_paise bigint NOT NULL DEFAULT 0 CHECK (gst_paise >= 0), -- GST component
  discount_paise bigint NOT NULL DEFAULT 0 CHECK (discount_paise >= 0), -- Referral / promo discount applied
  currency char(3) NOT NULL DEFAULT 'INR', -- Currency
  status text NOT NULL DEFAULT 'created' CHECK (status IN ('created','authorized','captured','failed','refund_pending','refunded','partially_refunded','cancelled')), -- Lifecycle
  gateway text NOT NULL DEFAULT 'razorpay' CHECK (gateway IN ('razorpay','manual','wallet')), -- Processor
  gateway_order_id text, -- Razorpay order_xxx
  gateway_payment_id text, -- Razorpay pay_xxx
  method text CHECK (method IN ('upi','card','netbanking','wallet','emi','manual')), -- Payment method
  failure_code text, -- Gateway error code
  failure_reason text, -- Gateway error description
  refunded_amount_paise bigint NOT NULL DEFAULT 0 CHECK (refunded_amount_paise >= 0), -- Total refunded
  invoice_number text, -- GST invoice number, e.g. GC/2026-27/000412
  captured_at timestamptz, -- When money was captured
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb, -- Extra context, e.g. {"subscription_id":"…","lead_id":"…"}
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Updated
  CONSTRAINT ck_transactions_refund CHECK (refunded_amount_paise <= amount_paise)
);
CREATE UNIQUE INDEX uq_transactions_public_code ON transactions (public_code);
CREATE UNIQUE INDEX uq_transactions_gateway_order ON transactions (gateway_order_id) WHERE gateway_order_id IS NOT NULL;
CREATE UNIQUE INDEX uq_transactions_gateway_payment ON transactions (gateway_payment_id) WHERE gateway_payment_id IS NOT NULL;
CREATE UNIQUE INDEX uq_transactions_invoice ON transactions (invoice_number) WHERE invoice_number IS NOT NULL;
CREATE INDEX idx_transactions_user ON transactions (user_id, created_at DESC);
CREATE INDEX idx_transactions_status_created ON transactions (status, created_at DESC);
CREATE INDEX idx_transactions_purpose_captured ON transactions (purpose, captured_at) WHERE status IN ('captured','partially_refunded','refunded');
CREATE TRIGGER trg_transactions_updated BEFORE UPDATE ON transactions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE teachers ADD CONSTRAINT fk_teachers_registration_txn FOREIGN KEY (registration_transaction_id) REFERENCES transactions(id) ON DELETE SET NULL;
ALTER TABLE institutes ADD CONSTRAINT fk_institutes_registration_txn FOREIGN KEY (registration_transaction_id) REFERENCES transactions(id) ON DELETE SET NULL;
ALTER TABLE leads ADD CONSTRAINT fk_leads_unlock_txn FOREIGN KEY (unlock_transaction_id) REFERENCES transactions(id) ON DELETE SET NULL;

-- @table refunds: Refund requests and their gateway processing.
CREATE TABLE refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  transaction_id uuid NOT NULL REFERENCES transactions(id) ON DELETE RESTRICT, -- Original payment
  amount_paise bigint NOT NULL CHECK (amount_paise > 0), -- Amount to refund
  reason_code text NOT NULL CHECK (reason_code IN ('teacher_rejected','institute_rejected','duplicate_charge','service_not_started','user_request','goodwill','other')), -- Why
  reason_note text, -- Details
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','processing','processed','denied','failed')), -- Lifecycle
  gateway_refund_id text, -- Razorpay rfnd_xxx
  requested_by_type text NOT NULL CHECK (requested_by_type IN ('app_user','admin','system')), -- Who asked
  requested_by_id uuid, -- Requester id
  decided_by uuid REFERENCES admins(id), -- Approver / denier
  decided_at timestamptz, -- Decision time
  denial_reason text, -- Shown to the user
  processed_at timestamptz, -- Gateway confirmed
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now() -- Updated
);
CREATE UNIQUE INDEX uq_refunds_gateway ON refunds (gateway_refund_id) WHERE gateway_refund_id IS NOT NULL;
CREATE INDEX idx_refunds_status ON refunds (status, created_at);
CREATE INDEX idx_refunds_transaction ON refunds (transaction_id);
CREATE TRIGGER trg_refunds_updated BEFORE UPDATE ON refunds FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- @table payment_webhook_events: Raw Razorpay webhooks, stored before processing so every event is processed exactly once.
CREATE TABLE payment_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  gateway text NOT NULL DEFAULT 'razorpay', -- Source
  event_id text NOT NULL, -- Gateway event id (x-razorpay-event-id)
  event_type text NOT NULL, -- e.g. payment.captured, refund.processed
  payload jsonb NOT NULL, -- Full body
  signature_valid boolean NOT NULL, -- HMAC check result
  processed_at timestamptz, -- NULL until processed
  processing_error text, -- Last error
  attempts smallint NOT NULL DEFAULT 0, -- Processing attempts
  received_at timestamptz NOT NULL DEFAULT now() -- Received
);
CREATE UNIQUE INDEX uq_payment_webhook_events ON payment_webhook_events (gateway, event_id);
CREATE INDEX idx_payment_webhook_unprocessed ON payment_webhook_events (received_at) WHERE processed_at IS NULL;

-- @migration 041 M41 Subscription Payments
-- @table subscriptions: Paid access periods for parents, students, teachers and institutes, including trials.
CREATE TABLE subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT, -- Subscriber account
  subscriber_type text NOT NULL CHECK (subscriber_type IN ('parent','student','teacher','institute')), -- Role
  institute_id uuid REFERENCES institutes(id) ON DELETE RESTRICT, -- For institute registrations
  fee_code text NOT NULL, -- Plan, e.g. PARENT_SUBSCRIPTION_YEARLY, TEACHER_REGISTRATION
  payment_configuration_id uuid REFERENCES payment_configurations(id) ON DELETE RESTRICT, -- Price version at purchase (NULL for trials)
  price_paise bigint NOT NULL DEFAULT 0 CHECK (price_paise >= 0), -- Price locked for this period
  status text NOT NULL CHECK (status IN ('trial','active','grace','expired','cancelled','free_access')), -- free_access = fee switched off by admin
  trial_ends_at timestamptz, -- End of free trial
  starts_at timestamptz NOT NULL, -- Period start
  ends_at timestamptz, -- Period end (NULL for free_access)
  auto_renew boolean NOT NULL DEFAULT false, -- UPI Autopay / card mandate active
  gateway_subscription_id text, -- Razorpay sub_xxx when auto-renew
  last_transaction_id uuid REFERENCES transactions(id) ON DELETE SET NULL, -- Most recent payment
  renewal_reminder_sent_at timestamptz, -- 7-day reminder sent
  cancelled_at timestamptz, -- Cancellation time
  cancel_reason text, -- Why
  cancelled_by_type text CHECK (cancelled_by_type IN ('user','admin','system')), -- Who cancelled
  granted_by uuid REFERENCES admins(id), -- Admin who granted/extended manually (complimentary access)
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Updated
  CONSTRAINT ck_subscriptions_period CHECK (ends_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX idx_subscriptions_user ON subscriptions (user_id, created_at DESC);
CREATE UNIQUE INDEX uq_subscriptions_one_live ON subscriptions (user_id, subscriber_type) WHERE status IN ('trial','active','grace','free_access');
CREATE INDEX idx_subscriptions_expiry ON subscriptions (ends_at) WHERE status IN ('trial','active','grace');
CREATE INDEX idx_subscriptions_type_status ON subscriptions (subscriber_type, status);
CREATE TRIGGER trg_subscriptions_updated BEFORE UPDATE ON subscriptions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- @migration 042 M42 Referral Management
-- @table referral_codes: One personal referral code per app user.
CREATE TABLE referral_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  user_id uuid REFERENCES app_users(id) ON DELETE CASCADE, -- Owner; NULL for admin campaign codes
  code text NOT NULL, -- Upper-case code, e.g. LAKSHMI50
  program_code text NOT NULL CHECK (program_code IN ('LEARNER_REFERRAL','TEACHER_REFERRAL','INSTITUTE_REFERRAL')), -- Program
  campaign_name text, -- For admin-created campaign codes
  usage_limit integer CHECK (usage_limit IS NULL OR usage_limit > 0), -- Max sign-ups (campaign codes)
  expires_at timestamptz, -- Campaign expiry
  is_active boolean NOT NULL DEFAULT true, -- Disabled codes stop working
  created_by uuid REFERENCES admins(id), -- Admin creator (campaign codes)
  created_at timestamptz NOT NULL DEFAULT now() -- Created
);
CREATE UNIQUE INDEX uq_referral_codes_code ON referral_codes (upper(code));
CREATE UNIQUE INDEX uq_referral_codes_user_program ON referral_codes (user_id, program_code) WHERE user_id IS NOT NULL;

-- @table referrals: One row per referred user, tracking qualification, fraud checks and reward payout.
CREATE TABLE referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  referral_code_id uuid NOT NULL REFERENCES referral_codes(id) ON DELETE RESTRICT, -- Code used
  referrer_user_id uuid REFERENCES app_users(id) ON DELETE SET NULL, -- Who invited (NULL for campaign codes)
  referee_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT, -- Who joined
  referral_setting_id uuid NOT NULL REFERENCES referral_settings(id) ON DELETE RESTRICT, -- Rules version applied
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','qualified','on_hold','rewarded','rejected','expired','reversed')), -- Lifecycle
  qualified_at timestamptz, -- Qualifying event time
  qualifying_transaction_id uuid REFERENCES transactions(id) ON DELETE SET NULL, -- Payment that qualified it
  reward_amount_paise bigint NOT NULL DEFAULT 0 CHECK (reward_amount_paise >= 0), -- Referrer reward
  referee_reward_paise bigint NOT NULL DEFAULT 0 CHECK (referee_reward_paise >= 0), -- Referee reward/discount
  reward_release_at timestamptz, -- End of hold period
  reward_transaction_id uuid REFERENCES transactions(id) ON DELETE SET NULL, -- Payout record
  fraud_score numeric(4,3) CHECK (fraud_score BETWEEN 0 AND 1), -- Automated risk score
  fraud_flags text[] NOT NULL DEFAULT '{}', -- e.g. {same_device, burst_signups, disposable_number}
  reviewed_by uuid REFERENCES admins(id), -- Admin who reviewed a held referral
  reviewed_at timestamptz, -- Review time
  rejection_reason text, -- Why rejected / reversed
  created_at timestamptz NOT NULL DEFAULT now(), -- Created (referee signed up)
  updated_at timestamptz NOT NULL DEFAULT now() -- Updated
);
CREATE UNIQUE INDEX uq_referrals_referee ON referrals (referee_user_id);
CREATE INDEX idx_referrals_referrer ON referrals (referrer_user_id, created_at DESC);
CREATE INDEX idx_referrals_status ON referrals (status, created_at DESC);
CREATE INDEX idx_referrals_release ON referrals (reward_release_at) WHERE status = 'qualified';
CREATE TRIGGER trg_referrals_updated BEFORE UPDATE ON referrals FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- @migration 043 M43 Complaint Management
CREATE SEQUENCE seq_case_number START 1001; -- generates complaints.case_number
-- @table complaints: Two-way safety reports: learners about teachers/institutes, teachers about parents/students.
CREATE TABLE complaints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  case_number text NOT NULL DEFAULT ('CS-' || nextval('seq_case_number')), -- e.g. CS-4471
  reporter_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT, -- Who reported
  reporter_type text NOT NULL CHECK (reporter_type IN ('parent','student','teacher','institute_staff')), -- Reporter role
  reported_type text NOT NULL CHECK (reported_type IN ('teacher','institute','parent','student')), -- Who is reported
  reported_user_id uuid REFERENCES app_users(id) ON DELETE RESTRICT, -- Reported account (teacher/parent/student)
  reported_institute_id uuid REFERENCES institutes(id) ON DELETE RESTRICT, -- Reported institute
  lead_id uuid REFERENCES leads(id) ON DELETE SET NULL, -- Related lead, if any
  complaint_type text NOT NULL CHECK (complaint_type IN ('fraud','misconduct','fake_information','harassment','other')), -- Type
  description text NOT NULL, -- What happened, 20–3,000 chars
  severity text NOT NULL DEFAULT 'medium' CHECK (severity IN ('low','medium','high','critical')), -- Set by triage rules, editable by admin
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_review','awaiting_info','escalated','resolved','dismissed')), -- Lifecycle
  assigned_admin_id uuid REFERENCES admins(id), -- Case owner
  resolution text CHECK (resolution IN ('no_action','warning_issued','content_removed','account_suspended','account_banned','refund_issued','referred_to_police')), -- Outcome
  resolution_note text, -- Explanation (internal)
  reporter_message text, -- Message sent to the reporter on closure
  is_upheld boolean, -- true when the complaint was valid; feeds the trust score
  sla_due_at timestamptz NOT NULL, -- Response due (critical 4h, high 24h, else 72h)
  resolved_at timestamptz, -- Closed
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Updated
  CONSTRAINT ck_complaints_target CHECK ((reported_type = 'institute') = (reported_institute_id IS NOT NULL) AND (reported_type = 'institute' OR reported_user_id IS NOT NULL))
);
CREATE UNIQUE INDEX uq_complaints_case ON complaints (case_number);
CREATE INDEX idx_complaints_queue ON complaints (status, severity, sla_due_at);
CREATE INDEX idx_complaints_reported_user ON complaints (reported_user_id, created_at DESC);
CREATE INDEX idx_complaints_reported_inst ON complaints (reported_institute_id, created_at DESC);
CREATE INDEX idx_complaints_assignee ON complaints (assigned_admin_id, status);
CREATE TRIGGER trg_complaints_updated BEFORE UPDATE ON complaints FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- @table complaint_actions: Case timeline: assignments, notes, warnings, suspensions, escalations.
CREATE TABLE complaint_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  complaint_id uuid NOT NULL REFERENCES complaints(id) ON DELETE CASCADE, -- Case
  action text NOT NULL CHECK (action IN ('created','assigned','note','info_requested','warning_issued','suspended','escalated','severity_changed','resolved','dismissed','reopened')), -- Event
  note text, -- Details
  is_internal boolean NOT NULL DEFAULT true, -- false = shown to reporter/reported
  metadata jsonb, -- e.g. {"from":"medium","to":"high"}
  admin_id uuid REFERENCES admins(id), -- Actor
  created_at timestamptz NOT NULL DEFAULT now() -- When
);
CREATE INDEX idx_complaint_actions_case ON complaint_actions (complaint_id, created_at);

-- @table complaint_attachments: Evidence files attached to a complaint.
CREATE TABLE complaint_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  complaint_id uuid NOT NULL REFERENCES complaints(id) ON DELETE CASCADE, -- Case
  file_id uuid NOT NULL REFERENCES files(id) ON DELETE RESTRICT, -- Private file
  uploaded_by_type text NOT NULL CHECK (uploaded_by_type IN ('app_user','admin')), -- Uploader kind
  created_at timestamptz NOT NULL DEFAULT now() -- Uploaded
);
CREATE INDEX idx_complaint_attachments_case ON complaint_attachments (complaint_id);

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

-- @migration 046 M46 Notification Management
-- @table notifications: Push / in-app notification campaigns created by admins (transactional pushes are sent by services and not stored here).
CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Primary key
  title text NOT NULL, -- Max 60 chars
  body text NOT NULL, -- Max 180 chars
  image_file_id uuid REFERENCES files(id) ON DELETE SET NULL, -- Optional rich image
  deep_link text, -- App route opened on tap
  channel text NOT NULL DEFAULT 'push_and_inbox' CHECK (channel IN ('push','inbox','push_and_inbox')), -- Delivery channel
  audience_type text NOT NULL CHECK (audience_type IN ('all','parents','students','teachers','institutes','segment','user_list')), -- Who receives it
  segment jsonb, -- Filters for audience_type = segment, e.g. {"city_ids":[…],"class_ids":[…],"subscription_status":["trial"]}
  user_ids uuid[], -- Explicit recipients for audience_type = user_list (max 10,000)
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','sending','sent','failed','cancelled')), -- Lifecycle
  scheduled_at timestamptz, -- Send time (NULL = send now)
  sent_at timestamptz, -- Finished sending
  target_count integer, -- Recipients resolved at send time
  delivered_count integer NOT NULL DEFAULT 0, -- FCM success count
  failed_count integer NOT NULL DEFAULT 0, -- FCM failures
  opened_count integer NOT NULL DEFAULT 0, -- Opens reported by the app
  created_by uuid REFERENCES admins(id), -- Creator
  approved_by uuid REFERENCES admins(id), -- Second admin approval for audiences over 50,000
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  updated_at timestamptz NOT NULL DEFAULT now(), -- Updated
  deleted_at timestamptz -- Soft delete (drafts only)
);
CREATE INDEX idx_notifications_status ON notifications (status, scheduled_at) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_notifications_updated BEFORE UPDATE ON notifications FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- @table notification_recipients: Per-user delivery record for a campaign. Partition by month at scale.
CREATE TABLE notification_recipients (
  notification_id uuid NOT NULL REFERENCES notifications(id) ON DELETE CASCADE, -- Campaign
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE, -- Recipient
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed','opened','no_token')), -- Delivery state
  error_code text, -- FCM error, e.g. UNREGISTERED
  sent_at timestamptz, -- Sent
  opened_at timestamptz, -- Opened
  PRIMARY KEY (notification_id, user_id)
);
CREATE INDEX idx_notification_recipients_user ON notification_recipients (user_id, sent_at DESC);

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

-- @migration 049 Admin Mobile OTP (extension, not part of the original 51-module spec)
-- @table admin_otp_codes: One-time codes for admin mobile OTP login. `code` is plaintext by design —
-- there is no SMS gateway wired up yet, so the code is surfaced on screen and via GET /auth/otp/logs
-- as a development stand-in. Replace with a hashed code + real gateway before production use.
CREATE TABLE admin_otp_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  phone text NOT NULL,
  code text NOT NULL,
  purpose text NOT NULL DEFAULT 'login' CHECK (purpose IN ('login')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'expired')),
  attempts smallint NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  verified_at timestamptz,
  requested_ip inet,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_admin_otp_codes_admin ON admin_otp_codes (admin_id, created_at DESC);
CREATE INDEX idx_admin_otp_codes_phone ON admin_otp_codes (phone, created_at DESC);

-- @migration 050 Mobile app foundation (/api/v1/app) — sourced from GuruMobile/sql/mobile_only.sql, applied verbatim
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

-- @migration 051 Fix: app_sessions refresh-token reuse detection (previous_token_hash)
-- Fix: mobile_only.sql's app_sessions table has no way to detect a rotated-out refresh token being
-- replayed (no previous_token_hash), so a stolen-and-replayed token could not trigger revoking the
-- rest of that session's family. Mirrors admin_sessions.previous_token_hash (see modules/M01).
ALTER TABLE app_sessions ADD COLUMN previous_token_hash text;
CREATE INDEX idx_app_sessions_prev_token ON app_sessions (previous_token_hash) WHERE previous_token_hash IS NOT NULL;
