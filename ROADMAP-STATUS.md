# GuruConnect — Build Roadmap & Progress Tracker

_Last updated: 2026-10-11_

How to use: when a module's API and screens are finished **and its tests pass**, change `➖` to `✅` in its row (and update the overall column and the summary counts).

**Legend:** ✅ done · 🟡 partly done (see note) · ➖ not started · n/a not applicable to that side

A module counts as **complete** only when *both* its columns are ✅.

Two products share one backend (`GuruBackend/`):

| Product | Where the code lives | Spec |
|---|---|---|
| **Admin Web Portal** (51 modules, M00–M50) | API: `GuruBackend/src/modules/*` (`/api/v1/admin`) · UI: `GureFronend/` | `modules/M00…M50-*.md` |
| **Mobile App** (55 modules, M00–M54) | API: `GuruBackend/src/modules/app/*` (`/api/v1/app`) · App: `D:\GuruMobile\apps\mobile` (Expo / React Native) | `D:\GuruMobile\modules\M00…M54-*.md` |

---

## Summary

| | Complete (API + UI) | API only | Partly done | Not started | Total |
|---|---|---|---|---|---|
| **Admin web** | **3** | 3 | 0 | 45 | 51 |
| **Mobile app** | **14** | 6 | 4 | 31 | 55 |
| **Both together** | **17** | 9 | 4 | 76 | 106 |

Overall: **17 of 106 modules are fully complete** (about 16%). A further 9 have their API built but no screens yet.

---

## Part 1 — Admin Web Portal (M00–M50)

| # | Module | API | Web UI | Overall | Notes |
|---|---|---|---|---|---|
| M00 | Platform foundation (audit logs, files, app users) | ✅ | ➖ | 🟡 | Tables, audit helper, files. No admin UI for audit logs/files. |
| M01 | Authentication | ✅ | ✅ | ✅ | Login, OTP login, forgot/reset, invite, sessions. Open: Argon2id, RS256, HIBP, SMS gateway. |
| M02 | Roles & permissions | ✅ | ➖ | 🟡 | RBAC live; no roles/permissions pages yet. |
| M03 | Admin profile management | ➖ | ➖ | ➖ | |
| M04 | Global settings | ➖ | ➖ | ➖ | |
| M05 | Dynamic payment configuration | ➖ | ➖ | ➖ | |
| M06 | Referral configuration | ➖ | ➖ | ➖ | |
| M07 | Country management | ✅ | ✅ | ✅ | List/search/sort/page, create, edit (If-Match), activate, delete (blocked while states use it), restore (super admin), cached dropdown. Also built the shared list pieces M08–M15 reuse: `MasterListPage` + config, `DataTable`, `Pagination`, `StatusSwitch`. |
| M08 | State management | ➖ | ➖ | ➖ | |
| M09 | City management | ➖ | ➖ | ➖ | |
| M10 | Area management | ➖ | ➖ | ➖ | |
| M11 | Class management | ✅ | ✅ | ✅ | List/search/filter by stage, create, edit (code locked), activate, delete (blocked while teachers/children use it), restore, drag-or-arrow reorder (rewrites level order). References are read from the database, so nothing can be orphaned. |
| M12 | Subject management | ➖ | ➖ | ➖ | |
| M13 | Board management | ➖ | ➖ | ➖ | |
| M14 | Teaching mode management | ➖ | ➖ | ➖ | |
| M15 | Teacher category management | ➖ | ➖ | ➖ | |
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
| M44 | Banner management | ➖ | ➖ | ➖ | Mobile already *serves* banners; no admin CRUD. |
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

1. **Admin masters M08–M15** (states, cities, areas, classes, subjects, boards, teaching modes, categories). M07 is done and left the reusable list and form pieces, so each of these is mostly a config file plus its API. The mobile app already reads them, and right now they only change through SQL.
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
