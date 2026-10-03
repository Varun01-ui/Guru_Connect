# Module 17 · Teacher Profile Management

> **Phase 5 · Teachers** · **Depends on:** M16 · **Owns tables:** none · **Reads:** `teachers`, `teacher_documents`, `teacher_verification_logs`, `teacher_subjects`, `teacher_classes`, `teacher_locations`, `trust_scores` · **Build estimate:** 4 days

## 1. Module Overview

The admin view of every teacher after registration: a searchable teacher directory and a teacher detail page where admins can edit profile fields, suspend or re-activate, grant or revoke the Verified badge, and set featured/premium listing manually. The detail page aggregates the teacher's subjects, classes, locations (Modules 18–20), analytics (21), reviews (33), trust score (36), leads (38) and complaints (43) in tabs.

## 2. Business Purpose

Operations and support need one place to look after a teacher: fix a typo in a qualification, hide a teacher during an investigation, feature top performers, and see everything about them before taking action.

## 3. User Stories

- As **Operations Admin**, I want to find a teacher by name, code or phone and open their full profile so that I can answer a parent's question.
- As **Support Admin**, I want to suspend a teacher with a reason so that they stop receiving leads during a complaint investigation.
- As **Verification Admin**, I want to revoke the Verified badge if a certificate turns out to be fake so that parents are protected.
- As **Operations Admin**, I want to feature a teacher for 30 days as a reward so that they appear on the home screen.
- As **Operations Admin**, I want to export the filtered teacher list so that I can plan a city campaign.

## 4. Functional Requirements & Business Logic

**FR-17.1 Directory.** `GET /teachers` with filters (below), search, sort and export. Row: avatar, name + badge, code, category, primary subject + other subjects (chips), primary city/area, mode(s), experience, fee, rating (count), trust score, plan (free / registered / premium), verification status, account status, featured switch.

**FR-17.2 Detail.** `GET /teachers/:id` returns profile, verification summary, current trust score, subscription state, counts (leads 30d, demos, reviews, complaints open). Tabs load their data from their own modules' endpoints.

**FR-17.3 Edit profile.** `PATCH /teachers/:id` (If-Match) for: full name*, gender, date of birth*, email, category, highest qualification*, experience years, bio, languages, fee per hour, demo availability, profile photo (fileId). Fields marked * are identity-linked: changing them on an approved teacher requires a reason and sets a `profile_changed_after_approval` warning in the verification timeline; changing `fullName` or `dateOfBirth` also re-runs the name/age checks. Phone number changes are not allowed here (the teacher changes it in the app with OTP).

**FR-17.4 Suspend / activate.** `POST /teachers/:id/suspend { reason, notifyTeacher, until? }`: `account_status = 'suspended'`, `suspended_at`, reason; teacher disappears from search within 1 minute (cache purge); open leads show "Teacher unavailable"; future demos are cancelled with `cancelled_by = 'admin'` and learners notified; featured/premium periods are paused (remaining days stored in metadata and restored on activation). Optional `until` schedules automatic re-activation. `POST /teachers/:id/activate { reason }` reverses it.

**FR-17.5 Badge.** `POST /teachers/:id/badge { grant: true|false, reason }` — grant only if `verification_status = 'approved'`. Revoking also triggers a trust score recalculation (the badge feeds the verification factors).

**FR-17.6 Featured / premium (manual).** `POST /teachers/:id/feature { featured: true, until, reason }` and `/premium { premium: true, until, reason }` for complimentary placements (paid ones come from Module 40 transactions). Featured slots per city are limited by the active FEATURED_TEACHER configuration (Module 5 — slots setting in system settings `limits.featured_slots_per_city`, default 12); exceeding it returns 409 with the current featured list.

**FR-17.7 Soft delete.** `DELETE /teachers/:id { reason }` (super admin only) for spam or at the teacher's request: soft-deletes the teacher, hides reviews from public, anonymises contact fields after 30 days (job), keeps transactions and complaints.

**FR-17.8 Profile completeness.** Recomputed on every change: photo 15, bio ≥ 100 chars 10, qualification 10, experience 5, ≥ 1 subject 15, ≥ 1 class 10, ≥ 1 location or online mode 10, fee 5, languages 5, ≥ 1 certificate approved 15 (= 100). Stored in `profile_completeness`; feeds the trust score.

## 5. Validation Rules

| Field | Rule |
| --- | --- |
| fullName | 2–100 chars; reason required if approved |
| dateOfBirth | teacher ≥ 18 and ≤ 90 years |
| email | valid, unique among live app users |
| categoryId | active teacher category |
| highestQualification | 2–120 chars |
| experienceYears | 0–60, ≤ age − 16 |
| bio | ≤ 2,000 chars, no phone numbers/emails/URLs (regex check — contact details must go through leads) |
| languages | 1–10 items from the supported list |
| feePerHourPaise | 0 … 1,00,000 paise (₹1,000) × 10 = max ₹10,000/hour |
| suspend.reason | 10–500 chars; `until` optional, > now, ≤ 365 days |
| feature/premium.until | > now, ≤ 90 days |

## 6. API Endpoints

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | /teachers | teachers.read | Directory with filters, search, sort |
| GET | /teachers/export | teachers.read | CSV of the current filter (sync ≤ 5,000 rows, else async via M48) |
| GET | /teachers/:id | teachers.read | Teacher detail |
| PATCH | /teachers/:id | teachers.update | Edit profile (If-Match) |
| POST | /teachers/:id/suspend | teachers.suspend | Suspend |
| POST | /teachers/:id/activate | teachers.suspend | Re-activate |
| POST | /teachers/:id/badge | teachers.badge | Grant or revoke Verified badge |
| POST | /teachers/:id/feature | teachers.feature | Set / clear complimentary featured period |
| POST | /teachers/:id/premium | teachers.feature | Set / clear complimentary premium period |
| DELETE | /teachers/:id | super admin | Soft delete |

## 7. Request Payloads

```json
// PATCH /teachers/:id   (If-Match: 2026-09-25T13:20:44.001Z)
{ "highestQualification": "Ph.D. Physics, IISc Bengaluru", "bio": "I teach Physics the way it is examined…", "feePerHourPaise": 120000, "reason": "Teacher requested qualification correction; certificate verified" }

// POST /teachers/:id/suspend
{ "reason": "Complaint CS-4412: asked parents to pay outside the app. Investigating.", "notifyTeacher": true, "until": null }

// POST /teachers/:id/feature
{ "featured": true, "until": "2026-10-26T18:29:59Z", "reason": "Top-rated JEE teacher in Bengaluru — September reward" }
```

## 8. Response Payloads

```json
// 200 GET /teachers
{ "data": [ { "id": "…", "publicCode": "GC-T10241", "fullName": "Dr. Ananya Iyer", "photoUrl": "…", "isVerifiedBadge": true, "category": "Coaching Faculty",
  "subjects": [ { "id": "…", "name": "Physics", "isPrimary": true }, { "id": "…", "name": "JEE Advanced" } ], "city": "Bengaluru", "area": "Koramangala", "modes": ["Online","At teacher's place"],
  "experienceYears": 14, "feePerHourPaise": 120000, "ratingAvg": 4.9, "ratingCount": 312, "trustScore": 94, "plan": "premium",
  "verificationStatus": "approved", "accountStatus": "active", "isFeatured": true, "featuredUntil": "2026-10-26T18:29:59Z" } ], "meta": { "page": 1, "pageSize": 20, "total": 9812, "totalPages": 491 } }

// 200 GET /teachers/:id
{ "data": { "id": "…", "publicCode": "GC-T10241", "fullName": "Dr. Ananya Iyer", "…": "…", "profileCompleteness": 95, "trust": { "score": 94, "calculatedAt": "…" },
  "subscription": { "status": "active", "endsAt": "2027-08-12T00:00:00Z" }, "counts": { "leads30d": 37, "demosUpcoming": 3, "reviewsPublished": 312, "complaintsOpen": 0 }, "updatedAt": "…" } }
```

## 9. PostgreSQL Tables

No new tables. This module works on: `teachers`, `teacher_documents`, `teacher_verification_logs`, `teacher_subjects`, `teacher_classes`, `teacher_locations`, `trust_scores`.

## 10. Column Definitions

No new columns. See the modules that own `teachers`, `teacher_documents`, `teacher_verification_logs`, `teacher_subjects`, `teacher_classes`, `teacher_locations`, `trust_scores`.

## 11. Relationships

No relationships of its own.

## 12. Indexing Strategy


- `idx_teachers_listing (account_status, verification_status, trust_score DESC)` backs the default directory sort.
- `idx_teachers_name_trgm` for fuzzy name search; `uq_teachers_public_code` for code lookups.
- City filters join `teacher_locations` via `idx_teacher_locations_city_area`; subject filters via `idx_teacher_subjects_subject`.
- `idx_teachers_featured` finds featured teachers to expire.

## 13. Permissions

| Permission key | Allows | Sensitive | Super | Ops | Verif. | Finance | Support |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `teachers.update` | Edit teacher profiles and mappings | — | ✓ | ✓ | — | — | — |
| `teachers.suspend` | Suspend and re-activate teachers | yes | ✓ | ✓ | — | — | — |
| `teachers.badge` | Grant or revoke the Verified badge | yes | ✓ | — | ✓ | — | — |
| `teachers.feature` | Mark teachers as featured or premium manually | — | ✓ | ✓ | — | — | — |
| `teachers.create` | Create a teacher manually on their behalf | — | ✓ | ✓ | — | — | — |

Deleting teachers is super-admin only (no permission key grants it). Identity-linked field edits on approved teachers are allowed with `teachers.update` but always require a reason.

## 14. UI Screens & React Page Structure

| Route | Page | Content |
| --- | --- | --- |
| `/teachers` | TeachersDirectoryPage | Status tabs (All, Verified, Pending, Re-upload, Suspended, Rejected, Featured), FilterBar, DataTable, bulk actions (export, feature, suspend) |
| `/teachers/:id` | TeacherDetailPage | Header (photo, name, badge, status, trust ring, quick actions); tabs: Profile · Subjects & classes · Locations & modes · Documents · Analytics · Reviews · Trust score · Leads & demos · Complaints · Activity |

```
src/features/teachers/
  pages/TeachersDirectoryPage.tsx, TeacherDetailPage.tsx
  components/TeacherHeader.tsx, TeacherProfileForm.tsx, SuspendDialog.tsx, BadgeDialog.tsx, FeatureDialog.tsx, TeacherTabs.tsx, CompletenessMeter.tsx
  tabs/ProfileTab.tsx, MappingsTab.tsx (M18–M19), LocationsTab.tsx (M20), DocumentsTab.tsx (M16 read-only), AnalyticsTab.tsx (M21), ReviewsTab.tsx (M33), TrustTab.tsx (M36), LeadsTab.tsx (M38–39), ComplaintsTab.tsx (M43), ActivityTab.tsx (AuditTrail)
```

## 15. UI Components

- `TeacherHeader` — status badges, trust ring, rating, quick actions gated by permission.
- `SuspendDialog` — reason, notify toggle, optional auto-reactivate date, impact summary (open leads, upcoming demos, featured days remaining).
- `FeatureDialog` — until date, remaining city slots.
- `CompletenessMeter` — bar with missing items.

## 16. Filters

Verification status, account status, category, subject (multi), class (multi), board, city, area, teaching mode, experience (min), fee range, rating (min), trust score (min), plan (free/registered/premium/featured), badge (yes/no), joined date range, has open complaints.

## 17. Search Capabilities

`q`: public code exact; name trigram (similarity ≥ 0.3, ranked); email prefix; phone last 10 digits (requires `users.pii`, otherwise ignored).

## 18. Pagination Requirements

Offset, default 20, max 100. Sort: trustScore (default desc), ratingAvg, ratingCount, experienceYears, feePerHourPaise, createdAt, fullName. Export limited to 5,000 rows synchronously; larger exports are queued (Module 48).

## 19. Audit Logs

| Event | Details |
| --- | --- |
| `teacher.updated` | changed fields, reason |
| `teacher.suspended` / `teacher.activated` | reason, until, leads/demos affected |
| `teacher.badge_granted` / `teacher.badge_revoked` | reason |
| `teacher.featured_set` / `teacher.featured_cleared` / `teacher.premium_set` / `teacher.premium_cleared` | until, reason |
| `teacher.deleted` | reason |
| `teacher.exported` | filter summary, row count |

## 20. Error Scenarios

| Scenario | HTTP | Code | Message |
| --- | --- | --- | --- |
| Badge for non-approved teacher | 409 | CONFLICT_STATE | "Only approved teachers can have the Verified badge." |
| Suspend an already suspended teacher | 409 | CONFLICT_STATE | "This teacher is already suspended." |
| Featured slots full in the city | 409 | CONFLICT_STATE | "Bengaluru already has 12 featured teachers." |
| Identity field change without reason | 422 | VALIDATION_FAILED | "Add a reason for changing verified details." |
| Bio contains contact details | 422 | VALIDATION_FAILED | "Remove phone numbers, emails and links from the bio." |
| Email used by another account | 409 | CONFLICT_DUPLICATE | "This email belongs to another account." |
| Stale edit | 409 | VERSION_CONFLICT | "Someone else changed this profile. Reload." |
| Export too large for sync | 202 | — | "Your export is being prepared. We'll email you." |

## 21. Future Scalability Notes & Enhancements

- Move teacher search to OpenSearch/Meilisearch with a change-data-capture feed once the directory passes ~200k teachers.
- Bulk edit (category, featured) with background jobs and per-row results.
- Teacher-level notes and tags for operations (e.g., "Launch ambassador").

## 22. Security Considerations

- Contact details masked without `users.pii`; profile photos public, documents private.
- Suspensions cascade immediately to search and leads; all changes audited with reason.
- Bio sanitised (plain text) and screened for contact details to keep deals on-platform.
