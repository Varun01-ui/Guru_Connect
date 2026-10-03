# 00 · Engineering Conventions (read first)

Every module in this pack follows the rules on this page. A module document only repeats a rule when it overrides it.

## 1. Tech stack

| Layer | Choice | Notes |
| --- | --- | --- |
| Runtime | Node.js 20 LTS, TypeScript 5 (strict) | One repo, two apps: `apps/api` and `apps/admin-web` |
| API | Express 4, `express-async-errors`, `helmet`, `cors`, `compression`, `pino-http` | REST only, JSON only |
| Database | PostgreSQL 16 | Extensions: `pgcrypto`, `citext`, `pg_trgm` |
| DB access | `pg` (node-postgres) + **Kysely** typed query builder | Raw SQL allowed for reports; always parameterised |
| Migrations | Plain SQL files in `sql/migrations`, run in numeric order by `node-pg-migrate` (SQL mode) or `dbmate` | Never edit a migration after it ran in any shared environment; add a new one |
| Validation | **Zod** schemas in `packages/shared` — imported by both API and React forms | One schema per request body / query |
| Cache & jobs | Redis 7 + **BullMQ** | Rate limits, permission cache, scheduled jobs, exports |
| Files | AWS S3 or Cloudflare R2 (S3 API) via `@aws-sdk/client-s3`, presigned URLs | Private bucket for documents, public bucket + CDN for images |
| Email | AWS SES (or SendGrid) through a `Mailer` interface | Password reset, invites, report-ready emails |
| Push | Firebase Cloud Messaging (firebase-admin) | Used by M46 and transactional events |
| Payments | Razorpay Orders, Refunds, Subscriptions APIs + webhooks | Amounts always in paise |
| Admin web | React 18 + Vite + TypeScript, React Router 6, TanStack Query 5, React Hook Form + Zod, TanStack Table 8, Tailwind CSS + shadcn/ui (Radix), Recharts | Desktop-first, usable on tablet and phone |
| Tests | Vitest (unit), Supertest (API), Testcontainers-Postgres (integration), Playwright (admin E2E) | Every module ships with API tests for its error scenarios |

## 2. Repository layout

```
guruconnect/
  apps/
    api/
      src/
        app.ts                # express app, middleware order
        server.ts
        config/               # env parsing with zod
        db/                   # kysely instance, generated types (kysely-codegen)
        middleware/           # auth, rbac, audit, validate, rateLimit, error
        lib/                  # s3, mailer, razorpay, fcm, crypto, pagination, csv
        jobs/                 # BullMQ queues + workers
        modules/
          auth/               # one folder per module
            auth.routes.ts
            auth.controller.ts
            auth.service.ts
            auth.repository.ts
            auth.schemas.ts   # re-exports from packages/shared
            auth.test.ts
          …
    admin-web/
      src/
        app/                  # router, layout, providers, query client
        components/ui/        # shadcn primitives
        components/common/    # DataTable, FilterBar, PageHeader, StatusBadge, ConfirmDialog, …
        features/<module>/    # pages, components, api hooks, types per module
        lib/                  # api client (fetch wrapper), auth store, permissions hook
  packages/
    shared/                   # zod schemas, enums, permission keys, error codes
  sql/
    migrations/ seed/
```

## 3. API conventions

- **Base path:** `/api/v1/admin` for the admin portal. Public mobile endpoints mentioned in modules live under `/api/v1/app` and are out of scope except where an admin change must be visible to the app.
- **Naming:** plural nouns, kebab-case paths, camelCase JSON. Database columns are snake_case; the repository layer maps them.
- **IDs:** UUID v4 strings everywhere. Human-friendly codes (e.g. `GC-T10241`) are for display and search only.
- **Money:** integer paise (`amountPaise: 49900`). The UI formats with `Intl.NumberFormat('en-IN', {style:'currency', currency:'INR'})`.
- **Time:** timestamps are ISO-8601 UTC in JSON (`2026-09-26T11:30:00.000Z`). The UI renders in the admin's time zone (default `Asia/Kolkata`). Date-only fields use `YYYY-MM-DD`.
- **Success envelope:**
  ```json
  { "data": { … } }
  { "data": [ … ], "meta": { "page": 1, "pageSize": 20, "total": 342, "totalPages": 18 } }
  ```
- **Error envelope:**
  ```json
  { "error": { "code": "VALIDATION_FAILED", "message": "Some fields need attention.", "details": [ { "path": "amountPaise", "message": "Must be 0 or more" } ], "requestId": "7d1c…" } }
  ```
- **Status codes:** 200 read/update, 201 create, 202 accepted (async job), 204 delete, 400 malformed JSON, 401 unauthenticated, 403 missing permission, 404 not found (also for soft-deleted rows), 409 conflict, 413 payload too large, 415 wrong content type, 422 validation, 429 rate limited, 500 unexpected, 502 gateway (Razorpay/S3/FCM) error.
- **Updates:** `PATCH` with only the changed fields. Rows that several admins may edit (profiles, settings, configs, reviews) require the header `If-Match: <updatedAt of the row as read>`. A mismatch returns **409 VERSION_CONFLICT** with the current row, and the UI shows "Someone else changed this. Reload to see their changes."
- **State changes** use action endpoints (`POST /teachers/:id/approve`), never a generic `PATCH status`, so each transition can validate, audit and notify.
- **Idempotency:** `POST` endpoints that create money movements or send messages accept `Idempotency-Key` (UUID). The key and response are stored in Redis for 24 hours.

### Standard error codes

| Code | HTTP | When |
| --- | --- | --- |
| `AUTH_REQUIRED` | 401 | No or malformed access token |
| `AUTH_TOKEN_EXPIRED` | 401 | Access token expired — client must call refresh |
| `AUTH_INVALID_CREDENTIALS` | 401 | Wrong email or password |
| `AUTH_ACCOUNT_LOCKED` | 423 | Too many failed logins; `details.lockedUntil` |
| `AUTH_ACCOUNT_DISABLED` | 403 | Admin disabled |
| `AUTH_REFRESH_INVALID` | 401 | Refresh token missing, expired, revoked or reused |
| `AUTH_LINK_EXPIRED` | 410 | Reset or invite link invalid, used or expired |
| `FORBIDDEN` | 403 | Missing permission; `details.required` lists the key |
| `NOT_FOUND` | 404 | Row missing or soft-deleted |
| `VALIDATION_FAILED` | 422 | Zod validation failed; `details` has field errors |
| `CONFLICT_DUPLICATE` | 409 | Unique rule violated (maps PG error 23505) |
| `CONFLICT_STATE` | 409 | Action not allowed from the current status; `details.currentStatus` |
| `CONFLICT_IN_USE` | 409 | Delete blocked because other rows reference it; `details.references` |
| `VERSION_CONFLICT` | 409 | `If-Match` mismatch |
| `RATE_LIMITED` | 429 | Too many requests; `Retry-After` header |
| `FILE_TOO_LARGE` / `FILE_TYPE_NOT_ALLOWED` | 413 / 415 | Upload checks |
| `GATEWAY_ERROR` | 502 | Razorpay, S3, SES or FCM failed |
| `IDEMPOTENCY_MISMATCH` | 422 | `Idempotency-Key` reused with a different request body |
| `INVALID_SIGNATURE` | 400 | Webhook HMAC check failed (public webhook receivers only) |
| `QUERY_TIMEOUT` | 503 | Report query exceeded `statement_timeout` (15 s); suggest narrowing filters or exporting |
| `INTERNAL_ERROR` | 500 | Anything else (logged with requestId) |

## 4. Pagination, sorting, filtering, search

- **Offset pagination** (default for admin tables): `?page=1&pageSize=20`. `pageSize` allowed values 10, 20, 50, 100; default 20; max 100. Response `meta` has `page`, `pageSize`, `total`, `totalPages`.
- **Cursor pagination** for append-only, high-volume lists (audit logs, timelines, notification recipients, raw events): `?limit=50&cursor=<opaque>`; `meta.nextCursor` is `null` on the last page. The cursor encodes `(created_at, id)`.
- **Totals:** for tables that can exceed 100,000 rows, `total` is an estimate from `pg_class.reltuples` when no filter is applied; `meta.totalIsEstimate: true`.
- **Sorting:** `?sort=createdAt:desc,fullName:asc`. Each list endpoint declares an allow-list of sortable fields; anything else returns 422. A unique tiebreaker (`id`) is always appended.
- **Filters:** plain query params, repeated for multi-select: `?status=pending&status=under_review&cityId=<uuid>&createdFrom=2026-09-01&createdTo=2026-09-30`. Date ranges are inclusive and interpreted in `Asia/Kolkata`.
- **Search:** `?q=` (2–100 chars, trimmed). Matching rules are defined per module (usually `ILIKE` prefix on codes/emails/phones + `pg_trgm` similarity on names).
- The React `DataTable` keeps page, sort, filters and `q` in the URL query string so views are shareable and survive refresh.

## 5. Authentication and RBAC in every request

Middleware order: `requestId → helmet/cors → pino-http → rateLimit → authenticate → loadPermissions → validate → handler → audit → errorHandler`.

- `authenticate` verifies the access JWT (see Module 1), loads `req.admin = { id, email, isSuperAdmin, sessionId }` and rejects disabled admins or revoked sessions (session id checked against a Redis deny-list).
- `requirePermission('teachers.approve')` checks the admin's effective permissions (union of all roles), cached in Redis `perm:<adminId>` for 5 minutes and busted on any role or assignment change. Super admins pass every check.
- The React app reads `GET /auth/me` → `permissions[]`, hides navigation items and buttons the admin cannot use (`<Can permission="teachers.approve">`), and still handles 403 from the API.

## 6. Soft delete

- Tables with `deleted_at` are soft-deleted: `UPDATE … SET deleted_at = now(), deleted_by = :adminId`.
- Every repository query adds `deleted_at IS NULL` unless the endpoint explicitly supports `?includeDeleted=true` (super admin only).
- Unique indexes are partial (`WHERE deleted_at IS NULL`) so a deleted name can be reused.
- Deleting a master record that is referenced by live rows returns **409 CONFLICT_IN_USE**; the UI offers "Deactivate instead".
- Restores: `POST /<resource>/:id/restore` where a module says so.

## 7. Audit logging (all admin actions)

- Every successful state-changing admin request writes one `audit_logs` row **in the same database transaction** as the change (helper `audit(tx, {...})`). If the audit insert fails, the change rolls back.
- `action` naming: `<entity>.<verb>` in past tense, e.g. `teacher.approved`, `payment_config.published`, `admin.role_assigned`.
- `old_values` / `new_values` contain only changed fields. Never log password hashes, tokens, OTPs, full Aadhaar/PAN numbers or document URLs; the helper strips keys matching `/password|token|secret|aadhaar_number|pan_number|signed_url/i`.
- Read access to sensitive data is audited too: unmasking a document, viewing full phone numbers, exporting reports (`*.unmasked`, `*.pii_viewed`, `report.exported`).
- Security events (login success/failure, lockout, password reset, token reuse) are logged with `actor_type = 'admin'` or `'system'`.
- Each module lists its audit events in section 19. Module 0 provides the audit log viewer.

## 8. Validation rules (global)

- Strings are trimmed; empty strings become `null` for optional fields.
- Names: 2–100 chars, letters, spaces, `.`, `'`, `-`; no emoji.
- Email: RFC 5322 basic, max 254, stored lower-case (`citext`).
- Phone: Indian mobile in E.164 `^\+91[6-9]\d{9}$` unless the module allows other countries.
- URLs: `https://` only, max 2,048.
- UUID params are validated before hitting the database (bad UUID → 404, not 500).
- Money: integer paise, 0 ≤ value ≤ 10,00,00,000 (₹10 lakh) unless stated.
- Text areas: max length per field; HTML is stripped server-side; Markdown is sanitised on render.
- Enumerations: validated against the same `CHECK` lists as the database (shared enums in `packages/shared`).

**Human-readable codes.** Codes shown to people come from PostgreSQL sequences through column defaults, so the application never generates them: `teachers.public_code` `GC-T10001…` (`seq_teacher_code`), `institutes.public_code` `GC-I2001…`, `parents.public_code` `GC-P50001…`, `students.public_code` `GC-S50001…`, `leads.public_code` `LD-100001…`, `transactions.public_code` `TXN-7000001…`, `complaints.case_number` `CS-1001…`. Sequences are never reset; gaps after rolled-back transactions are expected.

## 9. File uploads

1. Client calls `POST /api/v1/admin/files/presign` with `{ purpose, fileName, mimeType, sizeBytes, checksumSha256 }`.
2. API validates purpose-specific rules (documents: PDF/JPEG/PNG ≤ 10 MB; images: JPEG/PNG/WebP ≤ 5 MB), creates a `files` row with `status = 'pending'` and returns a presigned `PUT` URL (5-minute expiry) and `fileId`.
3. Client uploads directly to S3/R2, then calls `POST /files/:id/confirm`. API checks the object exists, size and checksum match, queues a virus scan, sets `status = 'uploaded'`.
4. Private files are only served through `GET /files/:id/url` which returns a 60-second signed URL and audits access for documents.

## 10. Background jobs (BullMQ)

| Queue | Schedule | Used by |
| --- | --- | --- |
| `payment-config-activate` | every minute | M5 — activates scheduled fee versions |
| `trust-recalc` | on event + nightly 02:00 IST | M36, M37 |
| `analytics-rollup` | hourly (today) + nightly 01:00 IST | M21, M47 |
| `subscription-lifecycle` | every 15 minutes | M30, M32, M41 — expiry, grace, reminders |
| `referral-release` | hourly | M42 — releases held rewards |
| `notifications-send` | on demand / scheduled | M46 |
| `report-export` | on demand | M48–M50 |
| `banner-status` | every 5 minutes | M44 — activates / expires banners |
| `cleanup` | nightly | M1 sessions and reset tokens, M0 soft-deleted files |

Jobs run as `actor_type = 'system'` in the audit log.

## 11. Security baseline

- HTTPS only, HSTS 1 year. Admin portal on its own domain (`admin.guruconnect.in`), not linked from the public site, behind Cloudflare with bot protection.
- CORS allow-list: the admin origin only. Cookies: `Secure; HttpOnly; SameSite=Strict; Path=/api/v1/admin/auth`.
- CSRF: the refresh endpoint checks `Origin` and a double-submit `X-CSRF-Token`; all other endpoints use the Bearer header (not cookies).
- Rate limits (Redis): login 5/min per IP+email, forgot password 3/hour per email, general API 300/min per admin, exports 10/hour per admin.
- Secrets in AWS Secrets Manager / environment; never in the repo.
- PII: phone numbers and emails of app users are masked (`+91 98XXX XX210`) unless the admin has `users.pii`; unmask requests are audited.
- Aadhaar handling: store only masked numbers and an HMAC hash for duplicate detection; never store full Aadhaar numbers. Document files are private and encrypted at rest (SSE-S3 / R2 default).
- Dependencies scanned in CI (`npm audit`, Dependabot); OWASP ASVS L2 as the checklist.

## 12. UI conventions (admin web)

- Layout: left sidebar (collapsible below 1080 px, drawer below 720 px), sticky top bar with global search, content max-width 1600 px.
- Shared components (build once in the first module that needs them): `PageHeader`, `DataTable` (server-side pagination/sort, row selection, column visibility, sticky header, CSV export button), `FilterBar`, `SearchInput` (300 ms debounce), `StatusBadge`, `ConfirmDialog` (typed-reason variant), `Drawer`, `FormField`, `MoneyInput` (₹ ↔ paise), `DateRangePicker`, `EntityPicker` (async select), `FileUploader` (presign flow), `Timeline`, `EmptyState`, `ErrorState`, `Can` (permission gate), `AuditTrail` (entity history panel).
- Every list page has: loading skeleton, empty state, error state with retry, and keeps filters in the URL.
- Every destructive or money-affecting action uses `ConfirmDialog`; actions that affect users (reject, suspend, publish price) require a reason.
- Accessibility: WCAG 2.1 AA, visible focus, keyboard-operable tables and dialogs, labels on every input.

## 13. Definition of done (per module)

1. Migration(s) applied; Kysely types regenerated.
2. Zod schemas in `packages/shared`; API routes with permission checks, validation and audit.
3. API tests covering every row of the module's Error Scenarios table.
4. React pages and components with loading/empty/error states and permission gating.
5. Audit events visible in the entity's `AuditTrail` panel.
6. Seed data updated if the module adds permissions or reference data.
