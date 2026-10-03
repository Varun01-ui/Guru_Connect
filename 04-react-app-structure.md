# 04 · React App Structure

Admin web app: React 18 + Vite + TypeScript, React Router 6 (data routers), TanStack Query for server state, TanStack Table, React Hook Form + Zod (schemas shared with the API from `packages/shared`), Tailwind CSS + shadcn/ui (Radix), Recharts, dnd-kit, CodeMirror 6 (blog editor).

## Folder layout

```
apps/admin-web/src/
  app/                 router.tsx, providers.tsx (QueryClient, Auth, Theme), AppShell.tsx
  lib/                 api.ts (fetch wrapper: envelope, 401 → refresh → retry, If-Match), money.ts, dates.ts (IST), permissions.ts
  components/ui/       shadcn primitives (Button, Dialog, Sheet, Tabs, Table, Badge, Tooltip, Toast…)
  components/shared/   DataTable, FilterBar, SearchInput, Pagination, StatusBadge, ConfirmDialog, ReasonDialog, EmptyState,
                       PermissionGate, MoneyCell, DateCell, UserChip, FileViewer, AuditTrail, KpiCard, PageHeader
  features/<module>/   pages/, components/, api/<module>.api.ts (query keys + hooks), schemas.ts (re-exports shared Zod)
  styles/              tokens.css (light/dark), tailwind.css
```

## App shell

- **Top bar:** global search (Module 0 `/search`, ⌘K), notifications bell (export ready, approvals waiting), profile menu (Module 3).
- **Sidebar** (items hidden when the admin lacks the read permission): Dashboard · Approvals (Teachers, Institutes) · Teachers · Institutes · Parents · Students · Reviews · Trust scores · Leads · Demos · Payments (Transactions, Refunds, Subscriptions, Reconciliation) · Referrals · Complaints · CMS (Banners, Blogs, Notifications) · Reports (Revenue, Teachers, Institutes, Exports) · Masters (Locations, Classes, Subjects, Boards, Modes, Categories) · Settings (Global, Pricing, Referral rules, Roles & permissions, Admins, Audit log).
- **Route guard:** `<RequirePermission keys={[...]}>` wraps each route; unauthorised routes render a 403 page, not a redirect loop.
- **Data pattern:** list pages keep filters, sort and page in the URL query string (shareable links); detail pages use drawers for quick views and full pages for workflows.
- **Mutations:** every state change goes through a dialog that collects the reason where required, sends `If-Match`, shows a toast naming the result, and invalidates the affected queries.

## Route map (84 routes)

| Route | Page component | Module | Content |
| --- | --- | --- | --- |
| `/audit-logs` | AuditLogListPage | [M00](modules/M00-platform-foundation-audit-logs-files-app-users.md) | Filterable log with drawer |
| `/login` | LoginPage | [M01](modules/M01-authentication-system.md) | Email, password, "Keep me signed in", "Forgot password?" |
| `/forgot-password` | ForgotPasswordPage | [M01](modules/M01-authentication-system.md) | Email field; always shows "If an account exists, we've emailed a link" |
| `/reset-password?token=` | ResetPasswordPage | [M01](modules/M01-authentication-system.md) | Validates token on load; password + confirm with live policy checklist |
| `/accept-invite?token=` | AcceptInvitePage | [M01](modules/M01-authentication-system.md) | Same form, title "Set your password" |
| `/account/security` | SessionsPage | [M01](modules/M01-authentication-system.md) | Active sessions table, "Sign out other devices" |
| `/settings/roles` | RolesListPage | [M02](modules/M02-roles-permissions.md) | Role cards with holder counts |
| `/settings/roles/new` | RoleEditorPage | [M02](modules/M02-roles-permissions.md) | Name, description, copy-from, permission matrix |
| `/settings/roles/:id` | RoleEditorPage | [M02](modules/M02-roles-permissions.md) | Permission matrix grouped by module with sensitive markers |
| `/settings/admins` | AdminsListPage | [M02](modules/M02-roles-permissions.md) | Table of admins, invite button |
| `/settings/admins/:id` | AdminDetailPage | [M02](modules/M02-roles-permissions.md) | Roles, status, last login, sessions, audit trail |
| `/account` | AccountPage | [M03](modules/M03-admin-profile-management.md) | Profile card (avatar, name, designation, phone), Preferences (time zone, theme, locale), Notifications, Security (change password, link to sessions) |
| `/settings/general` | GlobalSettingsPage | [M04](modules/M04-global-settings.md) | Tabs per group; each tab is one form with Save / Discard; maintenance-mode banner when on |
| `/payments/config` | PaymentConfigPage | [M05](modules/M05-dynamic-payment-configuration.md) | Grid of fee cards (on/off switch, current price, next scheduled change, draft badge); "What users will see" preview panel; change history timeline |
| `/payments/config/:feeCode` | FeeDetailPage | [M05](modules/M05-dynamic-payment-configuration.md) | Draft editor, preview, publish/schedule dialog, full version table, restore button |
| `/payments/referrals-config` | ReferralSettingsPage | [M06](modules/M06-referral-configuration.md) | One card per program: on/off, rewards, qualifying event, caps, hold, fraud switches, terms editor, version history |
| `/masters/locations/countries` | CountryListPage | [M07](modules/M07-country-management.md) | DataTable with filters, search, inline active switch, row actions (edit, deactivate, delete) |
| `/masters/locations/states` | StateListPage | [M08](modules/M08-state-management.md) | DataTable with filters, search, inline active switch, row actions (edit, deactivate, delete) |
| `/masters/locations/cities` | CityListPage | [M09](modules/M09-city-management.md) | DataTable with filters, search, inline active switch, row actions (edit, deactivate, delete) |
| `/masters/locations/areas` | AreaListPage | [M10](modules/M10-area-management.md) | DataTable with filters, search, inline active switch, row actions (edit, deactivate, delete) |
| `/masters/education/classes` | ClassListPage | [M11](modules/M11-class-management.md) | DataTable with filters, search, inline active switch, row actions (edit, deactivate, delete) |
| `/masters/education/subjects` | SubjectListPage | [M12](modules/M12-subject-management.md) | DataTable with filters, search, inline active switch, row actions (edit, deactivate, delete) |
| `/masters/education/boards` | BoardListPage | [M13](modules/M13-board-management.md) | DataTable with filters, search, inline active switch, row actions (edit, deactivate, delete) |
| `/masters/education/teaching-modes` | TeachingModeListPage | [M14](modules/M14-teaching-mode-management.md) | DataTable with filters, search, inline active switch, row actions (edit, deactivate, delete) |
| `/masters/education/teacher-categories` | TeacherCategoryListPage | [M15](modules/M15-teacher-category-management.md) | DataTable with filters, search, inline active switch, row actions (edit, deactivate, delete) |
| `/teachers/verification` | VerificationQueuePage | [M16](modules/M16-teacher-registration-queue.md) | KPI strip (in queue, re-upload requested, avg review time, approved this week), tabs (New, Under review, Re-upload, Over 24 h), queue table |
| `/teachers/verification/:teacherId` | VerificationCasePage | [M16](modules/M16-teacher-registration-queue.md) | Split view: left = application & checks & timeline; right = document grid with viewer; sticky decision bar |
| `/teachers/new` | CreateTeacherPage | [M16](modules/M16-teacher-registration-queue.md) | 3-step manual creation wizard |
| `/teachers` | TeachersDirectoryPage | [M17](modules/M17-teacher-profile-management.md) | Status tabs (All, Verified, Pending, Re-upload, Suspended, Rejected, Featured), FilterBar, DataTable, bulk actions (export, feature, suspend) |
| `/teachers/:id` | TeacherDetailPage | [M17](modules/M17-teacher-profile-management.md) | Header (photo, name, badge, status, trust ring, quick actions); tabs: Profile · Subjects & classes · Locations & modes · Documents · Analytics · Reviews · Trust score · Leads & demos · Complaints · Activity |
| `/teachers/:id` → Analytics tab | TeacherAnalyticsTab | [M21](modules/M21-teacher-analytics.md) | KPI tiles, views/leads line chart, funnel, source bars, response rate |
| `/analytics/teachers/leaderboard` | TeacherLeaderboardPage | [M21](modules/M21-teacher-analytics.md) | Filters (city, subject, period, metric) + ranked table |
| `/institutes/verification` | InstituteQueuePage | [M22](modules/M22-institute-registration-queue.md) | KPI strip, status tabs, queue table |
| `/institutes/:id/review` | InstituteReviewPage | [M22](modules/M22-institute-registration-queue.md) | Details, documents, photos, checks, timeline + evaluation panel (Module 27) and decision bar (Module 23) |
| `/institutes/new` | CreateInstitutePage | [M22](modules/M22-institute-registration-queue.md) | Manual onboarding wizard |
| `/institutes` | InstitutesDirectoryPage | [M24](modules/M24-institute-profile-management.md) | Tabs (Review queue → M22, Verified, Suspended, Rejected, All), filters, table |
| `/institutes/:id` | InstituteDetailPage | [M24](modules/M24-institute-profile-management.md) | Header (logo, badge, rating, status, actions); tabs: Profile · Batches · Photos · Managers (M25) · Teachers (M26) · Ratings (M27) · Reviews (M34) · Leads (M38) · Complaints (M43) · Activity |
| `/users/parents` | ParentsListPage | [M28](modules/M28-parent-management.md) | Filters, table, bulk message (M46 user_list), export |
| `/users/parents/:id` | ParentDetailPage | [M28](modules/M28-parent-management.md) | Header (name, code, status, subscription chip); tabs: Overview · Children · Subscription · Leads & demos · Reviews · Payments · Referrals · Complaints · Activity |
| `/payments/subscriptions/parents` | ParentSubscriptionsPage | [M30](modules/M30-parent-subscription-management.md) | Funnel tiles (trials, conversion, active, churn), status tabs, table |
| `/users/parents/:id` → Subscription tab | ParentSubscriptionTab | [M30](modules/M30-parent-subscription-management.md) | Current plan card, actions, history, payments |
| `/users/students` | StudentsListPage | [M31](modules/M31-student-management.md) | Filters, table, export |
| `/users/students/:id` | StudentDetailPage | [M31](modules/M31-student-management.md) | Header; tabs: Overview · Subscription · Leads & demos · Reviews · Payments · Referrals · Complaints · Activity |
| `/payments/subscriptions/students` | StudentSubscriptionsPage | [M32](modules/M32-student-subscription-management.md) | Same layout as parents; "Covered by parent" column |
| `/users/students/:id` → Subscription tab | StudentSubscriptionTab | [M32](modules/M32-student-subscription-management.md) | Card, actions, history |
| `/reviews/teachers` | TeacherReviewsPage | [M33](modules/M33-teacher-reviews.md) | All teacher reviews (status tabs, filters) — moderation actions come from Module 35 |
| `/teachers/:id` → Reviews tab | TeacherReviewsTab | [M33](modules/M33-teacher-reviews.md) | Summary (distribution bars, by role), list |
| `/reviews/institutes` | InstituteReviewsPage | [M34](modules/M34-institute-reviews.md) | List with tabs and filters |
| `/institutes/:id` → Reviews tab | InstituteReviewsTab | [M34](modules/M34-institute-reviews.md) | Summary with aspect bars, list |
| `/reviews/moderation` | ModerationQueuePage | [M35](modules/M35-review-moderation.md) | KPI tiles (pending, flagged, spam blocked 30d, avg rating, reply rate); tabs Pending · Flagged · Replies · Reported · Approved · Rejected; review cards with actions; bulk bar |
| `/reviews/moderation/stats` | ModerationStatsPage | [M35](modules/M35-review-moderation.md) | Volume chart, reasons, moderator table |
| `/trust` | TrustScorePage | [M36](modules/M36-teacher-trust-score.md) | Teacher list (search) · breakdown panel · weights card with sliders (sum indicator) + simulate + activate · distribution chart · anomalies table |
| `/teachers/:id` → Trust score tab | TrustTab | [M36](modules/M36-teacher-trust-score.md) | Breakdown, freeze/override actions, history (M37) |
| `/leads` | LeadsPage | [M38](modules/M38-lead-management.md) | KPI strip (total, response rate, conversion, median response) · filter bar · table |
| `/leads/:id` | LeadDetailPage | [M38](modules/M38-lead-management.md) | Header (code, status, actions) · requester & target cards · message · timeline · demo card · admin note |
| `/teachers/:id` → Leads tab | TeacherLeadsTab | [M38](modules/M38-lead-management.md) | Same table scoped to teacher + response metrics |
| `/demos` | DemosPage | [M39](modules/M39-demo-class-requests.md) | Tabs: List · Calendar (week view) · KPIs strip |
| `/demos/:id` | DemoDetailDrawer | [M39](modules/M39-demo-class-requests.md) | Drawer over the list: parties, slot, link, status actions, lead link |
| `/payments/transactions` | TransactionsPage | [M40](modules/M40-transactions.md) | Totals strip (gross, refunded, net) · filters · table · export |
| `/payments/transactions/:id` | TransactionDetailPage | [M40](modules/M40-transactions.md) | Amount breakdown · gateway ids (copy) · fulfilment state · refunds · webhooks · actions (Sync, Invoice, Request refund) |
| `/payments/refunds` | RefundsPage | [M40](modules/M40-transactions.md) | Tabs Requested / Processing / Processed / Denied / Failed · approve/deny |
| `/payments/reconciliation` | ReconciliationPage | [M40](modules/M40-transactions.md) | Date picker · mismatch table |
| `/payments/webhooks` | WebhooksPage | [M40](modules/M40-transactions.md) | Event list with state and retry |
| `/payments/subscriptions` | SubscriptionsPage | [M41](modules/M41-subscription-payments.md) | Metrics cards · plan tabs (Parents, Students, Teachers, Institutes) · table |
| `/payments/subscriptions/:id` | SubscriptionDrawer | [M41](modules/M41-subscription-payments.md) | Plan, dates, progress bar, payments, history, actions |
| Parent / student / teacher / institute detail → Subscription tab | SubscriptionTab | [M41](modules/M41-subscription-payments.md) | Same component scoped to a user (reused by M30, M32) |
| `/referrals` | ReferralsPage | [M42](modules/M42-referral-management.md) | Stats cards · tabs All / On hold / Rewarded / Rejected · table |
| `/referrals/:id` | ReferralDrawer | [M42](modules/M42-referral-management.md) | Parties, flags with explanations, timeline, actions |
| `/referrals/codes` | ReferralCodesPage | [M42](modules/M42-referral-management.md) | Campaign codes (create/edit/disable) · personal code lookup |
| `/referrals/leaderboard` | TopReferrersPage | [M42](modules/M42-referral-management.md) | Period picker · top 50 table |
| `/complaints` | ComplaintsPage | [M43](modules/M43-complaint-management.md) | Stats (open by severity, breached) · tabs My cases / Open / Awaiting info / Escalated / Closed · queue table with SLA countdown |
| `/complaints/:id` | ComplaintCasePage | [M43](modules/M43-complaint-management.md) | Header (case, severity, SLA) · parties · description · evidence gallery · timeline with note composer · action bar (Assign, Request info, Warn, Suspend, Escalate, Resolve, Dismiss) · related cases |
| `/cms/banners` | BannersPage | [M44](modules/M44-banner-management.md) | Placement tabs · cards with image, status, dates, CTR · drag to reorder · preview panel (phone frame) |
| `/cms/banners/new`, `/cms/banners/:id` | BannerEditorPage | [M44](modules/M44-banner-management.md) | Form left, live phone preview right |
| `/cms/blogs` | BlogsPage | [M45](modules/M45-blog-management.md) | Tabs by status · table (title, category, author, status, date, views) |
| `/cms/blogs/new`, `/cms/blogs/:id` | BlogEditorPage | [M45](modules/M45-blog-management.md) | Split Markdown editor / preview · sidebar (status, slug, category, tags, classes, cover, SEO, schedule) · review comments |
| `/cms/notifications` | NotificationsPage | [M46](modules/M46-notification-management.md) | Table (title, audience, status, target, delivered, open rate, date) · "New notification" |
| `/cms/notifications/new`, `/:id` | NotificationComposerPage | [M46](modules/M46-notification-management.md) | Steps: Message → Audience (segment builder with live estimate) → Schedule → Review; phone preview (Android/iOS lock-screen style) |
| `/cms/notifications/:id/report` | NotificationReportPage | [M46](modules/M46-notification-management.md) | Funnel (targeted → delivered → opened), failures by error code, recipients list |
| `/` | DashboardPage | [M47](modules/M47-dashboard-analytics.md) | Range picker · KPI grid · "Needs attention" queue cards (link to each queue) · charts row · city table |
| `/reports/revenue` | RevenueReportsPage | [M48](modules/M48-revenue-reports.md) | Tabs Overview · Products · Segments · GST · Subscriptions · Ledger; shared date range + granularity; export button per tab |
| `/reports/exports` | ExportsPage | [M48](modules/M48-revenue-reports.md) | My exports with status, size, expiry, download (shared by M49/M50) |
| `/reports/teachers` | TeacherReportsPage | [M49](modules/M49-teacher-reports.md) | Tabs Supply · Onboarding · Verification · Performance · Products · Risk; shared filters; export |
| `/reports/institutes` | InstituteReportsPage | [M50](modules/M50-institute-reports.md) | Tabs Onboarding · Ratings · Performance · Capacity · Renewals · Risk; shared filters; export |

## Shared components (build in Phase 0–1, reused everywhere)

| Component | Purpose |
| --- | --- |
| `DataTable` | TanStack Table wrapper: server-side sort/pagination, column visibility, row selection, sticky header, loading skeleton, empty state |
| `FilterBar` | Declarative filters (select, multi-select, date range, number range, toggle) synced to the URL |
| `StatusBadge` | Maps a status to colour + label + icon (never colour alone) |
| `ReasonDialog` | Confirm + reason textarea (min length from the endpoint's rule) for any action that requires a reason |
| `PermissionGate` | Renders children only if the admin has the key(s); used for buttons and menu items |
| `AuditTrail` | Cursor-paginated audit entries for an entity (Module 0 `/audit-logs/entity/...`) |
| `FileViewer` | Presigned-URL image/PDF viewer with zoom, rotate, masked-by-default for identity documents |
| `MoneyCell` / `DateCell` | ₹ with Indian grouping from paise; IST dates with relative time tooltip |
| `KpiCard` | Number, delta, sparkline — dashboard and report headers |
| `UserChip` | Avatar/initials, name, role tag, link to the user's page |
