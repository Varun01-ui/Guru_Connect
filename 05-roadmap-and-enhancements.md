# 05 · Roadmap and Future Enhancements

## Delivery plan by phase

| Phase | Modules | Estimate (dev-days) | Outcome when done |
| --- | --- | --- | --- |
| Phase 0 · Platform Foundation | M00 | 3–4 | Audit log, file uploads, app users table, shared API/UI plumbing |
| Phase 1 · Foundation | M01, M02, M03 | 9–11 | Admins can sign in; roles and permissions enforced |
| Phase 2 · Configuration | M04, M05, M06 | 9–10 | Settings, pricing and referral rules editable without deploys |
| Phase 3 · Locations | M07, M08, M09, M10 | 4–6 | Location masters |
| Phase 4 · Education Masters | M11, M12, M13, M14, M15 | 5.5–6 | Education masters |
| Phase 5 · Teachers | M16, M17, M18, M19, M20, M21 | 17–18 | Teachers can be verified, managed and analysed |
| Phase 6 · Institutes | M22, M23, M24, M25, M26, M27 | 18–19 | Institutes can be verified, rated and managed |
| Phase 7 · Parents | M28, M29, M30 | 7–8 | Parents, children and parent subscriptions manageable |
| Phase 8 · Students | M31, M32 | 3–5 | Students and student subscriptions manageable |
| Phase 9 · Reviews | M33, M34, M35 | 9–9 | Reviews visible and moderated |
| Phase 10 · Trust Score Engine | M36, M37 | 5–7 | Trust scores live and explainable |
| Phase 11 · Leads | M38, M39 | 5–5 | Leads and demos traceable |
| Phase 12 · Payments | M40, M41 | 8–8 | Payments, refunds and subscriptions operational |
| Phase 13 · Referrals | M42 | 3–3 | Referral program with fraud controls |
| Phase 14 · Complaints | M43 | 5–5 | Safety complaints handled with SLAs |
| Phase 15 · CMS | M44, M45, M46 | 9–9 | Banners, blog and push campaigns |
| Phase 16 · Reporting | M47, M48, M49, M50 | 12–12 | Dashboard and exportable reports |

Suggested milestones: **MVP-1** (Phases 0–6: admins, config, masters, teacher and institute verification) → **MVP-2** (Phases 7–12: users, reviews, trust, leads, payments) → **v1.0** (Phases 13–16).

## Future enhancements by module

### [M00](modules/M00-platform-foundation-audit-logs-files-app-users.md) Platform Foundation (Audit Logs, Files, App Users)

- Partition `audit_logs` monthly; ship to a data lake (S3 + Athena) for long-term queries.
- Move virus scanning to a Lambda triggered by S3 events.
- Add OpenSearch for global search when entity counts pass a few million; keep Postgres as the source of truth.
- Consider WORM storage (S3 Object Lock) for audit archives to satisfy compliance audits.

### [M01](modules/M01-authentication-system.md) Authentication System

- Add TOTP MFA (`mfa_enabled`, secret encrypted with KMS, backup codes) and make it mandatory for roles holding sensitive permissions.
- SSO with Google Workspace (OIDC) once the team grows; keep password login for break-glass super admin.
- Password history table if the policy needs "not last 5".
- Move JWT signing keys to KMS with rotation (`kid` header, JWKS endpoint).
- IP allow-listing per role (e.g., Finance only from office IPs).

### [M02](modules/M02-roles-permissions.md) Roles & Permissions

- Scope roles by city or institute (`admin_role_scopes` table with `scope_type`, `scope_id`) when regional teams arrive.
- Time-boxed access grants (auto-expire a role assignment).
- Approval workflow for sensitive permission grants (two-person rule).
- Export the permission matrix as CSV for compliance reviews.

### [M03](modules/M03-admin-profile-management.md) Admin Profile Management

- Add MFA enrolment here once Module 1 supports TOTP.
- Personal API tokens for automation (scoped, expiring) if integrations are needed.
- Per-admin saved table views and default filters.

### [M04](modules/M04-global-settings.md) Global Settings

- Per-city overrides (`system_setting_overrides` with `city_id`) if cities need different limits.
- Feature flags with percentage roll-outs (or adopt Unleash/GrowthBook) once experiments start.
- Scheduled setting changes (apply at a future time) using the same pattern as Module 5.

### [M05](modules/M05-dynamic-payment-configuration.md) Dynamic Payment Configuration

- City- or segment-specific pricing: add `scope jsonb` (city_ids, user_type) and resolve the most specific active version.
- Promo codes and coupons as a separate module referencing fee codes.
- A/B price tests (split by user id hash) with experiment ids stored on transactions.
- Multi-currency when expanding beyond India (currency per version already stored).

### [M06](modules/M06-referral-configuration.md) Referral Configuration

- Tiered rewards (more per referral after 5 successful referrals).
- Campaign-specific rules attached to campaign codes (Module 42) instead of the program default.
- Scheduled rule changes (reuse Module 5's scheduler).

### [M07](modules/M07-country-management.md) Country Management

Localised country names (`name_i18n jsonb`), country-level feature flags, per-country payment gateways.
- Localised names (`name_i18n jsonb`) for Hindi and regional-language apps.
- Public read endpoints can move behind a CDN with 10-minute caching because master data changes rarely.

### [M08](modules/M08-state-management.md) State Management

GST state codes for invoicing; district level between state and city if rural expansion needs it.
- Localised names (`name_i18n jsonb`) for Hindi and regional-language apps.
- Public read endpoints can move behind a CDN with 10-minute caching because master data changes rarely.

### [M09](modules/M09-city-management.md) City Management

City boundaries as GeoJSON polygons (PostGIS) for precise "near me" search; per-city pricing and featured-slot counts.
- Localised names (`name_i18n jsonb`) for Hindi and regional-language apps.
- Public read endpoints can move behind a CDN with 10-minute caching because master data changes rarely.

### [M10](modules/M10-area-management.md) Area Management

Geocode missing coordinates automatically (Google Geocoding) in a background job; PostGIS points for radius search.
- Localised names (`name_i18n jsonb`) for Hindi and regional-language apps.
- Public read endpoints can move behind a CDN with 10-minute caching because master data changes rarely.

### [M11](modules/M11-class-management.md) Class Management

Country-specific grade systems (Year 1–13 for UK curricula) via a `curriculum` column.
- Localised names (`name_i18n jsonb`) for Hindi and regional-language apps.
- Public read endpoints can move behind a CDN with 10-minute caching because master data changes rarely.

### [M12](modules/M12-subject-management.md) Subject Management

Syllabus topics under subjects (chapter-level matching); multilingual names; automatic trending from search logs.
- Localised names (`name_i18n jsonb`) for Hindi and regional-language apps.
- Public read endpoints can move behind a CDN with 10-minute caching because master data changes rarely.

### [M13](modules/M13-board-management.md) Board Management

Board-specific class systems and exam calendars (feeds content such as "Board exam timetable").
- Localised names (`name_i18n jsonb`) for Hindi and regional-language apps.
- Public read endpoints can move behind a CDN with 10-minute caching because master data changes rarely.

### [M14](modules/M14-teaching-mode-management.md) Teaching Mode Management

Mode-specific fields (e.g., max travel distance for home tuition, platform for online).
- Localised names (`name_i18n jsonb`) for Hindi and regional-language apps.
- Public read endpoints can move behind a CDN with 10-minute caching because master data changes rarely.

### [M15](modules/M15-teacher-category-management.md) Teacher Category Management

Allow teachers multiple categories (junction table) if single-category proves limiting.
- Localised names (`name_i18n jsonb`) for Hindi and regional-language apps.
- Public read endpoints can move behind a CDN with 10-minute caching because master data changes rarely.

### [M16](modules/M16-teacher-registration-queue.md) Teacher Registration Queue

- DigiLocker / UIDAI offline e-KYC and NSDL PAN verification APIs to replace manual checks for identity documents.
- University registry integrations (NAD / DigiLocker academic records) for certificates.
- Round-robin auto-assignment and reviewer workload balancing.
- Two-reviewer rule for high-risk cases (failed checks).
- Queue partitioning by city/language when reviewers specialise.

### [M17](modules/M17-teacher-profile-management.md) Teacher Profile Management

- Move teacher search to OpenSearch/Meilisearch with a change-data-capture feed once the directory passes ~200k teachers.
- Bulk edit (category, featured) with background jobs and per-row results.
- Teacher-level notes and tags for operations (e.g., "Launch ambassador").

### [M18](modules/M18-teacher-subject-mapping.md) Teacher Subject Mapping

- Per-subject fees and levels (beginner/advanced).
- Topic-level expertise under subjects when Module 12 adds syllabus topics.

### [M19](modules/M19-teacher-class-mapping.md) Teacher Class Mapping

Per-class fees and batch sizes; board-specific experience.

### [M20](modules/M20-teacher-location-mapping.md) Teacher Location Mapping

PostGIS for true distance search and polygons; availability per location (weekday/time) when scheduling moves on-platform.

### [M21](modules/M21-teacher-analytics.md) Teacher Analytics

- Stream events through Kafka/Kinesis into a columnar store (ClickHouse/BigQuery) when views exceed tens of millions per month; keep `teacher_daily_stats` as the serving table.
- Same analytics for teachers inside the teacher app (read from the same roll-up).

### [M22](modules/M22-institute-registration-queue.md) Institute Registration Queue

- GST and MCA (company) API verification; Google Places match for address and photos.
- Branch support: `parent_institute_id` for chains with many centres.

### [M23](modules/M23-institute-verification.md) Institute Verification

Field-agent mobile app for visits with geotagged photos and offline checklists; third-party inspection partners in new cities.

### [M24](modules/M24-institute-profile-management.md) Institute Profile Management

Branches/chains, timetable per batch, batch enrolment through the app, SEO landing pages per institute.

### [M25](modules/M25-institute-manager-accounts.md) Institute Manager Accounts

Granular per-staff permissions (custom institute roles) and staff activity logs visible to the manager.

### [M26](modules/M26-institute-teacher-management.md) Institute Teacher Management

Teacher-accepted linking with shared reviews; per-batch teacher assignment; faculty change history on the public profile.

### [M27](modules/M27-institute-rating-system.md) Institute Rating System

Evaluation templates per institute type (music school vs coaching centre); photo evidence per sub-criterion; external auditor accounts; publishing rating methodology publicly.

### [M28](modules/M28-parent-management.md) Parent Management

Segment builder saved as named audiences for notifications (M46); CRM-style notes and tags on parents; data-export (DSAR) automation.

### [M29](modules/M29-parent-children-management.md) Parent Children Management

Learning-to-rank recommendations using lead/demo outcomes; content recommendations (blogs by `class_ids`, Module 45) per child; school-level cohorts.

### [M30](modules/M30-parent-subscription-management.md) Parent Subscription Management

Family plans covering multiple children; pause subscription; win-back offers for churned parents.

### [M31](modules/M31-student-management.md) Student Management

School/college master table with verified institutions; student progress tracking with teachers.

### [M32](modules/M32-student-subscription-management.md) Student Subscription Management

Exam-season plans (e.g., 90-day JEE crash plan) as additional fee codes; institutional (school) bulk licences.

### [M33](modules/M33-teacher-reviews.md) Teacher Reviews

Review photos; aspect ratings for teachers (clarity, punctuality); helpful votes; translation of reviews.

### [M34](modules/M34-institute-reviews.md) Institute Reviews

Batch-level reviews; alumni verification (results) badges.

### [M35](modules/M35-review-moderation.md) Review Moderation

ML spam classifier trained on moderation decisions; moderator workload routing; transparency report of moderation stats.

### [M36](modules/M36-teacher-trust-score.md) Teacher Trust Score

Additional factors (response rate, activity, experience) as the brief's longer list — add keys to the weights JSON and columns via migration; per-category weights; ML-based anomaly detection.

### [M37](modules/M37-trust-score-history.md) Trust Score History

Partition logs by year; expose history to teachers in their app ("Why did my score change?").

### [M38](modules/M38-lead-management.md) Lead Management

Partition `leads` by month once > 20M rows; lead scoring (likelihood to convert); in-app chat between requester and teacher (would add a `lead_messages` table); auto re-routing of unanswered institute leads.

### [M39](modules/M39-demo-class-requests.md) Demo Class Requests

Teacher availability calendars with bookable slots; in-app video classes; paid trial classes (new fee code); Google/Outlook calendar sync.

### [M40](modules/M40-transactions.md) Transactions

Wallet balances for referral credits (`wallets`, `wallet_entries` double-entry ledger); multiple gateways (PhonePe/Cashfree) behind a `PaymentGateway` interface; partitioning `transactions` by financial year; automated settlement ingestion via Razorpay Settlements API; GST e-invoicing (IRN) when turnover requires it.

### [M41](modules/M41-subscription-payments.md) Subscription Payments

Family plans (one parent membership covering several children is already implied; multi-guardian sharing later); coupons and promo codes; plan upgrades with pro-rated credit; move history to a `subscription_events` table if analytics needs more than the audit log.

### [M42](modules/M42-referral-management.md) Referral Management

Tiered rewards (more after 5 referrals); cash payouts to bank via RazorpayX (KYC needed); device fingerprint service; share-link attribution with deep links.

### [M43](modules/M43-complaint-management.md) Complaint Management

Two-way messaging thread with parties inside the case; auto-detection of off-platform payment requests in chat; integration with police cyber-cell reporting; case templates per type; weekly transparency report (required under IT Rules for significant intermediaries).

### [M44](modules/M44-banner-management.md) Banner Management

A/B variants per banner; per-child-class targeting using `parent_children`; frequency capping; banner impressions table for per-day charts.

### [M45](modules/M45-blog-management.md) Blog Management

Revisions table for full history; multilingual posts (Hindi, Kannada, Tamil) with `locale`; authors directory; related posts; comments.

### [M46](modules/M46-notification-management.md) Notification Management

SMS and WhatsApp (Business API) channels with template approval; per-user send-time optimisation; campaign A/B tests; event-triggered journeys (e.g. trial ending).

### [M47](modules/M47-dashboard-analytics.md) Dashboard Analytics

Move analytics to a read replica, then to a columnar store (ClickHouse/BigQuery) fed by CDC; cohort retention charts; configurable dashboards per role; alerting on KPI drops.

### [M48](modules/M48-revenue-reports.md) Revenue Reports

Scheduled email reports (monthly finance pack); Tally/Zoho Books export format; read replica and materialised views; revenue forecasting from renewals due.

### [M49](modules/M49-teacher-reports.md) Teacher Reports

Recruitment targets per city; teacher cohort retention; NPS by teacher; automatic coaching nudges for low responders.

### [M50](modules/M50-institute-reports.md) Institute Reports

Institute-facing analytics in the institute app; benchmarking against similar institutes; seat-fill tracking once batches support enrolment.

## Platform-wide

- Read replica for reports and dashboard; later a columnar analytics store fed by CDC.
- Partition high-volume tables by month: `audit_logs`, `notification_recipients`, `teacher_profile_views`, `leads`, `transactions` (by financial year).
- SSO for admins (Google Workspace) and hardware-key MFA for Super Admin.
- Multilingual content (Hindi and regional languages) for CMS and notifications.
- Public status of verification and ratings as structured data for SEO.
