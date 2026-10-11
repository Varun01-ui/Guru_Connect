import type { Generated } from 'kysely'

type Timestamp = Date

// Regenerate with kysely-codegen once more modules ship; each module adds its
// own table interfaces here as it's built.
export interface DB {
  admins: {
    id: Generated<string>
    email: string
    password_hash: string
    full_name: string
    status: 'invited' | 'active' | 'locked' | 'disabled'
    is_super_admin: Generated<boolean>
    failed_login_count: Generated<number>
    locked_until: Timestamp | null
    last_login_at: Timestamp | null
    last_login_ip: string | null
    password_changed_at: Generated<Timestamp>
    mfa_enabled: Generated<boolean>
    created_by: string | null
    updated_by: string | null
    created_at: Generated<Timestamp>
    updated_at: Generated<Timestamp>
    deleted_at: Timestamp | null
    deleted_by: string | null
  }
  admin_profiles: {
    admin_id: string
    display_name: string | null
    phone: string | null
    designation: string | null
    avatar_file_id: string | null
    timezone: Generated<string>
    locale: Generated<string>
    theme: Generated<'light' | 'dark' | 'system'>
    notification_prefs: Generated<unknown>
    updated_at: Generated<Timestamp>
  }
  admin_sessions: {
    id: Generated<string>
    admin_id: string
    refresh_token_hash: string
    token_family: Generated<string>
    previous_token_hash: string | null
    ip_address: string | null
    user_agent: string | null
    device_label: string | null
    last_used_at: Generated<Timestamp>
    expires_at: Timestamp
    revoked_at: Timestamp | null
    revoked_reason:
      | 'logout'
      | 'logout_all'
      | 'password_changed'
      | 'token_reuse'
      | 'admin_forced'
      | 'expired'
      | 'account_disabled'
      | null
    created_at: Generated<Timestamp>
  }
  password_reset_tokens: {
    id: Generated<string>
    admin_id: string
    token_hash: string
    purpose: Generated<'reset' | 'invite'>
    expires_at: Timestamp
    used_at: Timestamp | null
    requested_ip: string | null
    created_at: Generated<Timestamp>
  }
  admin_otp_codes: {
    id: Generated<string>
    admin_id: string
    phone: string
    code: string
    purpose: Generated<'login'>
    status: Generated<'pending' | 'verified' | 'expired'>
    attempts: Generated<number>
    expires_at: Timestamp
    verified_at: Timestamp | null
    requested_ip: string | null
    created_at: Generated<Timestamp>
  }
  audit_logs: {
    id: Generated<string>
    actor_type: 'admin' | 'system' | 'app_user'
    actor_id: string | null
    actor_email: string | null
    action: string
    module: string
    entity_type: string | null
    entity_id: string | null
    old_values: Generated<unknown>
    new_values: Generated<unknown>
    reason: string | null
    ip_address: string | null
    user_agent: string | null
    request_id: string | null
    created_at: Generated<Timestamp>
  }

  // ---- Mobile app (/api/v1/app) — see GuruMobile/sql/mobile_only.sql for the source of truth ----

  app_users: {
    id: Generated<string>
    user_type: 'parent' | 'student' | 'teacher' | 'institute_staff'
    phone: string | null
    phone_verified_at: Timestamp | null
    email: string | null
    email_verified_at: Timestamp | null
    full_name: string
    auth_provider: Generated<'otp' | 'password' | 'google' | 'apple'>
    account_status: Generated<'active' | 'suspended' | 'banned' | 'deactivated'>
    suspended_reason: string | null
    suspended_at: Timestamp | null
    last_active_at: Timestamp | null
    created_at: Generated<Timestamp>
    updated_at: Generated<Timestamp>
    deleted_at: Timestamp | null
    preferred_language: Generated<string>
    profile_photo_file_id: string | null
    signup_source: 'organic' | 'referral' | 'campaign' | 'admin_created' | 'deep_link' | null
  }
  otp_challenges: {
    id: Generated<string>
    channel: 'sms' | 'email' | 'whatsapp'
    destination: string
    purpose: 'login' | 'signup' | 'change_phone' | 'change_email' | 'reset_password' | 'delete_account' | 'parent_consent'
    code_hash: string
    user_id: string | null
    attempts: Generated<number>
    resend_count: Generated<number>
    provider_message_id: string | null
    ip_address: string | null
    install_id: string | null
    expires_at: Timestamp
    verified_at: Timestamp | null
    consumed_at: Timestamp | null
    created_at: Generated<Timestamp>
  }
  app_sessions: {
    id: Generated<string>
    user_id: string
    device_id: string | null
    refresh_token_hash: string
    previous_token_hash: string | null
    token_family: string
    auth_method: 'otp' | 'password' | 'google' | 'email_otp'
    ip_address: string | null
    user_agent: string | null
    last_used_at: Generated<Timestamp>
    expires_at: Timestamp
    revoked_at: Timestamp | null
    revoked_reason:
      | 'logout'
      | 'logout_all'
      | 'reuse_detected'
      | 'password_changed'
      | 'account_suspended'
      | 'account_deleted'
      | 'expired'
      | 'admin'
      | null
    created_at: Generated<Timestamp>
  }
  user_auth_identities: {
    id: Generated<string>
    user_id: string
    provider: 'phone' | 'password' | 'google'
    provider_subject: string
    email: string | null
    password_hash: string | null
    password_updated_at: Timestamp | null
    failed_attempts: Generated<number>
    locked_until: Timestamp | null
    last_used_at: Timestamp | null
    created_at: Generated<Timestamp>
    updated_at: Generated<Timestamp>
    deleted_at: Timestamp | null
  }
  user_devices: {
    id: Generated<string>
    user_id: string
    install_id: string
    platform: 'android' | 'ios'
    os_version: string | null
    app_version: string
    build_number: number | null
    device_model: string | null
    fcm_token: string | null
    push_permission: Generated<'granted' | 'denied' | 'not_determined' | 'provisional'>
    locale: string | null
    timezone: Generated<string>
    last_seen_at: Generated<Timestamp>
    token_updated_at: Timestamp | null
    revoked_at: Timestamp | null
    created_at: Generated<Timestamp>
    updated_at: Generated<Timestamp>
  }
  user_consents: {
    id: Generated<string>
    user_id: string
    consent_type: 'terms' | 'privacy_policy' | 'marketing' | 'personalisation' | 'parental_consent' | 'data_processing_minor'
    document_version: string
    granted: boolean
    method: 'checkbox' | 'otp' | 'toggle' | 'email_link'
    guardian_phone: string | null
    ip_address: string | null
    install_id: string | null
    created_at: Generated<Timestamp>
  }
  parents: {
    id: Generated<string>
    user_id: string
    public_code: Generated<string>
    full_name: string
    email: string | null
    phone: string
    state_id: string | null
    city_id: string | null
    area_id: string | null
    account_status: Generated<'active' | 'suspended'>
    suspension_reason: string | null
    suspended_at: Timestamp | null
    suspended_by: string | null
    referral_code_used: string | null
    created_at: Generated<Timestamp>
    updated_at: Generated<Timestamp>
    deleted_at: Timestamp | null
    deleted_by: string | null
  }
  parent_children: {
    id: Generated<string>
    parent_id: string
    child_name: string
    class_id: string
    board_id: string | null
    preferred_mode_id: string | null
    school_name: string | null
    sort_order: Generated<number>
    created_at: Generated<Timestamp>
    updated_at: Generated<Timestamp>
    deleted_at: Timestamp | null
  }
  countries: {
    id: Generated<string>
    name: string
    iso2: string
    iso3: string
    phone_code: string
    currency_code: string
    is_active: Generated<boolean>
    sort_order: Generated<number>
    created_by: string | null
    updated_by: string | null
    created_at: Generated<Timestamp>
    updated_at: Generated<Timestamp>
    deleted_at: Timestamp | null
    deleted_by: string | null
  }
  states: {
    id: Generated<string>
    country_id: string
    name: string
    code: string
    type: Generated<'state' | 'union_territory'>
    is_active: Generated<boolean>
    sort_order: Generated<number>
    created_by: string | null
    updated_by: string | null
    created_at: Generated<Timestamp>
    updated_at: Generated<Timestamp>
    deleted_at: Timestamp | null
    deleted_by: string | null
  }
  cities: {
    id: string
    state_id: string
    name: string
    slug: string
    latitude: string | null
    longitude: string | null
    is_serviceable: Generated<boolean>
    is_active: Generated<boolean>
    sort_order: Generated<number>
    deleted_at: Timestamp | null
  }
  areas: {
    id: string
    city_id: string
    name: string
    slug: string
    pincodes: Generated<string[]>
    latitude: string | null
    longitude: string | null
    is_active: Generated<boolean>
    sort_order: Generated<number>
    deleted_at: Timestamp | null
  }
  classes: {
    id: Generated<string>
    name: string
    code: string
    stage: string
    level_order: number
    is_active: Generated<boolean>
    created_by: string | null
    updated_by: string | null
    created_at: Generated<Timestamp>
    updated_at: Generated<Timestamp>
    deleted_at: Timestamp | null
    deleted_by: string | null
  }
  boards: {
    id: string
    name: string
    short_name: string
    type: string
    state_id: string | null
    sort_order: Generated<number>
    is_active: Generated<boolean>
    deleted_at: Timestamp | null
  }
  teaching_modes: {
    id: Generated<string>
    name: string
    code: string
    description: string | null
    requires_location: Generated<boolean>
    is_active: Generated<boolean>
    sort_order: Generated<number>
    created_by: string | null
    updated_by: string | null
    created_at: Generated<Timestamp>
    updated_at: Generated<Timestamp>
    deleted_at: Timestamp | null
    deleted_by: string | null
  }
  subjects: {
    id: string
    name: string
    slug: string
    min_class_order: number | null
    max_class_order: number | null
    is_active: Generated<boolean>
    sort_order: Generated<number>
    deleted_at: Timestamp | null
  }
  teacher_categories: {
    id: Generated<string>
    name: string
    slug: string
    description: string | null
    icon_file_id: string | null
    is_active: Generated<boolean>
    sort_order: Generated<number>
    created_by: string | null
    updated_by: string | null
    created_at: Generated<Timestamp>
    updated_at: Generated<Timestamp>
    deleted_at: Timestamp | null
    deleted_by: string | null
  }
  parent_child_subjects: {
    child_id: string
    subject_id: string
  }
  parent_child_teacher_categories: {
    child_id: string
    category_id: string
  }
  files: {
    id: Generated<string>
    storage_provider: Generated<'s3' | 'r2'>
    bucket: string
    object_key: string
    original_name: string
    mime_type: string
    size_bytes: number
    checksum_sha256: string | null
    visibility: Generated<'private' | 'public'>
    purpose: string
    uploaded_by_type: 'admin' | 'app_user' | 'system'
    uploaded_by_id: string | null
    status: Generated<'pending' | 'uploaded' | 'quarantined' | 'deleted'>
    created_at: Generated<Timestamp>
    updated_at: Generated<Timestamp>
    deleted_at: Timestamp | null
  }
  banners: {
    id: Generated<string>
    title: string
    subtitle: string | null
    image_file_id: string
    placement: 'home_top' | 'home_middle' | 'search_inline' | 'teacher_dashboard' | 'institute_dashboard' | 'onboarding'
    audience: Generated<'all' | 'parents' | 'students' | 'teachers' | 'institutes'>
    city_ids: Generated<string[]>
    deep_link: string | null
    priority: Generated<number>
    starts_at: Timestamp
    ends_at: Timestamp | null
    status: Generated<'draft' | 'scheduled' | 'active' | 'paused' | 'expired'>
    deleted_at: Timestamp | null
  }
  user_notifications: {
    id: Generated<string>
    user_id: string
    category: string
    event_type: string
    title: string
    body: string
    image_url: string | null
    deep_link: string | null
    data: Generated<Record<string, unknown>>
    dedupe_key: string | null
    push_status: Generated<'pending' | 'sent' | 'failed' | 'skipped_pref' | 'skipped_quiet_hours' | 'no_device'>
    read_at: Timestamp | null
    expires_at: Timestamp | null
    created_at: Generated<Timestamp>
    deleted_at: Timestamp | null
  }
  referral_codes: {
    id: Generated<string>
    user_id: string | null
    code: string
    program_code: 'LEARNER_REFERRAL' | 'TEACHER_REFERRAL' | 'INSTITUTE_REFERRAL'
    campaign_name: string | null
    usage_limit: number | null
    expires_at: Timestamp | null
    is_active: Generated<boolean>
    created_by: string | null
    created_at: Generated<Timestamp>
  }
  referral_settings: {
    id: string
    program_code: string
    version: number
    is_enabled: boolean
    status: string
    effective_from: Timestamp
  }
  referrals: {
    id: Generated<string>
    referral_code_id: string
    referrer_user_id: string | null
    referee_user_id: string
    referral_setting_id: string
    status: Generated<string>
    created_at: Generated<Timestamp>
  }
  system_settings: {
    id: Generated<string>
    key: string
    value: unknown
    is_public: boolean
  }

  // ---- M11–M15 / M43 / M10 / M13 tables (shapes mirror sql/schema.sql) ----

  students: {
    id: Generated<string>
    user_id: string
    public_code: Generated<string>
    full_name: string
    email: string | null
    phone: string
    class_id: string | null
    board_id: string | null
    school_name: string | null
    parent_id: string | null
    parent_link_status: Generated<'none' | 'pending' | 'confirmed'>
    parent_name: string | null
    parent_phone: string | null
    parental_consent: Generated<'not_required' | 'pending' | 'confirmed' | 'declined'>
    parental_consent_at: Timestamp | null
    city_id: string | null
    area_id: string | null
    account_status: Generated<'active' | 'suspended'>
    referral_code_used: string | null
    created_at: Generated<Timestamp>
    updated_at: Generated<Timestamp>
    deleted_at: Timestamp | null
  }
  teachers: {
    id: Generated<string>
    user_id: string
    public_code: Generated<string>
    full_name: string
    gender: 'female' | 'male' | 'other' | 'undisclosed' | null
    date_of_birth: string | null
    email: string | null
    phone: string
    profile_photo_file_id: string | null
    category_id: string | null
    highest_qualification: string | null
    experience_years: number | null
    bio: string | null
    languages: Generated<string[]>
    fee_per_hour_paise: number | null
    demo_available: Generated<boolean>
    verification_status: Generated<'draft' | 'pending' | 'under_review' | 'reupload_requested' | 'approved' | 'rejected'>
    account_status: Generated<'active' | 'suspended'>
    is_verified_badge: Generated<boolean>
    is_featured: Generated<boolean>
    featured_until: Timestamp | null
    is_premium: Generated<boolean>
    premium_until: Timestamp | null
    registration_transaction_id: string | null
    submitted_at: Timestamp | null
    approved_at: Timestamp | null
    rejected_at: Timestamp | null
    rejection_reason_code: string | null
    rejection_note: string | null
    badge_granted_at: Timestamp | null
    badge_granted_by: string | null
    reviewed_by: string | null
    suspended_at: Timestamp | null
    suspension_reason: string | null
    created_by: string | null
    updated_by: string | null
    profile_completeness: Generated<number>
    trust_score: string | null
    rating_avg: string | null
    rating_count: Generated<number>
    created_at: Generated<Timestamp>
    updated_at: Generated<Timestamp>
    deleted_at: Timestamp | null
  }
  teacher_qualifications: {
    id: Generated<string>
    teacher_id: string
    level: 'secondary' | 'senior_secondary' | 'diploma' | 'graduate' | 'postgraduate' | 'doctorate' | 'professional' | 'certification'
    degree: string
    institution: string
    year_completed: number | null
    grade: string | null
    document_id: string | null
    is_highest: Generated<boolean>
    sort_order: Generated<number>
    created_at: Generated<Timestamp>
    updated_at: Generated<Timestamp>
    deleted_at: Timestamp | null
  }
  teacher_subjects: {
    id: Generated<string>
    teacher_id: string
    subject_id: string
    is_primary: Generated<boolean>
    experience_years: number | null
    created_at: Generated<Timestamp>
  }
  teacher_classes: {
    id: Generated<string>
    teacher_id: string
    class_id: string
    board_id: string | null
    created_at: Generated<Timestamp>
  }
  teacher_teaching_modes: {
    teacher_id: string
    teaching_mode_id: string
    created_at: Generated<Timestamp>
  }
  teacher_locations: {
    id: Generated<string>
    teacher_id: string
    city_id: string
    area_id: string | null
    is_primary: Generated<boolean>
    travel_radius_km: number | null
    address_line: string | null
    latitude: string | null
    longitude: string | null
    created_at: Generated<Timestamp>
  }
  teacher_documents: {
    id: Generated<string>
    teacher_id: string
    doc_type: 'aadhaar' | 'pan' | 'education_certificate' | 'professional_certificate' | 'experience_letter' | 'photo'
    file_id: string
    title: string | null
    doc_number_masked: string | null
    doc_number_hash: string | null
    version: Generated<number>
    is_current: Generated<boolean>
    status: Generated<'submitted' | 'approved' | 'rejected' | 'reupload_requested'>
    review_note: string | null
    reviewed_by: string | null
    reviewed_at: Timestamp | null
    created_at: Generated<Timestamp>
    updated_at: Generated<Timestamp>
  }
  teacher_verification_logs: {
    id: Generated<string>
    teacher_id: string
    document_id: string | null
    action: string
    from_status: string | null
    to_status: string | null
    note: string | null
    is_internal: Generated<boolean>
    metadata: unknown | null
    admin_id: string | null
    created_at: Generated<Timestamp>
  }
  trust_scores: {
    teacher_id: string
    score: string
    aadhaar_score: Generated<number>
    pan_score: Generated<number>
    certificate_score: Generated<number>
    review_score: Generated<number>
    complaint_score: Generated<number>
    completeness_score: Generated<number>
  }
  trust_score_weights: {
    id: Generated<string>
    version: number
    weights: Record<string, number>
    status: string
  }
  institutes: {
    id: Generated<string>
    public_code: Generated<string>
    name: string
    slug: string
    institute_type: 'coaching_centre' | 'tuition_centre' | 'school' | 'music_school' | 'coding_academy' | 'language_institute' | 'sports_academy' | 'other'
    gstin: string | null
    email: string | null
    phone: string
    address_line: string
    city_id: string
    area_id: string | null
    pincode: string | null
    latitude: string | null
    longitude: string | null
    verification_status: Generated<'draft' | 'pending' | 'under_review' | 'docs_requested' | 'visit_scheduled' | 'evaluation_done' | 'approved' | 'rejected'>
    account_status: Generated<'active' | 'suspended'>
    submitted_at: Timestamp | null
    rejected_at: Timestamp | null
    rejection_reason_code: string | null
    rejection_note: string | null
    created_at: Generated<Timestamp>
    updated_at: Generated<Timestamp>
    deleted_at: Timestamp | null
  }
  user_search_history: {
    id: Generated<string>
    user_id: string
    target: string
    query_text: string | null
    filters: Generated<unknown>
    child_id: string | null
    created_at: Generated<Timestamp>
    deleted_at: Timestamp | null
  }
  user_favorites: {
    id: Generated<string>
    user_id: string
    target_type: string
    teacher_id: string | null
    institute_id: string | null
    child_id: string | null
    created_at: Generated<Timestamp>
    deleted_at: Timestamp | null
  }
  recommendation_dismissals: {
    id: Generated<string>
    user_id: string
    child_id: string | null
    teacher_id: string | null
    institute_id: string | null
    created_at: Generated<Timestamp>
  }
  user_blocks: {
    id: Generated<string>
    blocker_user_id: string
    blocked_user_id: string
    created_at: Generated<Timestamp>
    deleted_at: Timestamp | null
  }
  payment_configurations: {
    id: Generated<string>
    fee_code: string
    version: number
    name: string
    description: string | null
    is_enabled: boolean
    amount_paise: number
    gst_inclusive: boolean
    gst_rate_bps: number
    billing_period: string
    validity_days: number | null
    trial_days: number
    effective_from: Timestamp
    effective_to: Timestamp | null
    status: 'draft' | 'scheduled' | 'active' | 'superseded' | 'cancelled'
  }
  transactions: {
    id: Generated<string>
    public_code: Generated<string>
    user_id: string
    payer_type: 'parent' | 'student' | 'teacher' | 'institute'
    institute_id: string | null
    purpose: 'teacher_registration' | 'institute_registration' | 'subscription' | 'premium_listing' | 'featured_listing' | 'contact_unlock' | 'referral_payout'
    direction: Generated<'credit' | 'debit'>
    payment_configuration_id: string | null
    fee_code: string | null
    amount_paise: number
    base_amount_paise: number
    gst_paise: Generated<number>
    discount_paise: Generated<number>
    status: Generated<'created' | 'authorized' | 'captured' | 'failed' | 'refund_pending' | 'refunded' | 'partially_refunded' | 'cancelled'>
    gateway: Generated<'razorpay' | 'manual' | 'wallet'>
    gateway_order_id: string | null
    gateway_payment_id: string | null
    method: 'upi' | 'card' | 'netbanking' | 'wallet' | 'emi' | 'manual' | null
    failure_code: string | null
    failure_reason: string | null
    captured_at: Timestamp | null
    metadata: Generated<Record<string, unknown>>
    created_at: Generated<Timestamp>
    updated_at: Generated<Timestamp>
  }
  wallet_ledger: {
    id: Generated<string>
    user_id: string
    amount_paise: number
    entry_type: 'referral_reward' | 'referee_bonus' | 'checkout_redemption' | 'redemption_refund' | 'reversal' | 'expiry' | 'admin_adjustment'
    transaction_id: string | null
    description: string
    idempotency_key: string
    created_at: Generated<Timestamp>
  }
  subscriptions: {
    id: Generated<string>
    user_id: string
    subscriber_type: 'parent' | 'student' | 'teacher' | 'institute'
    institute_id: string | null
    fee_code: string
    payment_configuration_id: string | null
    price_paise: Generated<number>
    status: 'trial' | 'active' | 'grace' | 'expired' | 'cancelled' | 'free_access'
    trial_ends_at: Timestamp | null
    starts_at: Timestamp
    ends_at: Timestamp | null
    auto_renew: Generated<boolean>
    last_transaction_id: string | null
    cancelled_at: Timestamp | null
    cancel_reason: string | null
    cancelled_by_type: 'user' | 'admin' | 'system' | null
    created_at: Generated<Timestamp>
    updated_at: Generated<Timestamp>
  }
  leads: {
    id: Generated<string>
    requester_user_id: string
    teacher_id: string | null
    lead_type: string
    target_type: string
    requester_type: string
    contact_unlocked: Generated<boolean>
    unlock_transaction_id: string | null
    status: string
    first_response_at: Timestamp | null
    updated_at: Generated<Timestamp>
    created_at: Generated<Timestamp>
    deleted_at: Timestamp | null
  }

  // ---- M16–M21 tables ----

  teacher_availability: {
    id: Generated<string>
    teacher_id: string
    day_of_week: number
    start_time: string
    end_time: string
    teaching_mode_id: string | null
    accepts_demos: Generated<boolean>
    created_at: Generated<Timestamp>
    updated_at: Generated<Timestamp>
    deleted_at: Timestamp | null
  }
  teacher_time_off: {
    id: Generated<string>
    teacher_id: string
    starts_on: string
    ends_on: string
    reason: string | null
    pause_leads: Generated<boolean>
    created_at: Generated<Timestamp>
    deleted_at: Timestamp | null
  }
  teacher_fee_plans: {
    id: Generated<string>
    teacher_id: string
    label: string
    subject_id: string | null
    class_from_id: string | null
    class_to_id: string | null
    teaching_mode_id: string | null
    fee_unit: 'per_hour' | 'per_month' | 'per_course'
    amount_paise: number
    sessions_per_week: number | null
    session_minutes: number | null
    notes: string | null
    is_active: Generated<boolean>
    sort_order: Generated<number>
    created_at: Generated<Timestamp>
    updated_at: Generated<Timestamp>
    deleted_at: Timestamp | null
  }
  demo_requests: {
    id: Generated<string>
    lead_id: string
    teacher_id: string | null
    institute_id: string | null
    requester_user_id: string
    requested_start_at: Timestamp
    confirmed_start_at: Timestamp | null
    status: Generated<'requested' | 'confirmed' | 'reschedule_proposed' | 'completed' | 'cancelled' | 'no_show' | 'expired'>
    cancelled_by: 'requester' | 'teacher' | 'institute' | 'admin' | 'system' | null
    cancel_reason: string | null
    completed_at: Timestamp | null
    created_at: Generated<Timestamp>
    updated_at: Generated<Timestamp>
  }
  teacher_daily_stats: {
    teacher_id: string
    stat_date: string
    profile_views: Generated<number>
    unique_viewers: Generated<number>
    lead_requests: Generated<number>
    demo_requests: Generated<number>
    demos_completed: Generated<number>
    reviews_published: Generated<number>
    rating_sum: Generated<number>
  }
  teacher_reviews: {
    id: Generated<string>
    teacher_id: string
    author_user_id: string
    author_type: 'parent' | 'student'
    rating: number
    comment: string
    status: Generated<'pending' | 'published' | 'rejected' | 'flagged' | 'hidden'>
    published_at: Timestamp | null
    created_at: Generated<Timestamp>
    deleted_at: Timestamp | null
  }
  user_notification_preferences: {
    user_id: string
    category: string
    push_enabled: Generated<boolean>
    email_enabled: Generated<boolean>
    quiet_hours_start: string | null
    quiet_hours_end: string | null
    updated_at: Generated<Timestamp>
  }
  institute_managers: {
    id: Generated<string>
    institute_id: string
    user_id: string | null
    full_name: string
    email: string | null
    phone: string
    designation: string | null
    staff_role: Generated<'manager' | 'counsellor'>
    is_primary: Generated<boolean>
    status: Generated<'invited' | 'active' | 'disabled'>
    invited_at: Timestamp | null
    accepted_at: Timestamp | null
    created_at: Generated<Timestamp>
    updated_at: Generated<Timestamp>
  }
  institute_documents: {
    id: Generated<string>
    institute_id: string
    doc_type: string
    file_id: string
    version: Generated<number>
    is_current: Generated<boolean>
    status: Generated<string>
    created_at: Generated<Timestamp>
  }

  // ---- Admin M02: roles & permissions ----

  roles: {
    id: Generated<string>
    code: string
    name: string
    description: string | null
    is_system: Generated<boolean>
    created_by: string | null
    updated_by: string | null
    created_at: Generated<Timestamp>
    updated_at: Generated<Timestamp>
    deleted_at: Timestamp | null
    deleted_by: string | null
  }
  permissions: {
    id: Generated<string>
    key: string
    module: string
    description: string
    is_sensitive: Generated<boolean>
    created_at: Generated<Timestamp>
  }
  role_permissions: {
    role_id: string
    permission_id: string
    granted_by: string | null
    granted_at: Generated<Timestamp>
  }
  admin_roles: {
    admin_id: string
    role_id: string
    assigned_by: string | null
    assigned_at: Generated<Timestamp>
  }
  refunds: {
    id: Generated<string>
    transaction_id: string
    amount_paise: number
    reason_code: string
    reason_note: string | null
    status: Generated<'requested' | 'approved' | 'processing' | 'processed' | 'denied' | 'failed'>
    requested_by_type: 'app_user' | 'admin' | 'system'
    requested_by_id: string | null
    decided_by: string | null
    decided_at: Timestamp | null
    created_at: Generated<Timestamp>
    updated_at: Generated<Timestamp>
  }
}
