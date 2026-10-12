# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

GuruConnect Admin Web Portal. This repo currently holds two things:

1. **A complete, implementation-ready SRS** (`README.md`, `00-conventions.md` … `05-roadmap-and-enhancements.md`, `modules/M00…M50-*.md`, `sql/`) — 51 modules, 71 tables, 436 admin API endpoints. Read this spec before implementing anything; the code must match it, not the other way around.
2. **The two admin apps being built from that spec**: `GuruBackend/` (Node.js + Express API) and `GureFronend/` (React + Vite admin web). `M01 Authentication` (`modules/M01-authentication-system.md`) is implemented — see "M01 Authentication — implemented" below for what's real and what's simplified. Every other module still needs to be implemented, in the order given in the root `README.md`'s implementation-order table.
3. **A mobile app API surface bolted onto the same `GuruBackend`**, mounted at `/api/v1/app` (separate from `/api/v1/admin`) — `src/modules/app/*`. This implements a subset (bootstrap, platform/masters, auth, registration) of a *separate, sibling* spec pack for the GuruConnect mobile app, which lives in its own repo at `D:\GuruMobile` (own `00-conventions.md`…`05-roadmap...md`, `modules/M00…M54-*.md`, `sql/mobile_only.sql` + `sql/seed/004_mobile.sql`). That pack's own `CLAUDE.md` describes a separate `apps/api` npm-workspace architecture — **that was never built** (no `apps/` directory exists there); this repo's `modules/app/*` is the one implementation of that spec that actually exists, built directly into `GuruBackend` on request. See "Mobile app API — implemented" below.

Read `00-conventions.md` in full before writing any admin backend or frontend code — it is the single source of truth for API shape, error codes, RBAC, audit logging, soft delete, pagination and the UI conventions. A module's own `modules/MNN-*.md` file (22 sections) is the spec for that module only; don't reimplement something a module doesn't ask for. For the mobile app surface, the equivalent source of truth is `D:\GuruMobile\00-conventions.md` and `D:\GuruMobile\modules\M00...M06-*.md`.

## Mobile app module specs to implement (read these first)

When asked to build mobile app modules **M10 to M15** (parent and student subscriptions, student registration and home, teacher registration, teacher documents, and the uploads and payments endpoints they need), read `GuruBackend/docs/mobile-specs/M10-M15-backend-spec.md` in full before writing any code. It is self-contained: it holds the exact spec text and the exact table definitions, and states what already exists and the build order. Implement exactly what it says. If something is not specified there, do not guess: list it as a question and continue with the rest.

## Repository layout

```
GuruConnect/
  README.md                     Single project README (spec pack summary + setup/run instructions)
  CLAUDE.md                     This file
  00-conventions.md             Stack, repo layout, API envelope, errors, pagination, RBAC, audit, security — READ FIRST
  01-data-model.md              All tables, ER diagrams, FKs
  02-api-index.md                Every endpoint, grouped by module, with its permission key
  03-rbac-matrix.md             Permission keys × default roles
  04-react-app-structure.md     Route map (84 routes), sidebar, folder layout, shared components
  05-roadmap-and-enhancements.md Delivery phases, future enhancements per module
  modules/MNN-*.md              One spec file per module (M00 platform foundation + M01–M50)
  sql/schema.sql                Whole DB schema, one file
  sql/migrations/NNN_*.sql      One migration per module that owns tables (numbered by module)
  sql/seed/*.sql                RBAC seed, reference data (India locations, classes, subjects...), config defaults
  index.html                    Searchable offline viewer for the whole spec pack
  GuruBackend/                  Node.js 20 + Express 4 + TypeScript API
  GureFronend/                  React 18 + Vite + TypeScript admin web
```

Inside each app, follow the module-per-folder pattern from `00-conventions.md` §2 (adapted to these two top-level app folders instead of a nested `apps/` workspace):

```
GuruBackend/src/
  app.ts, server.ts       Express app assembly / entrypoint
  config/env.ts           Zod-parsed environment config
  db/                     Kysely instance + table types (db/types.ts — hand-written until kysely-codegen is wired up)
  middleware/             authenticate, validate, errorHandler; still to come: requirePermission (RBAC), audit, global rateLimit (per-endpoint limits live in lib/rateLimit.ts, Redis-backed)
  lib/                    password (bcrypt), jwt, tokens, otp, audit, errors — plus s3/mailer/razorpay/fcm as later modules need them
  modules/auth/           M01 — auth.routes/service/repository/schemas.ts, auth.test.ts (see below)
  modules/<module>/       Same pattern for every other module: .routes.ts, .service.ts, .repository.ts, .schemas.ts, .test.ts
  scripts/seedAdmin.ts    npm run seed:admin — creates/updates one admin from SEED_ADMIN_* env vars (defaults: see below)

GureFronend/src/
  app/                    router.tsx, providers.tsx (QueryClient), AppShell.tsx
  lib/                    api.ts (fetch wrapper: envelope, in-memory access token, silent refresh-and-retry on 401)
  features/auth/          M01 — authStore.ts (in-memory session, useSyncExternalStore), RequireAuth.tsx, api/auth.api.ts,
                          pages/LoginPage.tsx (password + mobile-OTP tabs), ForgotPasswordPage.tsx, ResetPasswordPage.tsx
  components/shared/      DataTable, FilterBar, StatusBadge, ConfirmDialog, PageHeader, etc. — build once, reuse everywhere
  features/<module>/      pages/, components/, api hooks, schemas.ts
  styles/                 tokens.css (theme variables), tailwind.css
```

`packages/shared` (Zod schemas, enums, permission keys, error codes shared between both apps) does not exist yet — create it as an npm workspace the first time a schema needs to be shared, rather than duplicating validation logic between the two apps.

## Commands

**Backend** (`GuruBackend/`):
```
npm install
npm run dev          # tsx watch src/server.ts
npm run build        # tsc -p tsconfig.json
npm run test         # vitest run — loads .env.test (guruconnect_test db, Redis db 1)
npm run test:watch
npm run lint         # tsc --noEmit
```
Run a single backend test file: `npx vitest run src/modules/auth/auth.test.ts`

**Frontend** (`GureFronend/`):
```
npm install
npm run dev          # vite
npm run build        # tsc -b && vite build
npm run test         # vitest run
npm run test:watch
npm run lint         # oxlint
```
Run a single frontend test file: `npx vitest run src/features/auth/pages/LoginPage.test.tsx`

**Redis** — 7+ (Memurai Developer on Windows), `REDIS_URL` in `.env` (db 0) and `.env.test` (db 1). Optional at runtime; required for the Redis-specific auth tests, which fail loudly if it's down.

**Database** — PostgreSQL 16+, extensions `pgcrypto`, `citext`, `pg_trgm` (created by migration 000). Two local databases already exist, owned by role `prep`: `guruconnect` (dev) and `guruconnect_test` (test), both loaded with `sql/schema.sql` + all `sql/seed/*.sql`. Credentials are in `GuruBackend/.env` / `.env.test` (gitignored — `.env.example` has the shape). To rebuild from scratch:
```
psql -v ON_ERROR_STOP=1 -d guruconnect -f sql/schema.sql
for f in sql/seed/*.sql; do psql -v ON_ERROR_STOP=1 -d guruconnect -f "$f"; done
```
Seeds are idempotent — safe to re-run. Prefer `sql/migrations/*.sql` (numbered by module) over the single schema file once a real migration tool (node-pg-migrate SQL mode or dbmate) is wired up, per `README.md`.

## Testing rule (non-negotiable)

**Every module's code change ships with its tests in the same piece of work — write or update tests immediately after the implementation is functionally complete, before moving to the next module or task.** This applies to both apps:

- Backend: a module isn't done until its API tests cover every row of that module's *Error Scenarios* table (section 20 of the module's spec file), not just the happy path. Use Vitest + Supertest against the real `guruconnect_test` database (see `health.test.ts` for the pattern — no mocked DB).
- Frontend: a page/component isn't done until it has a Vitest + Testing Library test for its rendered states relevant to the change (loading/empty/error where applicable).
- Never mark a module or task complete without running its tests and seeing them pass.

## Architecture — things that require reading multiple files to understand

- **API envelope & errors.** Every response is `{ data, meta? }` or `{ error: { code, message, details?, requestId } }` — never a bare object or array. The standard error codes table (`00-conventions.md` §3) is shared across all modules; add a new code there before inventing one in a module.
- **Middleware order matters**: `requestId → helmet/cors → pino-http → rateLimit → authenticate → loadPermissions → validate → handler → audit → errorHandler`. `authenticate` (M01) exists now; `loadPermissions`/`requirePermission` (M02, RBAC), a real `audit` middleware wrapper and a global `rateLimit` middleware are still to come (Redis-backed rate limiting exists today as `lib/rateLimit.ts`, called per endpoint from services) — add them in that position as M02/M00 are implemented, don't append them after the routes.
- **RBAC is permission-key based, not role-based in the handlers.** Routes call `requirePermission('teachers.approve')`; the key → role mapping lives in `roles`/`role_permissions` (M02) and `03-rbac-matrix.md`. Permissions are cached in Redis per admin for 5 minutes and busted on role change.
- **Audit logging is transactional, not fire-and-forget.** Every state-changing admin request writes one `audit_logs` row *in the same DB transaction* as the change; if the audit insert fails, the change rolls back. Sensitive fields (passwords, tokens, Aadhaar/PAN, signed URLs) are stripped automatically — never bypass the shared `audit()` helper to log a state change directly.
- **Soft delete is the default**, not an opt-in: any table with `deleted_at` must have every repository query add `deleted_at IS NULL` (unless `?includeDeleted=true`, super-admin only), and unique indexes on those tables are partial (`WHERE deleted_at IS NULL`).
- **State transitions are dedicated action endpoints** (`POST /teachers/:id/approve`), never a generic `PATCH status` — this is how each transition gets its own validation, audit event and notification.
- **Money is integer paise everywhere** (API, DB, JS) — only the UI formats to ₹. **IDs are UUID v4**; human-facing codes (`GC-T10241`, `TXN-7000001`) come from PostgreSQL sequences via column defaults, never generated in application code.
- **Cross-module reads vs. table ownership**: the implementation-order table in `README.md` lists which tables each module owns and which modules it *reads* from without owning tables (e.g. M17, M30, M32, M49, M50 own nothing but read across several modules) — check that table before assuming a module needs its own migration.
- **Background jobs (BullMQ)** run scheduled/event-driven work outside the request cycle (trust score recalculation, subscription lifecycle, referral release, report export, banner activation) — see the queue table in `00-conventions.md` §10. These run as `actor_type = 'system'` in the audit log, not as an admin.
- **The React route map, sidebar and shared-component list are fully specified in `04-react-app-structure.md`** — new pages should reuse `DataTable`/`FilterBar`/`StatusBadge`/`ConfirmDialog`/etc. rather than rebuilding list/detail scaffolding per module.
- **Build order is a dependency graph, not a checklist**: `README.md`'s phase dependency graph and *Depends on* column determine what can be built next; a module can start once everything in its *Depends on* column is merged, and same-phase modules can be built in parallel.

## M01 Authentication — implemented

Email+password login, forgot/reset password, session listing/revocation and refresh-token rotation with reuse detection all follow `modules/M01-authentication-system.md` as written. Three deviations from that spec, made for this dev environment and called out so they get revisited before production:

- **Password hashing is bcrypt (`lib/password.ts`), not Argon2id.** Bcrypt is pure-JS (`bcryptjs`) and needs no native build step; Argon2id was the spec's choice for a reason (better resistance to GPU cracking) — swap it in before production.
- **Access tokens are HS256 (`lib/jwt.ts`, `JWT_ACCESS_SECRET`), not RS256 with a JWKS endpoint.** Fine for a single API process; move to RS256 with key rotation once there's more than one verifier.
- **Redis is wired up, but optional at runtime** (`lib/redis.ts`, `REDIS_URL`; `REDIS_ENABLED=false` turns it off). It backs the login/OTP/forgot-password rate limits (`lib/rateLimit.ts`, async `hitRateLimit`), the `revoked_sid:<sid>` deny-list checked first by `authenticate` (`lib/sessionDenylist.ts`) and the BullMQ nightly cleanup (`modules/auth/auth.jobs.ts`, started from `server.ts`). If Redis is down the API degrades instead of failing: rate limits fall back to in-process counters and `authenticate` still checks `admin_sessions.revoked_at` in Postgres (Postgres stays the source of truth). The permission cache (M02) will use the same client. **Dev Redis on this Windows machine** is a portable Memurai Developer (Redis 7-compatible) extracted to `C:\Users\HP\memurai-portable` — the MSI installer failed with 1603 (temp-dir access denied) so it was extracted with `msiexec /a` instead, and a per-user logon task "Memurai Dev Redis" starts it (`memurai-cli.exe ping` → PONG). The test suite uses Redis db 1 (`.env.test`) and `src/test/globalSetup.ts` clears `rl:*`/`revoked_sid:*` before each run.
- **Mailer** (`lib/mailer.ts`, templates in `modules/auth/auth.emails.ts`): reset link, password-changed confirmation, "someone tried to sign in" lockout notice and token-reuse notice are all sent through nodemailer when `SMTP_HOST` is set. With no SMTP configured they are logged to the console (`[dev-email]`), and under `NODE_ENV=test` they are captured in the exported `outbox` array so tests can read links out of them. Links are built from `ADMIN_PORTAL_URL`. The invite email template exists (`sendInviteEmail`) but nothing sends it until M02 creates admins.
- **Password policy** (`lib/passwordPolicy.ts`, FR-1.10): 12–128 chars, 3 of 4 character classes, not equal to email/name, plus a small built-in common-password list. **Not done:** the breached-password lookup (HIBP / bloom filter) and password history.
- **Session rules**: refresh rotation is a compare-and-swap in Postgres; a token rotated less than 10 s ago is served once more without touching cookies (two-tab grace), older reuse revokes the token family and emails the admin; refresh also checks Origin against `CORS_ORIGIN`; an 11th device signs out the least recently used session.
- **`DELETE /admins/:adminId/sessions`** is implemented but gated on `isSuperAdmin` instead of the spec's `sessions.revoke_any` permission, because RBAC (M02) doesn't exist yet. **Swap it for `requirePermission('sessions.revoke_any')` when M02 lands.**

**Extension beyond the spec: mobile OTP login.** The user asked for a mobile-OTP sign-in path in addition to email+password, with no SMS gateway available yet. Added `admin_otp_codes` (migration `049_admin_mobile_otp.sql`, appended to `schema.sql`) keyed off `admin_profiles.phone` (M03's column, not a new one on `admins`). Because there's no SMS provider, the generated code is deliberately visible: `POST /auth/otp/request` returns it as `devCode` in the response body, and `GET /auth/otp/logs?phone=` (disabled when `NODE_ENV=production`) lists recent codes — the LoginPage's "Fill from OTP logs" button calls that endpoint. Replace `admin_otp_codes.code` with a hashed value and wire a real SMS gateway before this goes anywhere near production; until then, don't remove the on-screen code or the logs endpoint, since they're the only way to complete this flow in dev.

**Demo admin**: `npm run seed:admin` in `GuruBackend/` (uses `db`, not raw SQL, so the hash always matches whatever `lib/password.ts` uses) creates/updates one super-admin from env vars, defaulting to `sameer@gmail.com` / `demo@123` / phone `+919999999999`. Already seeded into both `guruconnect` and `guruconnect_test`. Override with `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` / `SEED_ADMIN_PHONE` / `SEED_ADMIN_NAME` env vars if you need a different account.

**Bootstrap CLI**: `npm run admin:create -- --email you@example.com --name "Your Name" --super` (`src/scripts/adminCreate.ts`, FR-1.11) creates an *invited* admin with an unusable random password and prints a one-time 72-hour invite link to `/accept-invite`. Never run it against the dev DB just to test it — it creates a real row.

**Frontend (M01 UI)**: `LoginPage` (lockout countdown, throttle message), `ForgotPasswordPage`, `ResetPasswordPage` and `AcceptInvitePage` (both are `SetPasswordPage` with different wording, live `PasswordStrength` checklist), `SessionsPage` at `/account/security` (`SessionRow`, "Sign out other devices"), and `SessionExpiredDialog` — `apiFetch` calls `authStore.expire()` when a 401 can't be recovered and `RequireAuth` shows the dialog over the current page, returning to it after sign-in.

**Not part of M01 anymore, but still open:** the RS256/Argon2id swaps above, the HIBP check, and a real SMS gateway for the OTP path.

## Mobile parent modules M07 / M08 / M09 — implemented (`/api/v1/app`)

Specs live in `D:\GuruMobile\modules\M07-parent-child-setup.md`, `M08-parent-dashboard.md`, `M09-parent-profile.md`. Code: `GuruBackend/src/modules/app/{children,home,profile}/`, shared guard `middleware/requireParent.ts` (role must be `parent`; the parent id comes from the token's `pid`, never from the body/query), helpers `lib/ifMatch.ts`, `lib/present.ts` (masking, CDN URLs), `test/appHelpers.ts` (parent + seed-master fixtures).

- **`GET /masters`** now also returns `classes[levelOrder]`, `subjects[minClassOrder,maxClassOrder]`, `boards[shortName,type,stateId]`, `teacherCategories`, `teachingModes` (all active, ordered).
- **Children** (`/parent/children`): list, create (`Idempotency-Key` required, replayed from Redis for 24 h; `LIMIT_REACHED` is **409** as M07/the app asked — the mobile conventions table says 429, M07 wins), edit (`If-Match: <updatedAt>`, `VERSION_CONFLICT` 409, `meta.droppedSubjects` always present, `meta.recommendationsPreview` only for qualifying edits), soft delete, `PUT /order`. The limit is re-read from `system_settings.limits.parent_max_children` under a row lock on the parent, so concurrent creates can't exceed it. Optimistic locking compares `updated_at` at millisecond precision inside the `UPDATE`. Every write is audited in the same transaction (`app.child_added/updated/removed`).
- **Response conventions chosen where the spec was ambiguous:** `subjects` and `teacherCategories` are name arrays (with `subjectIds`/`categoryIds` beside them), `class` / `board` / `preferredMode` are objects (`board` = `{id,name,shortName}`, `preferredMode` = `{id,name}`, both `null` when unset). `DELETE` and `PUT /order` return `{data:{ok:true}}`.
- **`GET /home/parent`**: children switcher, banners (real: M44 serving rules against `banners`+`files`, `home_top` ≤3, `home_middle` ≤2), five rails, `?rail=&childId=&cursor=&limit=` single-rail pages (`{data:{items}, meta:{nextCursor}}`). **The rails are stubs**: `home/home.rails.ts#loadRail` returns empty pages because ranking needs teacher/institute tables that don't exist yet — fill that one function in (teacher/institute modules); the response contract, cursors and per-child null rails are already final. Likewise `children/children.recommendations.ts#computeRecommendationsPreview` returns `[]` until teachers exist; cache invalidation (`rec:<id>`, `home:rec:teacher:<id>`, `home:rec:institute:<id>`) is real.
- **Profile** (`/parent/profile`): masked phone/email, `photoUrl` from `app_users.profile_photo_file_id` → `files` (status `uploaded`) via `CDN_BASE_URL`, live children count, unread notifications. `PATCH` takes `{fullName?, cityId?, areaId?}` with `If-Match`; a city change clears the area unless a new one (in that city) is sent, and moves `parents.state_id` with the city (board rules compare against it); `app_users.full_name` is kept in step so `/me` shows the new name. `profilePhotoFileId` (a finished `avatar` upload by the same user, or `null` to remove) is supported — see "Uploads" below; the replaced/removed file is soft-deleted and its object deleted.
- **`/me`** still returns `registration.nextStep: 'child_setup'` until the parent has ≥1 live child.
- Idempotency (`lib/idempotency.ts`) is now Redis-backed with an in-process fallback (it was in-process only), so `registerParent` also benefits.


### Uploads (M00 BR-0.8) — implemented, local-disk storage only

`POST /uploads/presign`, `POST /uploads/:fileId/confirm`, `GET /files/:id/url` (`modules/app/uploads/`, any signed-in app role; ownership by `files.uploaded_by_id`). Purpose table (bucket, MIME types, max size) is `uploads.config.ts` and mirrors mobile conventions §10. Confirm checks stored size, stored Content-Type **and the file's magic bytes** against what was presigned (`lib/storage.ts#sniffMime`), deleting the object and soft-deleting the row on a mismatch. Pending uploads: max 20 per user (`LIMIT_REACHED`, `details.reason = "max_pending_uploads"`), and an hourly BullMQ job (`uploads.jobs.ts`, shared scheduler in `lib/jobs.ts`) removes ones older than 24 h.

- **No R2/S3 account exists**, so the only storage driver is local disk (`lib/storage.ts`, `STORAGE_LOCAL_DIR`, default `.storage`, git-ignored). Its "presigned" URLs are HMAC-signed links back to this API (`/api/v1/app/dev-storage/<bucket>/<key>`, enforcing expiry, exact Content-Type and Content-Length like a real R2 presigned PUT) and the dev "CDN" is `GET /cdn/<key>` (public bucket only). Both are mounted only when `NODE_ENV !== 'production'`; in production presign returns `GATEWAY_ERROR` until a real driver is bound to `storage` in `lib/storage.ts` (same `StorageProvider` interface; nothing else changes).
- **A phone/emulator can't reach `localhost`**: set `API_PUBLIC_URL` (e.g. `http://192.168.1.20:4000`) so presigned and CDN URLs point at an address the device can open. `CDN_BASE_URL` defaults to `<API_PUBLIC_URL>/cdn` in dev and `https://cdn.guruconnect.in` in production.
- **Spec vs schema mismatch, resolved in favour of the schema:** the specs say confirm sets `files.status = 'active'`, but the `files.status` CHECK only allows `pending | uploaded | quarantined | deleted`. The database uses `uploaded`; the confirm response still reports `status: "active"` (the M00 contract). Every query that trusts a file (banners, avatars, `/me`) requires `status = 'uploaded'`, `deleted_at IS NULL` and, for CDN URLs, `visibility = 'public'`.
- `files.storage_provider` is written as `'r2'` per spec (the column only allows `s3`/`r2`) even though local disk is what's behind it in dev.
- Registration-token uploads (uploading before an account exists) are not implemented — only signed-in users can upload.
## Mobile modules M10–M15 + M43 payments — implemented (`/api/v1/app`)

Spec: `GuruBackend/docs/mobile-specs/M10-M15-backend-spec.md`. Code: `modules/app/{student,teacher,teacherDocs,payments,subscriptions}/`, `home/home.student.ts`, guards `middleware/requireRole.ts` (`requireStudent`/`requireTeacher`), libs `kv.ts` (Redis + in-memory fallback), `notify.ts`, `pricing.ts` (`resolveFee`), `money.ts`, `razorpay.ts` (fake gateway behind an interface), `verhoeff.ts`, `contact.ts`.

- **Stubs behind interfaces:** SMS (`providers/sms.ts`, test mode records `smsOutbox`), payments (`lib/razorpay.ts` `fakeGateway`; `simulatePayment` stands in for Checkout), storage (local disk). Push delivery is not built: in-app `user_notifications` rows are written, `push_status` stays `pending`.
- **Wallet** is off unless `system_settings` `features.wallet_enabled = true` (M46 not built). **Payments** support only the fee codes M10/M13/M15 use (teacher registration, parent/student subscriptions); the others return 422 `not_supported_yet`.
- **Hooks left for other modules:** `assertParentalConsentAllows(studentId)` (M37/M38), rails other than `recommended_teachers` in `home.student.ts` (M8 rules not in the pack), webhook → `applyCapture`/`applyFailure` (M40), queued subscription periods in `transactions.metadata.pendingPeriod` (M41 job), refund requests flagged in `metadata.refundRequest`.
- **Tests:** vitest runs files sequentially (`fileParallelism: false`) because suites flip shared rows (fee configs, wallet setting). Without Redis the whole run takes ~25 min and the pre-existing Redis-dependent auth/children tests fail; start Memurai first.

## Mobile modules M16–M21 — implemented (`/api/v1/app`)

Spec: `GuruBackend/docs/mobile-specs/M16-M21-backend-spec.md`. Code: `modules/app/{teacherVerification,teacherAvailability,teacherProfile,teacherDashboard,notifications,institute}/`. New shared pieces: `lib/{gstin,geo,slug,names}.ts`, `requireInstituteStaff` / `requireInstituteManager` in `middleware/requireRole.ts`, an `iid` (institute id) claim on app access tokens, `createNotification` now honours `user_notification_preferences` (push off → `push_status = 'skipped_pref'`) and returns whether a row was written.

- **Profile completeness has one definition** (`teacher.repository.ts#completenessItems`, M17 BR-17.5): it drives `profile_completeness` (also after M14 writes), the Profile tab checklist and the dashboard's "next item".
- **Dashboard** (`GET /teacher/dashboard`) only reads `teacher_daily_stats`; nothing computes that roll-up yet (Admin M21). Live counters (unanswered/open leads, upcoming demos) are queried directly.
- **Reminder jobs** (`notifications.jobs.ts`, every 30 min via BullMQ, needs Redis): unanswered-lead reminders (6 h / 20 h), teacher plan/boost expiry (7/3/1 days), institute draft nudges (24 h / 72 h / 7 d). All are idempotent through `dedupe_key`.
- **Hooks for other modules:** `pausedUntil(teacherId)` (`teacherAvailability`) for Modules 27/37/38 (BR-19.4); the new-lead push (BR-20.4), demo reminders and review/verification pushes are sent by their own modules via `createNotification`.
- **Institute registration** supports phone tokens only. Email/Google tokens need the "combined token" OTP flow that M04 does not implement yet. Institute documents/submit (M22) and staff invites (M24) do not exist; invites are plain `institute_managers` rows with `status = 'invited'`.

## Admin M02 (Roles & Permissions) and M16 (Teacher Registration Queue) — implemented (`/api/v1/admin`)

Specs: `modules/M02-roles-permissions.md`, `modules/M16-teacher-registration-queue.md`. Code: `GuruBackend/src/modules/rbac/` and `GuruBackend/src/modules/teacherVerification/` (`tv.queries.ts` reads, `tv.actions.ts` writes, `tv.checks.ts` automated checks, `tv.jobs.ts` jobs). Tests build admins with `createAdminWithToken` (`test/helpers.ts`, no login round trip) and clean up with `purgeRbacFixtures`.

- **RBAC is live.** `middleware/requirePermission.ts` (`requirePermission` = any of the keys, `requireAllPermissions`), effective permissions cached 5 min in `lib/permissions.ts` (Redis `perm:<adminId>` with in-process fallback; busted on every role/assignment change). `GET /auth/me` now returns real `roles`, `permissions` and an `etag` (`?etag=` → 304 until they change). `DELETE /admins/:id/sessions` is gated by `sessions.revoke_any` (it was "super admin" before). **Every new admin route must declare `requirePermission`.**
- **The permission catalogue is the `permissions` table, seeded by `sql/seed/001_rbac.sql`**; there is no `packages/shared/permissions.ts` sync-on-deploy yet. Unknown keys are rejected by lookup.
- **Guard rails (FR-2.5)** hold for everyone: no disabling/deleting yourself, never zero active super admins, only a Super Admin grants or removes `super_admin`. Granting anything sensitive (including via a role assignment) needs a `reason`.
- **M16:** queue/stats/case detail, claim/release (`?force=true` needs `teacher_verification.decide`), per-document decisions, notes, send-back, approve/reject (badge, registration period starts at approval, FORGED_DOCUMENT suspends the app account, captured fee → auto-approved `refunds` row), manual creation (maker–checker). Teacher-visible log rows use `is_internal = false`; this is what the mobile `/teacher/verification` timeline reads.
- **Automated checks** run behind `IdentityChecks` (`tv.checks.ts`): duplicate identity and age are real; name match, face match and image quality return "not run" until a vendor exists. Jobs (every 5 min, need Redis): release claims idle 30 min, run pending checks, SLA e-mails to admins with `queue_alerts` on.
- **Hooks left:** trust score calc (M36), search index refresh, `teacher.approved` referral event (M42), blocking the document hash on FORGED_DOCUMENT (no blocklist table), admin file presign for manual creation (`files` rows must already exist).

## Admin M07 (Country Management) — implemented (`/api/v1/admin/countries`) — the first master module

Spec: `modules/M07-country-management.md`. Code: `GuruBackend/src/modules/countries/` (`countries.routes/service/schemas/test.ts`) and `GureFronend/src/features/masters/`. Every other master module (states, cities, areas, classes, subjects, boards, teaching modes, teacher categories) should copy this shape.

- **Backend pattern:** list (offset pagination, `q` = name prefix + trigram + exact ISO code, `sort=name|sortOrder|createdAt:asc|desc`, `active`, `includeDeleted` = super admin only), `GET :id` with a live usage count, create, `PATCH` (**`If-Match` required**, compared against `updated_at` under a row lock; a stale edit returns `VERSION_CONFLICT` with `details.current`; unchanged values are a no-op with no audit row), `activate`/`deactivate` (idempotent), soft `DELETE` (409 `CONFLICT_IN_USE` with `details.references` while live states use it — the row lock also blocks a concurrent state insert), `restore` (super admin; 409 `CONFLICT_DUPLICATE` if the unique fields were reused). Every write audits in the same transaction (`module: 'locations'`, `entity_type: 'countries'`).
- **Dropdown mode:** `?fields=id,name,...` returns active rows unpaginated, cached 10 min in `kv`. Writes bump a version key (`master:countries:ver`) instead of deleting keys, which orphans every cached variant at once.
- **Deviations from the spec text:** ISO/currency codes are upper-cased before validation (so `in` is accepted as `IN`); the 403 message for an admin who holds `locations.read` but not `locations.manage` is "You can view countries but not change them." (spec section 20).
- **Frontend pattern:** a module is a config file (`features/masters/config/<module>.config.tsx`: columns, zod form schema, fields, API path, permissions, usage labels) rendered by the generic `MasterListPage`, `MasterFormDrawer`, `DeleteOrDeactivateDialog`. Shared pieces built here and reusable by any list: `components/shared/{DataTable,Pagination,StatusSwitch,StatusBadge}`, `lib/apiFetchPage` (keeps the `meta` envelope), `lib/zodResolver` (no `@hookform/resolvers` dependency), `features/auth/usePermissions` (permissions from `/auth/me`, hides UI the API would refuse anyway). The sidebar (`app/AppShell.tsx`) is driven by a `NAV` array filtered by permission — add one line per module.
- **Tests:** backend `countries.test.ts` (58 tests, covers every row of the spec's Error Scenarios table; fixtures are purged by creator so re-runs are clean — the list search is fuzzy, so tests use unique tags). Frontend: `MasterListPage`, `MasterFormDrawer`, `usePermissions`, `AppShell`, `api` tests.

## Admin masters M08, M11, M14, M15 — implemented (`/api/v1/admin/{states,classes,teaching-modes,teacher-categories}`)

Built on a shared kernel so M09 (cities), M10 (areas), M12 (subjects) and M13 (boards) are mostly a definition plus their own list/create code. Specs: `modules/M08`, `M11`, `M14`, `M15`. M07 predates the kernel and still has its own copy of the same logic.

- **Backend kernel `GuruBackend/src/lib/masters/`:** `kernel.ts` (`MasterDef` + `patchMaster` / `setMasterActive` / `deleteMaster` / `restoreMaster` / `reorderMaster`: lock the row, check, change, audit in the same transaction, purge the cache), `references.ts` (**delete-in-use counts are read from `pg_catalog`** — every single-column FK pointing at the table, skipping soft-deleted rows — so a delete can't orphan a row even in tables the spec's hand-written list forgot), `dropdownCache.ts` (version-key purge), `query.ts` (zod pieces), `routes.ts` (`manageGuard` gives the "You can view X but not change them." 403). A module adds its own `schemas/service/routes/test` files, a `MasterDef`, and registers its router in `app.ts`. Add the new table name to `MasterTable` in `kernel.ts`.
- **Per-module rules worth knowing:** classes — `code` immutable (409 `CONFLICT_STATE`), `PUT /classes/order` rewrites `level_order` to 1..n (the table has no `sort_order`); teaching modes — the five built-in codes can't be deleted, deactivated or have `requiresLocation` changed; teacher categories — `slug` generated and then fixed, optional icon must be a finished public `category_icon` file, `PUT /order`; states — parent country must be active, a state with cities can't change country, can't be restored under a deleted country, `POST /states/import` takes `text/csv` (header `country_iso2,name,code,type`, ≤500 rows, `?dryRun=true`, any bad row rejects the whole file with a row-level error list, existing rows are skipped).
- **Frontend (`features/masters/`):** one `MasterConfig` per module. New config options since M07: `filters`, `fields` of kind `select`/`textarea`, `immutable` and `lockedHint`, `rowRules` (`canToggle` / `canDelete` / `lockedFields`), `selectedOption`, `confirmDeactivate`, `reorder`, `importCsv`. New components: `ReorderDialog` (drag or arrow buttons), `ImportCsvDialog` (check, then apply), shared `ConfirmDialog`. `usage(row)` replaced `usageCount`/`usageLabel`. Sidebar entries live in the `NAV` array in `app/AppShell.tsx`; `register_page`-style additions are one route in `app/router.tsx` plus one `NAV` line.
- **Not done:** the category `IconUploader` — admin file upload (presign) doesn't exist yet, so icons can't be chosen in the UI (the API accepts and serves one).
- **Tests:** classes 62, teaching modes 68, teacher categories 68, states 83 (+11 for `lib/csv`), each covering every row of the spec's Error Scenarios table. They purge fixtures by creator and restore any seeded rows they touch (class order, built-in mode descriptions, category order), so re-runs are clean. Frontend 198 tests in total.

## Admin M02 UI (Roles & Permissions screens) — implemented

Routes `/settings/roles`, `/settings/roles/new`, `/settings/roles/:id`, `/settings/admins`, `/settings/admins/:id`; sidebar group "Settings" (`roles.read` / `admins.read`). Code: `GureFronend/src/features/rbac/` (`api/rbac.api.ts`, `pages/{RolesListPage,RoleEditorPage,AdminsListPage,AdminDetailPage}.tsx`, `components/{PermissionMatrix,RoleCard,InviteAdminDialog,AssignRolesDialog,DisableAdminDialog,AdminStatusBadge}.tsx`, `Can.tsx`, `testData.ts` for fixtures). New shared pieces: `components/shared/Modal.tsx` (dialog shell), `lib/format.ts` (`formatDateTime`).

- **Permission matrix** groups the catalogue by module with one checkbox per key (the keys aren't uniform enough for a fixed read/create/update/delete grid), a "select all in module" toggle and a lock badge on sensitive keys. A reason is only asked for when a sensitive key is being *added* (matches `putRolePermissions`). Saves send `If-Match: <role.updatedAt>`; a `VERSION_CONFLICT` shows a "Reload latest" banner.
- **Assigning roles** previews what the admin gains and loses by fetching the permission keys of every role involved. The admin detail page hides disable/delete on your own account (the API refuses them anyway) and gates each button on `admins.manage` / `sessions.revoke_any`.
- **Gap:** the admin page's "audit trail" is a placeholder note; there is no audit-log read endpoint until the M00 viewer exists.
- **Tests:** 7 test files under `features/rbac/` (matrix, both lists, role editor create+edit, admin detail, invite/assign/disable dialogs, `Can`). Run the whole frontend suite with `--maxWorkers=4` if workers time out on a loaded machine.

## Admin masters M09, M10, M12, M13 (+ shared test suite) — implemented (`/api/v1/admin/{cities,areas,subjects,boards}`)

Same kernel as M08/M11/M14/M15. With these, **all of M07–M15 are done**. Specs: `modules/M09`, `M10`, `M12`, `M13`.

- **Kernel additions (`lib/masters/kernel.ts`):** `guardRestore` (e.g. a city can't come back under a deleted state, a trending subject can't take a slot that has been given away), `extraReferences` (counts references that aren't foreign keys: `institute_batches.subject_ids`), and array values (`pincodes`, `aliases`) now compare by value in `patchMaster` so retyping the same list is a no-op. `references.ts` exports `foreignKeysTo`, which the merge operations use.
- **`test/masterSuite.ts` — `describeMasterCommon(config)`** covers permissions, list/search/sort/page/filters, bad query params, deleted-row visibility, dropdown + cache purge, update (diff, no-op, stale, If-Match, concurrency), activate/deactivate, delete/restore. A new master module's test file builds fixtures, calls it once, and tests only what is special. Reuse it for any future master.
- **Rules worth knowing:** boards — a state board needs an active state, every other board has none, judged on the values *after* a patch; cities — slug generated (or supplied) and frozen once `isServiceable`, `GET /cities/:id/stats` for the launch confirmation, coordinates kept to 6 decimals; areas — `POST /areas/import` (≤ 2,000 rows, `?dryRun`, `?skipInvalid`), `POST /areas/:id/merge` (same city only, repoints every FK, keeps the teacher's primary flag, unions PIN codes ≤ 20), `GET /areas/by-pincode/:pin`; subjects — two-level hierarchy, class bounds must be real class levels, **at most 10 trending** (advisory lock, `409` lists the current ten), `POST /subjects/:id/merge` (teachers/children/institute staff/leads/batch arrays; refuses a source with sub-subjects).
- **Frontend additions:** `MasterField.showWhen`, `optionsValueKey` (select value from another field of the master, e.g. a class's `levelOrder`), `MasterConfig.confirmSave` (the form asks before saving, e.g. showing a city's numbers before it becomes a launch city), `merge` (row action + `MergeDialog`), `importCsv.allowSkipInvalid`. `changedFields` compares arrays by value.
- **Not done:** subject/category icon upload (no admin presign yet — the API accepts and serves an uploaded icon). The area list's "city is required" filter is optional (the list is paginated anyway).
- **Tests:** cities 80, areas 99, subjects 105, boards 67 (+ the common suite); frontend 398 in total. Run the frontend suite with `--maxWorkers=4` on a loaded machine.

## Admin M03, M04, M05, M44 — implemented (`/api/v1/admin`, plus `/api/v1/app/{settings,pricing,banners,events}`)

- **M04 Global settings** (`modules/settings/`, `lib/settingsCache.ts`): typed per-key validation (`settings.registry.ts` holds ranges and json schemas), atomic bulk `PATCH /settings` (`If-Match` = newest `updated_at` among submitted keys, reason required for `app.*`, typed confirmation flag for maintenance), per-key audit history. `GET /app/settings` is public with ETag/5-min cache, purged on save. `middleware/maintenanceGate.ts` answers `503 MAINTENANCE` on the mobile API when `app.maintenance_mode` is on (open: `/bootstrap`, `/settings`, `/auth/*`). New seed `sql/seed/005_features.sql` adds `features.wallet_enabled` (the wallet flag the payments code already read).
- **M03 Admin profile** (`modules/profile/`): `/me/profile` (lazy row, `If-Match`), avatar, `/me/change-password` (lockout shared with login, returns a fresh access token because the old one carries the old password version). **Admin uploads** (`modules/adminUploads/`, reuses the mobile upload service with `ownerType: 'admin'`): purposes `admin_avatar` and `banner_image` (needs `banners.manage`). Phone must be unique among admins (it is the OTP sign-in identity). No server-side image variants; the web crops avatars to a square client-side.
- **M44 Banners** (`modules/banners/`, `lib/deepLink.ts`, `lib/imageSize.ts`): lifecycle `draft→scheduled/active⇄paused→expired` with a 5-minute BullMQ job, 1080×480 (±2) header-based size check, deep-link registry + `banners.allowed_domains`, reorder (priority 100, 99, …). Mobile: `GET /app/banners` (cached per placement/audience/city, version-key purge) and `POST /app/events`. **Deviation:** impressions/clicks are added straight onto the banner row instead of a 15-minute aggregation job. The home screen still uses its own embedded query (`home.repository.ts`).
- **M05 Payment configuration** (`modules/paymentConfig/`): versioned fees with draft → publish/schedule, toggle, cancel, restore, history (cursor), preview/impact, `GET /app/pricing` (60 s cache, purged on every change). Per-fee period/validity/trial rules in `pc.rules.ts`; >50 % price moves need `confirmLargeChange`. All mutations of a fee run under a Postgres advisory lock; a pending scheduled version blocks immediate publish/toggle/restore (cancel it first). Draft saves are not written to `payment_configuration_history` (history rows restrict deletion of a discarded draft); they go to `audit_logs`. The `payment-config-activate` job runs every minute.
- **Web:** `features/settings` (`/settings/general`), `features/account` (`/account`, `ThemeSync` applies the saved theme), `features/cms/banners` (`/cms/banners`, reorder with ↑/↓ buttons, no dnd-kit), `features/payment-config` (`/payments/config[/:feeCode]`, debounced autosave of the draft). New shared pieces: `lib/money.ts`, `lib/theme.ts`, `lib/adminUpload.ts`.
- **Tests:** backend 1,535 tests in total (suite run on a fresh Memurai); frontend 716. Test fixtures for these modules restore the seeded rows they touch (settings values, fee versions).

