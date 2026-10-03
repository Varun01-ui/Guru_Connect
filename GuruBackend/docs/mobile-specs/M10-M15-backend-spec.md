# Backend specification: mobile app modules M10 to M15

This document is self-contained. It contains the exact specification text (copied verbatim from the product spec) and the exact PostgreSQL table definitions for these modules. Implement exactly what is written here. If something is not specified in this document, do not invent it: list it as a question instead.

Modules in scope: **M10** Parent Subscription, **M11** Student Registration, **M12** Student Dashboard, **M13** Student Subscription, **M14** Teacher Registration, **M15** Teacher Document Upload. Supporting parts they depend on are included: the uploads endpoints from **M00**, and the payments endpoints from **M43** (used by M10, M13 and M15).

## 0. Context you need before starting

**Already built and running** (do not rebuild): an Express + TypeScript + Kysely + Zod + PostgreSQL backend, with the mobile API mounted at `/api/v1/app` and modules under `src/modules/app/` (`auth`, `bootstrap`, `platform`, `registration`). It already provides `GET /bootstrap`, `GET /me`, `PUT/DELETE /devices/me`, `GET /masters`, `GET /masters/areas`, all `/auth/*` endpoints, and `GET /registration/context`, `POST /registration/referral/validate`, `POST /registration/parent`. Use `POST /registration/parent` as the reference pattern for `POST /registration/student` and `POST /registration/teacher` (registration-token auth, one DB transaction, then a session is issued). Reuse the existing `ApiError` helpers, the `authenticateApp` and `authenticateRegistration` middlewares, and the existing response envelope.

**Database:** the tables below already exist in `schema.sql`. The mobile-only tables (for example `teacher_qualifications`, `user_consents`, `otp_challenges`) come from `mobile_only.sql`. Verify with a query that they are present in the running database before relying on them.

**Provider stubs:** there is no SMS, Razorpay, Cloudflare R2 or Firebase account yet. Put each behind a small interface with a development implementation (SMS: print the OTP to the server log; storage: local disk; payments: a fake gateway). Do not block a module on real credentials.

**Order to build:** M11 and M12 first (no payments), then M14, then the uploads and M15, then M43's payment endpoints and M10/M13 last. Tell the app team as each group is ready.

**Notes on the specification text below:**
- Sections marked "Push Notification Requirements" describe notifications the server should create. Push delivery itself (Firebase) is out of scope for now; still write the in-app notification rows if the spec says to, and skip the push send.
- Text refers to other modules (for example M37, M30, M46). Only the modules listed above are in scope. Where a rule depends on an out-of-scope module, implement the part inside these modules and leave a clearly marked hook.
- Redis is referenced in places. There is no Redis in this environment yet: use an in-process fallback with the same keys and TTLs, behind an interface.


---

# Part A. API conventions (from 00-conventions.md)

## 5. API conventions for the app

- **Base URL** `https://api.guruconnect.in/api/v1/app`. All paths in module files are relative to it.
- **Headers sent by every request:** `Authorization: Bearer <access>` (when signed in), `X-Install-Id` (uuid from secure store), `X-App-Version` (semver), `X-App-Build`, `X-Platform` (`android`/`ios`), `Accept-Language` (`en-IN`), `X-Request-Id` (uuid per request, echoed back). `Idempotency-Key` (uuid) on create actions marked in module files.
- **Envelope** (same as admin): success `{ "data": …, "meta": {…} }`; error `{ "error": { "code", "message", "details", "requestId" } }`. `message` is safe to show to users; the app maps known codes to its own translated copy.
- **IDs** are UUIDs. Human codes (`GC-T10241`, `LD-100231`) are for display and support only.
- **Money** in paise (integer). The app formats with `formatINR(paise)` → `₹1,999`.
- **Time:** API sends ISO 8601 UTC; the app displays Asia/Kolkata. Dates without time (`2026-09-29`) are IST calendar dates.
- **Pagination:** feeds and lists use **cursor pagination**: `?limit=20&cursor=<opaque>` → `meta.nextCursor` (null at the end). Search results use `?page=` only where totals matter (section 17 of each module says which).
- **Version gate:** every response carries `X-Min-App-Version`. If the app is below it, the API returns `426 APP_UPDATE_REQUIRED` for all calls except `/bootstrap`; the app routes to the Force Update screen.
- **Maintenance:** when `app.maintenance_mode` is true, all calls except `/bootstrap` return `503 MAINTENANCE`.
- **Rate limits:** default 120 requests/minute per user and 300/minute per IP; tighter limits are listed per endpoint.

### Standard error codes (app)

| Code | HTTP | Meaning | App behaviour |
| --- | --- | --- | --- |
| `AUTH_REQUIRED` | 401 | No/invalid token | Go to Login, keep intended deep link |
| `AUTH_TOKEN_EXPIRED` | 401 | Access token expired | Refresh once, retry the request |
| `AUTH_REFRESH_INVALID` | 401 | Refresh token revoked/expired/reused | Clear session, go to Login with message "Please sign in again." |
| `ACCOUNT_SUSPENDED` | 403 | `account_status` suspended/banned | Blocking screen with support contact and reason |
| `FORBIDDEN` | 403 | Wrong role or not the owner | Toast "You can't do that." |
| `ROLE_MISMATCH` | 409 | Signing in with a role different from the account's | Explain and offer to continue as the existing role |
| `REGISTRATION_REQUIRED` | 409 | Verified phone/email has no account yet | Route to registration with `registrationToken` |
| `OTP_INVALID` / `OTP_EXPIRED` / `OTP_LOCKED` | 422 / 410 / 429 | OTP checks | Inline error under the code field |
| `VALIDATION_FAILED` | 422 | Zod failed; `details[]` = `{ path, message }` | Map to form fields |
| `NOT_FOUND` | 404 | Missing or soft-deleted | "This is no longer available." with back button |
| `CONFLICT_STATE` | 409 | Action not allowed in current status | Show message, refetch |
| `CONFLICT_DUPLICATE` | 409 | Unique rule | Inline message |
| `VERSION_CONFLICT` | 409 | `If-Match` mismatch on profile edits | "Updated on another device. Review and save again." |
| `SUBSCRIPTION_REQUIRED` | 402 | Feature needs an active plan | Open plans sheet (M10/M13) |
| `LIMIT_REACHED` | 429 | Business limit (leads/day, children) | Show limit copy from `details.limit` |
| `BLOCKED` | 403 | One side blocked the other | "You can't contact this user." |
| `RATE_LIMITED` | 429 | Too many requests; `Retry-After` | Disable button until retry time |
| `APP_UPDATE_REQUIRED` | 426 | Below minimum version | Force Update screen |
| `MAINTENANCE` | 503 | Maintenance mode | Maintenance screen |
| `PAYMENT_FAILED` | 402 | Gateway declined / signature mismatch | Payment result screen with retry |
| `GATEWAY_ERROR` | 502 | SMS, R2, FCM or Razorpay down | Retry button; never lose form input |
| `FILE_TOO_LARGE` / `FILE_TYPE_NOT_ALLOWED` | 413 / 415 | Upload rules | Inline under the picker |
| `INTERNAL_ERROR` | 500 | Anything else | Generic error state with request id (long-press to copy) |

## 6. Authentication and sessions

- **Access token:** JWT RS256, 15 minutes, audience `gc-app`. Claims: `sub` (app_users.id), `role` (`parent|student|teacher|institute_staff`), `pid` (id in the role table: parents.id, students.id, teachers.id or institute_managers.id), `iid` (institute id for staff), `sid` (app_sessions.id). Kept **in memory only**.
- **Refresh token:** 256-bit random, 30-day sliding / 60-day absolute, stored in `expo-secure-store` (Keychain / Android Keystore). Stored server-side as SHA-256 in `app_sessions`. **Rotates on every refresh**; presenting an old token revokes the whole `token_family` (theft detection).
- **Registration token:** after a new phone/email is verified, the API returns a 30-minute JWT (`aud gc-register`, `sub` = verified contact, `role`) that is the only credential accepted by the registration endpoints. The account (`app_users` + role row) is created only when registration is submitted, so there are no half-created accounts.
- **Refresh flow in the app:** `lib/api.ts` catches `AUTH_TOKEN_EXPIRED`, runs one shared refresh promise, retries queued requests; on `AUTH_REFRESH_INVALID` it signs out.
- **Server middleware order:** `requestId → versionGate → maintenanceGate → rateLimit → authenticateApp → loadAccount (status check, cached 60 s in Redis) → requireRole(...) → validate(zod) → handler`.
- **Ownership:** every handler scopes queries by the token (`WHERE parent_id = :pid`), never by ids sent in the body.

## 10. File uploads (Cloudflare R2)

1. App picks a file; images are resized to max 2000 px long edge, JPEG quality 0.8, EXIF GPS stripped; PDFs ≤ 10 MB.
2. `POST /uploads/presign { purpose, mimeType, sizeBytes, fileName }` → `{ fileId, uploadUrl, headers, expiresAt }` (URL valid 10 min; R2 S3-compatible presigned PUT with `Content-Type` and `Content-Length` fixed).
3. App `PUT`s the bytes directly to R2 with progress.
4. `POST /uploads/:fileId/confirm` → API checks object size/type via `HEAD`, marks `files.status = 'active'`.
5. The module's own endpoint links the `fileId` (e.g. `POST /teacher/documents { fileId, docType }`).

| Purpose | Bucket | Allowed | Max |
| --- | --- | --- | --- |
| `avatar`, `teacher_photo`, `institute_logo`, `institute_cover`, `institute_gallery` | `gc-public` (served via `cdn.guruconnect.in`) | jpeg, png, webp | 5 MB |
| `teacher_document`, `institute_document` | `gc-private` | jpeg, png, pdf | 10 MB |
| `complaint_evidence`, `support_attachment` | `gc-private` | jpeg, png, pdf | 10 MB |

Private files are read through `GET /files/:id/url` (owner only, 60-second presigned GET). Identity documents are never shown back in full after upload: the app shows a thumbnail with the masked number.

## 11. Audit logs

App actions that change important data write `audit_logs` rows in the **same transaction**, with `actor_type = 'app_user'`, `actor_id = sub`, `module = 'app.<feature>'`, IP, user agent (`GuruConnect/1.2.0 (Android 14; SM-A546E)`) and request id. Logged: sign-in/out, session revocation, contact changes, registration, profile and fee changes, document uploads, children changes, reviews and replies, leads and demo actions, payments started, reports and blocks, privacy/consent changes, account deletion. Reads and searches are **not** audit-logged (they go to analytics). Sensitive values (OTP, tokens, document numbers, passwords) are never written to audit logs. Each module lists its events in section 20.

## 12. Data conventions

- UUID primary keys everywhere (`gen_random_uuid()`); join tables use composite keys.
- **Soft delete**: user-facing deletes set `deleted_at`; queries filter `deleted_at IS NULL`; unique indexes are partial on live rows. Hard deletes only in the account-erasure job (M54) and for expired OTPs/sessions (cleanup jobs).
- `updated_at` (trigger) is the version for optimistic locking: edits send `If-Match: <updatedAt>`.
- Children are minors: first name only, class, board, subjects, school name optional — no photo, no date of birth.

## 13. Security baseline

- TLS only; HSTS on the API. Certificate pinning for `api.guruconnect.in` is planned after launch (section 21 of M00).
- Tokens only in secure store/memory. Encrypted MMKV for cached personal data. No PII in logs, Sentry breadcrumbs or analytics (scrub phone, email, names).
- `FLAG_SECURE` (Android) and a privacy overlay on iOS app switcher for document upload/view, payment and OTP screens.
- Root/jailbreak detection is informational only (sent as a header, used in fraud scoring) — the app still works.
- Server: Zod validation on every input, parameterised SQL (Kysely), per-endpoint rate limits, ownership checks, output DTOs that never include other users' phone/email unless the contact is unlocked.
- Contact info in free text (bios, messages, reviews) is detected and masked until contact is unlocked, to keep payments on-platform and users safe.
- DPDP Act 2023: consent captured and stored (`user_consents`), purpose-limited analytics, user can download and delete data (M52, M54); users under 18 need verifiable parental consent (M11).

---

# Part B. Module specifications

Each module below is copied in full for the sections a backend needs (purpose, business rules, validation, endpoints, request and response payloads, tables, notifications, security, error handling, test scenarios, audit events). Screens and UI sections are omitted because they are mobile-only.


---

## Module 11 · Student Registration [M11]

## 1. Module Purpose

Turns a verified phone/email (a `Registration token`) into a student account: name, class, board, school, subjects of interest, and city/area. Because many students are minors, this module implements the DPDP Act 2023 requirement for **verifiable parental consent**: a student whose class falls below the platform's no-consent threshold cannot contact a teacher until a parent confirms an OTP sent to the parent's own phone. It also lets the student name an existing parent's phone to be linked to that parent's account (confirmed by support, per Admin M31), without requiring a parent-side app action in v1.

## 3. Business Rules & Logic

**BR-11.1 Entry.** Reached from Login (M04) after a new phone/email is verified (`REGISTRATION_REQUIRED`) with role intent `student`, or from Role Select (M03). `GET /registration/context` (M05) supplies masters needed by the form (classes, boards) and whether a referral code was pre-filled from a deep link.

**BR-11.2 Fields.** Name (full name, own), Class (required), Board (optional — state boards filtered to the student's chosen state via city, else "Other"), School/college name (optional), Subjects of interest (0–6, multi-select — see BR-11.8 for how these are used), City (required), Area (optional, dependent on city), and, only if the class requires it (BR-11.3), a parent's name and phone.

**BR-11.3 Minor determination (DPDP proxy).** The app does not collect a student's date of birth (data-minimisation, conventions §12). "Under 18" is operationalised the same way as Admin M31 FR‑31.6: `requiresConsent = classes.level_order(classId) < classes.level_order('Class 9')` (i.e. below secondary school). `system_settings['students.min_age_without_consent']` (default 18) is the number shown in the app's help text and Terms; the class threshold is the mechanism that implements it without collecting an age. When `requiresConsent`, the parent's name and phone become required fields and the form shows an inline notice: "Since {name} is in {class}, a parent needs to approve by SMS after this step."

**BR-11.4 Submit (`POST /registration/student`, registration token, idempotent by token — a token can only be redeemed once).** In one transaction:
1. Create `app_users` (`user_type = 'student'`, contact from the token, `account_status = 'active'`, `signup_source` per conventions BR‑0.13).
2. Create `students` (`public_code` auto `GC-S…`, `full_name`, `class_id`, `board_id`, `school_name`, `city_id`, `area_id`, `parent_name`, `parent_phone`, `parental_consent = requiresConsent ? 'pending' : 'not_required'`, `referral_code_used`).
3. Insert `user_consents`: `terms` and `privacy_policy` (`method = 'checkbox'`, `document_version` from `GET /registration/context`), and `marketing` if the optional box was ticked. **Not** yet `data_processing_minor`/`parental_consent` — those are only written once a parent actually confirms (BR-11.7), never at submission.
4. If `parentPhone` exactly matches the `phone` of a live (`deleted_at IS NULL`), active `parents` row, set `students.parent_id` and `parent_link_status = 'pending'` (Admin M31 confirms this manually when the parent calls in, per its FR‑31.4 story — there is no self-serve parent-side confirmation screen in v1; see BR‑11.9).
5. If `requiresConsent`, create the first `otp_challenges` row (BR-11.6) and send the SMS.
6. Issue the app's normal session (access + refresh token, `app_sessions` row) — the student is signed in immediately regardless of consent status; consent only gates contacting teachers (BR-11.7).
7. Write `audit_logs` (`module = 'app.student_registration'`, `actor_type = 'app_user'`).
A second submit with the same (already-consumed) registration token → `AUTH_REQUIRED` (token already used); the client should not retry automatically.

**BR-11.5 Subjects are a cold-start signal, not a stored profile (schema request).** The schema has no `student_subjects` table (only `parent_child_subjects` exists, for children). The 0–6 `subjectIds` chosen here are cached in Redis `student:coldstart:<userId>` for 30 days and read once by Module 12's dashboard to bias its v0 ranking before real signals (favourites, search history, leads) accumulate; they are **not** persisted to Postgres and cannot be edited later in v1. A durable `student_subjects` junction table (mirroring `parent_child_subjects`) is the natural follow-up — see Schema requests in the module summary.

**BR-11.6 Parental consent OTP (`otp_challenges`, `purpose = 'parent_consent'`).** `channel = 'sms'`, `destination = students.parent_phone`, 6-digit code (`auth.otp_length`), hashed (`code_hash`), `expires_at = now() + 24h` (longer than login OTP since the parent may not check their phone right away), `resend_count`, `attempts`. SMS text: "{studentName} added you as their parent on GuruConnect. Enter {code} in their app to approve, or ignore to do nothing. Code valid 24 hours." The code is meant to be read by the parent and typed into the **student's own device** (no separate parent app flow in v1) — the OTP being sent to a distinct phone number the parent controls is what makes the consent "verifiable" against a self-declared checkbox.

**BR-11.7 Consent request/verify.**
- `POST /student/parent-consent/request` (Student, no body) resends the code to `students.parent_phone` if `parental_consent = 'pending'`; cooldown `auth.otp_resend_after_seconds` (30 s), max `auth.otp_max_per_hour` (5) per student. `CONFLICT_STATE` if `parental_consent` is already `confirmed`/`not_required`.
- `POST /student/parent-consent/verify { code }` (Student) checks the latest non-consumed, non-expired `otp_challenges` row for this student: on match, in one transaction, set `students.parental_consent = 'confirmed'`, `parental_consent_at = now()`, consume the challenge (`consumed_at`), and insert **two** `user_consents` rows: `parental_consent` and `data_processing_minor` (both `granted = true`, `method = 'otp'`, `guardian_phone = students.parent_phone`, `document_version` = the current privacy policy version). 5 wrong codes → `OTP_LOCKED` for 15 minutes (conventions §5); expired → `OTP_EXPIRED` with a Resend action.
- There is no in-app "decline" action: a parent who objects contacts support, who sets `parental_consent = 'declined'` (Admin M31), which the app shows as a blocking screen (BR-11.8).

**BR-11.8 What pending/declined consent blocks.** While `parental_consent = 'pending'`, the student can sign in, browse, search and save favourites, but every contact/demo action (Module 37, 38) returns `FORBIDDEN` with `details.reason = "parental_consent_pending"`; the app shows a persistent banner on Home ("Ask your parent to approve — Resend code") instead of hiding the whole app, so the student isn't locked out of exploring. `declined` blocks the same actions and additionally shows a full "Contact support" screen with no dismiss, since continuing to use the platform against a parent's stated objection isn't appropriate for a minor account.

**BR-11.9 Parent account linking is admin-mediated in v1.** Setting `parent_link_status = 'pending'` at BR‑11.4 step 4 does not notify the parent's app (no confirm/decline endpoint exists for this in the current module map) — it is a hint for support, matching Admin M31's own story ("Support Admin … link a student to their parent's account when the parent asks"). The registration screen tells the student: "If {parentName} already has a GuruConnect account, they can confirm the link by calling support." This is independent of parental consent (BR-11.3–11.7): a Class 12 student with no consent requirement can still optionally link a parent's account for visibility into their demo bookings.

**BR-11.10 Draft persistence.** The multi-field form is a Zustand + encrypted MMKV draft (`studentRegistrationDraft`), restored on relaunch until submitted or the registration token expires (30 minutes) — after expiry the draft is kept but the student is routed back through phone verification (M04) before resubmitting.

## 8. Validation Rules

| Field | Rule | Message shown |
| --- | --- | --- |
| fullName | 2–100 chars, letters/spaces/dot | "Enter your full name." |
| classId | active class | "Choose your class." |
| boardId | optional, active board | — |
| schoolName | optional, ≤ 120 chars | — |
| subjectIds | 0–6, active subjects | "Pick up to 6 subjects." |
| cityId | active city | "Choose a city." |
| areaId | optional; must belong to cityId | — |
| parentName | 2–100; required when `requiresConsent` | "Enter your parent's name." |
| parentPhone | E.164; required when `requiresConsent`, optional otherwise; not equal to the student's own verified phone | "Enter a valid phone number." / "This can't be your own number." |
| code (verify) | 6 digits | "Enter the 6-digit code." |

## 9. API Endpoints

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| POST | /registration/student | Registration token | Create the student account (Idempotency-Key = the registration token's `jti`) |
| POST | /student/parent-consent/request | Student | Resend the parental consent OTP |
| POST | /student/parent-consent/verify | Student | Verify the parent's OTP and confirm consent |

## 10. Request Payloads

```json
// POST /registration/student
{ "fullName": "Aarav Kumar", "classId": "c1a2s3s4-0008-4a1b-9c2d-3e4f5a6b7c8d", "boardId": "b0a1r2d3-0001-4a1b-9c2d-3e4f5a6b7c8d",
  "schoolName": "National Public School, Koramangala", "subjectIds": ["s1u2b3j4-0001", "s1u2b3j4-0002"],
  "cityId": "c1t2y3-0001-4a1b-9c2d-3e4f5a6b7c8d", "areaId": "a1r2e3a4-0007-4a1b-9c2d-3e4f5a6b7c8d",
  "parentName": "Lakshmi Venkatesh", "parentPhone": "+919845012345",
  "consents": { "terms": true, "privacyPolicy": true, "marketing": false }, "referralCode": null }

// POST /student/parent-consent/request

// POST /student/parent-consent/verify
{ "code": "482913" }
```

## 11. Response Payloads

```json
// 201 POST /registration/student
{ "data": { "userId": "…", "role": "student", "studentId": "…", "publicCode": "GC-S50141", "accessToken": "eyJ…", "refreshToken": "5f3a…",
  "parentalConsent": "pending", "parentPhoneMasked": "+91 98450 XXXXX", "nextStep": "parent_consent" } }

// 201 POST /registration/student   (Class 11, no consent needed)
{ "data": { "userId": "…", "role": "student", "studentId": "…", "publicCode": "GC-S50142", "accessToken": "…", "refreshToken": "…",
  "parentalConsent": "not_required", "parentPhoneMasked": null, "nextStep": null } }

// 200 POST /student/parent-consent/verify
{ "data": { "parentalConsent": "confirmed", "parentalConsentAt": "2026-09-26T11:20:00Z" } }

// 422 POST /student/parent-consent/verify   (wrong code)
{ "error": { "code": "OTP_INVALID", "message": "That code isn't right. 3 attempts left.", "details": { "attemptsLeft": 3 }, "requestId": "…" } }

// 403 POST /leads   (blocked while pending, shown by Module 37)
{ "error": { "code": "FORBIDDEN", "message": "Ask your parent to approve before contacting a teacher.", "details": { "reason": "parental_consent_pending" }, "requestId": "…" } }
```

## 12. PostgreSQL Tables & Columns


**Existing tables this module reads or writes** (full definitions in the owning module)

| Table | Owner | Purpose |
| --- | --- | --- |
| `students` | Admin M31 | Student profile, one per student app account. |
| `app_users` | Admin M00 | Login identity for every mobile app account (parent, student, teacher, institute staff). Role profiles hang off this table. |
| `user_consents` | App M52 | Record of every consent given or withdrawn (terms, privacy policy, parental consent, marketing), as required by the DPDP Act 2023. |
| `otp_challenges` | App M04 | One-time codes sent by SMS or email for login, sign-up, contact changes and account deletion. |
| `classes` | Admin M11 | Grades and levels learners study at, from Class 1 to competitive exam preparation. |

- `students`: this module inserts the row and later updates only `parental_consent`, `parental_consent_at`, `parent_id`, `parent_link_status` (BR-11.4/11.7); every other admin-editable field (suspend, delete) is Admin M31's.
- `app_users`: inserted at registration; `preferred_language`, `signup_source` set per conventions BR-0.13.
- `user_consents`: `terms`/`privacy_policy`/`marketing` at submission; `parental_consent`/`data_processing_minor` only on verified consent (BR-11.7) — never written speculatively.
- `otp_challenges`: `purpose = 'parent_consent'` rows created/consumed by BR-11.6/11.7; login OTP (`purpose = 'signup'`) belongs to Module 4 and is already spent by the time this module runs.
- `classes`: read-only, for the level-order threshold (BR-11.3) and board filtering.

## 16. Push Notification Requirements

| Event | Recipient | Title / Body | Deep link | Category | Urgent |
| --- | --- | --- | --- | --- | --- |
| `student.parental_consent_confirmed` | Student | "Your parent approved!" / "You can now contact teachers and book demos." | `gc://home` | account | no |
| `student.parental_consent_declined` | Student | "Account on hold" / "Your parent asked us to hold your account. Contact support for help." | `gc://support` | account | yes |
The OTP itself is SMS, not a push (the parent has no app session). In-app only: the pending banner on Home is derived from `/me`, not a stored notification.

## 17. Security Rules

- The registration token (`aud gc-register`) is the only credential `POST /registration/student` accepts; it is single-use and scoped to the verified contact, so no account can be created for a phone/email the student doesn't control.
- `parentPhone` is validated to differ from the student's own verified phone (prevents a student self-approving by entering their own number).
- OTP codes are hashed (`code_hash`), rate-limited (BR-11.6/11.7), and never logged or sent to Sentry/analytics.
- `students.parent_phone`/`parent_name` are visible to the student who entered them and to admins with `students.read`; they are never shown to other app users.
- Consent-gated actions check `students.parental_consent` server-side on every attempt (Module 37/38), never trusting a cached client flag.

## 18. Error Handling

| Scenario | Code | HTTP | App behaviour |
| --- | --- | --- | --- |
| Registration token already used | `AUTH_REQUIRED` | 401 | Route back to Login; "Please verify your number again." |
| Class requires consent but no parent phone given | `VALIDATION_FAILED` | 422 | Inline on `parentPhone`, form won't submit |
| Parent phone equals the student's own number | `VALIDATION_FAILED` | 422 | "This can't be your own number." |
| Consent OTP expired (> 24 h) | `OTP_EXPIRED` | 410 | "That code expired." + Resend |
| Consent OTP wrong 5 times | `OTP_LOCKED` | 429 | "Too many attempts. Try again in 15 minutes." |
| Resend before cooldown | `RATE_LIMITED` | 429 | Countdown shown on the button |
| Verify when already confirmed | `CONFLICT_STATE` | 409 | Toast + route to Home |
| Contact action while pending/declined | `FORBIDDEN` (`parental_consent_pending`/`_declined`) | 403 | Banner (pending) or blocking screen (declined) from Module 37/38 |

## 19. Testing Scenarios

- T11.1 (Maestro `student_registration_minor`) Class 8 student registers with a parent phone → account created, signed in, `ParentConsentPending` shown; parent's number receives the SMS (test-mode provider); entering the correct code on `ParentConsentOtp` confirms consent and clears the Home banner.
- T11.2 (Maestro `student_registration_adult`) Class 12 student registers with no parent phone → straight to Home, `parentalConsent: "not_required"`, no banner.
- T11.3 Attempt `POST /leads` while `parental_consent = 'pending'` → 403 `parental_consent_pending`; banner deep-links to `ParentConsentPending`.
- T11.4 Wrong code 5 times → `OTP_LOCKED` for 15 minutes; correct code after the lock clears succeeds.
- T11.5 Resend twice within 30 s → second call `RATE_LIMITED`; after 30 s it succeeds and invalidates the previous code.
- T11.6 Registration with a `parentPhone` matching an existing parent account → `students.parent_id` set, `parent_link_status = 'pending'`; Admin M31's student detail shows "Link pending" for support to confirm.
- T11.7 Kill the app mid-form after entering class and subjects → relaunch → `StudentRegistrationForm` restores the draft.
- T11.8 Registration token expires (31 minutes) before submit → submit fails `AUTH_REQUIRED`; draft is kept, student re-verifies phone and resumes on the same form.
- T11.9 "Skip for now" from `ParentConsentPending` → Home opens with the persistent banner; tapping the banner returns to `ParentConsentPending` (not the OTP screen directly, since the code may have expired).
- T11.10 Offline on `StudentRegistrationForm` → Continue disabled with an offline hint; back online → enabled, submits normally.
- T11.11 `subjectIds` chosen at registration influence Module 12's first Recommended Teachers rail before any search has happened; after 30 days (or first real search), the cold-start hint is ignored even if the Redis key hasn't expired exactly on schedule.

## 20. Audit Log Events

| Event | When | Details |
| --- | --- | --- |
| `app.student_registered` | Account created | class, board, city, consent required: yes/no |
| `app.parental_consent_requested` | OTP sent/resent | resend count |
| `app.parental_consent_confirmed` | Verify succeeds | — (no OTP value logged) |

---

## Module 12 · Student Dashboard [M12]

## 1. Module Purpose

The student's home screen: banners plus four ranked rails — Recommended Teachers, Recommended Institutes, Nearby Teachers, Top Rated Teachers and Verified Teachers, mirroring Module 8's shape but for a single learner rather than a family of children. There is no child switcher; "Recommended" is scoped to the student themself, seeded at first run by Module 11's cold-start subject hint and, from then on, by the student's own search and favourite activity. Like Module 8, this ships a v0 rule-based ranking that Module 30 later swaps in behind the same response.

## 3. Business Rules & Logic

**BR-12.1 One call, four rails.** `GET /home/student` returns banners and the first page of four rails (no child switcher, unlike Module 8): `recommended_teachers`, `recommended_institutes`, `nearby_teachers`, `top_rated_teachers`, `verified_teachers` is folded together with top-rated the same way Module 8 keeps them separate — this module keeps all **five** rail codes identical to Module 8's set for a consistent client component (`RailSection` is shared between M08 and M12). `?rail=<code>&cursor=&limit=` pages one rail, exactly as Module 8's BR-8.1.

**BR-12.2 Eligibility.** Same as Module 8 BR-8.2: `verification_status = 'approved'`, `account_status = 'active'`, excluding this student's `recommendation_dismissals` and `user_blocks` in either direction. Parental-consent status (Module 11) does **not** affect what the dashboard shows — only contacting (Module 37/38) is gated — so a pending student still gets full, useful browsing.

**BR-12.3 Recommended Teachers (v0, per student).** Because `students` has no subject/category preference table (unlike `parent_children`), candidates are scored from three signals, each optional and additive so a brand-new student still gets a reasonable list:
```
score = 2 × (class match: teacher has a teacher_classes row for students.class_id, board NULL or equal)
      + 2 × coldStartSubjectMatch      -- 0 or 1, from Module 11's Redis cold-start hint (0 after it expires/clears)
      + 3 × searchAffinitySubjectMatch -- 0..1, share of this student's last 20 `user_search_history` filters.subjectIds that overlap the teacher's subjects (0 with no search history)
      + 1 × favouriteCategoryMatch     -- 1 if the teacher's category appears among this student's `user_favorites` teachers' categories, else 0
      + trust_scores.score / 100
      + 0.5 × (teacher_locations row in the student's area, radius covers it ? 1 : 0)
```
A student with none of the three signals yet (no class set, no cold-start hint, no history, no favourites) falls back to Top Rated + Verified teachers in their city, and the rail header reads "Popular near you" instead of "Recommended for you" until a real signal exists.

**BR-12.4 Recommended Institutes.** Same formula as Module 8 BR-8.4, using the student's own `city_id`/`area_id` instead of a child's.

**BR-12.5 Nearby / Top Rated / Verified.** Identical logic and cache keys to Module 8 BR-8.5–8.7, scoped by `students.city_id`/`area_id` (these caches are shared across parents and students in the same city/area — one `home:nearby:<cityId>:<areaId>` entry serves both modules).

**BR-12.6 Banners.** Same mechanism as Module 8 BR-8.8 (reuses Module 44's `BannerService.getForPlacement`), with `audience IN ('all','students')`.

**BR-12.7 Cache keys and freshness.** `home:rec:teacher:student:<studentId>` / `home:rec:institute:student:<studentId>`, 6 hours, invalidated when the student's `class_id`/`city_id`/`area_id` changes (Module 51 account edit — students have no Module-9-equivalent profile editor beyond Account Settings) or a new search/favourite changes the top affinity signal (targeted bust, not full flush, same as Module 8). `meta.rails[*].cachedAt` is returned exactly as in Module 8's BR-8.11.

**BR-12.8 Replacement by Module 30.** As Module 8 BR-8.12 — request/response shape and cache keys are unchanged when Module 30's engine takes over `recommended_teachers`/`recommended_institutes`.

## 8. Validation Rules

| Field | Rule |
| --- | --- |
| rail (query) | one of the five rail codes or absent |
| cursor | opaque string from `meta.nextCursor` |
| limit | integer 1–20, default 10 (20 on `RailListScreen`) |

## 9. API Endpoints

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | /home/student | Student | Banners and five rails (`?rail=&cursor=&limit=`) |

## 10. Request Payloads

```json
// GET /home/student
// GET /home/student?rail=recommended_teachers&cursor=eyJvIjoxMH0&limit=20
```

## 11. Response Payloads

```json
// 200 GET /home/student
{ "data": {
  "parentalConsent": "pending",
  "banners": { "home_top": [ { "id": "…", "title": "JEE Main 2027 crash course", "imageUrl": "…", "deepLink": "gc://search?subjectId=…" } ], "home_middle": [] },
  "rails": {
    "recommended_teachers": { "header": "Recommended for you", "items": [ { "teacherId": "…", "fullName": "Meera Nair", "categoryName": "Competitive Exam Faculty",
      "feePerHourPaise": 70000, "ratingAvg": 4.7, "ratingCount": 41, "trustScore": 88.2, "isVerifiedBadge": true, "distanceLabel": "5.1 km", "score": 6.9 } ],
      "nextCursor": "…", "cachedAt": "2026-09-26T09:00:00Z" },
    "recommended_institutes": { "header": "Recommended for you", "items": [ "…" ], "nextCursor": null, "cachedAt": "…" },
    "nearby_teachers": { "items": [ "…" ], "nextCursor": "…", "cachedAt": "…" },
    "top_rated_teachers": { "items": [ "…" ], "nextCursor": "…", "cachedAt": "…" },
    "verified_teachers": { "items": [ "…" ], "nextCursor": "…", "cachedAt": "…" } } } }
```

## 12. PostgreSQL Tables & Columns


**Existing tables this module reads or writes** (full definitions in the owning module)

| Table | Owner | Purpose |
| --- | --- | --- |
| `students` | Admin M31 | Student profile, one per student app account. |
| `teachers` | Admin M16 | Teacher profile and verification state. One row per teacher app account. |
| `institutes` | Admin M22 | Coaching centres, tuition centres, schools and academies. Rated by GuruConnect after verification. |
| `trust_scores` | Admin M36 | Current trust score per teacher with its factor breakdown. |
| `teacher_locations` | Admin M20 | Cities and areas a teacher serves, with travel radius for home tuition. |
| `banners` | Admin M44 | Promotional banners in the mobile app. |

- `students`: reads `class_id`, `board_id`, `city_id`, `area_id`, `parental_consent` (for the banner); writes nothing.
- `teachers`, `institutes`, `trust_scores`, `teacher_locations`, `banners`: identical read-only use to Module 8.

## 16. Push Notification Requirements

None from this module (as Module 8); Module 11 owns the parental-consent pushes, Module 44 owns banner campaign pushes.

## 17. Security Rules

- No `childId`-equivalent parameter exists, so there is no cross-tenant id to validate beyond the token's own `sub`.
- Cards never include a teacher's/institute's phone/email. Banner deep links are allow-listed exactly as Module 8.
- The pending-consent banner reads only a status enum from `/me`, never the parent's phone (already masked by Module 11's own screens).

## 18. Error Handling

| Scenario | Code | HTTP | App behaviour |
| --- | --- | --- | --- |
| Unknown rail code | `VALIDATION_FAILED` | 422 | Ignored by the UI (client bug guard) |
| Student has no city/area set | — | 200 | Nearby/Top rated/Verified show "Set your area" linking to Account Settings (Module 51) |
| A rail's cache lookup fails | — | 200 (degrades) | That rail computes live once; Retry shown only if that also fails |

## 19. Testing Scenarios

- T12.1 (Maestro `student_home_load`) New student (just registered, Class 11, no consent needed) opens Home → banners and all five rails render; Recommended Teachers header reads "Popular near you" (no signals yet).
- T12.2 Student with a cold-start subject hint from registration → Recommended Teachers is biased toward matching-subject teachers on first load.
- T12.3 Student searches for "Physics" three times (Module 27) → within the cache TTL, Recommended Teachers shifts toward Physics teachers (search-affinity term).
- T12.4 Student with `parentalConsent = 'pending'` → banner shown on Home; tapping it opens `ParentConsentPending`; browsing and favouriting still work.
- T12.5 Airplane mode → dashboard opens fully from cache with the offline banner.
- T12.6 Student blocks a teacher (Module 49) → that teacher disappears from every rail on next refresh.
- T12.7 See all on Nearby Teachers → paginates correctly past the cached page.
- T12.8 Student changes city in Account Settings (Module 51) → next Home load re-scopes Nearby/Top Rated/Verified to the new city.
- T12.9 One rail's Redis dependency fails → the other four still render; only the failed rail shows Retry.
- T12.10 Student with no favourites, no search history and an expired cold-start hint → Recommended Teachers falls back cleanly to city Top Rated/Verified ordering, not an empty rail.

## 20. Audit Log Events

None — dashboard reads are not audit-logged (conventions §11), matching Module 8.

---

## Module 14 · Teacher Registration [M14]

## 1. Module Purpose

The seven-step wizard that turns a phone-verified registration token into a `teachers` row in `verification_status = 'draft'`, fully described (personal details, qualifications, experience, subjects, classes, teaching modes, locations) so that Module 15 has everything it needs to accept documents and submit for verification. Every step writes straight to its server table as it is completed — there are no lost drafts if the app is killed — while a local Zustand draft holds the in-progress screen so a half-typed field survives a rotation or a brief network drop. A progress indicator and a resumable `nextStep` keep a teacher who registers on a train and finishes on Wi-Fi from ever starting over.

## 3. Business Rules & Logic

**BR-14.1 Account creation.** `POST /registration/teacher` (Registration token, `aud gc-register`, role `teacher`) is the only entry point. In one transaction: insert `app_users` (`phone` from the token's verified contact, `role = 'teacher'`, `signup_source` per conventions §13, `preferred_language`), insert `teachers` (`user_id`, `full_name`, `gender`, `date_of_birth`, `category_id`, `verification_status = 'draft'`, `account_status = 'active'`, `profile_completeness = 0`), insert `user_consents` (terms + privacy, `accepted_at = now()`, owned by M52), apply `referralCode` if present (validated the same way as M05 `POST /registration/referral/validate`; stored for M46 to pay out once the teacher is approved), create an `app_sessions` row and issue access + refresh tokens exactly like `POST /auth/refresh` (conventions §6). Response includes the new `teacherId`, tokens, and `nextStep: "qualification"`. A registration token already consumed (an `app_users` row already exists for that phone) returns `CONFLICT_STATE` and the app routes to Login instead.
**BR-14.2 Step order and ownership.** Personal details (this endpoint) → Qualification → Experience → Subjects → Classes → Teaching modes → Locations → (Module 15 Documents). "Personal details" and "Experience" are both partial edits of the `teachers` row and share one endpoint, `PATCH /teacher/registration/basics` (If-Match on `teachers.updated_at`): the Personal Details screen sends `{ fullName, gender, dateOfBirth, email, categoryId, languages }`; the Experience screen sends `{ experienceYears, highestQualification, bio, feePerHourPaise, demoAvailable }`. Both are optional partial payloads — only the fields present are validated and updated.
**BR-14.3 Progress and resume.** `GET /teacher/registration` returns the current draft (`teachers` row + qualifications + subjects + classes + modes + locations), `completedSteps` (each step is "complete" per the rule in BR-14.4) and `nextStep` (first incomplete step, or `"documents"` when all seven are done). `GET /me` (M00) surfaces the same `nextStep` under `registration.nextStep` so Splash (M01) resumes the wizard on relaunch without a second network call once `/me` is cached.
**BR-14.4 Step completion rules.**

| Step | Complete when |
| --- | --- |
| Personal details | `full_name`, `gender`, `date_of_birth`, `category_id` set |
| Qualification | ≥ 1 row in `teacher_qualifications` |
| Experience | `experience_years` and `highest_qualification` set |
| Subjects | ≥ 1 row in `teacher_subjects` |
| Classes | ≥ 1 row in `teacher_classes` |
| Teaching modes | ≥ 1 row in `teacher_teaching_modes` |
| Locations | ≥ 1 row in `teacher_locations`, OR every selected teaching mode has `requires_location = false` (pure online tutor) |
**BR-14.5 Qualifications (owns `teacher_qualifications`).** `POST /teacher/qualifications { level, degree, institution, yearCompleted, grade, isHighest }` appends a row (`sort_order` = current max + 1). `PATCH /teacher/qualifications/:id` edits one row (ownership: `teacher_id = pid`). `DELETE /teacher/qualifications/:id` soft-deletes (`deleted_at`); at least one qualification must remain once the step is marked complete elsewhere (deleting the last one is allowed while still in `draft` — it simply un-completes the step). Setting `isHighest: true` unsets it on every other row of the same teacher in the same transaction (`is_highest` is not a database-unique constraint — enforced in the service layer since a teacher may have zero qualifications marked highest transiently while editing). `document_id` is written later by Module 15 when the teacher attaches a certificate to a qualification; it is never set from this module.
**BR-14.6 Replace-set steps (subjects, classes, teaching modes, locations).** Each of `PUT /teacher/subjects`, `PUT /teacher/classes`, `PUT /teacher/teaching-modes`, `PUT /teacher/locations` replaces the whole set for the teacher in one transaction (diffed: insert new, delete removed, update changed — same pattern as Admin M18). Limits: subjects 1–10 with exactly one `isPrimary` (auto-promotes the first item if none is flagged, matching Admin FR-18.2); classes 1–20, each optionally paired with a `boardId`; teaching modes 1–4 (the full active `teaching_modes` list); locations 0–5, each `{ cityId, areaId?, isPrimary, travelRadiusKm?, addressLine?, latitude?, longitude? }` with exactly one `isPrimary` when the set is non-empty. A location is required unless every chosen teaching mode has `requires_location = false` (BR-14.4); the Locations screen shows "Skip — you teach online only" only in that case.
**BR-14.7 Category change guard.** Changing `categoryId` after subjects have been added shows a confirmation ("Your subjects were set up for {old category}. Review them next.") but does not clear the subject set — the teacher is taken back to the Subjects step.
**BR-14.8 Locking during review.** The four replace-set endpoints (subjects, classes, teaching-modes, locations) and the qualification endpoints check `teachers.verification_status IN ('draft', 'approved')`; any other status (`pending`, `under_review`, `reupload_requested`, `rejected`) returns `409 CONFLICT_STATE` with `details.reason = "verification_in_progress"` so an application being actively reviewed can't shift mid-review. `draft` is the registration wizard itself; `approved` is these same six endpoints reused, unchanged, as Module 17's Subjects / Classes / Teaching modes / Locations / Qualifications editors after launch — Module 17 owns no separate endpoints for these. `PATCH /teacher/registration/basics` is narrower and **draft-only**: once approved, the equivalent personal/experience fields are edited through Module 17's `PATCH /teacher/profile` instead (which additionally requires a reason for identity-linked fields, per Admin FR-17.3). While `reupload_requested`, only Module 15's document endpoints are open; while `pending`/`under_review`/`rejected`, nothing in Modules 14, 15 or 17 is editable until Module 16's resubmit flow or a support-assisted re-application returns the teacher to `draft`.
**BR-14.9 Side effects.** After every write in this module: recompute `teachers.profile_completeness` using the Admin M17 formula (photo 15, bio ≥ 100 chars 10, qualification 10, experience 5, ≥ 1 subject 15, ≥ 1 class 10, ≥ 1 location or online mode 10, fee 5, languages 5, ≥ 1 certificate approved 15 — the last two are always 0 until Module 15/17 run, so a fresh draft tops out at 60); write no audit row per keystroke, only per successful step save (conventions §11); emit `teacher.registration_step_saved` for analytics (event name only, no PII).
**BR-14.10 Rate limits.** `POST /registration/teacher` is limited to 5 attempts per registration token (a token is single-use regardless — a second call after success returns `CONFLICT_STATE`); qualification/set-replace endpoints are limited to 30 requests/minute per teacher (protects against a runaway autosave loop).

## 8. Validation Rules

| Field | Rule | Message shown |
| --- | --- | --- |
| fullName | 2–100 chars | "Enter your full name as on your ID" |
| gender | one of female, male, other, undisclosed | "Select an option" |
| dateOfBirth | age ≥ 18 and ≤ 90 | "You must be at least 18 to register as a teacher" |
| email | valid email, optional | "Enter a valid email" |
| categoryId | active teacher category | "Choose a category" |
| languages | 1–10 from the supported list | "Add at least one language" |
| level (qualification) | one of secondary…certification | "Select a level" |
| degree | 2–120 chars | "Enter your degree or certification name" |
| institution | 2–120 chars | "Enter your institution name" |
| yearCompleted | 1960–current year | "Enter a valid year" |
| grade | ≤ 40 chars, optional | — |
| experienceYears | 0–60, ≤ age − 16 | "Experience can't exceed your working years" |
| highestQualification | 2–120 chars | "Enter your highest qualification" |
| bio | ≤ 2,000 chars, no phone/email/URL patterns | "Remove phone numbers, emails or links" |
| feePerHourPaise | 0–1,00,000 paise (₹1,000/hour), optional | "Enter a fee up to ₹1,000/hour" |
| subjects.items | 1–10, unique subjectId, exactly one isPrimary | "Add at least one subject" |
| subjects.experienceYears | 0–60, optional | — |
| classes.items | 1–20, unique classId | "Add at least one class" |
| teachingModes.items | 1–4, unique, active only | "Select at least one teaching mode" |
| locations.items | 0–5; required unless all modes are online-only; exactly one isPrimary when non-empty | "Add a city you teach in" |
| locations.travelRadiusKm | 2–25, required when Home tuition is selected | "Set how far you're willing to travel" |

## 9. API Endpoints

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| POST | /registration/teacher | Registration token | Create the app_users + teachers draft, issue session (Idempotency-Key) |
| GET | /teacher/registration | Teacher | Current draft, completed steps, nextStep |
| PATCH | /teacher/registration/basics | Teacher | Update personal-details or experience fields (If-Match) |
| POST | /teacher/qualifications | Teacher | Add a qualification |
| PATCH | /teacher/qualifications/:id | Teacher | Edit a qualification |
| DELETE | /teacher/qualifications/:id | Teacher | Remove a qualification |
| PUT | /teacher/subjects | Teacher | Replace the subject set |
| PUT | /teacher/classes | Teacher | Replace the class set |
| PUT | /teacher/teaching-modes | Teacher | Replace the teaching-mode set |
| PUT | /teacher/locations | Teacher | Replace the location set |

## 10. Request Payloads

```json
// POST /registration/teacher   (Authorization: Bearer <registration token>, Idempotency-Key: 7c1e…)
{ "fullName": "Kavya Menon", "gender": "female", "dateOfBirth": "1994-06-12", "categoryId": "…home-tutor…", "referralCode": "RAHUL482" }

// PATCH /teacher/registration/basics   (If-Match: "2026-09-26T09:00:11.000Z")
{ "experienceYears": 4, "highestQualification": "B.Sc., B.Ed. (Primary)", "bio": "I teach Maths and Science for Classes 6-10 with a focus on CBSE board exams.", "feePerHourPaise": 60000, "demoAvailable": true }

// POST /teacher/qualifications
{ "level": "postgraduate", "degree": "M.Sc. Physics", "institution": "Bangalore University", "yearCompleted": 2010, "grade": "First class", "isHighest": true }

// PUT /teacher/subjects
{ "items": [ { "subjectId": "…physics…", "isPrimary": true, "experienceYears": 14 }, { "subjectId": "…jee-advanced…", "isPrimary": false, "experienceYears": 8 } ] }

// PUT /teacher/locations
{ "items": [ { "cityId": "…bengaluru…", "areaId": "…koramangala…", "isPrimary": true, "travelRadiusKm": 8, "addressLine": "5th Block, Koramangala" } ] }
```

## 11. Response Payloads

```json
// 201 POST /registration/teacher
{ "data": { "teacherId": "3fa1…", "accessToken": "eyJhbGciOi…", "refreshToken": "8f2c…", "role": "teacher", "nextStep": "qualification" } }

// 200 GET /teacher/registration
{ "data": {
  "teacher": { "id": "…", "fullName": "Kavya Menon", "gender": "female", "dateOfBirth": "1994-06-12", "categoryId": "…", "verificationStatus": "draft",
              "experienceYears": 4, "highestQualification": "B.Sc., B.Ed. (Primary)", "bio": "…", "feePerHourPaise": 60000, "demoAvailable": true, "updatedAt": "2026-09-26T09:00:11.000Z" },
  "qualifications": [ { "id": "…", "level": "postgraduate", "degree": "M.Sc. Physics", "institution": "Bangalore University", "yearCompleted": 2010, "isHighest": true, "sortOrder": 1 } ],
  "subjects": [], "classes": [], "teachingModes": [], "locations": [],
  "completedSteps": ["personal","qualification","experience"], "nextStep": "subjects" } }

// 409 PUT /teacher/subjects  (already submitted)
{ "error": { "code": "CONFLICT_STATE", "message": "Your application is already under review and can't be edited here.", "details": { "reason": "verification_in_progress" }, "requestId": "…" } }
```

## 12. PostgreSQL Tables & Columns

**New tables owned by this module** (migration `sql/migrations/114_app_m14_teacher_registration_qualifications.sql`)

### `teacher_qualifications`

Degrees and certifications a teacher lists during registration and in the profile builder.

| Column | Type | Null | Default | Constraints / References | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | uuid | no | gen_random_uuid() | PK | Primary key |
| `teacher_id` | uuid | no | — | FK → `teachers.id` (on delete cascade) | Owner |
| `level` | text | no | — | CHECK level IN ('secondary','senior_secondary','diploma','graduate','postgraduate','doctorate','professional','certification') | Level |
| `degree` | text | no | — | — | e.g. M.Sc. Physics, B.Ed. |
| `institution` | text | no | — | — | University / board / body |
| `year_completed` | smallint | yes | — | CHECK year_completed BETWEEN 1960 AND 2100 | Year |
| `grade` | text | yes | — | — | e.g. 78% / 8.4 CGPA (optional) |
| `document_id` | uuid | yes | — | FK → `teacher_documents.id` (on delete set null) | Supporting certificate (Module 15) |
| `is_highest` | boolean | no | false | — | Shown on cards; mirrors teachers.highest_qualification |
| `sort_order` | smallint | no | 0 | — | Display order |
| `created_at` | timestamptz | no | now() | — | Created |
| `updated_at` | timestamptz | no | now() | — | Updated |
| `deleted_at` | timestamptz | yes | — | — | Soft delete |

<details><summary>DDL</summary>

```sql
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
```

</details>

**Indexes:** `idx_teacher_qualifications_teacher` on `(teacher_id, sort_order) WHERE deleted_at IS NULL`; `uq_teacher_qualifications_highest` (unique) on `(teacher_id) WHERE is_highest AND deleted_at IS NULL`

**Existing tables this module reads or writes** (full definitions in the owning module)

| Table | Owner | Purpose |
| --- | --- | --- |
| `teachers` | Admin M16 | Teacher profile and verification state. One row per teacher app account. |
| `teacher_subjects` | Admin M18 | Subjects a teacher teaches. |
| `teacher_classes` | Admin M19 | Classes (and optionally boards) a teacher covers. |
| `teacher_teaching_modes` | Admin M20 | Teaching modes a teacher offers (Online, Home tuition, …). |
| `teacher_locations` | Admin M20 | Cities and areas a teacher serves, with travel radius for home tuition. |
| `teacher_categories` | Admin M15 | Types of teacher shown as categories and used in parent preferences, e.g. Home Tutor, Coaching Faculty. |

| Column | Written by this module |
| --- | --- |
| `teachers.full_name`, `.gender`, `.date_of_birth`, `.email`, `.category_id`, `.languages` | `PATCH /teacher/registration/basics` (personal-details fields) |
| `teachers.experience_years`, `.highest_qualification`, `.bio`, `.fee_per_hour_paise`, `.demo_available` | `PATCH /teacher/registration/basics` (experience fields) |
| `teachers.profile_completeness` | recomputed after every write in this module (BR-14.9) |
| `teacher_qualifications.*` | owned outright — `document_id` is left null here, set later by Module 15 |
| `teacher_subjects`, `teacher_classes`, `teacher_teaching_modes`, `teacher_locations` | replace-set writes (BR-14.6) |
`teacher_categories`, `subjects`, `classes`, `boards`, `teaching_modes`, `cities`, `areas` are read-only lookups served by `GET /masters` (Module 0).

## 16. Push Notification Requirements

None from this module. The teacher gets no push until Module 15 submits for review (Module 16/20 then send verification-status pushes). The end of registration (after Locations, before Documents) is the point Module 20 prompts for notification permission ("Get notified the moment you're verified").

## 17. Security Rules

- Every write endpoint scopes by `teacher_id` derived from the access token's `pid`, never from the body.
- `POST /registration/teacher` accepts only a `gc-register` token whose `role` claim is `teacher`; any other role is `403 FORBIDDEN`.
- `PATCH /teacher/registration/basics` (draft-only) and the qualification/replace-set endpoints (draft or approved) reject in every other status (BR-14.8), so a teacher can never edit these fields while an application is actively under review.
- Bio is scanned for phone numbers, emails and URLs (same regex as Admin FR-17.5) and rejected with `VALIDATION_FAILED`, keeping contact off-platform even before verification.
- No document upload happens in this module, so `FLAG_SECURE` is not required on these screens.

## 18. Error Handling

| Scenario | Code | HTTP | App behaviour |
| --- | --- | --- | --- |
| Registration token expired/invalid | `AUTH_REQUIRED` | 401 | Back to phone verification |
| Token already used (account exists) | `CONFLICT_STATE` | 409 | Route to Login |
| Write while under review (`reason: verification_in_progress`) | `CONFLICT_STATE` | 409 | Toast + route to Verification status (M16) |
| Stale edit on basics | `VERSION_CONFLICT` | 409 | "Updated on another device. Review and save again." refetch and reopen |
| More than 10 subjects / 20 classes / 4 modes / 5 locations | `VALIDATION_FAILED` | 422 | Inline count warning at the limit |
| Two primary subjects/locations sent | `VALIDATION_FAILED` | 422 | Client blocks before submit; server double-checks |
| Bio contains a phone/email/URL | `VALIDATION_FAILED` | 422 | Inline under the bio field |
| Location required but none given | `VALIDATION_FAILED` (`reason: location_required`) | 422 | Banner "Add at least one city you teach in" |
| Network error mid-step | `NETWORK_OFFLINE` / `GATEWAY_ERROR` | — | Local draft kept; Retry button; Next stays disabled |

## 19. Testing Scenarios

- T14.1 Happy path: register → 7 steps → lands on Documents with `nextStep: "documents"`. Maestro flow `teacher_registration_happy_path`.
- T14.2 Kill the app after saving Qualifications, relaunch → `GET /teacher/registration` resumes at Experience with the qualification intact.
- T14.3 Registering with an under-18 date of birth is rejected client-side and server-side.
- T14.4 Adding a second qualification with `isHighest: true` unsets the first; `GET /teacher/registration` shows only one highest.
- T14.5 Selecting only "Online" as a teaching mode skips the Locations screen entirely; `completedSteps` includes `locations` without any row.
- T14.6 Selecting "Home tuition" and leaving Locations empty blocks Next with `location_required`.
- T14.7 Editing basics after Module 15 has submitted the application (`verification_status = 'pending'`) returns 409 and the app shows "Your application is already under review."
- T14.8 Offline: opening any step shows cached data but every Save/Next button is disabled with a hint.
- T14.9 Stale `If-Match` on `PATCH /teacher/registration/basics` (edited on another device) surfaces the conflict message and reloads the latest basics.
- T14.10 11th subject in `PUT /teacher/subjects` is rejected with `VALIDATION_FAILED` before any row changes (transaction rolled back, existing 10 untouched).
- T14.11 A valid referral code on `POST /registration/teacher` is recorded and visible later in Module 46 once the teacher is approved.
- T14.12 Concurrent duplicate `POST /registration/teacher` with the same `Idempotency-Key` returns the same `teacherId` and tokens without creating a second row.

## 20. Audit Log Events

| Event | When | Details |
| --- | --- | --- |
| `app.teacher_registered` | Account created | category, referral code used (boolean) |
| `app.teacher_registration_step_saved` | Any step successfully saved | step name |
| `app.teacher_qualification_added` / `_updated` / `_deleted` | Qualification changes | qualification id, level, isHighest |
| `app.teacher_subjects_set` / `_classes_set` / `_modes_set` / `_locations_set` | Replace-set writes | added, removed counts |

---

## Module 15 · Teacher Document Upload [M15]

## 1. Module Purpose

Collects the identity and qualification evidence a teacher must provide before GuruConnect will show them in search: Aadhaar, PAN, education certificates, an optional professional certificate and experience letter, and a verification selfie ("photo") compared against the Aadhaar photo by Admin M16's automated checks. Every file goes to the private R2 bucket through Module 0's presign/confirm flow; identity numbers are masked immediately and only an HMAC hash is kept for duplicate detection. Once every required document is present, the teacher pays the registration fee (if one is configured) and submits, moving `teachers.verification_status` from `draft` to `pending` and handing the case to the Admin M16 queue.

## 3. Business Rules & Logic

**BR-15.1 Preconditions.** `GET`/`POST`/`DELETE /teacher/documents` require `teachers.verification_status IN ('draft', 'reupload_requested')` (uploading or replacing a flagged document works in both states); any other status is `409 CONFLICT_STATE` (`reason: not_editable`) and the app routes to Module 16 Verification Status instead. `POST /teacher/registration/submit` (BR-15.8) is narrower: it only fires the **first-time** `draft → pending` transition and requires `verification_status = 'draft'` exactly — the corresponding `reupload_requested → pending` transition after a re-upload is a different endpoint, owned and detailed by Module 16 (`POST /teacher/verification/resubmit`), not this module; this module's role in that path ends at uploading the replacement document. The Documents screen itself is reachable only once Module 14's seven steps are complete (`nextStep = "documents"`); reaching it earlier redirects to the first incomplete step.
**BR-15.2 Upload flow (per document).** 1) Camera or gallery/file picker per `doc_type`, resized/compressed per conventions §10 (images) or kept as-is for PDF (certificates only). 2) `POST /uploads/presign { purpose: "teacher_document", mimeType, sizeBytes, fileName }` (Module 0) → presigned PUT to `gc-private`. 3) App `PUT`s the file with progress. 4) `POST /uploads/:fileId/confirm`. 5) `POST /teacher/documents { docType, fileId, title?, docNumber? }` creates or replaces the current document for that type in one transaction: if a current row of the same `doc_type` exists, set its `is_current = false`; insert a new row with `version = previous + 1` (or `1`), `is_current = true`, `status = 'submitted'`. For `aadhaar` and `pan`, `docNumber` is required, sent once over TLS, never stored or logged in full: the server strips spaces/case, computes `doc_number_masked` (Aadhaar → `"XXXX XXXX " + last4`; PAN → first character + `"XXXXX"` + last 4 characters) and `doc_number_hash = HMAC-SHA256(normalisedNumber, docHashKey)` (key in KMS, conventions §13); the request body field is discarded after this step and never appears in any response, log or audit row.
**BR-15.3 Document types and rules.** `aadhaar` and `pan`: exactly one current row each, `docNumber` required, image or PDF. `education_certificate`: 1–5 current rows allowed simultaneously (each is its own "slot", not replaced by a new upload unless the teacher explicitly deletes and re-adds — see BR-15.5), `title` required (e.g. "B.Ed., Bangalore University 2010"); may optionally be linked to a `teacher_qualifications` row via `qualificationId` in the request, which is written to `teacher_qualifications.document_id`. `professional_certificate` and `experience_letter`: 0–5 current rows, optional, same slot behaviour as certificates. `photo`: exactly one current row, a live selfie (camera capture only — the picker is disabled for this type to discourage uploading an old photo), used only for the automated face-match check (Admin FR-16.4) and never shown publicly; it is unrelated to the public profile photo the teacher sets later in Module 17 (`teachers.profile_photo_file_id`).
**BR-15.4 Duplicate hint.** After an Aadhaar or PAN upload, the app calls nothing extra — duplicate checking against other teachers' current documents is Admin M16's automated check (FR-16.4), run when the teacher submits, not shown to the teacher. If the *same* teacher re-uploads an Aadhaar with a hash identical to their own previous rejected upload, the app shows an informational note ("This looks the same as your last upload — check your camera focus") client-side only (compares to the last known masked value locally; no extra call).
**BR-15.5 Delete / replace.** `DELETE /teacher/documents/:id` is allowed only on the current version of `education_certificate`, `professional_certificate` or `experience_letter` (multi-slot types) and only while `verification_status = 'draft'` — since nothing has been reviewed yet, the row is hard-deleted along with a request to clean up the `files` row (soft `status = 'deleted'`, object removed by the nightly job). `aadhaar`, `pan` and `photo` cannot be deleted, only replaced (a fresh `POST /teacher/documents` supersedes the current row as in BR-15.2); this keeps exactly one current identity/photo row at all times, matching `uq_teacher_documents_current_identity`. While `verification_status = 'reupload_requested'`, `DELETE` is disabled entirely — the teacher may only upload a replacement for the document(s) Module 16 flagged (each new upload via BR-15.2 automatically supersedes the flagged version); once every flagged document has a new `submitted` row, the teacher taps "Resend for review" (Module 16 `POST /teacher/verification/resubmit`), which this module does not own.
**BR-15.6 Required set for submission.** `GET /teacher/documents` reports readiness: current `aadhaar` present, current `pan` present, ≥ 1 current `education_certificate`, current `photo` present. All four are mandatory; `professional_certificate` and `experience_letter` are optional and never block submission.
**BR-15.7 Registration fee gate.** The Documents screen's sticky action reads `GET /api/v1/app/pricing` (Module 5, via Module 43's `GET /payments/quote?feeCode=TEACHER_REGISTRATION`) for the current `TEACHER_REGISTRATION` fee. If `enabled = false`, the button is "Submit for verification" and skips straight to BR-15.8. If `enabled = true`, the button is "Pay ₹{amount} & submit": tapping it runs the Module 43 payment flow (`GET /payments/quote` → `POST /payments/orders` → Razorpay Checkout → `POST /payments/verify`); on a captured payment the app immediately calls `POST /teacher/registration/submit { transactionId }`.
**BR-15.8 Submit (first submission only).** `POST /teacher/registration/submit { transactionId? }` requires `verification_status = 'draft'`: 1) re-checks BR-15.6's required set and the fee precondition (`transactionId` required and its transaction `status = 'captured'`, `fee_code = 'TEACHER_REGISTRATION'`, `payer = teacher's user_id`, unused by another teacher, only when the fee is enabled); 2) in one transaction sets `teachers.verification_status = 'pending'`, `submitted_at = now()`, `registration_transaction_id = transactionId` (or `NULL` when the fee is disabled); 3) writes `teacher_verification_logs` (`action = 'submitted'`, `from_status = 'draft'`, `to_status = 'pending'`); 4) audits `app.teacher_registration_submitted`; 5) sends the teacher a confirmation push/in-app message ("We've received your application — most reviews finish within 24 hours."). A teacher whose status is already `pending`/`under_review`/`approved` gets `CONFLICT_STATE`; a teacher in `reupload_requested` gets a clear `CONFLICT_STATE` pointing at Module 16's "Resend for review" action instead (no fee is ever charged twice).
**BR-15.9 Idempotency.** `POST /teacher/registration/submit` is idempotent on `teacher_id` — a duplicate double-tap after the first success simply returns the already-`pending` state (`200`, not a new log row) as long as no other write has moved the status since.

## 8. Validation Rules

| Field | Rule | Message shown |
| --- | --- | --- |
| docType | one of aadhaar, pan, education_certificate, professional_certificate, experience_letter, photo | — |
| file (aadhaar/pan/photo) | jpeg/png, ≤ 10 MB | "Choose a JPG or PNG under 10 MB" |
| file (certificate/experience_letter) | jpeg/png/pdf, ≤ 10 MB | "Choose a JPG, PNG or PDF under 10 MB" |
| docNumber (aadhaar) | 12 digits, passes Verhoeff checksum | "Enter a valid 12-digit Aadhaar number" |
| docNumber (pan) | `^[A-Z]{5}[0-9]{4}[A-Z]$` | "Enter a valid PAN, e.g. ABCDE1234F" |
| title (certificate types) | 2–120 chars | "Give this document a short title" |
| qualificationId | optional, must belong to this teacher | — |
| transactionId (submit) | required and `captured` when the fee is enabled | "Complete payment before submitting" |

## 9. API Endpoints

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | /teacher/documents | Teacher | Current documents per type, readiness for submit |
| POST | /teacher/documents | Teacher | Add or replace the current document of a type (Idempotency-Key) |
| DELETE | /teacher/documents/:id | Teacher | Remove a multi-slot document (draft only) |
| POST | /teacher/registration/submit | Teacher | Submit for verification (Idempotency-Key) |

## 10. Request Payloads

```json
// POST /teacher/documents
{ "docType": "aadhaar", "fileId": "7c1e4b2a-…", "docNumber": "491234567890" }

// POST /teacher/documents  (certificate, linked to a qualification)
{ "docType": "education_certificate", "fileId": "9a0d…", "title": "M.Sc. Physics, Bangalore University 2010", "qualificationId": "…" }

// POST /teacher/registration/submit
{ "transactionId": "b3f0b7b1-…" }
```

## 11. Response Payloads

```json
// 200 GET /teacher/documents
{ "data": {
  "documents": {
    "aadhaar": { "id": "…", "status": "submitted", "numberMasked": "XXXX XXXX 2978", "thumbnailUrl": "https://…signed…", "version": 1 },
    "pan": { "id": "…", "status": "submitted", "numberMasked": "AXXXXX123F", "version": 1 },
    "education_certificate": [ { "id": "…", "title": "M.Sc. Physics, Bangalore University 2010", "status": "submitted", "version": 1 } ],
    "professional_certificate": [], "experience_letter": [], "photo": { "id": "…", "status": "submitted", "version": 1 } },
  "readyToSubmit": true, "missing": [] } }

// 201 POST /teacher/documents
{ "data": { "id": "…", "docType": "aadhaar", "status": "submitted", "numberMasked": "XXXX XXXX 2978", "version": 1 } }

// 200 POST /teacher/registration/submit
{ "data": { "verificationStatus": "pending", "submittedAt": "2026-09-26T09:40:00Z" } }

// 409 POST /teacher/registration/submit  (missing documents)
{ "error": { "code": "VALIDATION_FAILED", "message": "Upload all required documents before submitting.", "details": { "missing": ["photo"] }, "requestId": "…" } }
```

## 12. PostgreSQL Tables & Columns


**Existing tables this module reads or writes** (full definitions in the owning module)

| Table | Owner | Purpose |
| --- | --- | --- |
| `teacher_documents` | Admin M16 | Every uploaded verification document version. Only one current version per teacher and type. |
| `files` | Admin M00 | Metadata for every uploaded object stored in S3 / Cloudflare R2. Binary content never touches PostgreSQL. |
| `teachers` | Admin M16 | Teacher profile and verification state. One row per teacher app account. |

| Column | Written by this module |
| --- | --- |
| `teacher_documents.*` | owned by Admin M16; this module inserts new versions and flips `is_current`; never sets `status` to anything but `submitted`, never touches `reviewed_by`/`reviewed_at`/`review_note` (admin-only) |
| `teachers.verification_status`, `.submitted_at`, `.registration_transaction_id` | `POST /teacher/registration/submit` |
| `teacher_verification_logs` (`submitted`/`resubmitted`) | written alongside the status change, same transaction |
`files` rows are created by Module 0's presign; this module only references `file_id` and marks abandoned certificate files for cleanup on delete.

## 16. Push Notification Requirements

| Event | Recipient | Title / Body | Deep link | Category | Urgent |
| --- | --- | --- | --- | --- | --- |
| Registration submitted | Teacher | "Application submitted" / "We're reviewing your documents. Most reviews finish within 24 hours." | `gc://teacher/verification` | verification | No |
No push for individual document uploads — only the submission confirmation (also shown in-app immediately, so the push mainly reaches a backgrounded app).

## 17. Security Rules

- Every document row is scoped to `teacher_id = pid`; a teacher can never read or list another teacher's documents.
- Aadhaar/PAN numbers are never persisted in full and never appear in any response after the initial `POST /teacher/documents` call (which itself returns only the masked value) — not in logs, Sentry breadcrumbs, or audit rows.
- `docHashKey` (HMAC key) lives in KMS; only the verification service can compute or compare hashes.
- `TeacherDocumentCaptureScreen` and `TeacherDocumentPreviewScreen` enable `FLAG_SECURE` (Android) and the iOS app-switcher privacy overlay (conventions §13) for the whole time an identity number or document image is on screen.
- Private files are only ever fetched through Module 0's 60-second signed `GET /files/:id/url`, requested lazily per row, never bulk-downloaded.
- Rate limit: 20 document writes/hour and 5 submit attempts/hour per teacher.

## 18. Error Handling

| Scenario | Code | HTTP | App behaviour |
| --- | --- | --- | --- |
| Wrong status for editing (`pending`/`approved`/etc.) | `CONFLICT_STATE` (`not_editable`) | 409 | Route to Verification Status (M16) |
| Invalid Aadhaar checksum / PAN format | `VALIDATION_FAILED` | 422 | Inline under the number field |
| File too large / wrong type | `FILE_TOO_LARGE` / `FILE_TYPE_NOT_ALLOWED` | 413/415 | Inline under the picker, retake prompted |
| Submit with missing required docs | `VALIDATION_FAILED` (`details.missing[]`) | 422 | Overview highlights the missing rows |
| Submit with fee enabled but no captured payment | `VALIDATION_FAILED` (`reason: payment_required`) | 422 | Reopens the payment sheet |
| Delete an identity/photo document | `FORBIDDEN` | 403 | "Upload a new one instead — Aadhaar can't be removed." |
| Delete while `reupload_requested` | `CONFLICT_STATE` | 409 | "Upload a replacement instead of deleting." |
| Duplicate double-submit | — (idempotent) | 200 | No-op, same confirmation screen |

## 19. Testing Scenarios

- T15.1 Happy path: upload all four required docs, fee enabled, pay, submit → `TeacherRegistrationSubmitted`. Maestro flow `teacher_document_submit_happy_path`.
- T15.2 Registration fee disabled (`TEACHER_REGISTRATION.enabled = false`) → sticky button reads "Submit for verification" and no payment sheet appears.
- T15.3 Invalid Aadhaar checksum is rejected before any upload starts.
- T15.4 Re-uploading Aadhaar creates version 2, sets version 1 `is_current = false`; `GET /teacher/documents` shows only version 2.
- T15.5 Deleting a second education certificate removes only that row; the first remains current.
- T15.6 Attempting to delete the Aadhaar document returns 403.
- T15.7 Submitting with `photo` missing is blocked with `missing: ["photo"]`.
- T15.8 Killing the app mid-upload of a PDF certificate resumes and completes after relaunch.
- T15.9 A teacher in `reupload_requested` can only upload replacements for the flagged types; `DELETE` is blocked entirely.
- T15.10 Calling `POST /teacher/registration/submit` while `verification_status = 'reupload_requested'` is rejected with `CONFLICT_STATE`, directing the teacher to Module 16's resubmit action.
- T15.11 Double-tapping "Submit" after a successful submit returns the same `pending` state without a duplicate verification log row.
- T15.12 Offline: the Documents screen renders from cache; every action shows "Connect to upload documents" and is disabled.

## 20. Audit Log Events

| Event | When | Details |
| --- | --- | --- |
| `app.teacher_document_uploaded` | Each successful `POST /teacher/documents` | doc type, version (never the file name for identity documents, per conventions §11) |
| `app.teacher_document_deleted` | Successful delete | doc type, version |
| `app.teacher_registration_submitted` | Successful submit | fee code, transaction id (if any), from status |

---

# Part C. Uploads (from M00), required by M15

**BR-0.8 Uploads to R2.** `POST /uploads/presign` validates purpose, MIME type and size against conventions §10, creates a `files` row (`status = 'pending'`, `storage_provider = 'r2'`, `uploaded_by_type = 'app_user'`), and returns a presigned PUT URL (10 min). `POST /uploads/:fileId/confirm` does a `HEAD` on the object, checks size and content type match, sets `status = 'active'`, and for `gc-public` purposes returns the CDN URL. Pending files older than 24 h are deleted by a job (object + row). A user may have at most 20 pending uploads.

**Endpoints**

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| POST | /uploads/presign | Any user (and Registration token for registration uploads) | Create a pending file and presigned R2 PUT URL |
| POST | /uploads/:fileId/confirm | Any user | Verify the uploaded object and activate the file |
| GET | /files/:id/url | Any user (owner only) | 60-second presigned GET for a private file |

**Payloads**

Note: the spec groups several endpoints in the same code blocks, so you will also see `PUT /devices/me`, `POST /events` and `GET /me` below. `/devices/me` is already built and `/events` is out of scope. `GET /me` is already built, but its response here also shows `teacher` and `subscription` fields; add those fields when the modules in this document need them. The new endpoints are the three `/uploads/*` and `/files/:id/url` ones.

```json
// PUT /devices/me
{ "installId": "6f0e4c1a-5b7e-4a0e-9d8c-2f1b3c4d5e6f", "platform": "android", "osVersion": "14", "appVersion": "1.0.0", "buildNumber": 12,
  "deviceModel": "SM-A546E", "fcmToken": "eXk2…:APA91b…", "pushPermission": "granted", "locale": "en-IN", "timezone": "Asia/Kolkata" }

// POST /uploads/presign
{ "purpose": "teacher_document", "mimeType": "image/jpeg", "sizeBytes": 845213, "fileName": "aadhaar-front.jpg" }

// POST /events
{ "events": [ { "clientEventId": "0b1c…", "name": "search_result_click", "ts": "2026-09-26T10:12:03.120Z", "props": { "teacherId": "…", "position": 3, "rail": "search" } } ] }
```

```json
// 200 GET /me
{ "data": { "userId": "…", "role": "parent", "profileId": "…", "fullName": "Lakshmi Venkatesh", "photoUrl": null, "language": "en", "accountStatus": "active",
  "registration": { "complete": true, "nextStep": null }, "teacher": null,
  "subscription": { "status": "trial", "planName": "Parent membership · Monthly", "endsAt": "2026-10-03T18:29:59Z" },
  "unreadNotifications": 3, "flags": { "messagesEnabled": true, "walletEnabled": true } } }

// 200 PUT /devices/me
{ "data": { "deviceId": "…", "pushEnabled": true } }

// 201 POST /uploads/presign
{ "data": { "fileId": "…", "uploadUrl": "https://<account>.r2.cloudflarestorage.com/gc-private/teacher-docs/…?X-Amz-Signature=…",
  "method": "PUT", "headers": { "Content-Type": "image/jpeg" }, "expiresAt": "2026-09-26T10:22:03Z" } }

// 200 POST /uploads/:fileId/confirm
{ "data": { "fileId": "…", "status": "active", "publicUrl": null } }

// 200 GET /masters   (ETag: "m-20260926-7f3a")
{ "data": { "version": "m-20260926-7f3a",
  "classes": [ { "id": "…", "name": "Class 5", "levelOrder": 7, "stage": "primary" } ],
  "subjects": [ { "id": "…", "name": "Mathematics", "classFromOrder": 1, "classToOrder": 14 } ],
  "boards": [ { "id": "…", "name": "CBSE" } ], "teachingModes": [ { "id": "…", "name": "Online", "code": "online" } ],
  "teacherCategories": [ { "id": "…", "name": "School Tutor" } ], "states": [ { "id": "…", "name": "Karnataka" } ],
  "cities": [ { "id": "…", "name": "Bengaluru", "stateId": "…" } ] } }
```

## 10. File uploads (Cloudflare R2)

1. App picks a file; images are resized to max 2000 px long edge, JPEG quality 0.8, EXIF GPS stripped; PDFs ≤ 10 MB.
2. `POST /uploads/presign { purpose, mimeType, sizeBytes, fileName }` → `{ fileId, uploadUrl, headers, expiresAt }` (URL valid 10 min; R2 S3-compatible presigned PUT with `Content-Type` and `Content-Length` fixed).
3. App `PUT`s the bytes directly to R2 with progress.
4. `POST /uploads/:fileId/confirm` → API checks object size/type via `HEAD`, marks `files.status = 'active'`.
5. The module's own endpoint links the `fileId` (e.g. `POST /teacher/documents { fileId, docType }`).

| Purpose | Bucket | Allowed | Max |
| --- | --- | --- | --- |
| `avatar`, `teacher_photo`, `institute_logo`, `institute_cover`, `institute_gallery` | `gc-public` (served via `cdn.guruconnect.in`) | jpeg, png, webp | 5 MB |
| `teacher_document`, `institute_document` | `gc-private` | jpeg, png, pdf | 10 MB |
| `complaint_evidence`, `support_attachment` | `gc-private` | jpeg, png, pdf | 10 MB |

Private files are read through `GET /files/:id/url` (owner only, 60-second presigned GET). Identity documents are never shown back in full after upload: the app shows a thumbnail with the masked number.

---

# Part D. Payments (from M43), required by M10, M13 and M15

Only what M10, M13 and M15 call is needed: quote, create order, verify, status. Use a fake gateway behind an interface for now.

## 1. Module Purpose

The single way money moves from a user to GuruConnect in the app. It prices a purchase from the **active** `payment_configurations` version (Admin M05), adds or splits GST at 18 %, optionally redeems GuruConnect wallet credit (M46), creates a Razorpay order and a `transactions` row, opens **Razorpay Standard Checkout** through `react-native-razorpay` (UPI intent apps, UPI ID, cards, net banking), verifies the signature on the server, and shows a clear result — success, processing, failed or cancelled. The Razorpay webhook handled by Admin M40 is the source of truth: access is granted only when the gateway confirms capture. The module ships two reusable pieces used by every paying screen: the `PaymentSheet` (price breakdown and Pay button) and the `PaymentResult` screen. Callers: parent and student memberships (M10, M13), teacher registration fee (M15), institute registration fee (M22), contact unlock (M37) and renewals, premium and featured boosts (M44). Build this module's API and `PaymentSheet` before any purchase button; until then M10/M13 ship in "view plans" mode.

## 3. Business Rules & Logic

**BR-43.1 Fee codes, purposes and who may pay.**

| Fee code | `transactions.purpose` | Payer role (`payer_type`) | Context required | Extra preconditions |
| --- | --- | --- | --- | --- |
| `TEACHER_REGISTRATION` | `teacher_registration` | teacher (`teacher`) | — | First payment: `teachers.verification_status` in `draft`, `reupload_requested` and `registration_transaction_id` null. Renewal (`context.renewal = true`): approved teacher, registration period ends within 30 days or has ended |
| `INSTITUTE_REGISTRATION` | `institute_registration` | institute staff with `staff_role = manager` (`institute`, `institute_id = iid`) | — | Same rules as teacher, on `institutes` |
| `PARENT_SUBSCRIPTION_MONTHLY` / `_YEARLY` | `subscription` | parent (`parent`) | — | See BR-43.9 |
| `STUDENT_SUBSCRIPTION_MONTHLY` / `_YEARLY` | `subscription` | student (`student`) | — | Student with `parental_consent` in `not_required`, `confirmed` |
| `PREMIUM_TEACHER` | `premium_listing` | teacher | — | `verification_status = approved`, account active, live registration period (when the registration fee is enabled); the new end date may not be more than 90 days from today (`boost_limit`) |
| `FEATURED_TEACHER` | `featured_listing` | teacher | — | As premium, plus a free featured slot in the teacher's primary city (`limits.featured_slots_per_city`, default 12) |
| `CONTACT_UNLOCK` | `contact_unlock` | parent, student | `leadId` | Lead owned by the requester (`requester_user_id = sub`), `contact_unlocked = false`, status not `spam`/`closed` |

Any other role/fee combination → `FORBIDDEN`. A disabled fee (`is_enabled = false`) → `CONFLICT_STATE` `details.reason = "fee_disabled"`; callers follow Admin M05 FR-5.10 (skip payment, hide button).

**BR-43.2 Price resolution.** `resolveFee(feeCode, now())` (Admin M05 FR-5.9) returns the single version in force. The quote and the order both call it; the order stores `payment_configuration_id` and `fee_code` so the user pays the version they saw. If the version id sent with the order differs from the one in force (an admin published between quote and Pay), the order is refused with `CONFLICT_STATE` `details.reason = "price_changed"` and the new quote in `details.quote`; the sheet refreshes and shows "The price was updated. Please review." The app never sends an amount that is charged; `expectedPayablePaise` is only compared.

**BR-43.3 GST and wallet calculation (integers, paise, round half up).**
1. List total `L`: if `gst_inclusive` then `L = amount_paise`; else `L = amount_paise + round(amount_paise × gst_rate_bps / 10000)`.
2. Wallet (only when M46 is live and the user ticks "Use wallet balance"): `maxRedeem = floor(L × wallet.max_redeem_percent / 100)` (setting, default 50); `W = min(walletBalance, maxRedeem)`; `W = 0` when the balance is ≤ 0.
3. Charged `C = L − W` (always ≥ 50 % of `L`, so never below Razorpay's ₹1 minimum for any seeded fee).
4. Split: `base = round(C × 10000 / (10000 + gst_rate_bps))`, `gst = C − base`. Wallet credit is a discount before tax, so GST is on the amount actually paid.
5. Stored on `transactions`: `amount_paise = C`, `base_amount_paise = base`, `gst_paise = gst`, `discount_paise = W`, `metadata.listAmountPaise = L`, `metadata.walletRedeemedPaise = W`.

Worked examples with the launch prices (all `gst_inclusive`, 1800 bps): Teacher registration ₹499 → base ₹422.88 + GST ₹76.12. Parent monthly ₹299 → ₹253.39 + ₹45.61. Parent monthly with ₹100 wallet → pay ₹199 = ₹168.64 + ₹30.36. Parent yearly ₹1,999 with ₹100 wallet → pay ₹1,899 = ₹1,609.32 + ₹289.68. Contact unlock ₹49 → ₹41.53 + ₹7.47.

**BR-43.4 Wallet visibility.** The wallet row is hidden unless `/bootstrap` `features.walletEnabled` is true **and** M46 is deployed (the server returns `quote.wallet = null` otherwise). When hidden, `useWallet` is ignored server-side. When shown with a zero balance the row is not rendered at all.

**BR-43.5 Order creation (`POST /payments/orders`, Idempotency-Key).** In one database transaction, holding `pg_advisory_xact_lock(hashtext('pay:' || user_id || ':' || fee_code))`:
1. Validate role, preconditions (BR-43.1) and price version (BR-43.2).
2. **Reuse** an open order: if a `created` transaction exists for the same user, fee code and context, younger than 25 minutes, with the same `payment_configuration_id` and the same `W`, return it (no new Razorpay order). If an `authorized` transaction exists for the same key → `CONFLICT_STATE` `details.reason = "payment_in_progress"` with its `transactionId`; the app opens `PaymentResult` in processing state for it.
3. Compute BR-43.3. If `W > 0`, insert `wallet_ledger` (`entry_type = checkout_redemption`, `amount_paise = −W`, `transaction_id`, `idempotency_key = redeem:<transactionId>`, description "Used at checkout · TXN-7702140"). The balance is re-read under the per-user lock `pg_advisory_xact_lock(hashtext('wallet:' || user_id))`.
4. Insert `transactions` (`status = created`, `gateway = razorpay`, `direction = credit`, purpose/payer from BR-43.1, `institute_id` for institutes, amounts, `metadata = { context, listAmountPaise, walletRedeemedPaise, platform, appVersion, installId }`).
5. Call Razorpay `POST /v1/orders { amount: C, currency: "INR", receipt: public_code, notes: { transactionId, feeCode, userId } }` (timeout 8 s). On success store `gateway_order_id`. On Razorpay error roll back everything (wallet debit included) → `GATEWAY_ERROR`.
6. Audit `app.payment_started`. Return checkout options (BR-43.6).
Idempotency: the key and a hash of the body are stored in Redis `idem:app:<userId>:<key>` for 24 h; a replay with the same body returns the stored response; a different body → `VALIDATION_FAILED` `details.reason = "idempotency_key_reused"`.

**BR-43.6 Checkout options (built by the server, passed unchanged to `RazorpayCheckout.open`).** `key` (public key id only; the secret never leaves the server), `order_id`, `amount`, `currency`, `name: "GuruConnect"`, `description` (fee `name`), `image` (CDN logo), `prefill { name, contact, email }` of the signed-in user, `readonly { contact: true }`, `theme { color: "#1B7F5A" }`, `method { upi: true, card: true, netbanking: true, wallet: false, emi: false, paylater: false }`, `config.display.preferences.show_default_blocks: true` with UPI first, `retry { enabled: true, max_count: 3 }`, `timeout: 900` (15 min), `send_sms_hash: true` (Android OTP autofill for card OTPs), `notes`.

**BR-43.7 Client payment sequence.**
1. `PaymentSheet` loads `GET /payments/quote`; user taps **Pay ₹199** → `POST /payments/orders`.
2. Before opening Checkout the app writes `usePendingPayment` (MMKV): `{ transactionId, feeCode, returnTo, startedAt }` — survives the app being killed while the UPI app is in front (common on 2 GB phones).
3. `RazorpayCheckout.open(options)`:
   - resolves `{ razorpay_payment_id, razorpay_order_id, razorpay_signature }` → `POST /payments/verify` → `PaymentResult`.
   - rejects with `code 0` / `reason payment_cancelled` → `PaymentResult` state **cancelled** after one status check (a UPI payment can succeed even when the user backs out).
   - rejects with `code 2` (network) or any other error → one status check, then **failed** or **processing** depending on the server state.
4. `PaymentResult` polls `GET /payments/:id/status` until a final state (BR-43.10). On a final state `usePendingPayment` is cleared.
5. **Cold start with a pending payment** (app killed during UPI intent): M01 launch sequence checks `usePendingPayment`; if younger than 30 minutes it routes to `PaymentResult` for that transaction after the gates pass; older entries are checked once silently and cleared.

**BR-43.8 Signature verification (`POST /payments/verify`).** Server loads the transaction by id **and** `user_id = sub`, checks `gateway_order_id = razorpayOrderId`, computes `HMAC_SHA256(order_id + "|" + payment_id, key_secret)` and compares in constant time. Mismatch → `PAYMENT_FAILED` `details.reason = "signature_mismatch"`, transaction unchanged, security log and Sentry alert (never trust a client "success"). Match → set `gateway_payment_id`, and `status = authorized` if still `created`/`failed`. Then the server fetches the payment from Razorpay (`GET /v1/payments/:id`, timeout 5 s): if `captured`, it runs the same idempotent `PaymentCaptureService.apply(payment)` that the webhook job uses; otherwise it returns `processing`. The client signature alone never grants access.

**BR-43.9 Subscription purchase rules.** Payer may buy when: no live row (`trial`, `active`, `grace`, `free_access`) → period starts at capture; a live `trial` → trial ends at capture and `active` starts (Admin M41 FR-41.2); a live `active`/`grace` ending within 30 days → the new period is queued to start at `ends_at` (stored in `transactions.metadata.pendingPeriod`, activated by the M41 job); a live `active` ending in more than 30 days → `CONFLICT_STATE` `details.reason = "already_subscribed"`; `free_access` → purchase hidden (fee off). A user-cancelled row whose `ends_at` is still in the future counts as `active` for these rules (the new period starts at its `ends_at`). Switching monthly → yearly follows the same queue rule. Price changes apply only to new purchases and renewals.

**BR-43.10 Status model shown to the app.**

| `transactions.status` | App state (`status` field) | PaymentResult copy |
| --- | --- | --- |
| `created` (no payment attempt yet or attempt in progress) | `pending` | "Waiting for payment…" |
| `authorized`, or `created` after a successful verify | `processing` | "Payment processing. This can take up to 5 minutes." |
| `captured` + fulfilment done | `success` | "Payment successful" |
| `captured` + fulfilment not yet done | `processing` | Same as processing (fulfilment normally < 2 s) |
| `failed` | `failed` | "Payment failed" + gateway reason |
| `cancelled` | `expired` | "This payment session expired. No money was taken." |
| `refund_pending`, `refunded`, `partially_refunded` | `refunded` | Links to M45 detail |

Polling: every 2 s for 10 s, then every 5 s until 60 s; then the screen stays in processing with "We'll notify you when it's confirmed" and a **Done** button. The server, when asked for status of a transaction still `created`/`authorized` more than 20 s after verify, fetches the order's payments from Razorpay at most once per 10 s (Redis lock `paysync:<id>`), applying capture or failure idempotently. `failed` is not final for the order: Razorpay allows up to 3 attempts per order, so a later `payment.captured` on the same order moves `failed → captured`.

**BR-43.11 Webhook is the source of truth (Admin M40 FR-40.1).** `POST /webhooks/razorpay` (owned by Admin M40) stores every event in `payment_webhook_events` and processes it in a BullMQ job. This module defines what `PaymentCaptureService.apply` does on `payment.captured`, in one transaction, with `SELECT … FOR UPDATE` on the transaction row, skipping if already `captured`:
1. Set `status = captured`, `captured_at`, `gateway_payment_id`, `method` (`upi`, `card`, `netbanking`), `metadata.payerFingerprint = sha256(vpa or card id or bank code)` (used by M46 fraud rules; the raw value is never stored), invoice number (Admin M40).
2. Fulfil by purpose (each step checks current state first):
   - `teacher_registration` first payment: `teachers.registration_transaction_id = id`; the 12-month period is created at approval (Admin M16 FR-16.8). Renewal: insert the next `subscriptions` period (`subscriber_type = teacher`, `fee_code = TEACHER_REGISTRATION`, starting at the current `ends_at` or now if ended).
   - `institute_registration`: same on `institutes` (period starts at approval, Admin M23 FR-23.3).
   - `subscription`: Admin M41 FR-41.2 (BR-43.9).
   - `premium_listing`: `teachers.is_premium = true`, `premium_until = greatest(now(), coalesce(premium_until, now())) + validity_days`.
   - `featured_listing`: `is_featured = true`, `featured_until` the same way.
   - `contact_unlock`: `leads.contact_unlocked = true`, `unlock_transaction_id = id`.
3. After commit: M46 referral qualification hook (`first_payment`), notification `payment.captured` (M47), invoice PDF job (Admin M40), `meKeys` change signalled through the push `data`.
`payment.failed` sets `failed`, `failure_code`, `failure_reason` (unless already captured) and sends `payment.failed`. Orders still `created` after 30 minutes are set `cancelled` by the Admin M40 job; this module adds: if `W > 0`, post `wallet_ledger` `redemption_refund` (+W, `idempotency_key = redeem_refund:<id>`) in the same transaction. A late capture on a `cancelled` transaction is still captured and fulfilled; if its wallet redemption was already refunded, a new `checkout_redemption` (−W, `idempotency_key = redeem_retry:<id>`) is posted; the balance may go negative (M46 BR-46.9). If the purchase is no longer valid (lead already unlocked by another payment, subscription already bought), a system refund request (`duplicate_charge`) is created for Admin M40.

**BR-43.12 UPI intent handling.** Android 11+ needs package visibility for UPI apps: the Expo config plugin adds `<queries><intent><action android:name="android.intent.action.VIEW"/><data android:scheme="upi"/></intent></queries>`. iOS `LSApplicationQueriesSchemes`: `tez`, `phonepe`, `paytmmp`, `bhim`, `credpay`, `amazonpay`. Checkout lists installed UPI apps; if none, "UPI ID" (collect) is offered. While the UPI app is in front the JS thread may be paused; when the app returns to foreground with a pending payment and no Checkout result within 5 s, the app starts status polling itself.

**BR-43.13 Limits.** At most 3 open (`created`, < 30 min) orders per user; `POST /payments/orders` 10/min and 30/hour per user; `POST /payments/verify` 20/min; `GET /payments/:id/status` 60/min. A user with 5 failed transactions in 24 h sees "Having trouble paying? Contact support." under the Pay button (payments keep working).

**BR-43.14 Reusable components contract.** Callers open the sheet with `navigation.navigate('PaymentSheet', { feeCode, context, returnTo, title })`. On success `PaymentResult` invalidates query keys by purpose (BR in @state) and its **Continue** button navigates to `returnTo` (e.g. `{ route: 'LeadDetail', params: { id } }`). Callers never call Razorpay directly.

## 8. Validation Rules

Shared schemas in `packages/shared/payments.ts`: `PaymentQuoteQuerySchema`, `CreateOrderSchema`, `VerifyPaymentSchema`.

| Field | Rule | Message shown |
| --- | --- | --- |
| feeCode | one of the 9 fee codes | "This item can't be bought here." |
| context.leadId | uuid; required for `CONTACT_UNLOCK`, forbidden otherwise | "Pick the request you want to unlock." |
| context.renewal | boolean; only for registration fee codes | — |
| useWallet | boolean, default false | — |
| paymentConfigurationId | uuid of the quoted version | "The price was updated. Please review." |
| expectedPayablePaise | integer ≥ 100; must equal the server's computed `C` | "The price was updated. Please review." |
| Idempotency-Key header | uuid v4, required on orders | "Something went wrong. Try again." |
| transactionId | uuid owned by the caller | "Payment not found." |
| razorpayOrderId | `^order_[A-Za-z0-9]{14}$` | "We couldn't confirm this payment." |
| razorpayPaymentId | `^pay_[A-Za-z0-9]{14}$` | "We couldn't confirm this payment." |
| razorpaySignature | 64 hex chars | "We couldn't confirm this payment." |

## 9. API Endpoints

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | /payments/quote | Any user | Price, GST split, wallet redemption and period for a fee code (`?feeCode=&useWallet=&leadId=&renewal=`) |
| POST | /payments/orders | Any user | Create transaction + Razorpay order and return checkout options (Idempotency-Key). 10/min, 30/hour |
| POST | /payments/verify | Any user | Verify Checkout signature, fetch payment, apply capture if confirmed. 20/min |
| GET | /payments/:id/status | Any user (owner) | Polling status with fulfilment state; triggers throttled gateway sync. 60/min |

The Razorpay webhook receiver `POST /webhooks/razorpay` is owned by Admin M40; the pricing list for plan screens is M10 `GET /plans`.

## 10. Request Payloads

```json
// GET /payments/quote?feeCode=PARENT_SUBSCRIPTION_MONTHLY&useWallet=true

// POST /payments/orders   (Idempotency-Key: 5d0c2f4e-8a1b-4f7e-9d3c-7b2a1e0f9c11)
{ "feeCode": "PARENT_SUBSCRIPTION_MONTHLY", "context": {}, "useWallet": true,
  "paymentConfigurationId": "0a6f2b8e-3c1d-4e5f-9a7b-1c2d3e4f5a6b", "expectedPayablePaise": 19900 }

// POST /payments/orders   (contact unlock)
{ "feeCode": "CONTACT_UNLOCK", "context": { "leadId": "7c9e6679-7425-40de-944b-e07fc1f90ae7" }, "useWallet": false,
  "paymentConfigurationId": "…", "expectedPayablePaise": 4900 }

// POST /payments/verify
{ "transactionId": "b3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d", "razorpayOrderId": "order_OZ4kQ9xY2mN7pL",
  "razorpayPaymentId": "pay_OZ4lA1bC2dE3fG", "razorpaySignature": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08" }

// GET /payments/b3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d/status
```

## 11. Response Payloads

```json
// 200 GET /payments/quote
{ "data": { "feeCode": "PARENT_SUBSCRIPTION_MONTHLY", "paymentConfigurationId": "0a6f2b8e-3c1d-4e5f-9a7b-1c2d3e4f5a6b", "version": 1,
  "name": "Parent membership · Monthly", "description": "Unlimited teacher contacts and free demo bookings", "billingPeriod": "monthly", "validityDays": 30,
  "listAmountPaise": 29900, "gstRateBps": 1800, "gstInclusive": true,
  "wallet": { "balancePaise": 10000, "maxRedeemPercent": 50, "maxRedeemPaise": 14950, "appliedPaise": 10000 },
  "discountPaise": 10000, "payablePaise": 19900, "basePaise": 16864, "gstPaise": 3036,
  "period": { "startsAt": "2026-09-26T10:30:00Z", "endsAt": "2026-10-26T10:30:00Z", "queued": false } } }

// 201 POST /payments/orders
{ "data": { "transactionId": "b3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d", "publicCode": "TXN-7702140", "status": "created", "expiresAt": "2026-09-26T11:00:00Z",
  "checkout": { "key": "rzp_live_Kx7…", "order_id": "order_OZ4kQ9xY2mN7pL", "amount": 19900, "currency": "INR", "name": "GuruConnect",
    "description": "Parent membership · Monthly", "image": "https://cdn.guruconnect.in/brand/logo-192.png",
    "prefill": { "name": "Lakshmi Venkatesh", "contact": "+919845012345", "email": "lakshmi.v@gmail.com" }, "readonly": { "contact": true },
    "theme": { "color": "#1B7F5A" }, "method": { "upi": true, "card": true, "netbanking": true, "wallet": false, "emi": false, "paylater": false },
    "retry": { "enabled": true, "max_count": 3 }, "timeout": 900, "send_sms_hash": true,
    "notes": { "transactionId": "b3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d", "feeCode": "PARENT_SUBSCRIPTION_MONTHLY" } } } }

// 200 POST /payments/verify   (captured during verify)
{ "data": { "transactionId": "b3f1c2d4-…", "status": "success", "fulfilment": { "type": "subscription", "state": "done", "subscriptionId": "…", "endsAt": "2026-10-26T10:30:00Z" } } }

// 200 POST /payments/verify   (bank still confirming)
{ "data": { "transactionId": "b3f1c2d4-…", "status": "processing", "fulfilment": { "type": "subscription", "state": "pending" }, "nextPollAfterMs": 2000 } }

// 200 GET /payments/:id/status
{ "data": { "transactionId": "b3f1c2d4-…", "publicCode": "TXN-7702140", "status": "failed", "rawStatus": "failed", "amountPaise": 19900, "method": "upi",
  "failure": { "code": "BAD_REQUEST_ERROR", "reason": "Payment was declined by the bank." }, "fulfilment": null, "invoiceAvailable": false,
  "canRetry": true, "nextPollAfterMs": null } }

// 409 POST /payments/orders   (admin published a new price)
{ "error": { "code": "CONFLICT_STATE", "message": "The price was updated. Please review.",
  "details": { "reason": "price_changed", "quote": { "paymentConfigurationId": "…", "listAmountPaise": 179900, "payablePaise": 179900 } }, "requestId": "…" } }

// 402 POST /payments/verify   (signature mismatch)
{ "error": { "code": "PAYMENT_FAILED", "message": "We couldn't confirm this payment.", "details": { "reason": "signature_mismatch" }, "requestId": "…" } }
```

## 12. PostgreSQL Tables & Columns


**Existing tables this module reads or writes** (full definitions in the owning module)

| Table | Owner | Purpose |
| --- | --- | --- |
| `transactions` | Admin M40 | Every payment attempt through Razorpay, plus refunds and reward payouts. Amounts in paise. |
| `payment_configurations` | Admin M05 | One row per version of each fee. The app charges whichever version is active at payment time. |
| `payment_webhook_events` | Admin M40 | Raw Razorpay webhooks, stored before processing so every event is processed exactly once. |
| `wallet_ledger` | App M46 | Append-only ledger of GuruConnect wallet credits and debits (referral rewards, use at checkout, reversals). Balance = sum(amount_paise). |
| `subscriptions` | Admin M41 | Paid access periods for parents, students, teachers and institutes, including trials. |
| `teachers` | Admin M16 | Teacher profile and verification state. One row per teacher app account. |
| `institutes` | Admin M22 | Coaching centres, tuition centres, schools and academies. Rated by GuruConnect after verification. |
| `institute_managers` | Admin M25 | App accounts that act for an institute. Exactly one active primary manager; counsellors can only handle leads. |
| `leads` | Admin M38 | Enquiries and call-back requests from parents/students to a teacher or institute. |
| `app_users` | Admin M00 | Login identity for every mobile app account (parent, student, teacher, institute staff). Role profiles hang off this table. |
| `system_settings` | Admin M04 | Typed key–value settings that change platform behaviour without a deploy. |
| `audit_logs` | Admin M00 | Append-only record of every admin action and security event. Never updated or deleted by the application. |
| `user_notifications` | App M00 | The in-app notification inbox for every user: transactional events and copies of admin campaigns. |

- `payment_configurations`: read only, through `resolveFee` (Admin M05 FR-5.9); never cached longer than 60 s (Redis `pricing:v1`, purged on publish).
- `transactions`: this module inserts (`created`) and updates `gateway_order_id`, `gateway_payment_id`, `status` (`authorized` on verify); capture, failure, invoice number and cancellation are written by `PaymentCaptureService` / Admin M40 jobs. `metadata` keys written here: `context`, `listAmountPaise`, `walletRedeemedPaise`, `pendingPeriod`, `payerFingerprint`, `platform`, `appVersion`, `installId`.
- `wallet_ledger` (M46): `checkout_redemption` (−W) on order, `redemption_refund` (+W) on cancel/expiry, a second `checkout_redemption` (key `redeem_retry:<id>`) on late capture. Balance = `SUM(amount_paise)` for the user.
- `payment_webhook_events`: written by Admin M40; this module's status endpoint reads nothing from it (it syncs from Razorpay instead).
- `subscriptions`, `teachers`, `institutes`, `leads`: written only by the fulfilment step (BR-43.11).

## 17. Security Rules

- Razorpay key secret and webhook secret live in the secrets manager; the app only receives the public key id.
- Amounts are computed server-side only; `expectedPayablePaise` is a comparison, not an input.
- Ownership: every lookup is `WHERE id = :id AND user_id = :sub` (institutes: `institute_id = :iid` and the caller is a `manager`); counsellors get `FORBIDDEN`.
- Signature check with constant-time compare; mismatches are counted per user (3 in 24 h → account flagged for review in Admin M40).
- Fulfilment only from gateway-confirmed state (webhook or server fetch), never from the client.
- `PaymentSheet` and `PaymentResult` use `useSecureScreen()` (FLAG_SECURE / iOS snapshot blur). No card or UPI data touches the app code or our servers; `payerFingerprint` is a SHA-256 hash.
- Checkout options, order ids and payment ids are never written to analytics or Sentry breadcrumbs (scrubbed by key name).
- Wallet debits run under a per-user advisory lock so two devices cannot spend the same balance.

## 18. Error Handling

| Scenario | Code | HTTP | App behaviour |
| --- | --- | --- | --- |
| Fee switched off | `CONFLICT_STATE` (`fee_disabled`) | 409 | Close sheet, toast "This is free right now.", caller continues |
| Price changed between quote and Pay | `CONFLICT_STATE` (`price_changed`) | 409 | `PriceChangedSheet` with the new quote |
| Existing payment still processing | `CONFLICT_STATE` (`payment_in_progress`) | 409 | Open `PaymentResult` for that transaction |
| Already subscribed (> 30 days left) | `CONFLICT_STATE` (`already_subscribed`) | 409 | Toast "You already have an active plan till 3 Oct." |
| No featured slot in the city | `CONFLICT_STATE` (`featured_slots_full`) | 409 | Inline "All featured spots in Bengaluru are taken. Try Premium." |
| Boost already bought 90 days ahead | `CONFLICT_STATE` (`boost_limit`) | 409 | Inline "You can buy up to 90 days ahead." |
| Lead already unlocked | `CONFLICT_STATE` (`already_unlocked`) | 409 | Close sheet, refetch lead |
| Wrong role for the fee / counsellor paying | `FORBIDDEN` | 403 | Toast "You can't do that." |
| Too many open orders or requests | `RATE_LIMITED` | 429 | Disable Pay until `Retry-After` |
| Idempotency key reused with another body | `VALIDATION_FAILED` (`idempotency_key_reused`) | 422 | New key, toast "Please try again." |
| Razorpay order API down | `GATEWAY_ERROR` | 502 | Inline "Payments are temporarily unavailable. Try again in a minute." + Retry |
| Signature mismatch | `PAYMENT_FAILED` (`signature_mismatch`) | 402 | `PaymentResult` failed with "We couldn't confirm this payment." + support link |
| Gateway declined | status `failed` | 200 | `PaymentResult` failed with mapped reason, Try again |
| User closed Checkout | client `cancelled` | — | Status check, then `PaymentResult` cancelled |
| Transaction of another user | `NOT_FOUND` | 404 | "This is no longer available." |

---

## Module 10 · Parent Subscription [M10]

## 1. Module Purpose

Membership purchase and renewal for parents: trial, monthly and yearly plans, current status, auto-renew control and cancellation. This module owns `GET /plans` and `GET /subscriptions/current`, both re-used as-is by Module 13 (student subscription, `?role=student`) and Module 44 (boosts reuse the same subscription read model). Contact with teachers, demo bookings and full profile access are gated on having a live subscription (`trial`/`active`/`grace`/`free_access`); this module is where a parent gets one.

**Build-order note.** Purchasing calls Module 43's `POST /payments/orders` and opens its `PaymentSheet`. Build Module 43's API and `PaymentSheet` component before wiring this module's Pay button; until then this module ships in "view plans" mode (plans and current status visible, Subscribe button disabled with "Payments coming soon").

## 3. Business Rules & Logic

**BR-10.1 Plans.** `GET /plans?role=parent` reads the **active** `payment_configurations` for `PARENT_SUBSCRIPTION_MONTHLY` and `PARENT_SUBSCRIPTION_YEARLY` (Admin M05 `resolveFee`, same function Module 43 uses so the price shown here is exactly what checkout will charge) and returns both cards with `isEnabled`, `amountPaise`, `billingPeriod`, `validityDays`, `trialDays`, a computed per-month figure for the yearly card, and whether the parent is trial-eligible (BR-10.2). A disabled plan is omitted from the list, not shown greyed out (Admin M05 FR-5.10); if **both** are disabled the screen shows "Membership is free right now" (the parent already has `free_access`, Admin M41 FR‑41.5).

**BR-10.2 Trial eligibility.** A parent is trial-eligible only if they have never had a `subscriptions` row with `subscriber_type = 'parent'` before (any status) — i.e. first purchase only; `trial_days` comes from whichever plan's active version they buy first, and Module 43/Admin M41 create the `trial` row on first successful purchase of a fee whose `trial_days > 0`. The plans screen shows "{n}-day free trial, then {price}" only when eligible; otherwise "{price}, billed {period}".

**BR-10.3 Current status.** `GET /subscriptions/current?role=parent` returns the parent's single live-or-most-recent `subscriptions` row (the `uq_subscriptions_one_live` row if one exists, else the latest by `created_at`): `status`, `feeCode`, plan name, `startsAt`, `endsAt`/`trialEndsAt`, `autoRenew`, `daysLeft`, and `canPurchase` (false only when a live `active`/`grace` row has `endsAt` more than 30 days away — Module 43 BR‑43.9 — since a nearer renewal can be bought now and queued).

**BR-10.4 Purchase.** The Subscribe button opens Module 43's `PaymentSheet` with `feeCode`, `context: {}`, `returnTo: { route: 'ParentSubscription' }`. This module defines no purchase endpoint of its own; on `PaymentResult` success it invalidates `subscriptionKeys.current('parent')` and `planKeys.parent` and shows a success banner on return ("Your membership is active till {date}").

**BR-10.5 Auto-renew.** Toggling off calls Admin/shared `POST /subscriptions/:id/auto-renew { enabled: false }` (Module 44 owns the enum; this module's UI just confirms "You'll keep access until {endsAt}, then your membership won't renew." and calls the shared endpoint with the parent's own subscription id — ownership checked `user_id = sub`). Turning auto-renew **on** is not supported from this screen in v1 (no stored mandate re-activation flow yet); the parent buys the next period manually near expiry instead.

**BR-10.6 Cancel.** `POST /subscriptions/:id/cancel { mode: 'at_period_end' | 'immediately', reason }` (shared endpoint, ownership-checked). `immediately` is offered only within 24 hours of first purchase (a lightweight cooling-off window) and always shows the refund policy link; after 24 hours only `at_period_end` is offered. A refund, if any, is requested through Module 45's flow, not created here.

**BR-10.7 Fee switched off / on.** When `PARENT_SUBSCRIPTION_*` is disabled (Admin M05), existing paid parents keep their period; new/lapsed parents get `free_access` (Admin M41 FR‑41.5) and this screen shows a "Free access" state with no Subscribe button. Re-enabling either moves them to a fresh trial (`subscriptions.free_access_to_trial_on_enable`, default true, from `system_settings`) or ends access with 3 days' notice; either way the parent gets a push (BR-10.9) and the screen reflects the new state on next open.

**BR-10.8 Renewal reminder.** 7 days before `endsAt` (if `auto_renew`), Admin M41's job sets `renewal_reminder_sent_at` and this module's push template fires (BR‑10.9); the plans screen shows "Renews on {date} for {price}" from that point.

## 8. Validation Rules

| Field | Rule | Message shown |
| --- | --- | --- |
| cancel.mode | `at_period_end` or `immediately`; `immediately` only within 24 h of `starts_at` | "You can only cancel immediately within 24 hours of subscribing." |
| cancel.reason | optional, ≤ 300 chars | — |
| auto-renew.enabled | must be `false` (turning on unsupported here) | — |

## 9. API Endpoints

This module owns no new endpoints; it reads and calls shared ones (Admin M41/App M43/M44 scope), always with `role=parent` and ownership enforced server-side by the token.

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | /plans | Any user | Active plans for the caller's role (`?role=parent`) |
| GET | /subscriptions/current | Any user | Caller's current/most recent subscription (`?role=parent`) |
| POST | /subscriptions/:id/auto-renew | Any user (owner) | Turn auto-renew off |
| POST | /subscriptions/:id/cancel | Any user (owner) | Cancel now or at period end |

## 10. Request Payloads

```json
// GET /plans?role=parent

// GET /subscriptions/current?role=parent

// POST /subscriptions/4a5b6c7d-8e9f-4a1b-9c2d-3e4f5a6b7c8d/auto-renew
{ "enabled": false }

// POST /subscriptions/4a5b6c7d-8e9f-4a1b-9c2d-3e4f5a6b7c8d/cancel
{ "mode": "at_period_end", "reason": "Found a teacher through a friend" }
```

## 11. Response Payloads

```json
// 200 GET /plans?role=parent
{ "data": [
  { "feeCode": "PARENT_SUBSCRIPTION_MONTHLY", "name": "Parent membership · Monthly", "amountPaise": 29900, "billingPeriod": "monthly", "validityDays": 30,
    "trialDays": 7, "trialEligible": true, "perMonthPaise": 29900 },
  { "feeCode": "PARENT_SUBSCRIPTION_YEARLY", "name": "Parent membership · Yearly", "amountPaise": 199900, "billingPeriod": "yearly", "validityDays": 365,
    "trialDays": 7, "trialEligible": true, "perMonthPaise": 16658, "bestValue": true } ] }

// 200 GET /subscriptions/current?role=parent
{ "data": { "id": "4a5b6c7d-8e9f-4a1b-9c2d-3e4f5a6b7c8d", "feeCode": "PARENT_SUBSCRIPTION_MONTHLY", "planName": "Parent membership · Monthly",
  "status": "trial", "startsAt": "2026-09-22T10:00:00Z", "trialEndsAt": "2026-09-29T10:00:00Z", "endsAt": null, "autoRenew": false, "daysLeft": 3, "canPurchase": true } }

// 200 POST /subscriptions/:id/cancel
{ "data": { "id": "4a5b6c7d-…", "status": "active", "cancelledAt": null, "endsAt": "2026-10-22T10:00:00Z", "autoRenew": false, "message": "You'll keep access until 22 Oct 2026." } }

// 409 POST /subscriptions/:id/cancel   (immediately after 24h)
{ "error": { "code": "VALIDATION_FAILED", "message": "You can only cancel immediately within 24 hours of subscribing.", "details": { "path": "mode" }, "requestId": "…" } }
```

## 12. PostgreSQL Tables & Columns


**Existing tables this module reads or writes** (full definitions in the owning module)

| Table | Owner | Purpose |
| --- | --- | --- |
| `subscriptions` | Admin M41 | Paid access periods for parents, students, teachers and institutes, including trials. |
| `payment_configurations` | Admin M05 | One row per version of each fee. The app charges whichever version is active at payment time. |
| `transactions` | Admin M40 | Every payment attempt through Razorpay, plus refunds and reward payouts. Amounts in paise. |
| `parents` | Admin M28 | Parent profile, one per parent app account. |

- `subscriptions`: read-only here except for the two shared write endpoints (`auto-renew`, `cancel`), which are owned by Admin M41 and reused with `subscriber_type = 'parent'` enforced from the token, not the body.
- `payment_configurations`: read via `resolveFee` for plan cards; never written.
- `transactions`: read only to show "Price paid" (`subscriptions.last_transaction_id → transactions.amount_paise`).
- `parents`: read to check the subscriber identity (`user_id = sub`); no columns written.

## 16. Push Notification Requirements

| Event | Recipient | Title / Body | Deep link | Category | Urgent |
| --- | --- | --- | --- | --- | --- |
| `subscription.trial_ending` | Parent | "Your trial ends tomorrow" / "Subscribe to keep contacting teachers without interruption." | `gc://plans` | subscription | no |
| `subscription.renewal_reminder` | Parent | "Renews in 7 days" / "Your {plan} renews on {date} for {price}." | `gc://plans` | subscription | no |
| `subscription.grace_started` | Parent | "Payment failed" / "We couldn't renew your membership. Update payment within 3 days to avoid losing access." | `gc://plans` | subscription | yes |
| `subscription.expired` | Parent | "Membership ended" / "Subscribe again to keep contacting teachers." | `gc://plans` | subscription | no |
| `subscription.moved_to_free_access` / `.moved_to_trial` | Parent | "Membership is now free" / "on your {plan} switch from free" | `gc://plans` | subscription | no |
In-app inbox mirrors all of the above (Module 48); none are `urgent` except the grace start (protects against a lapse the parent didn't notice).

## 17. Security Rules

- Every action resolves the subscription id against the caller's own `user_id`/role; a parent can never act on another user's subscription (`FORBIDDEN`, not `NOT_FOUND`, to avoid leaking existence — actually returns `NOT_FOUND` per conventions to avoid confirming the id belongs to someone: "This is no longer available.").
- No card, UPI or bank data is handled here — purchase entirely delegates to Module 43's `PaymentSheet`.
- Cancellation reason free text is scanned by the same contact-info masking as reviews (conventions §13) before being stored, in case a parent pastes a phone number by habit.

## 18. Error Handling

| Scenario | Code | HTTP | App behaviour |
| --- | --- | --- | --- |
| Cancel `immediately` after 24 h | `VALIDATION_FAILED` | 422 | Inline in the cancel sheet; only `at_period_end` enabled |
| Auto-renew off on a non-live subscription | `CONFLICT_STATE` | 409 | Toast "Only an active plan can have auto-renew changed." |
| Cancel on an already-cancelled subscription | `CONFLICT_STATE` | 409 | Toast + refetch |
| Acting on another user's subscription id | `NOT_FOUND` | 404 | "This is no longer available." |
| Buy while `active` with > 30 days left | `CONFLICT_STATE` (`already_subscribed`, from M43) | 409 | Toast "You already have an active plan till {date}." |

## 19. Testing Scenarios

- T10.1 (Maestro `parent_subscribe_trial`) New parent opens Plans → both cards show "7-day free trial" → Subscribe on Yearly → PaymentSheet → pay → returns with "Active" banner and trial dates removed on next fetch (server started the paid period immediately per Module 43/Admin M41 FR‑41.2).
- T10.2 Existing parent (already had a trial before) → cards show no trial line, straight price.
- T10.3 Turn off auto-renew on an active plan → confirm sheet → status stays `active`, `autoRenew:false`, "Renews" copy becomes "Ends 22 Oct 2026, no further charge."
- T10.4 Cancel `immediately` at hour 25 after purchase → blocked client-side and server-side with the same message.
- T10.5 Grace period: simulate a failed renewal → red banner shown, `subscription.grace_started` push received, still full access.
- T10.6 Admin disables both parent fees mid-session → next `GET /plans` returns an empty list → screen shows "Membership is free right now."
- T10.7 Offline → Subscribe/auto-renew/cancel buttons disabled; cached status still visible.
- T10.8 `SUBSCRIPTION_REQUIRED` thrown while unlocking a contact → ParentPlans opens as a modal; back returns to the contact screen unchanged.
- T10.9 Two devices both open the cancel sheet; one cancels first → the second's action gets `CONFLICT_STATE` and refetches to show the new state.
- T10.10 Renewal reminder push tap → deep link opens ParentPlans directly (not the notification inbox).

## 20. Audit Log Events

| Event | When | Details |
| --- | --- | --- |
| `app.subscription_auto_renew_disabled` | Toggle off succeeds | subscription id, reason (none for this action) |
| `app.subscription_cancel_requested` | Cancel succeeds | subscription id, mode, reason |
Purchase, capture and system transitions (trial→active, grace, expiry, free_access) are audited by Module 43 and Admin M41 as `system`/payment actors, not duplicated here.

---

## Module 13 · Student Subscription [M13]

## 1. Module Purpose

Membership purchase and renewal for students — the same job Module 10 does for parents, reusing its owned `GET /plans` and `GET /subscriptions/current` with `role=student`, `STUDENT_SUBSCRIPTION_MONTHLY`/`_YEARLY` fee codes, and the student-specific trial rule: a limited number of free contacts during the trial instead of (or alongside) a time-boxed trial, and a "covered by parent's plan" shortcut for linked students.

**Build-order note.** As Module 10: purchasing opens Module 43's `PaymentSheet`; until Module 43 ships, this module shows plans and status only, with the Subscribe button disabled ("Payments coming soon").

## 3. Business Rules & Logic

**BR-13.1 Plans.** `GET /plans?role=student` mirrors Module 10 BR-10.1 for `STUDENT_SUBSCRIPTION_MONTHLY`/`_YEARLY`, via the same `resolveFee` used by Module 43. `trialEligible` mirrors Module 10 BR-10.2 (first-ever student subscription only).

**BR-13.2 Trial shape for students.** A student's trial (`subscriptions.status = 'trial'`, `trial_ends_at` from the fee's `trial_days`) additionally carries a **free-contact allowance**: `system_settings['limits.student_trial_free_contacts']` (default 5). `GET /subscriptions/current?role=student` returns `trialContactsUsed`/`trialContactsLimit` alongside the usual fields; Module 37 (Contact Teacher) decrements the allowance on each new lead created during a trial and returns `SUBSCRIPTION_REQUIRED` once it reaches the limit, even if `trial_ends_at` hasn't passed yet — whichever comes first ends trial access. `trialContactsUsed` is computed live as `count(leads where requester_user_id = sub and created_at >= subscriptions.starts_at)`, not stored on the subscription row, so it is always exact.

**BR-13.3 One trial per phone/device (Admin M32 FR‑32.2).** A registration or subsequent purchase attempt from a device fingerprint that already hosts another trial account skips the trial: the first subscription created for that account is `active` (goes straight through Module 43's checkout) rather than `trial`. The app never explains "why no trial" beyond the plan card simply showing the price with no trial line (`trialEligible: false`); the reason is logged server-side only (`trial_blocked: device_reused`, an app analytics event, not shown to the user).

**BR-13.4 Covered by parent's plan.** If `students.parent_id` is set, `parent_link_status = 'confirmed'`, and that parent's `subscriptions` row (`subscriber_type = 'parent'`) is live (`trial`, `active`, `grace`, `free_access`), the student is treated as fully covered: `GET /subscriptions/current?role=student` returns `status: 'covered_by_parent'` (a client-facing status distinct from the six database enum values — computed, never written to `subscriptions`), `canPurchase: false`, and Module 37/38 skip the subscription check entirely for this student. No student `subscriptions` row is created while covered. If the parent's plan later lapses, the student falls back to their own trial/paid status (creating a fresh trial only if BR‑13.1's eligibility still holds, i.e. it's genuinely their first time).

**BR-13.5 Purchase, auto-renew, cancel.** Identical mechanics to Module 10 BR-10.4–10.6, with `feeCode` from the student fee codes and `returnTo: { route: 'StudentSubscription' }`. Purchasing is hidden entirely (not just disabled) while `covered_by_parent` (BR-13.4).

**BR-13.6 Fee switched off/on and renewal reminders.** Same as Module 10 BR-10.7–10.8, scoped to `subscriber_type = 'student'`.

## 8. Validation Rules

Identical to Module 10 BR-10 validation table, with `role=student` fixed by the route (not user-editable) and fee codes restricted to `STUDENT_SUBSCRIPTION_MONTHLY`/`_YEARLY`.

## 9. API Endpoints

This module owns no new endpoints; it reuses Module 10's shared ones with `role=student`.

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | /plans | Any user | Active plans for the caller's role (`?role=student`) |
| GET | /subscriptions/current | Any user | Caller's current/most recent subscription, or `covered_by_parent` (`?role=student`) |
| POST | /subscriptions/:id/auto-renew | Any user (owner) | Turn auto-renew off |
| POST | /subscriptions/:id/cancel | Any user (owner) | Cancel now or at period end |

## 10. Request Payloads

```json
// GET /plans?role=student

// GET /subscriptions/current?role=student
```

## 11. Response Payloads

```json
// 200 GET /plans?role=student
{ "data": [
  { "feeCode": "STUDENT_SUBSCRIPTION_MONTHLY", "name": "Student membership · Monthly", "amountPaise": 19900, "billingPeriod": "monthly", "validityDays": 30, "trialDays": 7, "trialEligible": true, "perMonthPaise": 19900 },
  { "feeCode": "STUDENT_SUBSCRIPTION_YEARLY", "name": "Student membership · Yearly", "amountPaise": 149900, "billingPeriod": "yearly", "validityDays": 365, "trialDays": 7, "trialEligible": true, "perMonthPaise": 12492, "bestValue": true } ] }

// 200 GET /subscriptions/current?role=student   (trial with contacts remaining)
{ "data": { "id": "…", "feeCode": "STUDENT_SUBSCRIPTION_MONTHLY", "planName": "Student membership · Monthly", "status": "trial",
  "startsAt": "2026-09-20T09:00:00Z", "trialEndsAt": "2026-09-27T09:00:00Z", "daysLeft": 1, "trialContactsUsed": 3, "trialContactsLimit": 5, "canPurchase": true } }

// 200 GET /subscriptions/current?role=student   (covered by parent)
{ "data": { "status": "covered_by_parent", "coveredBy": { "parentId": "…", "parentName": "Lakshmi Venkatesh", "planName": "Parent membership · Yearly", "until": "2027-09-26T10:48:00Z" }, "canPurchase": false } }
```

## 12. PostgreSQL Tables & Columns


**Existing tables this module reads or writes** (full definitions in the owning module)

| Table | Owner | Purpose |
| --- | --- | --- |
| `subscriptions` | Admin M41 | Paid access periods for parents, students, teachers and institutes, including trials. |
| `payment_configurations` | Admin M05 | One row per version of each fee. The app charges whichever version is active at payment time. |
| `transactions` | Admin M40 | Every payment attempt through Razorpay, plus refunds and reward payouts. Amounts in paise. |
| `students` | Admin M31 | Student profile, one per student app account. |
| `parents` | Admin M28 | Parent profile, one per parent app account. |

- `subscriptions`, `payment_configurations`, `transactions`: same read/shared-write scope as Module 10, filtered to `subscriber_type = 'student'`.
- `students`: read `parent_id`, `parent_link_status` to compute `covered_by_parent` (BR-13.4); read `class_id`/`city_id` for nothing subscription-specific.
- `parents`: read the linked parent's live subscription status only when `parent_link_status = 'confirmed'`; no other parent data is exposed to the student.

## 16. Push Notification Requirements

| Event | Recipient | Title / Body | Deep link | Category | Urgent |
| --- | --- | --- | --- | --- | --- |
| `subscription.trial_contacts_low` | Student | "1 free contact left" / "Subscribe to keep contacting teachers without limits." | `gc://plans` | subscription | no |
| `subscription.trial_ending` | Student | "Your trial ends tomorrow" / same copy as Module 10 | `gc://plans` | subscription | no |
| `subscription.renewal_reminder` / `.grace_started` / `.expired` / `.moved_to_free_access` / `.moved_to_trial` | Student | Same templates as Module 10, student-scoped | `gc://plans` | subscription | grace only |
`trial_contacts_low` fires once, when `trialContactsUsed = trialContactsLimit − 1`, from Module 37's contact-creation path.

## 17. Security Rules

- Same ownership model as Module 10 (`user_id = sub` on every subscription action).
- `covered_by_parent` reveals only the parent's first name and plan name/end date to the student — never the parent's phone/email or payment history.
- Trial-abuse signals (`trial_blocked: device_reused`) are analytics-only, never shown to the user and never exposed through this API (conventions §13 — device fingerprint is never PII the client can read back).

## 18. Error Handling

Same table as Module 10 BR-10 errors, plus:

| Scenario | Code | HTTP | App behaviour |
| --- | --- | --- | --- |
| Purchase attempted while `covered_by_parent` | `CONFLICT_STATE` (`covered_by_parent`) | 409 | Toast "You're covered by your parent's membership."; UI shouldn't have shown Subscribe at all |
| Contact attempted after trial contacts exhausted (pre-`trial_ends_at`) | `SUBSCRIPTION_REQUIRED` | 402 | Module 37 opens `StudentPlans` |

## 19. Testing Scenarios

- T13.1 (Maestro `student_subscribe_trial`) New unlinked student → Plans shows 7-day trial with 5 free contacts → contacts 5 teachers → 6th contact attempt blocked with `SUBSCRIPTION_REQUIRED` even though 2 trial days remain.
- T13.2 Student with `parent_link_status = 'confirmed'` and the parent on an active yearly plan → Plans shows "Covered by parent", no plan cards, Subscribe hidden.
- T13.3 Parent's plan expires → student's own trial/paid state takes over on next check; if the student never had a subscription row, a fresh trial starts.
- T13.4 Second registration on the same device fingerprint → new account's first subscription is `active` from first payment, no trial line shown on Plans.
- T13.5 4th of 5 trial contacts made → `subscription.trial_contacts_low` push received.
- T13.6 Subscribe on Yearly → PaymentSheet → pay → trial ends immediately, `active` starts (Module 43/Admin M41 FR-41.2), contacts become unlimited.
- T13.7 Turn off auto-renew, then cancel at period end → same behaviour and messages as Module 10 T10.3/T10.9.
- T13.8 Offline → Subscribe/auto-renew/cancel disabled; cached status (including trial contacts remaining) still visible.
- T13.9 Admin grants a scholarship (`programTag: 'scholarship'`, Admin M32 FR‑32.3) → student's Plans shows `free_access`-equivalent "active" state with `price_paise = 0`, no trial UI.
- T13.10 `SUBSCRIPTION_REQUIRED` thrown from a demo booking attempt (Module 38) → `StudentPlans` opens as a modal; back returns to the booking screen.

## 20. Audit Log Events

| Event | When | Details |
| --- | --- | --- |
| `app.subscription_auto_renew_disabled` / `app.subscription_cancel_requested` | Same triggers as Module 10 | subscription id, mode/reason |
Trial-contact decrements are not separately audited (derived from `leads`, already audited by Module 37); `covered_by_parent` computation is read-only and not an event.

---

# Part E. Exact table definitions (from sql/schema.sql)

These are the authoritative column names, types and constraints. Do not rename or add columns. If a change is truly needed, say so as a question.

```sql
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

-- @table teacher_teaching_modes: Teaching modes a teacher offers (Online, Home tuition, …).
CREATE TABLE teacher_teaching_modes (
  teacher_id uuid NOT NULL REFERENCES teachers(id) ON DELETE CASCADE, -- Teacher
  teaching_mode_id uuid NOT NULL REFERENCES teaching_modes(id) ON DELETE RESTRICT, -- Mode offered
  created_at timestamptz NOT NULL DEFAULT now(), -- Created
  PRIMARY KEY (teacher_id, teaching_mode_id)
);
CREATE INDEX idx_teacher_teaching_modes_mode ON teacher_teaching_modes (teaching_mode_id);

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

```
