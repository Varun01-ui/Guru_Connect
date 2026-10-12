# GuruConnect — Build Roadmap & Progress Tracker

_Last updated: 2026-10-12_

How to use: when a module's API and screens are finished **and its tests pass**, change `➖` to `✅` in its row (and update the overall column and the summary counts), then run `node scripts/syncRoadmap.mjs` to carry the ticks into the **Status** column of the *Implementation order* table in `README.md` (the repo's front page on GitHub).

**Legend:** ✅ done · 🟡 partly done (see note) · ➖ not started · n/a not applicable to that side

A module counts as **complete** only when *both* its columns are ✅.

> **Admin and mobile modules are numbered separately.** Admin M11 is *Class management*; mobile M11 is *Student registration*. Each table below is its own list.

Two products share one backend (`GuruBackend/`):

| Product | Where the code lives | Spec |
|---|---|---|
| **Admin Web Portal** (51 modules, M00–M50) | API: `GuruBackend/src/modules/*` (`/api/v1/admin`) · UI: `GureFronend/` | `modules/M00…M50-*.md` |
| **Mobile App** (55 modules, M00–M54) | API: `GuruBackend/src/modules/app/*` (`/api/v1/app`) · App: `D:\GuruMobile\apps\mobile` (Expo / React Native) | `D:\GuruMobile\modules\M00…M54-*.md` |

---

## Summary

| | Complete (API + UI) | API only | Partly done | Not started | Total |
|---|---|---|---|---|---|
| **Admin web** | **15** | 2 | 0 | 34 | 51 |
| **Mobile app** | **14** | 6 | 4 | 31 | 55 |
| **Both together** | **29** | 8 | 4 | 65 | 106 |

Overall: **29 of 106 modules are fully complete** (about 27%). A further 8 have their API built but no screens yet.

---

## Part 1 — Admin Web Portal (M00–M50)

| # | Module | API | Web UI | Overall | Notes |
|---|---|---|---|---|---|
| M00 | Platform foundation (audit logs, files, app users) | ✅ | ➖ | 🟡 | Tables, audit helper, files. No admin UI for audit logs/files. |
| M01 | Authentication | ✅ | ✅ | ✅ | Login, OTP login, forgot/reset, invite, sessions. Open: Argon2id, RS256, HIBP, SMS gateway. |
| M02 | Roles & permissions | ✅ | ✅ | ✅ | API was already done; the screens are now built. Roles (cards, search), role editor with a permission matrix (sensitive permissions marked, reason required, stale-edit reload, Super Admin read-only), Admins list (search, status/role/last-sign-in filters, paging), admin detail (edit name, change roles with a gain/lose preview, resend invite, disable/enable/delete with a reason, sign out everywhere) and the invite dialog. Not done: the audit trail on the admin page, because the audit log viewer (M00) doesn't exist yet. |
| M03 | Admin profile management | ✅ | ✅ | ✅ | `/account`: profile, avatar (new admin upload endpoints), theme / time zone / language, notification prefs, change password. Avatar is cropped in the browser; no server-side size variants. |
| M04 | Global settings | ✅ | ✅ | ✅ | `/settings/general`: tabs per group, typed inputs, sticky save bar, per-key history, typed confirmation for maintenance mode. Public `GET /app/settings` (ETag) and the mobile `503 MAINTENANCE` gate are live. |
| M05 | Dynamic payment configuration | ✅ | ✅ | ✅ | `/payments/config`: fee cards, autosaved drafts, price preview, publish now or schedule, toggle, cancel, restore, change history; `GET /app/pricing`. Per-minute job activates scheduled prices. |
| M06 | Referral configuration | ➖ | ➖ | ➖ | |
| M07 | Country management | ✅ | ✅ | ✅ | List/search/sort/page, create, edit (If-Match), activate, delete (blocked while states use it), restore (super admin), cached dropdown. Also built the shared list pieces M08–M15 reuse: `MasterListPage` + config, `DataTable`, `Pagination`, `StatusSwitch`. |
| M08 | State management | ✅ | ✅ | ✅ | List/search/filter by country and type, create under an active country, edit, activate, delete (blocked while cities/boards/parents use it), restore (not under a deleted country), CSV import (dry-run check, then apply; any bad row rejects the whole file). A state with cities can't move to another country. |
| M09 | City management | ✅ | ✅ | ✅ | List/search (closest names first)/filter by country, state, tier and launch status, create (slug made from the name, or your own), edit, activate, delete (blocked while areas/teachers/parents use it), restore (not under a deleted state), live stats. Marking a city as a launch city shows its numbers first and warns under 20 verified teachers; the slug is frozen after launch. |
| M10 | Area management | ✅ | ✅ | ✅ | List/search (name or a PIN code)/filter by city and map position, create (slug made from the name, unique within the city), edit, activate, delete (blocked while teachers/parents/students use it), restore (not under a deleted city), CSV import up to 2,000 rows (check first; any bad row rejects the file, or tick 'skip invalid rows'), merge a duplicate area into another in the same city (moves teachers/parents/students, combines PIN codes), PIN-code lookup API. |
| M11 | Class management | ✅ | ✅ | ✅ | List/search/filter by stage, create, edit (code locked), activate, delete (blocked while teachers/children use it), restore, drag-or-arrow reorder (rewrites level order). References are read from the database, so nothing can be orphaned. |
| M12 | Subject management | ✅ | ✅ | ✅ | List/search (name or alias)/filter by category, parent, trending and class, create (slug made from the name and fixed), edit, aliases, two-level parent/sub-subject, class range checked against real class levels, trending capped at 10 (names the current ten), activate, delete (blocked while teachers/children/batches/sub-subjects use it), restore, merge a duplicate subject into another (moves teachers, children and batches, keeps the primary flag, adds the name as an alias). Not done: the icon uploader (no admin file upload yet); the API accepts and serves an uploaded icon. |
| M13 | Board management | ✅ | ✅ | ✅ | List/search/filter by type and state, create (a state board needs an active state, any other board has none), edit, activate, delete (blocked while teacher class mappings, children or students use it), restore. The state field only appears for state boards. |
| M14 | Teaching mode management | ✅ | ✅ | ✅ | List/search, create, edit (code locked), activate, delete (blocked while teachers/children/batches use it), restore. The 5 built-in modes (Online, At teacher's place, Home tuition, Hybrid, Group batch) can be renamed and re-ordered but never removed, deactivated or have the location flag changed. |
| M15 | Teacher category management | ✅ | ✅ | ✅ | List/search, create (slug generated, fixed after creation), edit, activate (asks first when teachers use it), delete (blocked while teachers/children use it), restore, reorder (first 8 active fill the app home grid). Not done: the icon uploader, because admin file upload (presign) does not exist yet; the API already accepts an uploaded icon and returns its CDN URL. |
| M16 | Teacher registration queue | ✅ | ➖ | 🟡 | Queue, claim, decisions, approve/reject. Face/name-match checks wait on a vendor. |
| M17 | Teacher profile management | ➖ | ➖ | ➖ | |
| M18 | Teacher–subject mapping | ➖ | ➖ | ➖ | |
| M19 | Teacher–class mapping | ➖ | ➖ | ➖ | |
| M20 | Teacher–location mapping | ➖ | ➖ | ➖ | |
| M21 | Teacher analytics | ➖ | ➖ | ➖ | Needs the `teacher_daily_stats` roll-up. |
| M22 | Institute registration queue | ➖ | ➖ | ➖ | |
| M23 | Institute verification | ➖ | ➖ | ➖ | |
| M24 | Institute profile management | ➖ | ➖ | ➖ | |
| M25 | Institute manager accounts | ➖ | ➖ | ➖ | |
| M26 | Institute teacher management | ➖ | ➖ | ➖ | |
| M27 | Institute rating system | ➖ | ➖ | ➖ | |
| M28 | Parent management | ➖ | ➖ | ➖ | |
| M29 | Parent children management | ➖ | ➖ | ➖ | |
| M30 | Parent subscription management | ➖ | ➖ | ➖ | |
| M31 | Student management | ➖ | ➖ | ➖ | |
| M32 | Student subscription management | ➖ | ➖ | ➖ | |
| M33 | Teacher reviews | ➖ | ➖ | ➖ | |
| M34 | Institute reviews | ➖ | ➖ | ➖ | |
| M35 | Review moderation | ➖ | ➖ | ➖ | |
| M36 | Teacher trust score | ➖ | ➖ | ➖ | |
| M37 | Trust score history | ➖ | ➖ | ➖ | |
| M38 | Lead management | ➖ | ➖ | ➖ | |
| M39 | Demo class requests | ➖ | ➖ | ➖ | |
| M40 | Transactions | ➖ | ➖ | ➖ | Mobile payments write to `transactions`; no admin view or webhook yet. |
| M41 | Subscription payments | ➖ | ➖ | ➖ | |
| M42 | Referral management | ➖ | ➖ | ➖ | |
| M43 | Complaint management | ➖ | ➖ | ➖ | |
| M44 | Banner management | ✅ | ✅ | ✅ | `/cms/banners`: list by placement, editor with live phone preview, publish / pause / resume, reorder with ↑ ↓, audience preview. App gets `/app/banners` and `/app/events`. Counters are added straight onto the banner row (no 15-minute aggregation job). |
| M45 | Blog management | ➖ | ➖ | ➖ | |
| M46 | Notification management | ➖ | ➖ | ➖ | |
| M47 | Dashboard analytics | ➖ | ➖ | ➖ | The dashboard page is a placeholder. |
| M48 | Revenue reports | ➖ | ➖ | ➖ | |
| M49 | Teacher reports | ➖ | ➖ | ➖ | |
| M50 | Institute reports | ➖ | ➖ | ➖ | |

---

## Part 2 — Mobile App (M00–M54)

| # | Module | API | App screens | Overall | Notes |
|---|---|---|---|---|---|
| M00 | Mobile platform foundation | ✅ | ✅ | ✅ | Bootstrap, masters, uploads, theme, navigation. Local-disk storage only (no R2 yet). |
| M01 | Splash screen | ✅ | ✅ | ✅ | Includes force-update, maintenance, no-connection. |
| M02 | Onboarding screens | ✅ | ✅ | ✅ | |
| M03 | Authentication selection | n/a | ✅ | ✅ | Role tiles in `RegistrationRouter`. |
| M04 | Login | ✅ | ✅ | ✅ | OTP, forgot/reset password, active sessions. |
| M05 | Registration | ✅ | 🟡 | 🟡 | App handles parent and teacher; student and institute show "Coming soon". |
| M06 | Parent registration | ✅ | ✅ | ✅ | |
| M07 | Parent child setup | ✅ | ✅ | ✅ | |
| M08 | Parent dashboard | ✅ | 🟡 | 🟡 | Banners real; recommendation rails return empty until teacher search/ranking exists. |
| M09 | Parent profile | ✅ | ✅ | ✅ | |
| M10 | Parent subscription | ✅ | ➖ | 🟡 | API only; payment is a fake gateway. |
| M11 | Student registration | ✅ | ➖ | 🟡 | API only. |
| M12 | Student dashboard | ✅ | ➖ | 🟡 | API only (`recommended_teachers` rail only). |
| M13 | Student subscription | ✅ | ➖ | 🟡 | API only. |
| M14 | Teacher registration | ✅ | ✅ | ✅ | |
| M15 | Teacher document upload | ✅ | ✅ | ✅ | |
| M16 | Teacher verification status | ✅ | ✅ | ✅ | |
| M17 | Teacher profile builder | ✅ | ✅ | ✅ | |
| M18 | Teacher dashboard | ✅ | ✅ | ✅ | Daily stats stay empty until the Admin M21 roll-up exists. |
| M19 | Teacher availability | ✅ | ✅ | ✅ | |
| M20 | Teacher notifications | ✅ | ➖ | 🟡 | Preferences and reminder jobs built; no push delivery and no screen. |
| M21 | Institute registration | ✅ | ➖ | 🟡 | API only; phone sign-up only. |
| M22 | Institute verification | ➖ | ➖ | ➖ | |
| M23 | Institute dashboard | ➖ | ➖ | ➖ | |
| M24 | Institute manager | ➖ | ➖ | ➖ | |
| M25 | Institute teacher management | ➖ | ➖ | ➖ | |
| M26 | Institute rating display | ➖ | ➖ | ➖ | |
| M27 | Teacher search | ➖ | ➖ | ➖ | |
| M28 | Institute search | ➖ | ➖ | ➖ | |
| M29 | Advanced filters | ➖ | ➖ | ➖ | |
| M30 | Recommendation engine | ➖ | ➖ | ➖ | |
| M31 | Teacher profile view | ➖ | ➖ | ➖ | |
| M32 | Institute profile view | ➖ | ➖ | ➖ | |
| M33 | Profile sharing | ➖ | ➖ | ➖ | |
| M34 | Teacher reviews | ➖ | ➖ | ➖ | |
| M35 | Institute reviews | ➖ | ➖ | ➖ | |
| M36 | Teacher reply to review | ➖ | ➖ | ➖ | |
| M37 | Contact teacher | ➖ | ➖ | ➖ | |
| M38 | Demo class request | ➖ | ➖ | ➖ | |
| M39 | Contact institute | ➖ | ➖ | ➖ | |
| M40 | Favorite teachers | ➖ | ➖ | ➖ | |
| M41 | Favorite institutes | ➖ | ➖ | ➖ | |
| M42 | Trust score display | ➖ | ➖ | ➖ | |
| M43 | Payment gateway | 🟡 | ➖ | 🟡 | Fake gateway behind an interface; real Razorpay and webhook not built. |
| M44 | Subscriptions | 🟡 | ➖ | 🟡 | Parent/student plans exist via M10/M13; teacher plans and renewal job not built. |
| M45 | Payment history | ➖ | ➖ | ➖ | |
| M46 | Referral system | ➖ | ➖ | ➖ | |
| M47 | Push notifications | ➖ | ➖ | ➖ | Only in-app notification rows exist; no FCM delivery. |
| M48 | Notification center | ➖ | ➖ | ➖ | |
| M49 | Report user | ➖ | ➖ | ➖ | |
| M50 | Complaint history | ➖ | ➖ | ➖ | |
| M51 | Account settings | ➖ | ➖ | ➖ | |
| M52 | Privacy settings | ➖ | ➖ | ➖ | |
| M53 | Help & support | ➖ | ➖ | ➖ | |
| M54 | Delete account | ➖ | ➖ | ➖ | |

---

## Suggested next steps

Ordered by what unblocks the most:

1. **Admin M06 referral configuration**, the last of the settings modules. M03, M04 and M05 are done, as are the location and education masters (M07–M15).
2. **Admin UI for M02 and M16.** The APIs are done; without screens nobody can review a teacher in the browser.
3. **Teacher and institute search (mobile M27–M31).** This is what fills the empty parent/student dashboard rails.
4. **Mobile screens for M10–M13 and M21**, since their APIs already exist.
5. **Real payments (Razorpay), webhook, and push delivery (FCM)**, plus R2/S3 storage. All are currently stubs.

## How the counts were taken

Read from the code on 2026-10-11, not from the spec's own claims:

- **API:** the routers mounted in `GuruBackend/src/modules/` and `modules/app/router.ts`.
- **Admin web UI:** the routes in `GureFronend/src/app/router.tsx`. Only login, password reset, invite, sessions and a placeholder dashboard exist.
- **Mobile app:** the screens under `D:\GuruMobile\apps\mobile\src\features`.

This was a structural check. I did not run the test suites for this report, so "done" means the code and its tests are present, not that a fresh run passed.
