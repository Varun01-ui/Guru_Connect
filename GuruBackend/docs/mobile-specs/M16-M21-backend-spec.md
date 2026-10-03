# Backend specification: mobile app modules M16 to M21

This document is self-contained: exact specification text (copied verbatim from the product spec) and exact PostgreSQL table definitions. Implement exactly what is written here. If something is not specified in this document, do not invent it: list it as a question instead.

Modules in scope: **M16** Teacher Verification Status, **M17** Teacher Profile Builder, **M18** Teacher Dashboard, **M19** Teacher Availability, **M20** Teacher Notifications, **M21** Institute Registration.

## 0. Context you need before starting

**Already built**: M00 (platform subset), M01 bootstrap, M04 auth, M05/M06 parent registration, M07 children, M08 parent home, M09 parent profile, M10/M13 subscriptions, M11 student registration, M12 student home, M14 teacher registration (draft creation, basics, qualifications, subjects/classes/modes/locations), M15 teacher documents + submit for verification, uploads, payments. This batch is the teacher's post-approval experience (M16-M19), the shared notification-preferences endpoints (M20), and institute registration (M21, the institute's equivalent of M06/M14).

**M16 is the gate.** A teacher only reaches M17/M18/M19 once Admin has approved their M15 submission (`teachers.verification_status = 'approved'`). Build M16 first so you can set a teacher to `approved` in your dev database and test the rest.

**M20's endpoints are shared infrastructure**, already partly described under M00 as `NotificationService`/device registration — this document gives the actual `/notification-preferences` endpoints a teacher (or any role) uses to control them. Push delivery (Firebase) is still out of scope; only the preference rows and in-app notification list need to be real.

**M21 reuses M04/M05/M00 endpoints you already built** (`/auth/otp/*`, `/registration/context`, `/registration/referral/validate`, `/masters`, `/masters/areas`) — follow `POST /registration/parent` and `POST /registration/teacher` as the pattern for `POST /registration/institute`.

**Provider stubs:** no SMS, Razorpay, R2 or Firebase credentials — keep using the dev provider interfaces already in place (console SMS/email, local-disk storage, fake payment gateway).

**Order to build:** M16, then M19 (independent of M17), then M17, then M18 (reads what M16/M17 produce), then M20, then M21 last (a different role's registration, independent of the others).


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

Each module is copied in full for the sections a backend needs (purpose, business rules, validation, endpoints, request/response payloads, tables, notifications, security, error handling, test scenarios, audit events). Screen/UI sections are omitted (mobile-only).


---

## Module 16 · Teacher Verification Status [M16]

## 1. Module Purpose

The single screen a teacher checks after submitting: where their application stands, which documents (if any) need attention, and a full timeline of what's happened. It translates the six internal `teachers.verification_status` values into four things a teacher actually needs to see — Pending, Approved, Rejected, Re-upload Required — while still showing per-document detail from `teacher_documents.status` so a teacher whose Aadhaar is already approved but whose certificate is still being checked isn't left guessing. It also owns the resubmit action that returns a `reupload_requested` teacher to the queue after they've replaced the flagged documents in Module 15.

## 3. Business Rules & Logic

**BR-16.1 Status mapping.** `teachers.verification_status` maps to the app-facing status as: `draft` → not shown (this screen is only reachable after Module 15's submit); `pending` and `under_review` → **Pending** (both are "we're reviewing it" from the teacher's side — the internal claim/assignment mechanics of Admin M16 are never exposed); `reupload_requested` → **Re-upload Required**; `approved` → **Approved**; `rejected` → **Rejected**. `GET /teacher/verification` returns both the raw `verificationStatus` (for deep-link/analytics use) and the mapped `displayStatus`.
**BR-16.2 Document checklist.** For each of the six `teacher_documents.doc_type` values with a current row, the screen shows `teacher_documents.status` as one of: Uploaded (submitted), Approved, Needs re-upload (reupload_requested, with `review_note` shown verbatim — it is always teacher-safe copy per Admin FR-16.5/validation), Rejected (with `review_note`). A missing optional type (`professional_certificate`, `experience_letter`) shows nothing. This lets a teacher see partial progress (e.g. "3 of 4 approved") while the overall status is still Pending.
**BR-16.3 Non-internal notes.** `teacher_verification_logs` rows with `is_internal = false` are shown in the timeline as messages from GuruConnect (e.g. a reviewer's non-internal note); `is_internal = true` rows are never returned by this endpoint at all — the API filters them server-side, not the client.
**BR-16.4 Timeline.** `GET /teacher/verification` includes the last 20 `teacher_verification_logs` rows for the teacher (oldest first), each rendered as one of: "Application submitted" (`submitted`), "Re-submitted" (`resubmitted`), a per-document line "{doc type} approved/needs changes" (`document_approved`/`document_rejected`/`reupload_requested`, using `document_id` to label the type), "Application approved" (`approved`), "Application rejected" (`rejected`, with the rejection reason in plain copy — see BR-16.6), "Verified badge granted" (`badge_granted`, shown only if `is_verified_badge`). `assigned`, `note_added` (internal), and `auto_check` rows are never surfaced.
**BR-16.5 Approved.** When `displayStatus = 'Approved'`, the screen also shows whether the Verified badge was granted (`teachers.is_verified_badge`) and a "Complete your profile" call to action into Module 17 (fee plans, availability, bio) since a bare-minimum approved profile ranks poorly in search.
**BR-16.6 Rejected.** Shows `teachers.rejection_reason_code` translated to teacher-safe copy (e.g. `NAME_MISMATCH` → "The name on your documents didn't match.") and `rejection_note`. Per Admin FR-16.9, a rejected teacher may re-apply: the screen shows "You can apply again in {n} days" counting 30 days from `rejected_at`, or "You can apply again" with a button once that window has passed — re-applying is a fresh `POST /registration/teacher`-style flow handled by Admin support resetting the record to `draft` (out of this module's scope; the button simply deep-links to Module 5's registration-context check, which routes appropriately). `FORGED_DOCUMENT` rejections additionally show a permanent "This account can't reapply — contact support" state (the account is suspended server-side; `GET /me` already reflects `ACCOUNT_SUSPENDED` and Module 0 routes to `AccountBlocked` before this screen would even load).
**BR-16.7 Resubmit.** `POST /teacher/verification/resubmit` requires `teachers.verification_status = 'reupload_requested'` and that every current document with `status IN ('reupload_requested', 'rejected')` at the time re-upload was requested now has a newer current version with `status = 'submitted'` (Module 15 uploads already guarantee this — a fresh upload always creates a new current row with `status = 'submitted'`). In one transaction: `teachers.verification_status = 'pending'` (NOT `submitted_at`, which keeps its original value so Admin M16's SLA clock is unaffected — Admin FR-16.7); insert `teacher_verification_logs` (`action = 'resubmitted'`, `from_status = 'reupload_requested'`, `to_status = 'pending'`); audit `app.teacher_verification_resubmitted`; push/in-app confirmation. If any flagged document still shows `reupload_requested`/`rejected`, the call fails with `VALIDATION_FAILED` (`details.pending[]` lists the doc types still outstanding) and the button stays labelled "Upload the remaining documents first" client-side.
**BR-16.8 Polling and push.** The screen refetches on foreground and pulls to refresh; it also listens for the `verification` push category (Module 20) to invalidate and refetch immediately rather than waiting for the next foreground, so a teacher who has the app open in the background sees the update the moment the push arrives.

## 8. Validation Rules

| Field | Rule | Message shown |
| --- | --- | --- |
| Resubmit precondition | every previously flagged document has a newer `submitted` version | "Upload the remaining documents first" |
No user-entered fields on this screen beyond the resubmit action itself (no body).

## 9. API Endpoints

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | /teacher/verification | Teacher | Mapped status, document checklist, timeline |
| POST | /teacher/verification/resubmit | Teacher | Return a reupload_requested application to the queue |

## 10. Request Payloads

```json
// GET /teacher/verification
// POST /teacher/verification/resubmit   (no body)
```

## 11. Response Payloads

```json
// 200 GET /teacher/verification  (Re-upload Required)
{ "data": {
  "verificationStatus": "reupload_requested", "displayStatus": "reupload_required", "submittedAt": "2026-09-20T05:10:00Z",
  "isVerifiedBadge": false,
  "documents": [
    { "docType": "aadhaar", "status": "approved" },
    { "docType": "pan", "status": "reupload_requested", "reviewNote": "The image is blurry — please retake it in good light.", "replaced": false },
    { "docType": "education_certificate", "status": "approved" },
    { "docType": "photo", "status": "approved" } ],
  "canResubmit": false,
  "timeline": [ { "at": "2026-09-20T05:10:00Z", "event": "submitted", "label": "Application submitted" },
                { "at": "2026-09-22T11:00:00Z", "event": "document_rejected", "label": "PAN needs changes", "docType": "pan" } ] } }

// 200 GET /teacher/verification  (Rejected)
{ "data": { "verificationStatus": "rejected", "displayStatus": "rejected", "rejectionReasonCode": "NAME_MISMATCH",
  "rejectionNote": "The name on your PAN card doesn't match your Aadhaar. Please re-apply with matching documents.",
  "rejectedAt": "2026-08-20T09:00:00Z", "canReapplyAt": "2026-09-19T09:00:00Z", "reapplyBlocked": false } }

// 422 POST /teacher/verification/resubmit
{ "error": { "code": "VALIDATION_FAILED", "message": "Upload the remaining documents first.", "details": { "pending": ["pan"] }, "requestId": "…" } }
```

## 12. PostgreSQL Tables & Columns


**Existing tables this module reads or writes** (full definitions in the owning module)

| Table | Owner | Purpose |
| --- | --- | --- |
| `teachers` | Admin M16 | Teacher profile and verification state. One row per teacher app account. |
| `teacher_documents` | Admin M16 | Every uploaded verification document version. Only one current version per teacher and type. |
| `teacher_verification_logs` | Admin M16 | Timeline of every verification event for a teacher, shown in the review screen. |

This module only reads. `teachers.verification_status` is written by Admin M16 (claim/approve/reject) and by this module's `POST /teacher/verification/resubmit` (the only write it owns: `reupload_requested → pending`, `submitted_at` untouched). `teacher_documents.status`/`review_note` are admin-written (Admin M16) or reset to `submitted` by Module 15 uploads. `teacher_verification_logs` rows are inserted by Admin M16, Module 15 (`submitted`) and this module (`resubmitted`); this module filters out `is_internal = true` rows before returning the timeline.

## 16. Push Notification Requirements

| Event | Recipient | Title / Body | Deep link | Category | Urgent |
| --- | --- | --- | --- | --- | --- |
| Document approved | Teacher | "Document approved" / "Your {docType} has been approved." | `gc://teacher/verification` | verification | No |
| Re-upload requested | Teacher | "Action needed on your application" / "We need a clearer copy of your {docType}." | `gc://teacher/verification` | verification | No |
| Application approved | Teacher | "You're verified! 🎉" / "Your GuruConnect profile is now live. Complete it to start getting leads." | `gc://teacher/verification` | verification | Yes |
| Application rejected | Teacher | "Update on your application" / "Your application wasn't approved this time." | `gc://teacher/verification` | verification | No |
All are sent by Admin M16's actions (Module 0's `NotificationService`) and Module 15's submit confirmation; this module only consumes them to refresh its own screen (BR-16.8).

## 17. Security Rules

- `GET /teacher/verification` and `POST /teacher/verification/resubmit` are scoped to `teacher_id = pid`; a teacher can never see another teacher's verification detail.
- Only teacher-safe copy ever reaches the app: `review_note`/`rejection_note` are validated admin-side to be free of internal jargon (Admin validation rules), but this endpoint additionally strips any note flagged `is_internal` regardless of source table, as defence in depth.
- No document thumbnails are shown on this screen (that's Module 15's job while editable); this screen is read-mostly and does not need `FLAG_SECURE`.

## 18. Error Handling

| Scenario | Code | HTTP | App behaviour |
| --- | --- | --- | --- |
| Teacher not yet submitted (`draft`) | `NOT_FOUND` | 404 | Redirect to Module 14/15 instead of showing this screen |
| Resubmit with documents still flagged | `VALIDATION_FAILED` (`details.pending[]`) | 422 | Button stays "Upload the remaining documents first", list highlighted |
| Resubmit when status isn't `reupload_requested` | `CONFLICT_STATE` | 409 | Refetch; screen just shows the current (already-changed) status |
| Network error on load | `NETWORK_OFFLINE` / `GATEWAY_ERROR` | — | Cached status shown with "Updated Xh ago"; Retry banner |

## 19. Testing Scenarios

- T16.1 `pending` and `under_review` both render as "Under review" with no functional difference visible to the teacher.
- T16.2 One document `reupload_requested`, others `approved` → checklist shows 3/4 approved and only the flagged one actionable.
- T16.3 Resubmit blocked while the flagged PAN hasn't been re-uploaded; unblocked immediately after Module 15 uploads a new current PAN version.
- T16.4 Successful resubmit sets status to Pending in the UI without a page reload and keeps the original submitted-at date shown ("Submitted 6 days ago", not reset to today).
- T16.5 Approved teacher sees the Verified badge chip only when `isVerifiedBadge` is true.
- T16.6 Rejected with `NAME_MISMATCH` shows the 30-day re-apply countdown; after the countdown, "Apply again" becomes enabled.
- T16.7 Rejected with `FORGED_DOCUMENT` never shows a re-apply path (this state is in practice unreachable in-app since the account is suspended first, but the copy is tested in isolation).
- T16.8 A `verification` push arriving while the screen is open triggers an immediate refetch, not just on next foreground.
- T16.9 Internal-only log rows (`is_internal = true`, `assigned`, `note_added`, `auto_check`) never appear in the rendered timeline (asserted against a fixture with mixed rows).
- T16.10 Offline: cached "Pending" status renders with a staleness hint; the resubmit button is disabled with "Connect to send this back for review."

## 20. Audit Log Events

| Event | When | Details |
| --- | --- | --- |
| `app.teacher_verification_resubmitted` | Successful resubmit | from status, documents that were replaced |

---

## Module 19 · Teacher Availability [M19]

## 1. Module Purpose

Lets an approved teacher declare the weekly hours they can take classes or demo requests, and mark date ranges they're away (exams, travel, illness) so demo booking blocks those dates and the profile shows "Away" instead of silently going unanswered. Module 38 reads these two tables (plus existing `demo_requests`) to compute the actual bookable slots a parent sees — this module owns the input, not the slot-generation algorithm.

## 3. Business Rules & Logic

**BR-19.1 Weekly windows (owns `teacher_availability`).** `PUT /teacher/availability { items: [{ dayOfWeek, startTime, endTime, teachingModeId?, acceptsDemos }] }` replaces the whole set in one transaction (same replace-set pattern as Module 14/18's set endpoints): insert new, delete removed, update changed. `dayOfWeek` 0 (Sunday) – 6 (Saturday), IST. 0–5 windows per day; windows on the same day must not overlap **regardless of `teachingModeId`** (a teacher is one person and can only be in one window at a time even if one window is tagged "online" and another "home tuition"). `teachingModeId`, if set, must be one of the teacher's own `teacher_teaching_modes` (Module 14); if omitted, the window applies to any of the teacher's modes. `acceptsDemos` marks whether Module 38 may offer this window for a **free demo** (a teacher might keep weekday evenings for paying students only and reserve weekend slots for demos).
**BR-19.2 Time off (owns `teacher_time_off`).** `POST /teacher/time-off { startsOn, endsOn, reason?, pauseLeads }` adds a date range (inclusive, IST calendar dates). Ranges for the same teacher must not overlap each other; max 10 active (non-expired) ranges at a time; `endsOn − startsOn` ≤ 90 days. `pauseLeads: true` additionally hides the teacher from new lead/demo requests for the duration (BR-19.4) and shows "Away until {date}" on the public profile (Module 31); `pauseLeads: false` only blocks new demo slots in that range (Module 38) without otherwise affecting lead visibility — e.g. a teacher who is simply not available for demos this week but still wants enquiry messages.
**BR-19.3 Clash with existing demos.** Creating a `teacher_time_off` row (with either `pauseLeads` value) checks `demo_requests` for this teacher with `status IN ('requested','confirmed','reschedule_proposed')` and a start (`confirmed_start_at` or, if not yet confirmed, `requested_start_at`) inside `[startsOn 00:00 IST, endsOn 23:59 IST]`. If any are found and the request did not pass `confirmForce: true`, the call returns `409 CONFLICT_STATE` with the list of affected demos (`{ demoId, requesterName, startAt }`) so the app can show "You have 2 demos in this range — Cancel them / Choose different dates". With `confirmForce: true`, the time-off row is created and, in the same transaction, every affected demo is set to `status = 'cancelled'`, `cancelled_by = 'teacher'`, `cancel_reason = 'Teacher marked this period as time off'`; both sides are notified (Module 38's cancellation push, not duplicated here) and the underlying lead is left open (matches Admin FR-39's cancellation semantics — a cancelled demo doesn't close the lead).
**BR-19.4 Effect of an active time off with `pauseLeads = true`.** While `now()` (IST date) falls inside such a range: the teacher does not appear in Module 27 Teacher Search's default results (an explicit-name or shared-link view still works, marked "Away"); Module 37 blocks new leads to this teacher with `BLOCKED`-style messaging ("This teacher is away until {date}. Try again later or explore similar teachers.") — existing open leads and their messages remain fully usable; Module 38 shows no bookable demo slots for the range. None of this changes `teachers.account_status` or `verification_status` — it is a visibility flag read by those other modules, not a suspension.
**BR-19.5 Deleting time off.** `DELETE /teacher/time-off/:id` removes it early (hard delete — nothing references it once removed; any demos already cancelled by BR-19.3 stay cancelled, they are not un-cancelled). Deleting a range that has already fully elapsed is a no-op cleanup allowed at any time.
**BR-19.6 Reads for other modules.** `GET /teacher/availability` returns the weekly windows plus the active/upcoming time-off ranges in one payload; this is what the Profile Builder's Availability card (Module 17 BR-17.7) and the Dashboard summarise. Module 38's slot generation and Module 31's public "Availability" section call the same underlying data through their own read paths (documented there), not through this module's endpoints, to keep read-scaling independent of the teacher-facing screen.

## 8. Validation Rules

| Field | Rule | Message shown |
| --- | --- | --- |
| dayOfWeek | 0–6 | — |
| startTime / endTime | `HH:mm`, endTime > startTime, window ≥ 30 min | "End time must be after start time" |
| windows per day | 0–5, non-overlapping | "This overlaps another window on the same day" |
| teachingModeId | optional, one of the teacher's own modes | — |
| startsOn / endsOn (time off) | dates, endsOn ≥ startsOn, span ≤ 90 days, startsOn ≥ today | "Pick a range up to 90 days" |
| reason | ≤ 200 chars, optional | — |
| active time-off ranges | ≤ 10, non-overlapping with each other | "You already have time off marked for these dates" |

## 9. API Endpoints

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | /teacher/availability | Teacher | Weekly windows + time-off ranges |
| PUT | /teacher/availability | Teacher | Replace the weekly window set |
| GET | /teacher/time-off | Teacher | List time-off ranges |
| POST | /teacher/time-off | Teacher | Add a time-off range (Idempotency-Key) |
| DELETE | /teacher/time-off/:id | Teacher | Remove a time-off range early |

## 10. Request Payloads

```json
// PUT /teacher/availability
{ "items": [ { "dayOfWeek": 1, "startTime": "18:00", "endTime": "21:00", "teachingModeId": "…online…", "acceptsDemos": true },
             { "dayOfWeek": 6, "startTime": "10:00", "endTime": "13:00", "teachingModeId": "…home-tuition…", "acceptsDemos": true } ] }

// POST /teacher/time-off
{ "startsOn": "2026-10-03", "endsOn": "2026-10-12", "reason": "Family trip", "pauseLeads": true }

// POST /teacher/time-off   (retry after clash)
{ "startsOn": "2026-10-03", "endsOn": "2026-10-12", "reason": "Family trip", "pauseLeads": true, "confirmForce": true }
```

## 11. Response Payloads

```json
// 200 GET /teacher/availability
{ "data": { "windows": [ { "id": "…", "dayOfWeek": 1, "startTime": "18:00", "endTime": "21:00", "teachingMode": "Online", "acceptsDemos": true } ],
  "timeOff": [ { "id": "…", "startsOn": "2026-10-03", "endsOn": "2026-10-12", "reason": "Family trip", "pauseLeads": true } ] } }

// 409 POST /teacher/time-off  (clash)
{ "error": { "code": "CONFLICT_STATE", "message": "You have demos scheduled during this time.", "details": {
  "affectedDemos": [ { "demoId": "…", "requesterName": "Lakshmi V.", "startAt": "2026-10-05T12:30:00Z" } ] }, "requestId": "…" } }

// 201 POST /teacher/time-off  (with confirmForce)
{ "data": { "id": "…", "startsOn": "2026-10-03", "endsOn": "2026-10-12", "pauseLeads": true, "cancelledDemoCount": 2 } }
```

## 12. PostgreSQL Tables & Columns

**New tables owned by this module** (migration `sql/migrations/119_app_m19_teacher_availability.sql`)

### `teacher_availability`

Weekly recurring time windows when a teacher can take classes or demos (IST).

| Column | Type | Null | Default | Constraints / References | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | uuid | no | gen_random_uuid() | PK | Primary key |
| `teacher_id` | uuid | no | — | FK → `teachers.id` (on delete cascade) | Owner |
| `day_of_week` | smallint | no | — | CHECK day_of_week BETWEEN 1 AND 7 | ISO day: 1 = Monday … 7 = Sunday |
| `start_time` | time | no | — | — | Local start, e.g. 16:00 |
| `end_time` | time | no | — | — | Local end, e.g. 20:00 |
| `teaching_mode_id` | uuid | yes | — | FK → `teaching_modes.id` (on delete restrict) | NULL = any mode |
| `accepts_demos` | boolean | no | true | — | Demo slots can be booked in this window |
| `created_at` | timestamptz | no | now() | — | Created |
| `updated_at` | timestamptz | no | now() | — | Updated |
| `deleted_at` | timestamptz | yes | — | — | Soft delete |

**Table constraints:** `CONSTRAINT ck_teacher_availability_window CHECK (end_time > start_time AND end_time - start_time >= interval '30 minutes')`

<details><summary>DDL</summary>

```sql
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
```

</details>

**Indexes:** `idx_teacher_availability_teacher` on `(teacher_id, day_of_week, start_time) WHERE deleted_at IS NULL`; `idx_teacher_availability_search` on `(day_of_week, start_time, end_time) WHERE deleted_at IS NULL`

### `teacher_time_off`

Dates when a teacher is unavailable (holidays, exams). Blocks demo booking and shows "Away" on the profile.

| Column | Type | Null | Default | Constraints / References | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | uuid | no | gen_random_uuid() | PK | Primary key |
| `teacher_id` | uuid | no | — | FK → `teachers.id` (on delete cascade) | Owner |
| `starts_on` | date | no | — | — | First day off |
| `ends_on` | date | no | — | — | Last day off (inclusive) |
| `reason` | text | yes | — | — | Private note, max 120 chars |
| `pause_leads` | boolean | no | false | — | Stop new leads during the period |
| `created_at` | timestamptz | no | now() | — | Created |
| `deleted_at` | timestamptz | yes | — | — | Soft delete |

**Table constraints:** `CONSTRAINT ck_teacher_time_off_range CHECK (ends_on >= starts_on AND ends_on - starts_on <= 90)`

<details><summary>DDL</summary>

```sql
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
```

</details>

**Indexes:** `idx_teacher_time_off_teacher` on `(teacher_id, starts_on) WHERE deleted_at IS NULL`

**Existing tables this module reads or writes** (full definitions in the owning module)

| Table | Owner | Purpose |
| --- | --- | --- |
| `demo_requests` | Admin M39 | Free demo class bookings and their outcome. |

| Column | Written by this module |
| --- | --- |
| `teacher_availability.*` | owned outright (replace-set) |
| `teacher_time_off.*` | owned outright |
| `demo_requests.status`, `.cancelled_by`, `.cancel_reason` | set to `cancelled` only as the BR-19.3 side effect of a confirmed time-off clash — this module never otherwise touches `demo_requests` |

## 16. Push Notification Requirements

| Event | Recipient | Title / Body | Deep link | Category | Urgent |
| --- | --- | --- | --- | --- | --- |
| Demo cancelled by time off | Requester (parent/student) | "Your demo was cancelled" / "{Teacher} marked this time as unavailable. Find another slot or teacher." | `gc://demos/:id` | demos | No |
Sent as part of Module 38's normal demo-cancellation notification pipeline when BR-19.3's `confirmForce` path runs; this module triggers the state change, Module 38/0 own the actual push template.

## 17. Security Rules

- Every read/write is scoped to `teacher_id = pid`.
- `pauseLeads` visibility (BR-19.4) is enforced server-side in Module 27/37/38's own queries (a filter on `teacher_time_off`), not by hiding data client-side, so it can't be bypassed by an old cached app build.
- Cancelling demos via BR-19.3 requires the explicit `confirmForce: true` the teacher only sends after seeing the clash dialog — the server never silently cancels a demo the teacher hasn't been shown.

## 18. Error Handling

| Scenario | Code | HTTP | App behaviour |
| --- | --- | --- | --- |
| Overlapping windows same day | `VALIDATION_FAILED` | 422 | Inline on the grid, new window highlighted |
| More than 5 windows in a day | `VALIDATION_FAILED` | 422 | "Up to 5 windows per day" |
| Time-off clash without `confirmForce` | `CONFLICT_STATE` | 409 | Clash dialog shown |
| Overlapping time-off ranges | `VALIDATION_FAILED` | 422 | "You already have time off marked for these dates" |
| 11th active time-off range | `VALIDATION_FAILED` (`reason: max_time_off`) | 422 | "Remove an old range first" |
| Delete a non-existent/foreign time-off id | `NOT_FOUND` | 404 | Toast, list refetched |

## 19. Testing Scenarios

- T19.1 Saving two non-overlapping windows on Monday succeeds; a third overlapping one is rejected before any write.
- T19.2 Adding time off with no clashing demos succeeds immediately with `cancelledDemoCount: 0`.
- T19.3 Adding time off overlapping one confirmed demo returns 409 with that demo listed; retrying with `confirmForce: true` cancels it and the requester is notified (asserted via Module 38's mocked notify call).
- T19.4 `pauseLeads: false` time off blocks Module 38 demo slots for the range but a new lead (enquiry) can still be sent (cross-module fixture against Module 37).
- T19.5 Deleting an upcoming time-off range removes it from `GET /teacher/availability`; a demo already cancelled by BR-19.3 stays cancelled.
- T19.6 11th active time-off range is rejected until one is deleted or expires.
- T19.7 A window without `teachingModeId` is treated as applying to all the teacher's modes when Module 38 generates slots (fixture asserts against Module 38's slot generator, not this module).
- T19.8 Offline: the weekly grid renders cached windows; Save/Add are disabled with "Connect to save your availability."
- T19.9 `endsOn` before `startsOn` is rejected client-side and server-side.
- T19.10 A time-off range longer than 90 days is rejected.

## 20. Audit Log Events

| Event | When | Details |
| --- | --- | --- |
| `app.teacher_availability_set` | `PUT /teacher/availability` succeeds | window count |
| `app.teacher_time_off_added` | `POST /teacher/time-off` succeeds | dates, pauseLeads, cancelledDemoCount |
| `app.teacher_time_off_removed` | `DELETE /teacher/time-off/:id` succeeds | dates |

---

## Module 17 · Teacher Profile Builder [M17]

## 1. Module Purpose

The teacher's "Profile" tab: everything that makes an approved teacher's public listing complete and competitive — About (bio, photo), Experience, Languages, Subjects and Classes (reusing Module 14's own editors), a Fee Structure builder (owns `teacher_fee_plans`), and a link out to Availability (Module 19). It computes and shows the same profile-completeness percentage Admin M17 computes server-side, so a teacher always sees the identical number an admin would. A live preview screen renders the profile exactly as parents see it, so a teacher can check their own listing before it goes live in search.

## 3. Business Rules & Logic

**BR-17.1 Access gate.** `GET /teacher/profile` and `GET /teacher/profile/preview` work in every `verification_status` (a not-yet-approved teacher can review their draft data, shown with a "Not visible to parents yet" watermark on the preview). Every write endpoint (`PATCH /teacher/profile`, all `/teacher/fee-plans` writes) requires `verification_status = 'approved'`; any other status returns `409 CONFLICT_STATE` (`reason: not_approved`) and the screen shows the Module 16 verification banner instead of edit controls. Subjects, Classes, Teaching modes and Locations sections on this tab are read-only summaries that deep-link into Module 14's own editors (BR-14.8 already gates those to `draft`/`approved`).
**BR-17.2 Profile fields.** `PATCH /teacher/profile { fullName?, gender?, dateOfBirth?, email?, categoryId?, languages?, experienceYears?, highestQualification?, bio?, feePerHourPaise?, demoAvailable?, profilePhotoFileId?, reason? }` (If-Match on `teachers.updated_at`) — a superset partial update of the same columns Module 14 sets during registration, now available post-approval. `fullName` and `dateOfBirth` are identity-linked: changing either on an approved teacher requires `reason` (10–500 chars) and writes a `teacher_verification_logs` row (`action = 'note_added'`, `is_internal = true`, `metadata: { profile_changed_after_approval: true, field, oldValue, newValue }`) so Admin M16/M17 see it in the timeline, matching Admin FR-17.3; it does **not** change `verification_status`. `profilePhotoFileId` must reference a `files` row with `purpose = 'teacher_photo'`, `status = 'active'`, uploaded by this teacher (Module 0 presign, public bucket) — this is the public listing photo, distinct from the private verification selfie Module 15 collected.
**BR-17.3 Fee plans (owns `teacher_fee_plans`).** `POST /teacher/fee-plans { label, subjectId?, classFromId?, classToId?, teachingModeId?, feeUnit, amountPaise, sessionsPerWeek?, sessionMinutes?, notes? }` appends a plan (`sortOrder` = max + 1, `isActive = true`). `PATCH /teacher/fee-plans/:id` edits one (ownership-scoped). `DELETE /teacher/fee-plans/:id` soft-deletes (`deleted_at`) — plans are never hard-deleted since they may be referenced from a lead or demo conversation history. `GET /teacher/fee-plans` (folded into `GET /teacher/profile`) lists active plans ordered by `sort_order`. Limit: 1–12 active plans per teacher.
**BR-17.4 Fee plan validation logic.** `classFromId`'s `level_order` (Module 0 masters) must be ≤ `classToId`'s; `subjectId`, if set, must be one of the teacher's current `teacher_subjects`; `teachingModeId`, if set, must be one of the teacher's current `teacher_teaching_modes`; `feeUnit = 'per_hour'` requires `sessionMinutes` (15–180); `per_month`/`per_course` require `sessionsPerWeek` (1–14). `amountPaise` follows the same ceiling as Admin FR-17.5: 0–1,00,00,000 paise (₹1,00,000), sense-checked client-side against `per_hour` plans over ₹10,000/hour with a soft confirmation ("That's an unusually high rate — are you sure?").
**BR-17.5 Profile completeness (matches Admin FR-17.8 exactly).** Recomputed after every write from this module or from Module 14's reused endpoints (subjects/classes/locations/qualifications) and written to `teachers.profile_completeness`: photo 15 (`profile_photo_file_id` set), bio 10 (`bio` ≥ 100 chars), qualification 10 (≥ 1 `teacher_qualifications` row), experience 5 (`experience_years` set), subjects 15 (≥ 1 `teacher_subjects` row), classes 10 (≥ 1 `teacher_classes` row), locations 10 (≥ 1 `teacher_locations` row OR every teaching mode is online-only), fee 5 (≥ 1 active `teacher_fee_plans` row OR `fee_per_hour_paise` set), languages 5 (≥ 1 language), certificate 15 (≥ 1 `teacher_documents` of type `education_certificate` with `status = 'approved'` — the only factor this module cannot itself satisfy; it can only reach 85 until Module 16's admin approves a certificate). `GET /teacher/profile` returns the total plus a per-item checklist (`{ key, label, earned, of }`) driving the "Complete your profile" card.
**BR-17.6 Preview.** `GET /teacher/profile/preview` returns the same shape Module 31 (public Teacher Profile View) would show a parent — trust score, rating, fee plans, availability summary from Module 19, verified badge — so the teacher sees exactly what's public. While not `approved`, every field is still returned but the response carries `visibleToParents: false` and the app renders a "Preview only — not visible until approved" banner over it.
**BR-17.7 Availability link.** This tab shows a summary card ("3 weekly slots · Demos available Mon–Fri evenings") read from Module 19's own endpoint (`GET /teacher/availability`, called by this screen, not owned here) with a "Manage availability" button that navigates to Module 19; no availability data is written from this module.

## 8. Validation Rules

| Field | Rule | Message shown |
| --- | --- | --- |
| fullName / dateOfBirth (if changed) | same as Module 14; `reason` 10–500 chars required | "Tell us why you're changing this" |
| bio | ≤ 2,000 chars, no phone/email/URL | "Remove phone numbers, emails or links" |
| profilePhotoFileId | active `teacher_photo` file owned by this teacher | "Upload a photo first" |
| feePlans.label | 2–60 chars | "Give this plan a short name" |
| feePlans.feeUnit | per_hour, per_month, per_course | — |
| feePlans.amountPaise | 0–1,00,00,000 paise | "Enter a valid amount" |
| feePlans.sessionMinutes | 15–180, required for per_hour | "Enter a class length" |
| feePlans.sessionsPerWeek | 1–14, required for per_month/per_course | "Enter sessions per week" |
| feePlans count | 1–12 active plans | "You can add up to 12 fee plans" |
| feePlans.subjectId / teachingModeId | must belong to the teacher's own sets | "Add this subject/mode to your profile first" |

## 9. API Endpoints

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | /teacher/profile | Teacher | Full profile, completeness checklist, fee plans |
| PATCH | /teacher/profile | Teacher | Edit About/Experience fields (If-Match) |
| GET | /teacher/profile/preview | Teacher | Public-shaped preview |
| GET | /teacher/fee-plans | Teacher | List active fee plans |
| POST | /teacher/fee-plans | Teacher | Add a fee plan |
| PATCH | /teacher/fee-plans/:id | Teacher | Edit a fee plan |
| DELETE | /teacher/fee-plans/:id | Teacher | Remove a fee plan |

## 10. Request Payloads

```json
// PATCH /teacher/profile   (If-Match: "2026-09-26T09:00:11.000Z")
{ "bio": "I've taught JEE Physics for 14 years, focusing on problem-solving speed for the exam.", "languages": ["English","Hindi","Kannada"], "profilePhotoFileId": "…" }

// POST /teacher/fee-plans
{ "label": "JEE Physics batch", "subjectId": "…physics…", "classFromId": "…class-11…", "classToId": "…class-12…", "teachingModeId": "…online…",
  "feeUnit": "per_month", "amountPaise": 400000, "sessionsPerWeek": 3, "notes": "Group batch of up to 8 students" }
```

## 11. Response Payloads

```json
// 200 GET /teacher/profile
{ "data": { "teacher": { "id": "…", "fullName": "Dr. Ananya Iyer", "bio": "…", "languages": ["English","Hindi"], "photoUrl": "https://cdn.guruconnect.in/…",
  "experienceYears": 14, "highestQualification": "Ph.D. Physics, IISc Bengaluru", "feePerHourPaise": 120000, "demoAvailable": true, "isVerifiedBadge": true,
  "verificationStatus": "approved", "updatedAt": "…" },
  "completeness": { "percent": 85, "items": [ { "key": "certificate", "label": "An approved certificate", "earned": 0, "of": 15 } ] },
  "subjects": [ { "subjectId": "…", "name": "Physics", "isPrimary": true } ], "classes": [ { "classId": "…", "name": "Class 12", "boardName": "CBSE" } ],
  "feePlans": [ { "id": "…", "label": "JEE Physics batch", "feeUnit": "per_month", "amountPaise": 400000, "sessionsPerWeek": 3 } ] } }

// 201 POST /teacher/fee-plans
{ "data": { "id": "…", "label": "JEE Physics batch", "feeUnit": "per_month", "amountPaise": 400000, "sessionsPerWeek": 3, "sortOrder": 3 } }

// 409 PATCH /teacher/profile  (not approved)
{ "error": { "code": "CONFLICT_STATE", "message": "Complete verification before editing your public profile.", "details": { "reason": "not_approved" }, "requestId": "…" } }
```

## 12. PostgreSQL Tables & Columns

**New tables owned by this module** (migration `sql/migrations/117_app_m17_teacher_profile_builder_fee_structure.sql`)

### `teacher_fee_plans`

A teacher's fee structure: price per class group, subject and mode, per hour, per month or per course.

| Column | Type | Null | Default | Constraints / References | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | uuid | no | gen_random_uuid() | PK | Primary key |
| `teacher_id` | uuid | no | — | FK → `teachers.id` (on delete cascade) | Owner |
| `label` | text | no | — | — | e.g. Class 11–12 Physics · Online |
| `subject_id` | uuid | yes | — | FK → `subjects.id` (on delete restrict) | NULL = all subjects the teacher teaches |
| `class_from_id` | uuid | yes | — | FK → `classes.id` (on delete restrict) | Lowest class covered |
| `class_to_id` | uuid | yes | — | FK → `classes.id` (on delete restrict) | Highest class covered |
| `teaching_mode_id` | uuid | yes | — | FK → `teaching_modes.id` (on delete restrict) | NULL = any mode |
| `fee_unit` | text | no | — | CHECK fee_unit IN ('per_hour','per_month','per_course') | Billing unit |
| `amount_paise` | bigint | no | — | CHECK amount_paise BETWEEN 5000 AND 50000000 | ₹50 to ₹5,00,000 |
| `sessions_per_week` | smallint | yes | — | CHECK sessions_per_week BETWEEN 1 AND 14 | For per_month plans |
| `session_minutes` | smallint | yes | — | CHECK session_minutes BETWEEN 30 AND 240 | Length of one session |
| `notes` | text | yes | — | — | e.g. Includes weekly test, max 200 chars |
| `is_active` | boolean | no | true | — | Hidden when false |
| `sort_order` | smallint | no | 0 | — | Display order |
| `created_at` | timestamptz | no | now() | — | Created |
| `updated_at` | timestamptz | no | now() | — | Updated |
| `deleted_at` | timestamptz | yes | — | — | Soft delete |

<details><summary>DDL</summary>

```sql
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
```

</details>

**Indexes:** `idx_teacher_fee_plans_teacher` on `(teacher_id, sort_order) WHERE deleted_at IS NULL`

**Existing tables this module reads or writes** (full definitions in the owning module)

| Table | Owner | Purpose |
| --- | --- | --- |
| `teachers` | Admin M16 | Teacher profile and verification state. One row per teacher app account. |
| `teacher_qualifications` | App M14 | Degrees and certifications a teacher lists during registration and in the profile builder. |
| `teacher_subjects` | Admin M18 | Subjects a teacher teaches. |
| `teacher_classes` | Admin M19 | Classes (and optionally boards) a teacher covers. |

| Column | Written by this module |
| --- | --- |
| `teachers.full_name`, `.gender`, `.date_of_birth`, `.email`, `.category_id`, `.languages`, `.experience_years`, `.highest_qualification`, `.bio`, `.fee_per_hour_paise`, `.demo_available`, `.profile_photo_file_id` | `PATCH /teacher/profile`, approved teachers only |
| `teachers.profile_completeness` | recomputed after every write here or via Module 14's reused endpoints (BR-17.5) |
| `teacher_fee_plans.*` | owned outright by this module |
`teacher_qualifications`, `teacher_subjects`, `teacher_classes` are read here (summary rows, completeness inputs) and written only through Module 14's endpoints.

## 16. Push Notification Requirements

None from this module directly. A completed profile crossing 80% triggers an in-app (not push) nudge card on the Dashboard (Module 18) suggesting the next missing item; Module 20 is not asked to push for profile completeness.

## 17. Security Rules

- Every endpoint scopes by `teacher_id = pid`; ownership checked on every fee-plan id.
- `PATCH /teacher/profile` blocks writes unless `verification_status = 'approved'` (BR-17.1); identity-linked field changes are logged even though they don't change verification state, giving support a paper trail (BR-17.2).
- Bio is scanned for phone numbers, emails and URLs (same rule as Module 14), keeping contact off-platform.
- `profilePhotoFileId` must be `gc-public` and owned by the caller — a teacher cannot set another user's uploaded file as their photo.

## 18. Error Handling

| Scenario | Code | HTTP | App behaviour |
| --- | --- | --- | --- |
| Write while not approved | `CONFLICT_STATE` (`not_approved`) | 409 | Section rows show a lock icon; tapping shows the verification banner |
| Identity field changed without reason | `VALIDATION_FAILED` | 422 | Inline "Tell us why you're changing this" |
| Bio contains contact details | `VALIDATION_FAILED` | 422 | Inline under bio |
| Stale edit (`If-Match`) | `VERSION_CONFLICT` | 409 | "Updated elsewhere. Review and save again." |
| Fee plan references a subject/mode not on the profile | `VALIDATION_FAILED` | 422 | "Add this to your profile first" with a shortcut |
| 13th fee plan | `VALIDATION_FAILED` (`reason: max_fee_plans`) | 422 | "You can add up to 12 fee plans" |
| Photo file not active/owned | `VALIDATION_FAILED` | 422 | "Upload a photo first" |

## 19. Testing Scenarios

- T17.1 Approved teacher edits bio and languages, saves, sees completeness update from 70% to 80% immediately. Maestro flow `teacher_profile_edit_happy_path`.
- T17.2 Non-approved teacher (`pending`) sees every section locked except read-only view and preview with the "not visible" banner.
- T17.3 Changing `fullName` on an approved teacher without a reason is rejected; with a reason, it saves and a `teacher_verification_logs` row appears (verified via Module 16's timeline in an integration test).
- T17.4 Adding a fee plan referencing a subject not in `teacher_subjects` is rejected until the subject is added via Module 14's Subjects editor.
- T17.5 Completeness caps at 85% with zero approved certificates and reaches 100% once Admin M16 approves one (cross-module fixture).
- T17.6 13th fee plan is rejected; deleting one first allows a 12th to be added again.
- T17.7 Preview screen for an unapproved teacher shows `visibleToParents: false` and the amber banner; for an approved teacher it matches Module 31's public shape field-for-field.
- T17.8 Stale `If-Match` on `PATCH /teacher/profile` surfaces the version-conflict message.
- T17.9 Offline: About/Experience/Fee-plan screens render cached data; every Save button is disabled with "Connect to save changes."
- T17.10 Deleting a fee plan referenced in an open lead's conversation history still succeeds (soft delete; history keeps showing the old label via the row's `deleted_at`, not a hard removal).

## 20. Audit Log Events

| Event | When | Details |
| --- | --- | --- |
| `app.teacher_profile_updated` | `PATCH /teacher/profile` succeeds | changed fields |
| `app.teacher_identity_field_changed` | `fullName`/`dateOfBirth` changed on an approved teacher | field, reason |
| `app.teacher_fee_plan_added` / `_updated` / `_deleted` | Fee plan writes | plan id, label, amount |

---

## Module 18 · Teacher Dashboard [M18]

## 1. Module Purpose

The first screen an approved teacher sees: how many people looked at their profile, how many leads and demos came from it, what their rating and trust score look like, and what needs attention right now (unanswered leads, a low completeness score, a document still needing re-upload). Every number here reads from the same `teacher_daily_stats` roll-up Admin M21 already computes nightly and hourly-for-today, so a teacher and an admin looking at the same teacher never see different figures.

## 3. Business Rules & Logic

**BR-18.1 Range.** `GET /teacher/dashboard?range=7|30` (default 7) aggregates `teacher_daily_stats` rows for `stat_date` in the last N days (IST calendar days, today included and refreshed hourly per Admin FR-21.2): `profileViews` = Σ `profile_views`, `uniqueViewers` = Σ `unique_viewers` (an approximation — daily uniques are not deduplicated across days, matching Admin M21's own totals so the two screens never disagree), `leadRequests` = Σ `lead_requests`, `demoRequests` = Σ `demo_requests`, `demosCompleted` = Σ `demos_completed`, `reviewsPublished` = Σ `reviews_published`, `avgRating` = Σ `rating_sum` / Σ `reviews_published` (null if zero). A `previousPeriod` block repeats the same aggregation for the N days before that, giving each tile a delta ("↑ 18% vs last 7 days").
**BR-18.2 Live counters (not from the roll-up).** `unansweredLeads` = count of the teacher's `leads` with `status IN ('new','viewed')` and `created_at < now() - interval '24 hours'` (matches Admin FR-38.4's "unanswered" definition); `openLeads` = count with `status IN ('new','viewed','contacted')`; `upcomingDemos` = count of `demo_requests` with `status IN ('requested','confirmed','reschedule_proposed')` and a start at or after now. These read live, not from yesterday's roll-up, since they drive an action banner that must be current.
**BR-18.3 Response rate.** `responseRatePct` = leads with `first_response_at` set within 24 h of `created_at` ÷ non-spam leads created in the selected range (matches Admin FR-38.4/FR-21.3 exactly, computed the same way so a teacher's number matches what an admin sees on their profile). `medianFirstResponseMinutes` over the same set.
**BR-18.4 Trust score card.** Reads `trust_scores` (current `score`, band: `excellent` ≥ 90, `good` 80–89, `fair` 60–79, `poor` < 60 — the same bands Admin M36's simulate endpoint uses) and the top-line factor with the most room to improve (the factor with the largest gap between its current value and 100, weighted by its weight) as a single suggestion line, e.g. "Add a certificate to improve your score" — the full breakdown itself is Module 42's job; this card only teases it with one line and a "See details" link.
**BR-18.5 Completeness nudge.** Shows `teachers.profile_completeness` (Module 17) as a compact bar only while < 100; tapping it deep-links to the single highest-value missing item from Module 17's checklist (BR-17.5), not the whole Profile tab, to keep the action obvious.
**BR-18.6 Recent activity feed.** The five most recent events across `leads` (`created`, `converted`), `teacher_reviews` (`published`) and `demo_requests` (`completed`, `no_show`) for this teacher, merged and sorted by time, each a one-line row with an icon and a deep link (to Module 37 Contact Teacher / Module 39 Demo detail / Module 34 review).
**BR-18.7 Verification/document banners.** If `verification_status = 'reupload_requested'`, the dashboard's top banner is the Module 16 action ("2 documents need your attention") ahead of everything else — a teacher who can't yet appear in search shouldn't be shown lead metrics as if things are normal. If `pending`/`under_review`, a lighter "Your application is under review" banner is shown above the (still-visible, currently-empty) metric tiles.
**BR-18.8 Refresh.** Pull-to-refresh and refetch on foreground; `staleTime` 60 s (matches the hourly-for-today roll-up cadence — more frequent polling wouldn't show new numbers anyway).

## 8. Validation Rules

| Param | Rule |
| --- | --- |
| range | `7` or `30` only |
No user-entered fields.

## 9. API Endpoints

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | /teacher/dashboard | Teacher | KPIs, trust score, completeness, unanswered leads, recent activity |

## 10. Request Payloads

```json
// GET /teacher/dashboard?range=7
```

## 11. Response Payloads

```json
// 200 GET /teacher/dashboard?range=7
{ "data": {
  "verificationStatus": "approved",
  "range": 7, "period": { "from": "2026-09-20", "to": "2026-09-26" },
  "kpis": { "profileViews": { "value": 1284, "deltaPct": 18.4 }, "uniqueViewers": { "value": 1011, "deltaPct": 12.1 },
            "leadRequests": { "value": 37, "deltaPct": 9.0 }, "demoRequests": { "value": 18, "deltaPct": -4.2 },
            "demosCompleted": { "value": 11, "deltaPct": 22.0 }, "reviewsPublished": { "value": 6, "deltaPct": 0 }, "avgRating": { "value": 4.83 } },
  "responseRatePct": 94.6, "medianFirstResponseMinutes": 22,
  "trustScore": { "score": 94.10, "band": "excellent", "suggestion": "Add a professional certificate to reach 97+" },
  "profileCompleteness": { "percent": 85, "nextItem": { "key": "certificate", "label": "Get a certificate approved", "points": 15 } },
  "unansweredLeads": 0, "openLeads": 4, "upcomingDemos": 3,
  "recentActivity": [ { "type": "lead_converted", "at": "2026-09-25T18:20:00Z", "label": "Lead from Lakshmi V. converted", "deepLink": "gc://leads/…" },
                       { "type": "review_published", "at": "2026-09-24T10:00:00Z", "label": "New 5★ review from a parent", "deepLink": "gc://teacher/reviews/…" } ] } }

// 200 GET /teacher/dashboard  (pending)
{ "data": { "verificationStatus": "pending", "range": 7, "kpis": null, "trustScore": null, "profileCompleteness": null, "unansweredLeads": 0, "recentActivity": [] } }
```

## 12. PostgreSQL Tables & Columns


**Existing tables this module reads or writes** (full definitions in the owning module)

| Table | Owner | Purpose |
| --- | --- | --- |
| `teacher_daily_stats` | Admin M21 | Daily roll-up per teacher, written by a nightly job. All analytics screens read from here. |
| `teacher_profile_views` | Admin M21 | Raw profile-view events from the app. High volume; partition by month when it exceeds ~50M rows. |
| `leads` | Admin M38 | Enquiries and call-back requests from parents/students to a teacher or institute. |
| `teacher_reviews` | Admin M33 | Reviews of teachers by parents and students. Only published reviews count toward ratings and trust. |
| `trust_scores` | Admin M36 | Current trust score per teacher with its factor breakdown. |

This module only reads. `teacher_daily_stats` (Admin M21) is summed over the requested range; `leads` and `demo_requests` are queried live for the two counters in BR-18.2 (indexed by `idx_leads_teacher (teacher_id, status, created_at DESC)` and `idx_demo_requests_teacher_time`); `teacher_reviews` supplies the recent-activity feed's `published` events (`teacher_id`, `status = 'published'`); `trust_scores` supplies the score card.

## 16. Push Notification Requirements

None from this module. The banners and tiles react to state already pushed by Modules 16, 20, 37 and 39; this screen has no push events of its own.

## 17. Security Rules

- Scoped entirely to `teacher_id = pid`; no other teacher's numbers are ever computable from this endpoint.
- `recentActivity` never includes a requester's phone or email (masked the same way Module 37/38 mask them); it only names the requester by first name + last initial, matching how Admin FR-38's masking is applied on the app side.

## 18. Error Handling

| Scenario | Code | HTTP | App behaviour |
| --- | --- | --- | --- |
| Invalid range value | `VALIDATION_FAILED` | 422 | Falls back to 7 client-side (the picker never sends an invalid value in practice) |
| Not yet approved | — (200, `kpis: null`) | 200 | Metrics hidden, status banner shown instead |
| Network error | `NETWORK_OFFLINE` / `GATEWAY_ERROR` | — | Cached dashboard with staleness hint; Retry banner if no cache exists |

## 19. Testing Scenarios

- T18.1 Approved teacher with activity in both periods shows correct deltas (`deltaPct` matches `(current-previous)/previous*100` fixture).
- T18.2 Pending teacher sees the "under review" banner and null metrics, not zeros.
- T18.3 `reupload_requested` teacher sees the red banner above the greeting, taking visual priority over everything else.
- T18.4 `unansweredLeads > 0` shows the amber banner; tapping it opens Module 37 filtered to unanswered.
- T18.5 Trust score band boundaries: 90.0 → excellent, 89.99 → good, 60.0 → fair, 59.99 → poor.
- T18.6 Completeness nudge picks the highest-point missing item, not the first one alphabetically (fixture: certificate 15 pts beats languages 5 pts even though languages sorts first).
- T18.7 Switching from 7 to 30 days refetches and both are cached independently (going back to 7 doesn't trigger a network call within `staleTime`).
- T18.8 Zero reviews in the period → `avgRating` is `null`, rendered as "No reviews yet" not "0.0★".
- T18.9 Offline: dashboard renders from cache with "Updated Xh ago"; pull-to-refresh shows the offline toast instead of spinning forever.
- T18.10 Recent activity never shows a requester's full phone/email even when the underlying lead has `contactUnlocked: true`.

## 20. Audit Log Events

None. This is a read-only analytics screen; no audit rows are written (conventions §11 — reads are not audit-logged).

---

## Module 20 · Teacher Notifications [M20]

## 1. Module Purpose

Owns the one notification-preferences screen and its two endpoints (`GET`/`PUT /notification-preferences`) shared by every role in the app — a parent, student, teacher or institute manager all land on the same screen shape, reading and writing the same `user_notification_preferences` table. This module also documents, for the Teacher role specifically, the full catalogue of alerts a teacher receives (new lead, unanswered-lead reminder, demo reminders, verification updates, review received, subscription expiry) so a developer building any of those triggering modules (M16, M37, M38, M39, M34, M41, M44) knows the exact category, urgency and copy to send through Module 0's `NotificationService`, without redefining the preferences plumbing in each of them.

## 3. Business Rules & Logic

**BR-20.1 Categories.** The eleven categories are fixed by the `user_notification_preferences.category` enum: `account`, `verification`, `leads`, `demos`, `reviews`, `payments`, `subscription`, `referral`, `complaints`, `recommendations`, `announcements`. `GET /notification-preferences` returns all eleven for the caller's role (a missing row defaults to `pushEnabled: true, emailEnabled: false`, per Module 0 BR-0.7/schema default), each with an optional per-category `quietHoursStart`/`quietHoursEnd` override (null = use the platform default 21:30–08:00 IST, conventions §9). Only categories relevant to the caller's role are shown (e.g. a parent never sees `verification`); for the Teacher role the visible set is `account`, `verification`, `leads`, `demos`, `reviews`, `payments`, `subscription`, `referral`, `complaints`, `announcements` (`recommendations` is learner-only).
**BR-20.2 Locked categories.** `account` and `payments` cannot have push disabled (they carry security/session and money-relevant information); `PUT` with `pushEnabled: false` for either is rejected client-side (the toggle is disabled, greyed, with a lock icon and helper "Security and payment alerts can't be turned off") and, defensively, server-side (`VALIDATION_FAILED`). Email remains toggleable for every category including these two.
**BR-20.3 Save.** `PUT /notification-preferences { items: [{ category, pushEnabled, emailEnabled, quietHoursStart?, quietHoursEnd? }] }` upserts every row in one transaction (`ON CONFLICT (user_id, category) DO UPDATE`); a category omitted from the array is left unchanged (this is a partial upsert, not a replace-set, since the fixed category list never needs deletion). Each row's `updated_at` drives no `If-Match` — a genuine multi-device race here just means "last write wins" on a low-stakes settings screen, so no optimistic-lock friction is added.
**BR-20.4 New lead (urgent, category `leads`).** Sent by Module 37 the moment a lead's `target_type = 'teacher'` row is inserted: `urgent: true` (bypasses quiet hours entirely, conventions §9) since a fast reply materially affects whether the family picks this teacher. Title "New lead!" · body "{requesterFirstName} is looking for a {subject} teacher for {class}." · deep link `gc://teacher/leads/:id`.
**BR-20.5 Unanswered-lead reminder (category `leads`).** A job scans `leads` with `target_type = 'teacher'`, `status IN ('new','viewed')`; sends a non-urgent reminder at `created_at + 6h` (dedupe key `lead_reminder_1:<leadId>`) and again at `created_at + 20h` (`lead_reminder_2:<leadId>`) if still unanswered, then stops (Module 38's own lifecycle closes it at 30 days without further reminders from this rule). Title "Still waiting for your reply" · body "{requesterFirstName}'s enquiry has been open for {n} hours." · deep link `gc://teacher/leads/:id`. Each dedupe key ensures at most one send per milestone even if the job re-runs.
**BR-20.6 Demo reminders (category `demos`).** Sent by Module 38/39's own reminder job 1 hour before `confirmed_start_at` to both the teacher and the requester; documented here for completeness of the teacher's alert catalogue. Title "Demo in 1 hour" · body "Your demo with {requesterFirstName} starts at {time}." · deep link `gc://demos/:id`.
**BR-20.7 Verification updates (category `verification`).** Document approved / re-upload requested / application approved / application rejected — full templates and urgency already specified in Module 16's `@push` table; cross-referenced here as the same category a teacher can (mostly) not disable in practice (push is technically toggleable for `verification` unlike `account`/`payments`, but the app strongly discourages it with a confirmation: "You may miss updates about your application.").
**BR-20.8 Review received (category `reviews`).** Sent by Module 34/36 when a `teacher_reviews` row transitions to `status = 'published'` for this teacher. Non-urgent. Title "New review" · body "{rating}★ — \"{comment, truncated to 60 chars}…\"" · deep link `gc://teacher/reviews/:id`.
**BR-20.9 Subscription / boost expiry (category `subscription`).** For a teacher with an active `is_premium`/`is_featured` period (Module 44 boosts) or an active `subscriptions` row, a job sends reminders at 7, 3 and 1 day(s) before expiry (dedupe key `sub_expiry_<days>:<subscriptionOrBoostId>`), non-urgent. Title "Your {planName} listing expires soon" · body "{n} days left. Renew to keep your premium placement in search." · deep link `gc://plans`.
**BR-20.10 Quiet hours interaction.** For every non-urgent category, Module 0's `NotificationService` (BR-0.7) checks the category's own `quiet_hours_start`/`quiet_hours_end` if set, else the platform default; a push landing inside quiet hours is delayed to the end of the window, never dropped. `urgent: true` (new lead only, among this module's rules) always bypasses quiet hours regardless of category override.

## 8. Validation Rules

| Field | Rule | Message shown |
| --- | --- | --- |
| category | one of the eleven enum values | — |
| pushEnabled (account, payments) | must be `true` | "Security and payment alerts can't be turned off" |
| quietHoursStart / quietHoursEnd | valid `HH:mm`, both set together or both null | "Set both a start and end time" |

## 9. API Endpoints

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | /notification-preferences | Any user | Current per-category push/email settings |
| PUT | /notification-preferences | Any user | Update one or more categories |

## 10. Request Payloads

```json
// PUT /notification-preferences
{ "items": [ { "category": "reviews", "pushEnabled": true, "emailEnabled": false },
             { "category": "leads", "pushEnabled": true, "emailEnabled": true, "quietHoursStart": null, "quietHoursEnd": null } ] }
```

## 11. Response Payloads

```json
// 200 GET /notification-preferences
{ "data": { "items": [
  { "category": "leads", "label": "Leads", "description": "New enquiries and messages", "pushEnabled": true, "emailEnabled": true, "locked": false, "quietHoursStart": null, "quietHoursEnd": null },
  { "category": "verification", "label": "Verification", "description": "Application and document updates", "pushEnabled": true, "emailEnabled": false, "locked": false },
  { "category": "payments", "label": "Payments", "description": "Payments and receipts", "pushEnabled": true, "emailEnabled": true, "locked": true } ] } }

// 422 PUT /notification-preferences  (locking violation)
{ "error": { "code": "VALIDATION_FAILED", "message": "Security and payment alerts can't be turned off.", "details": { "path": "items[2].pushEnabled" }, "requestId": "…" } }
```

## 12. PostgreSQL Tables & Columns


**Existing tables this module reads or writes** (full definitions in the owning module)

| Table | Owner | Purpose |
| --- | --- | --- |
| `user_notifications` | App M00 | The in-app notification inbox for every user: transactional events and copies of admin campaigns. |
| `user_notification_preferences` | App M00 | Per-category push/email switches. Missing row = defaults (push on, email off). |
| `user_devices` | App M00 | Every app install a user has signed in on, with its FCM token. One row per (user, install). |

| Column | Written by this module |
| --- | --- |
| `user_notification_preferences.*` | owned outright (upsert per category) |
`user_notifications` (the inbox) and `user_devices` (FCM tokens) are read by Module 0's `NotificationService`/worker when deciding whether and how to deliver; this module never writes them directly — it only supplies the on/off and quiet-hours inputs that service reads before sending.

## 16. Push Notification Requirements

| Event | Recipient | Title / Body | Deep link | Category | Urgent |
| --- | --- | --- | --- | --- | --- |
| New lead | Teacher | "New lead!" / "{requester} is looking for a {subject} teacher for {class}." | `gc://teacher/leads/:id` | leads | Yes |
| Unanswered-lead reminder (6h, 20h) | Teacher | "Still waiting for your reply" / "{requester}'s enquiry has been open for {n} hours." | `gc://teacher/leads/:id` | leads | No |
| Demo reminder (1h before) | Teacher | "Demo in 1 hour" / "Your demo with {requester} starts at {time}." | `gc://demos/:id` | demos | No |
| Document approved / re-upload / application approved / rejected | Teacher | (see Module 16 §16) | `gc://teacher/verification` | verification | No (approval is urgent — see M16) |
| Review received | Teacher | "New review" / "{rating}★ — \"{comment}…\"" | `gc://teacher/reviews/:id` | reviews | No |
| Subscription/boost expiring (7/3/1 days) | Teacher | "Your {planName} listing expires soon" / "{n} days left. Renew to keep your premium placement." | `gc://plans` | subscription | No |
Every row here is filtered through this module's preferences (BR-20.1–20.3) before Module 0's worker sends it; a category with `pushEnabled: false` still writes the `user_notifications` inbox row (Module 48 still shows it) but skips the FCM send (`push_status = 'skipped_pref'`).

## 17. Security Rules

- `GET`/`PUT /notification-preferences` are scoped to `sub` (the caller's own `app_users.id`); no user can read or change another user's preferences.
- Locked categories (BR-20.2) are enforced server-side even though the client also disables the control, since a modified/old client build must not be able to silence security or payment alerts.
- No PII is included in any push body beyond a first name and non-sensitive counts/subjects (conventions §13 — no full phone numbers, no document numbers).

## 18. Error Handling

| Scenario | Code | HTTP | App behaviour |
| --- | --- | --- | --- |
| Disable push on `account`/`payments` | `VALIDATION_FAILED` | 422 | Toggle snaps back with the lock helper text |
| Only one of quietHoursStart/End set | `VALIDATION_FAILED` | 422 | Inline "Set both a start and end time" |
| Unknown category in payload | `VALIDATION_FAILED` | 422 | Ignored row highlighted, others still saved |
| Network error mid-toggle | `NETWORK_OFFLINE` | — | Optimistic state kept, queued for replay (offline class 1) |

## 19. Testing Scenarios

- T20.1 Toggling `reviews` push off then back on round-trips correctly and the FCM send is skipped/resumed accordingly (integration test against a stubbed `NotificationService`).
- T20.2 Attempting to disable `payments` push is rejected both client-side (button disabled) and server-side (direct API call in the test).
- T20.3 A new lead push is delivered at 11:45 PM IST (inside quiet hours) immediately, because `urgent: true` bypasses quiet hours.
- T20.4 An unanswered-lead reminder at the 6-hour mark is sent exactly once even if the reminder job runs twice in that window (dedupe key asserted).
- T20.5 A teacher with `leads` push disabled still gets the lead in their in-app inbox (Module 48) with `push_status = 'skipped_pref'`.
- T20.6 Custom quiet hours set only on `demos` (e.g. 22:00–06:00) don't affect delivery timing for `leads`.
- T20.7 Toggling a preference while offline updates the UI immediately and replays once reconnected, resulting in exactly one server-side row update (not one per offline toggle if the user flips it twice offline — the queue coalesces to the latest value per category).
- T20.8 A parent opening the same `NotificationSettingsScreen` sees `recommendations` in their list and does not see `verification`, confirming the role-filtered category set (BR-20.1).
- T20.9 Subscription-expiry reminders fire at 7, 3 and 1 days before `featured_until`/`premium_until` and never twice for the same milestone.
- T20.10 Offline: the screen renders cached preferences with a staleness hint; toggles remain interactive (queued), unlike a class-3 online-only screen.

## 20. Audit Log Events

| Event | When | Details |
| --- | --- | --- |
| `app.notification_preference_updated` | Each successful `PUT` row change | category, pushEnabled, emailEnabled |

---

## Module 21 · Institute Registration [M21]

## 1. Module Purpose

Lets the owner of a coaching centre, tuition centre, school or academy create a GuruConnect institute account in two short steps: institute and owner details (Institute Name, Owner Name, Mobile, Email, Institute type, optional GSTIN) and location (address, city, area, PIN code, map pin). One submit creates, in a single database transaction, the owner's `app_users` row (`user_type = 'institute_staff'`), the `institutes` row in `draft`, and the owner's `institute_managers` row as the primary manager, then signs the owner in and sends them to document upload (M22). The same endpoint also lets a person invited by an institute manager (M24) join that institute as a manager or counsellor. Before the application is submitted for review, the primary manager can correct these basics.

## 3. Business Rules & Logic

**BR-21.1 Who can register.** Only a caller holding a registration token (conventions §6) with `role = institute_staff`, issued by M04 after a new phone or email is verified, can call `POST /registration/institute`. One app account has one role and belongs to one institute in v1 (`iid` claim). The person who registers is the **owner**: they become the institute's primary manager (`staff_role = 'manager'`, `is_primary = true`). Ownership can later be transferred only by GuruConnect support (Admin M25 FR-25.5).

**BR-21.2 Owner mobile must be verified.**
- Token issued for a phone → the Mobile field is prefilled and locked.
- Token issued for an email or Google sign-in → the Location step cannot be submitted until the owner verifies a mobile with M04 `POST /auth/otp/request` (`purpose = signup`) and `POST /auth/otp/verify`, sent with the current registration token; M04 returns a new registration token carrying both contacts (M05 shared rule). The email is then already verified.
- The mobile must not belong to any live `app_users` row (`deleted_at IS NULL`); otherwise `409 CONFLICT_DUPLICATE`, `details.reason = "phone_in_use"`.
- The owner mobile is stored in `app_users.phone`, `institute_managers.phone` and, as the institute's official number, `institutes.phone` (editable later only through support, M24 BR-24.6).

**BR-21.3 Steps.**
1. **Institute & owner** — Institute Name, Institute type, Owner Name, Mobile, Email, GSTIN (optional).
2. **Location** — Address, City, Area, PIN code, map pin, terms and privacy consent, optional referral code (field shown only when `GET /registration/context` (M05) reports the `INSTITUTE_REFERRAL` program enabled; it is off at launch).
The draft is saved to encrypted MMKV after every field change (debounced 500 ms) under `draft:instituteRegistration:<tokenSub>` and deleted on success or after 7 days.

**BR-21.4 GSTIN validation (client and server, `isValidGstin(gstin, stateCode)` in packages/shared).**
1. Normalise: trim, remove spaces, upper-case. Empty → stored as NULL.
2. Pattern `^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$` (15 chars: 2-digit state code, 10-char PAN, entity number, `Z`, check character).
3. Checksum: with the alphabet `0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ`, for each of the first 14 characters at index `i` (0-based) take `v = indexOf(char)`, `p = v × (i even ? 1 : 2)`, add `floor(p / 36) + (p mod 36)` to `sum`. Check character = alphabet[`(36 − sum mod 36) mod 36`]. It must equal the 15th character. Example: `29AAGCA4321M1ZJ` is valid; `29AAGCA4321M1ZK` fails.
4. The first two digits must equal the GST state code of the selected city's state. `GST_STATE_CODES` in packages/shared maps `states.code` to the GST code (KA → 29, MH → 27, DL → 07, TN → 33, TG → 36, KL → 32, WB → 19, GJ → 24, UP → 09, RJ → 08, AP → 37, and the rest of the official list). Because the city is chosen in step 2, the client re-checks the state match when the city changes and moves the user back to step 1 with the error if it no longer matches.
5. Server only: another live institute (`deleted_at IS NULL`, `verification_status <> 'rejected'`) with the same `gstin` → `409 CONFLICT_DUPLICATE`, `details.reason = "gstin_in_use"`. The other institute's name is never revealed to the app. The GST portal lookup of legal name and address is done later by Admin M22 FR-22.5, not at registration.

**BR-21.5 Location rules.**
- `cityId`: an active city (`cities.is_active`). Cities with `is_serviceable = false` are selectable with a "Launching soon" tag; the institute can register and be verified but is not listed in search (M28) until the city is serviceable.
- `areaId`: required; active and belonging to the city.
- `pincode`: `^[1-9][0-9]{5}$`. Typing a PIN first filters the area list to areas of the city whose `areas.pincodes` contain it and auto-selects when exactly one matches. If the chosen area's `pincodes` is non-empty and does not contain the PIN, the app shows a soft warning ("560095 isn't usually in Koramangala. Please check.") but allows saving; Admin M22 FR-22.5 flags it.
- **Map pin**: required. The pin starts at the area's `latitude/longitude`, else the city's, else Bengaluru centre. The owner drags the map under a fixed centre pin or taps "Use my current location" (foreground permission requested only on that tap, `expo-location`). Stored as `latitude`, `longitude` rounded to 6 decimals. If the city has coordinates, the pin must be within 40 km of them (haversine) → otherwise `VALIDATION_FAILED` "The pin is too far from Bengaluru. Move it to your institute." Maps use `react-native-maps` (Google Maps SDK on Android with the key injected by the Expo config plugin from an EAS secret; Apple Maps on iOS).

**BR-21.6 Owner registration — server steps (`mode = "owner"`), one transaction.**
1. Middleware: registration token valid (`aud gc-register`, `role institute_staff`, not expired, `jti` not yet used — checked in Redis), `Idempotency-Key` present. A repeated key within 24 h returns the stored response.
2. Validate `InstituteRegistrationSchema`; re-check phone uniqueness, GSTIN rules, city/area/PIN, pin distance.
3. `INSERT app_users` (`user_type = 'institute_staff'`, `phone`, `phone_verified_at = now()`, `email`, `email_verified_at` only if the token verified the email, `full_name = ownerName`, `auth_provider` from the token: `otp` / `password` / `google`, `account_status = 'active'`, `preferred_language` from `Accept-Language` (default `en`), `signup_source` per M00 BR-0.13).
4. `INSERT user_auth_identities` for each verified method (M04 rules: `phone` always; `google` or `password` when used).
5. `INSERT institutes` (`name`, `slug` per BR-21.7, `institute_type`, `phone = owner mobile`, `email`, `gstin`, `address_line`, `city_id`, `area_id`, `pincode`, `latitude`, `longitude`, `verification_status = 'draft'`, `account_status = 'active'`). `public_code` comes from the sequence (`GC-I2143`).
6. `INSERT institute_managers` (`institute_id`, `user_id`, `full_name`, `email`, `phone`, `designation = 'Owner'`, `staff_role = 'manager'`, `is_primary = true`, `status = 'active'`, `invited_at = NULL`, `accepted_at = now()`).
7. `INSERT user_consents` two rows (`terms`, `privacy_policy`; `granted = true`, `method = 'checkbox'`, `document_version` from the request, IP, install id).
8. Referral (only if a valid code was sent and the program is enabled): `INSERT referrals` (`status = 'pending'`), qualifying event `institute_approved` (M46 / Admin M42).
9. Create the session (M04 service: `app_sessions` row, refresh token) and `INSERT audit_logs` `app.institute_registered`.
10. Commit; mark the token `jti` used; send the welcome email if an email exists. The response carries the tokens and `nextStep = "institute_documents"`.
Any failure rolls everything back — there are never half-created institutes.

**BR-21.7 Slug.** `slugify(name + " " + areaName)` (lower-case, ASCII, hyphens, max 80 chars), e.g. `apex-jee-academy-koramangala`. On collision append `-2`, `-3` … (checked against `uq_institutes_slug`). The slug is fixed at registration; a name change before submission regenerates it; after approval only admins change it.

**BR-21.8 Join as invited staff (`mode = "join"`).** `GET /registration/context` (M05) lists pending invites for the token's phone (from `institute_managers` with `status = 'invited'`, `user_id IS NULL`, same `phone`). The person sees "Join Apex JEE Academy as Counsellor" and submits `{ mode: "join", inviteId, fullName, consents }`. Checks: invite exists, still `invited`, `invited_at` within 72 h (else `CONFLICT_STATE`, `details.reason = "invite_expired"` — the manager can resend, M24 BR-24.3), phone equals the token phone, institute not deleted and `account_status = 'active'`. Transaction: `INSERT app_users` (as step 3, `full_name = fullName`), identities, consents, then `UPDATE institute_managers SET user_id, full_name, status = 'active', accepted_at = now()`, session, audit `app.institute_staff_joined`. After commit M24's "staff joined" push goes to the inviting manager and the primary manager. `nextStep = null` (staff land on the Dashboard tab).

**BR-21.9 Editing basics before review.** `PATCH /institute/registration/basics` (If-Match = `institutes.updated_at`), caller must be an active `manager` of the institute. Allowed while `verification_status` is `draft` or `docs_requested`, or `rejected` with `rejected_at` ≥ 30 days ago (the first edit moves `rejected → draft`, clearing `rejection_reason_code` and `rejection_note`, and writes nothing to the verification log). In `pending`, `under_review`, `visit_scheduled` and `evaluation_done` → `CONFLICT_STATE`, `details.reason = "in_review"`; after `approved` → `CONFLICT_STATE`, `details.reason = "approved_use_profile"` (M24 handles profile edits and support requests). Editable fields: name, instituteType, ownerName (updates `app_users.full_name` and the primary's `institute_managers.full_name`), email (institute email only; account email changes go through M51), gstin, address, city, area, pincode, pin. The owner mobile is not editable here. Changing the city clears the area and requires a new pin; changing the name regenerates the slug (BR-21.7).

**BR-21.10 After success.** The app stores the tokens (M04), invalidates `meKeys.me`, clears the draft, shows the push pre-permission sheet ("Get notified when your institute is verified", conventions §9), then opens M22 Documents. `GET /me` for institute staff returns `institute { id, name, staffRole, isPrimary, verificationStatus }` and `registration.nextStep` = `institute_documents` (draft, required documents missing), `institute_submit` (documents complete, not submitted) or `null`. Splash (M01 BR-1.5) resumes at that step.

**BR-21.11 Abuse limits.** `POST /registration/institute` is limited to 5 calls per hour per install and 2 successful owner registrations per install per 30 days (`LIMIT_REACHED`, `details.reason = "install_registrations"`). Duplicate detection across GSTIN, registration number and phone happens again in Admin M22 FR-22.5.

## 8. Validation Rules

Shared schemas in packages/shared: `InstituteRegistrationSchema` (owner mode), `InstituteJoinSchema`, `InstituteBasicsPatchSchema` (all fields optional, same rules), `isValidGstin()`.

| Field | Rule | Message shown |
| --- | --- | --- |
| instituteName | 3–120 chars after trim; letters, digits, spaces and `. , & ' ( ) - /`; not only digits | "Enter your institute's name (3–120 characters)." |
| instituteType | one of coaching_centre, tuition_centre, school, music_school, coding_academy, language_institute, sports_academy, other | "Choose the type of institute." |
| ownerName | 2–100 chars; letters, spaces, `. ' -` | "Enter the owner's full name." |
| mobile | `+91` and 10 digits starting 6–9 | "Enter a valid 10-digit mobile number." |
| mobile (server) | not used by a live account; verified in the registration token | "This number already has a GuruConnect account. Sign in instead." |
| email | valid email, ≤ 254 chars, stored lower-case | "Enter a valid email address." |
| gstin | optional; BR-21.4 pattern | "Enter a valid 15-character GSTIN." |
| gstin checksum | BR-21.4 step 3 | "This GSTIN doesn't look right. Check the last character." |
| gstin state | first 2 digits = GST code of the city's state | "This GSTIN is registered in another state." |
| gstin (server) | not used by another live institute | "This GSTIN is already registered on GuruConnect. Contact support if this is your institute." |
| addressLine | 5–200 chars | "Enter the full address (at least 5 characters)." |
| cityId | active city | "Choose your city." |
| areaId | active area in the city | "Choose your area." |
| pincode | `^[1-9][0-9]{5}$` | "Enter a 6-digit PIN code." |
| latitude / longitude | −90…90 / −180…180, 6 decimals, both present, ≤ 40 km from city centre | "Set your institute's location on the map." / "The pin is too far from Bengaluru. Move it to your institute." |
| consents.terms / consents.privacy | must be true; `documentVersion` non-empty | "Please accept the Terms and Privacy Policy." |
| referralCode | optional, 4–20 chars `[A-Z0-9]`, validated by M05 | "This referral code isn't valid." |
| inviteId (join) | uuid of a pending invite for this phone | "This invite is no longer valid." |
| fullName (join) | 2–100 chars as ownerName | "Enter your full name." |

## 9. API Endpoints

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| POST | /registration/institute | Registration token | `mode = owner`: create owner account + draft institute + primary manager in one transaction; `mode = join`: accept a staff invite. Returns session tokens (Idempotency-Key). 5/hour per install |
| PATCH | /institute/registration/basics | Institute staff (manager) | Edit registration details while `draft`, `docs_requested` or re-applying after rejection (If-Match). 30/hour |

Uses: M05 `GET /registration/context`, `POST /registration/referral/validate`; M04 `POST /auth/otp/request`, `POST /auth/otp/verify`; M00 `GET /masters`, `GET /masters/areas`; M24 `GET /institute/profile` (prefill for editing).

## 10. Request Payloads

```json
// POST /registration/institute   (Authorization: Bearer <registrationToken>, Idempotency-Key: 2b7c…)
{ "mode": "owner",
  "institute": { "name": "Apex JEE Academy", "instituteType": "coaching_centre", "email": "contact@apexjee.in", "gstin": "29AAGCA4321M1ZJ",
                 "addressLine": "3rd Floor, 80 Feet Road, 6th Block", "cityId": "5b1e…blr", "areaId": "9c2d…kor", "pincode": "560034",
                 "latitude": 12.935214, "longitude": 77.624481 },
  "owner": { "fullName": "Suresh Menon", "mobile": "+919845012345" },
  "consents": { "terms": true, "privacy": true, "documentVersion": "2026-09" },
  "referralCode": null }

// POST /registration/institute   (join mode)
{ "mode": "join", "inviteId": "e41a…", "fullName": "Kavita Rao", "consents": { "terms": true, "privacy": true, "documentVersion": "2026-09" } }

// PATCH /institute/registration/basics   (If-Match: "2026-09-26T09:41:07.412Z")
{ "name": "Apex JEE & NEET Academy", "gstin": null, "pincode": "560095" }
```

## 11. Response Payloads

```json
// 201 POST /registration/institute (owner)
{ "data": {
  "session": { "accessToken": "eyJhbGciOiJSUzI1NiIs…", "expiresIn": 900, "refreshToken": "q8V…", "sessionId": "…" },
  "user": { "id": "…", "role": "institute_staff", "profileId": "…managerId…", "fullName": "Suresh Menon" },
  "institute": { "id": "…", "publicCode": "GC-I2143", "slug": "apex-jee-academy-koramangala", "name": "Apex JEE Academy", "verificationStatus": "draft",
                 "staffRole": "manager", "isPrimary": true },
  "nextStep": "institute_documents" } }

// 201 POST /registration/institute (join)
{ "data": { "session": { "accessToken": "…", "expiresIn": 900, "refreshToken": "…", "sessionId": "…" },
  "user": { "id": "…", "role": "institute_staff", "profileId": "…", "fullName": "Kavita Rao" },
  "institute": { "id": "…", "name": "Apex JEE Academy", "verificationStatus": "approved", "staffRole": "counsellor", "isPrimary": false }, "nextStep": null } }

// 200 PATCH /institute/registration/basics
{ "data": { "id": "…", "name": "Apex JEE & NEET Academy", "slug": "apex-jee-neet-academy-koramangala", "gstin": null, "pincode": "560095",
            "verificationStatus": "docs_requested", "updatedAt": "2026-09-26T10:02:55.120Z" } }

// 422 GSTIN in another state
{ "error": { "code": "VALIDATION_FAILED", "message": "Please check the highlighted fields.",
  "details": [ { "path": "institute.gstin", "message": "This GSTIN is registered in another state." } ], "requestId": "…" } }

// 409 GSTIN already used
{ "error": { "code": "CONFLICT_DUPLICATE", "message": "This GSTIN is already registered on GuruConnect. Contact support if this is your institute.",
  "details": { "reason": "gstin_in_use", "path": "institute.gstin" }, "requestId": "…" } }
```

## 12. PostgreSQL Tables & Columns


**Existing tables this module reads or writes** (full definitions in the owning module)

| Table | Owner | Purpose |
| --- | --- | --- |
| `app_users` | Admin M00 | Login identity for every mobile app account (parent, student, teacher, institute staff). Role profiles hang off this table. |
| `institutes` | Admin M22 | Coaching centres, tuition centres, schools and academies. Rated by GuruConnect after verification. |
| `institute_managers` | Admin M25 | App accounts that act for an institute. Exactly one active primary manager; counsellors can only handle leads. |
| `user_auth_identities` | App M04 | Sign-in methods linked to an account: phone OTP, email + password, Google. |
| `app_sessions` | App M04 | Refresh-token sessions for app users, one per signed-in install. Refresh tokens rotate on every use. |
| `user_consents` | App M52 | Record of every consent given or withdrawn (terms, privacy policy, parental consent, marketing), as required by the DPDP Act 2023. |
| `referral_codes` | Admin M42 | One personal referral code per app user. |
| `referrals` | Admin M42 | One row per referred user, tracking qualification, fraud checks and reward payout. |
| `referral_settings` | Admin M06 | Versioned rules for each referral program. One active version per program. |
| `states` | Admin M08 | States and union territories within a country. |
| `cities` | Admin M09 | Cities where teachers and institutes can be listed. |
| `areas` | Admin M10 | Localities within a city, used for "nearby" search and teacher coverage. |
| `audit_logs` | Admin M00 | Append-only record of every admin action and security event. Never updated or deleted by the application. |

- `app_users`: one row per owner or joining staff member, `user_type = 'institute_staff'`.
- `institutes`: created in `draft` with the basics; `phone` = owner mobile; `slug`, `public_code` generated; `latitude/longitude` from the pin. Other profile columns (about, logo, facilities, capacity, fees) are filled later in M24.
- `institute_managers`: owner row `staff_role = 'manager'`, `is_primary = true`, `status = 'active'`, `designation = 'Owner'`; join mode updates the invited row (`user_id`, `status = 'active'`, `accepted_at`). The unique index `uq_institute_managers_primary` guarantees one live primary.
- `user_consents`, `user_auth_identities`, `app_sessions`, `referrals`: written through the shared M04/M05 services inside the same transaction.
- `states.code` is read to find the GST state code for the GSTIN check.

## 16. Push Notification Requirements

| Event | Recipient | Title / Body | Deep link | Category | Urgent |
| --- | --- | --- | --- | --- | --- |
| Draft not submitted 24 h, 72 h, 7 days after registration | Primary manager | "Finish verifying Apex JEE Academy" / "Upload your documents so parents can find you." | `/institute/documents` | verification | No |
| Invited staff joined (sent by this module, template owned by M24) | Inviter and primary manager | "Kavita Rao joined your team" / "They can now answer enquiries as Counsellor." | `/institute/staff` | account | No |

Registration itself sends no push (the device is registered only after sign-in); the owner gets a welcome email when an email is present. Reminders stop as soon as the institute leaves `draft`.

## 17. Security Rules

- The registration token is single-use (`jti` stored in Redis for its lifetime) and only valid for `/registration/*` and M04 OTP calls.
- The account is created only on successful submit; no pre-created rows can be hijacked.
- Server never trusts `mobile` from the body when the token carries a phone: the token's phone is used.
- The GSTIN duplicate message never reveals the other institute; lookups are exact-match and rate limited with the endpoint.
- Join mode: invite must match the token's phone exactly; invite ids are uuids and never guessable; expired or disabled invites are rejected.
- `PATCH /institute/registration/basics` checks `institute_managers.staff_role = 'manager'` and `status = 'active'` for the token's `pid` and `iid`; counsellors get `FORBIDDEN`.
- No PII in analytics: events `institute_reg_step_completed { step }`, `institute_reg_submitted { instituteType, hasGstin }`.

## 18. Error Handling

| Scenario | Code | HTTP | App behaviour |
| --- | --- | --- | --- |
| Invalid field (incl. GSTIN format, checksum, state) | `VALIDATION_FAILED` | 422 | Map `details[].path` to the field; GSTIN errors jump back to step 1 |
| Mobile already has an account | `CONFLICT_DUPLICATE` (`phone_in_use`) | 409 | Sheet "This number already has an account" with "Sign in" |
| GSTIN used by another institute | `CONFLICT_DUPLICATE` (`gstin_in_use`) | 409 | Inline under GSTIN + "Contact support" link (M53) |
| Registration token expired | `AUTH_REQUIRED` (`registration_token_expired`) | 401 | Login with "Please verify your number again to finish."; draft kept |
| Staff invite expired | `CONFLICT_STATE` (`invite_expired`) | 409 | Expired invite state on InstituteJoinInvite |
| Edit basics while in review / approved | `CONFLICT_STATE` (`in_review` / `approved_use_profile`) | 409 | Read-only screen with the banner; refetch |
| Stale edit | `VERSION_CONFLICT` | 409 | "Updated on another device. Review and save again." and reload values |
| Counsellor edits basics | `FORBIDDEN` | 403 | Toast "Only a manager can change these details." |
| Too many registrations from this phone | `LIMIT_REACHED` (`install_registrations`) | 429 | "You've registered the maximum number of institutes from this phone. Contact support." |
| Too many attempts | `RATE_LIMITED` | 429 | Disable the button until `Retry-After` |
| Network / 5xx | `GATEWAY_ERROR` / `INTERNAL_ERROR` | 502 / 500 | Retry button; form values kept |

## 19. Testing Scenarios

- T21.1 Happy path (Maestro `institute_registration_happy`): phone OTP → both steps → pin set → account created; DB has one `app_users` (`institute_staff`), one `institutes` (`draft`), one `institute_managers` (`manager`, primary, active); lands on M22 Documents.
- T21.2 Same `Idempotency-Key` sent twice (double tap / retry after timeout) → one set of rows; second call returns the same 201 body.
- T21.3 GSTIN `29AAGCA4321M1ZJ` with a Bengaluru city passes; `29AAGCA4321M1ZK` fails checksum; `27AAPFU0939F1ZV` with Bengaluru fails the state check.
- T21.4 GSTIN of an existing approved institute → 409 `gstin_in_use`; message contains no institute name.
- T21.5 GSTIN left empty → stored NULL; registration succeeds.
- T21.6 PIN 560095 with area Koramangala (pincodes 560034, 560095) → no warning; PIN 560001 → soft warning but save succeeds.
- T21.7 Pin 55 km from Bengaluru centre → 422 on the pin; moving it inside 40 km succeeds.
- T21.8 Google sign-up: Location step requires phone OTP; after verification the new token carries both contacts and the account has `email_verified_at` set.
- T21.9 Kill the app on step 2 → relaunch → draft restored with all fields; after success the draft is gone.
- T21.10 Registration token older than 30 min → `AUTH_REQUIRED`; after re-login the draft is restored and submit works.
- T21.11 Join mode: invite created 2 h ago → account created and `institute_managers.status = 'active'`, `user_id` set; inviter receives the "joined your team" push. Invite 80 h old → `invite_expired`.
- T21.12 Force a failure after the `institutes` insert (test hook) → no `app_users`, `institutes` or `institute_managers` row remains.
- T21.13 PATCH basics in `docs_requested` succeeds and regenerates the slug; in `pending` → `in_review`; from a counsellor → `FORBIDDEN`; with an old If-Match → `VERSION_CONFLICT`.
- T21.14 Rejected 31 days ago: PATCH basics moves the institute to `draft`; rejected 10 days ago → `CONFLICT_STATE`.

## 20. Audit Log Events

| Event | When | Details |
| --- | --- | --- |
| `app.institute_registered` | Owner registration committed | institute id, public code, type, city, hasGstin, signup source |
| `app.institute_staff_joined` | Invited staff accepted via join mode | institute id, staff id, staff role |
| `app.institute_basics_updated` | PATCH basics saved | changed field names with old/new values (GSTIN stored masked to last 4) |
| `app.institute_reapplied` | First edit after a rejection moved the status to `draft` | previous rejection reason code |

---

# Part C. Exact table definitions (from sql/schema.sql)

Authoritative column names, types and constraints. Do not rename or add columns. If a change is truly needed, say so as a question.

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

```
