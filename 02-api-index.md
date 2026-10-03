# 02 · API Index

All 436 admin endpoints. Base URL `/api/v1/admin` unless the path says otherwise. Every endpoint requires a valid access token and the listed permission (checked by `requirePermission()` middleware). Envelope, errors, pagination and idempotency rules are in `00-conventions.md`.

## Phase 0 · Platform Foundation

### [M00](modules/M00-platform-foundation-audit-logs-files-app-users.md) Platform Foundation (Audit Logs, Files, App Users)

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/audit-logs` | audit_logs.read | List audit entries (cursor pagination) |
| GET | `/audit-logs/:id` | audit_logs.read | One entry with full old/new values |
| GET | `/audit-logs/entity/:entityType/:entityId` | read permission of that entity's module | History of one record |
| POST | `/files/presign` | any authenticated admin | Create a pending file and return an upload URL |
| POST | `/files/:id/confirm` | uploader or super admin | Confirm the upload finished |
| GET | `/files/:id/url` | depends on purpose (see FR-0.6) | Short-lived download URL |
| DELETE | `/files/:id` | uploader or super admin | Soft-delete an unused file (409 if referenced) |
| GET | `/app-users` | any of parents.read, students.read, teachers.read, institutes.read | Role-agnostic user list |
| GET | `/app-users/:id` | same as above | One user with linked profile ids |
| GET | `/search` | any authenticated admin | Global search across entities |

## Phase 1 · Foundation

### [M01](modules/M01-authentication-system.md) Authentication System

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| POST | `/auth/login` | public (rate limited) | Sign in, returns access token + sets refresh cookie |
| POST | `/auth/refresh` | refresh cookie + CSRF header | Rotate refresh token, return new access token |
| POST | `/auth/logout` | authenticated | Revoke current session |
| POST | `/auth/logout-all` | authenticated | Revoke all own sessions |
| POST | `/auth/forgot-password` | public (rate limited) | Email a reset link (always 202) |
| POST | `/auth/reset-password` | public (token) | Set a new password with a reset or invite token |
| GET | `/auth/reset-password/validate` | public (token) | Check a token before showing the form |
| GET | `/auth/me` | authenticated | Current admin, roles, permissions |
| GET | `/auth/sessions` | authenticated | Own active sessions |
| DELETE | `/auth/sessions/:id` | authenticated (own session) | Sign out one device |
| DELETE | `/admins/:adminId/sessions` | sessions.revoke_any | Force sign-out another admin everywhere |

### [M02](modules/M02-roles-permissions.md) Roles & Permissions

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/permissions` | roles.read | Permission catalogue grouped by module |
| GET | `/roles` | roles.read | Roles with admin counts |
| POST | `/roles` | roles.manage | Create custom role (optionally copy from a role) |
| GET | `/roles/:id` | roles.read | Role with permission keys and holders |
| PATCH | `/roles/:id` | roles.manage | Rename / describe (custom roles; description only for system roles) |
| PUT | `/roles/:id/permissions` | roles.manage | Replace the role's permissions |
| DELETE | `/roles/:id` | roles.manage | Soft-delete a custom role with no holders |
| GET | `/admins` | admins.read | List admins |
| POST | `/admins/invite` | admins.manage | Invite an admin with roles |
| GET | `/admins/:id` | admins.read | Admin detail with roles, last login, sessions count |
| PATCH | `/admins/:id` | admins.manage | Edit name |
| PUT | `/admins/:id/roles` | admins.manage | Replace the admin's roles |
| POST | `/admins/:id/resend-invite` | admins.manage | New invite email |
| POST | `/admins/:id/disable` | admins.manage | Disable and sign out everywhere |
| POST | `/admins/:id/enable` | admins.manage | Re-enable (status back to active) |
| DELETE | `/admins/:id` | admins.manage | Soft-delete a disabled admin |

### [M03](modules/M03-admin-profile-management.md) Admin Profile Management

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/me/profile` | authenticated | Own profile |
| PATCH | `/me/profile` | authenticated | Update own profile (If-Match) |
| PUT | `/me/profile/avatar` | authenticated | Set avatar from an uploaded file |
| DELETE | `/me/profile/avatar` | authenticated | Remove avatar |
| POST | `/me/change-password` | authenticated | Change own password |

## Phase 2 · Configuration

### [M04](modules/M04-global-settings.md) Global Settings

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/settings` | settings.read | All settings grouped |
| GET | `/settings/:key` | settings.read | One setting with metadata |
| PATCH | `/settings` | settings.update | Save several settings of one group atomically |
| GET | `/api/v1/app/settings (mobile)` | public | Public settings for the app (outside the admin base path) |

### [M05](modules/M05-dynamic-payment-configuration.md) Dynamic Payment Configuration

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/payment-configs` | payment_config.read | All fees with active / scheduled / draft versions |
| GET | `/payment-configs/:feeCode` | payment_config.read | One fee with all versions |
| PUT | `/payment-configs/:feeCode/draft` | payment_config.edit | Create or update the draft |
| DELETE | `/payment-configs/:feeCode/draft` | payment_config.edit | Discard the draft |
| GET | `/payment-configs/:feeCode/draft/preview` | payment_config.read | Price card + impact summary |
| POST | `/payment-configs/:feeCode/draft/publish` | payment_config.publish | Publish now or schedule |
| POST | `/payment-configs/:feeCode/toggle` | payment_config.publish | Switch on/off immediately (new version) |
| POST | `/payment-configs/versions/:id/cancel` | payment_config.publish | Cancel a scheduled version |
| POST | `/payment-configs/versions/:id/restore` | payment_config.publish | Restore an old version as a new one |
| GET | `/payment-configs/history` | payment_config.read | Change history across fees |
| GET | `/api/v1/app/pricing (mobile)` | public | Resolved active prices |

### [M06](modules/M06-referral-configuration.md) Referral Configuration

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/referral-settings` | referral_settings.read | Active and draft version per program |
| GET | `/referral-settings/:program` | referral_settings.read | All versions of a program |
| PUT | `/referral-settings/:program/draft` | referral_settings.update | Create/update draft |
| DELETE | `/referral-settings/:program/draft` | referral_settings.update | Discard draft |
| POST | `/referral-settings/:program/draft/publish` | referral_settings.update | Publish draft (immediate) |
| POST | `/referral-settings/:program/toggle` | referral_settings.update | Enable/disable immediately |
| GET | `/api/v1/app/referral-programs (mobile)` | public | Active program rules |

## Phase 3 · Locations

### [M07](modules/M07-country-management.md) Country Management

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/countries` | locations.read | List with filters, search, sort, pagination |
| GET | `/countries/:id` | locations.read | One country with usage counts |
| POST | `/countries` | locations.manage | Create |
| PATCH | `/countries/:id` | locations.manage | Update (If-Match) |
| POST | `/countries/:id/activate` | locations.manage | Activate |
| POST | `/countries/:id/deactivate` | locations.manage | Deactivate |
| DELETE | `/countries/:id` | locations.manage | Soft delete (blocked when in use) |
| POST | `/countries/:id/restore` | locations.manage + super admin | Restore a deleted country |

### [M08](modules/M08-state-management.md) State Management

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/states` | locations.read | List with filters, search, sort, pagination |
| GET | `/states/:id` | locations.read | One state with usage counts |
| POST | `/states` | locations.manage | Create |
| PATCH | `/states/:id` | locations.manage | Update (If-Match) |
| POST | `/states/:id/activate` | locations.manage | Activate |
| POST | `/states/:id/deactivate` | locations.manage | Deactivate |
| DELETE | `/states/:id` | locations.manage | Soft delete (blocked when in use) |
| POST | `/states/:id/restore` | locations.manage + super admin | Restore a deleted state |
| POST | `/states/import` | locations.manage | CSV bulk import (≤ 500 rows) |

### [M09](modules/M09-city-management.md) City Management

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/cities` | locations.read | List with filters, search, sort, pagination |
| GET | `/cities/:id` | locations.read | One city with usage counts |
| POST | `/cities` | locations.manage | Create |
| PATCH | `/cities/:id` | locations.manage | Update (If-Match) |
| POST | `/cities/:id/activate` | locations.manage | Activate |
| POST | `/cities/:id/deactivate` | locations.manage | Deactivate |
| DELETE | `/cities/:id` | locations.manage | Soft delete (blocked when in use) |
| POST | `/cities/:id/restore` | locations.manage + super admin | Restore a deleted city |
| GET | `/cities/:id/stats` | locations.manage | Counts of teachers, institutes, users, areas |

### [M10](modules/M10-area-management.md) Area Management

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/areas` | locations.read | List with filters, search, sort, pagination |
| GET | `/areas/:id` | locations.read | One area with usage counts |
| POST | `/areas` | locations.manage | Create |
| PATCH | `/areas/:id` | locations.manage | Update (If-Match) |
| POST | `/areas/:id/activate` | locations.manage | Activate |
| POST | `/areas/:id/deactivate` | locations.manage | Deactivate |
| DELETE | `/areas/:id` | locations.manage | Soft delete (blocked when in use) |
| POST | `/areas/:id/restore` | locations.manage + super admin | Restore a deleted area |
| POST | `/areas/import` | locations.manage | CSV bulk import (≤ 2,000 rows) |
| POST | `/areas/:id/merge` | locations.manage | Merge into another area |
| GET | `/areas/by-pincode/:pin` | locations.manage | Areas containing a PIN code |

## Phase 4 · Education Masters

### [M11](modules/M11-class-management.md) Class Management

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/classes` | education_masters.read | List with filters, search, sort, pagination |
| GET | `/classes/:id` | education_masters.read | One class with usage counts |
| POST | `/classes` | education_masters.manage | Create |
| PATCH | `/classes/:id` | education_masters.manage | Update (If-Match) |
| POST | `/classes/:id/activate` | education_masters.manage | Activate |
| POST | `/classes/:id/deactivate` | education_masters.manage | Deactivate |
| DELETE | `/classes/:id` | education_masters.manage | Soft delete (blocked when in use) |
| POST | `/classes/:id/restore` | education_masters.manage + super admin | Restore a deleted class |
| PUT | `/classes/order` | education_masters.manage | Reorder (rewrites level_order) |

### [M12](modules/M12-subject-management.md) Subject Management

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/subjects` | education_masters.read | List with filters, search, sort, pagination |
| GET | `/subjects/:id` | education_masters.read | One subject with usage counts |
| POST | `/subjects` | education_masters.manage | Create |
| PATCH | `/subjects/:id` | education_masters.manage | Update (If-Match) |
| POST | `/subjects/:id/activate` | education_masters.manage | Activate |
| POST | `/subjects/:id/deactivate` | education_masters.manage | Deactivate |
| DELETE | `/subjects/:id` | education_masters.manage | Soft delete (blocked when in use) |
| POST | `/subjects/:id/restore` | education_masters.manage + super admin | Restore a deleted subject |
| POST | `/subjects/:id/merge` | education_masters.manage | Merge a duplicate subject |

### [M13](modules/M13-board-management.md) Board Management

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/boards` | education_masters.read | List with filters, search, sort, pagination |
| GET | `/boards/:id` | education_masters.read | One board with usage counts |
| POST | `/boards` | education_masters.manage | Create |
| PATCH | `/boards/:id` | education_masters.manage | Update (If-Match) |
| POST | `/boards/:id/activate` | education_masters.manage | Activate |
| POST | `/boards/:id/deactivate` | education_masters.manage | Deactivate |
| DELETE | `/boards/:id` | education_masters.manage | Soft delete (blocked when in use) |
| POST | `/boards/:id/restore` | education_masters.manage + super admin | Restore a deleted board |

### [M14](modules/M14-teaching-mode-management.md) Teaching Mode Management

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/teaching-modes` | education_masters.read | List with filters, search, sort, pagination |
| GET | `/teaching-modes/:id` | education_masters.read | One teaching mode with usage counts |
| POST | `/teaching-modes` | education_masters.manage | Create |
| PATCH | `/teaching-modes/:id` | education_masters.manage | Update (If-Match) |
| POST | `/teaching-modes/:id/activate` | education_masters.manage | Activate |
| POST | `/teaching-modes/:id/deactivate` | education_masters.manage | Deactivate |
| DELETE | `/teaching-modes/:id` | education_masters.manage | Soft delete (blocked when in use) |
| POST | `/teaching-modes/:id/restore` | education_masters.manage + super admin | Restore a deleted teaching mode |

### [M15](modules/M15-teacher-category-management.md) Teacher Category Management

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/teacher-categories` | education_masters.read | List with filters, search, sort, pagination |
| GET | `/teacher-categories/:id` | education_masters.read | One teacher category with usage counts |
| POST | `/teacher-categories` | education_masters.manage | Create |
| PATCH | `/teacher-categories/:id` | education_masters.manage | Update (If-Match) |
| POST | `/teacher-categories/:id/activate` | education_masters.manage | Activate |
| POST | `/teacher-categories/:id/deactivate` | education_masters.manage | Deactivate |
| DELETE | `/teacher-categories/:id` | education_masters.manage | Soft delete (blocked when in use) |
| POST | `/teacher-categories/:id/restore` | education_masters.manage + super admin | Restore a deleted teacher category |
| PUT | `/teacher-categories/order` | education_masters.manage | Reorder categories |

## Phase 5 · Teachers

### [M16](modules/M16-teacher-registration-queue.md) Teacher Registration Queue

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/teacher-verifications` | teachers.read | Queue with tabs, filters, SLA |
| GET | `/teacher-verifications/stats` | teachers.read | Counts per status, oldest age, decisions this week |
| GET | `/teacher-verifications/:teacherId` | teachers.read | Case detail |
| POST | `/teacher-verifications/:teacherId/claim` | teacher_verification.review | Claim / take over a case |
| POST | `/teacher-verifications/:teacherId/release` | teacher_verification.review | Release a claim |
| POST | `/teacher-documents/:documentId/approve` | teacher_verification.review | Approve a document |
| POST | `/teacher-documents/:documentId/reject` | teacher_verification.review | Reject a document |
| POST | `/teacher-documents/:documentId/request-reupload` | teacher_verification.review | Mark for re-upload |
| GET | `/teacher-documents/:documentId/file` | teacher_documents.unmask | Signed URL to the original (audited) |
| POST | `/teacher-verifications/:teacherId/notes` | teacher_verification.review | Add note |
| POST | `/teacher-verifications/:teacherId/request-reupload` | teacher_verification.review | Send back to teacher |
| POST | `/teacher-verifications/:teacherId/approve` | teacher_verification.decide | Approve teacher |
| POST | `/teacher-verifications/:teacherId/reject` | teacher_verification.decide | Reject teacher |
| POST | `/teachers` | teachers.create | Create a teacher manually |

### [M17](modules/M17-teacher-profile-management.md) Teacher Profile Management

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/teachers` | teachers.read | Directory with filters, search, sort |
| GET | `/teachers/export` | teachers.read | CSV of the current filter (sync ≤ 5,000 rows, else async via M48) |
| GET | `/teachers/:id` | teachers.read | Teacher detail |
| PATCH | `/teachers/:id` | teachers.update | Edit profile (If-Match) |
| POST | `/teachers/:id/suspend` | teachers.suspend | Suspend |
| POST | `/teachers/:id/activate` | teachers.suspend | Re-activate |
| POST | `/teachers/:id/badge` | teachers.badge | Grant or revoke Verified badge |
| POST | `/teachers/:id/feature` | teachers.feature | Set / clear complimentary featured period |
| POST | `/teachers/:id/premium` | teachers.feature | Set / clear complimentary premium period |
| DELETE | `/teachers/:id` | super admin | Soft delete |

### [M18](modules/M18-teacher-subject-mapping.md) Teacher Subject Mapping

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/teachers/:teacherId/subjects` | teachers.read | Current subjects |
| PUT | `/teachers/:teacherId/subjects` | teachers.update | Replace subject set |

### [M19](modules/M19-teacher-class-mapping.md) Teacher Class Mapping

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/teachers/:teacherId/classes` | teachers.read | Current classes and boards |
| PUT | `/teachers/:teacherId/classes` | teachers.update | Replace class/board coverage |

### [M20](modules/M20-teacher-location-mapping.md) Teacher Location Mapping

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/teachers/:teacherId/locations` | teachers.read | Locations and modes |
| PUT | `/teachers/:teacherId/locations` | teachers.update | Replace locations |
| PUT | `/teachers/:teacherId/teaching-modes` | teachers.update | Replace modes |

### [M21](modules/M21-teacher-analytics.md) Teacher Analytics

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/teachers/:id/analytics` | teacher_analytics.read | Series + totals for one teacher |
| GET | `/teachers/:id/analytics/sources` | teacher_analytics.read | Views by source |
| GET | `/teacher-analytics/leaderboard` | teacher_analytics.read | Top teachers by metric |
| POST | `/teacher-analytics/rebuild` | super admin | Recompute roll-ups for a date range (async) |

## Phase 6 · Institutes

### [M22](modules/M22-institute-registration-queue.md) Institute Registration Queue

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/institute-verifications` | institutes.read | Queue |
| GET | `/institute-verifications/stats` | institutes.read | Counts per status, oldest age |
| GET | `/institute-verifications/:instituteId` | institutes.read | Case detail |
| POST | `/institute-documents/:id/approve` | institute_documents.review | Approve a document |
| POST | `/institute-documents/:id/reject` | institute_documents.review | Reject a document |
| POST | `/institute-documents/:id/request-reupload` | institute_documents.review | Mark for re-upload |
| GET | `/institute-documents/:id/file` | institute_documents.unmask | Signed URL to the original (audited) |
| POST | `/institute-verifications/:instituteId/request-documents` | institute_documents.review | Send back to the manager |
| POST | `/institutes` | institutes.update | Manual onboarding (draft + manager invite) |

### [M23](modules/M23-institute-verification.md) Institute Verification

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| POST | `/institute-verifications/:id/schedule-visit` | institute_verification.decide | Schedule or reschedule evaluation |
| POST | `/institute-verifications/:id/visit-completed` | institute_ratings.rate | Record that the visit happened |
| POST | `/institute-verifications/:id/approve` | institute_verification.decide | Approve and publish |
| POST | `/institute-verifications/:id/reject` | institute_verification.decide | Reject |
| POST | `/institutes/:id/badge` | institute_verification.decide | Grant / revoke badge |
| GET | `/institute-verifications/:id/timeline` | institutes.read | Verification timeline |
| POST | `/institute-verifications/:id/notes` | institute_documents.review | Add note |

### [M24](modules/M24-institute-profile-management.md) Institute Profile Management

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/institutes` | institutes.read | Directory |
| GET | `/institutes/export` | institutes.read | CSV export |
| GET | `/institutes/:id` | institutes.read | Detail |
| PATCH | `/institutes/:id` | institutes.update | Edit profile (If-Match) |
| PUT | `/institutes/:id/photos` | institutes.update | Public gallery order |
| GET | `/institutes/:id/batches` | institutes.read | Batches |
| POST | `/institutes/:id/batches` | institutes.update | Add batch |
| PATCH | `/institute-batches/:batchId` | institutes.update | Edit batch |
| DELETE | `/institute-batches/:batchId` | institutes.update | Remove batch (soft) |
| POST | `/institutes/:id/suspend` | institutes.suspend | Suspend |
| POST | `/institutes/:id/activate` | institutes.suspend | Re-activate |
| POST | `/institutes/:id/premium` | institutes.update | Complimentary premium |

### [M25](modules/M25-institute-manager-accounts.md) Institute Manager Accounts

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/institutes/:id/managers` | institute_managers.read | Staff list |
| GET | `/institute-managers/:staffId` | institute_managers.read | One staff member |
| POST | `/institute-managers/:staffId/resend-invite` | institute_managers.manage | New invite |
| POST | `/institute-managers/:staffId/disable` | institute_managers.manage | Disable |
| POST | `/institute-managers/:staffId/enable` | institute_managers.manage | Re-enable |
| POST | `/institute-managers/:staffId/role` | institute_managers.manage | Change role |
| POST | `/institutes/:id/managers/replace-primary` | institute_managers.manage | Replace the primary manager |

### [M26](modules/M26-institute-teacher-management.md) Institute Teacher Management

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/institutes/:id/teachers` | institute_teachers.read | Institute's teachers |
| GET | `/institute-teachers/:itId` | institute_teachers.read | One entry with subjects/classes |
| GET | `/institute-teachers` | institute_teachers.read | Cross-institute search (by phone or teacherId) |
| PATCH | `/institute-teachers/:itId` | institute_teachers.manage | Admin override edit |
| PUT | `/institute-teachers/:itId/subjects` | institute_teachers.manage | Replace subjects |
| PUT | `/institute-teachers/:itId/classes` | institute_teachers.manage | Replace classes |
| POST | `/institute-teachers/:itId/link` | institute_teachers.manage | Link to a GuruConnect teacher |
| POST | `/institute-teachers/:itId/remove` | institute_teachers.manage | Remove with reason |

### [M27](modules/M27-institute-rating-system.md) Institute Rating System

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/institutes/:id/ratings` | institute_ratings.read | Rating versions |
| POST | `/institutes/:id/ratings` | institute_ratings.rate | Start a draft (pre-filled) |
| GET | `/institute-ratings/:ratingId` | institute_ratings.read | One rating with criteria |
| PATCH | `/institute-ratings/:ratingId` | institute_ratings.rate | Update draft (If-Match) |
| POST | `/institute-ratings/:ratingId/submit` | institute_ratings.rate | Submit and make current |
| DELETE | `/institute-ratings/:ratingId` | institute_ratings.rate | Discard a draft |
| GET | `/institute-ratings/leaderboard` | institute_ratings.read | Top-rated institutes |

## Phase 7 · Parents

### [M28](modules/M28-parent-management.md) Parent Management

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/parents` | parents.read | Directory |
| GET | `/parents/export` | parents.read | CSV (masked unless users.pii) |
| GET | `/parents/:id` | parents.read | Detail |
| PATCH | `/parents/:id` | parents.update | Edit profile |
| POST | `/parents/:id/reveal-contact` | users.pii | Full phone/email (audited) |
| POST | `/parents/:id/change-phone-request` | parents.update | Start OTP phone change |
| POST | `/parents/:id/suspend` | parents.suspend | Suspend |
| POST | `/parents/:id/activate` | parents.suspend | Re-activate |
| DELETE | `/parents/:id` | super admin | Delete account (privacy) |

### [M29](modules/M29-parent-children-management.md) Parent Children Management

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/parents/:parentId/children` | parent_children.read | Children of a parent |
| GET | `/parent-children/:childId` | parent_children.read | One child |
| PATCH | `/parent-children/:childId` | parent_children.manage | Support edit (reason) |
| DELETE | `/parent-children/:childId` | parent_children.manage | Remove child (soft) |
| GET | `/parent-children/:childId/recommendations` | parent_children.read | Recommendations with score breakdown |
| GET | `/children-demand` | parent_children.read | Aggregated demand vs supply |

### [M30](modules/M30-parent-subscription-management.md) Parent Subscription Management

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/parent-subscriptions` | parent_subscriptions.read | Parent subscriptions (latest per parent) |
| GET | `/parent-subscriptions/stats` | parent_subscriptions.read | Funnel and plan mix |
| GET | `/parents/:parentId/subscriptions` | parent_subscriptions.read | History for one parent |
| POST | `/parents/:parentId/subscriptions/grant` | parent_subscriptions.manage | Complimentary access |
| POST | `/subscriptions/:id/extend` | parent_subscriptions.manage (for parent subscriptions) | Extend |
| POST | `/subscriptions/:id/cancel` | parent_subscriptions.manage | Cancel |
| POST | `/subscriptions/:id/auto-renew` | parent_subscriptions.manage | Turn auto-renew off |

## Phase 8 · Students

### [M31](modules/M31-student-management.md) Student Management

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/students` | students.read | Directory |
| GET | `/students/export` | students.read | CSV |
| GET | `/students/:id` | students.read | Detail |
| PATCH | `/students/:id` | students.update | Edit |
| POST | `/students/:id/reveal-contact` | users.pii | Full phone/email (audited) |
| POST | `/students/:id/link-parent` | students.update | Request parent link |
| POST | `/students/:id/unlink-parent` | students.update | Remove parent link |
| POST | `/students/:id/suspend` | students.suspend | Suspend |
| POST | `/students/:id/activate` | students.suspend | Re-activate |
| DELETE | `/students/:id` | super admin | Delete account |

### [M32](modules/M32-student-subscription-management.md) Student Subscription Management

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/student-subscriptions` | student_subscriptions.read | Student subscriptions (latest per student) |
| GET | `/student-subscriptions/stats` | student_subscriptions.read | Funnel and plan mix |
| GET | `/students/:studentId/subscriptions` | student_subscriptions.read | History for one student |
| POST | `/students/:studentId/subscriptions/grant` | student_subscriptions.manage | Complimentary access |
| POST | `/subscriptions/:id/extend` | student_subscriptions.manage (for student subscriptions) | Extend |
| POST | `/subscriptions/:id/cancel` | student_subscriptions.manage | Cancel |
| POST | `/subscriptions/:id/auto-renew` | student_subscriptions.manage | Turn auto-renew off |

## Phase 9 · Reviews

### [M33](modules/M33-teacher-reviews.md) Teacher Reviews

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/teacher-reviews` | teacher_reviews.read | All teacher reviews with filters |
| GET | `/teacher-reviews/:id` | teacher_reviews.read | One review with moderation history |
| GET | `/teachers/:id/reviews` | teacher_reviews.read | Reviews of one teacher |
| GET | `/teachers/:id/reviews/summary` | teacher_reviews.read | Rating summary |
| GET | `/app-users/:userId/reviews` | teacher_reviews.read | Reviews written by a user |

### [M34](modules/M34-institute-reviews.md) Institute Reviews

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/institute-reviews` | institute_reviews.read | All institute reviews |
| GET | `/institute-reviews/:id` | institute_reviews.read | One review with moderation history |
| GET | `/institutes/:id/reviews` | institute_reviews.read | Reviews of one institute |
| GET | `/institutes/:id/reviews/summary` | institute_reviews.read | Summary incl. aspect averages |

### [M35](modules/M35-review-moderation.md) Review Moderation

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/review-moderation/queue` | reviews.moderate | Pending / flagged / replies / reported queues |
| GET | `/review-moderation/stats` | reviews.moderate | Moderation analytics |
| POST | `/review-moderation/:reviewType/:reviewId/approve` | reviews.moderate | Publish |
| POST | `/review-moderation/:reviewType/:reviewId/reject` | reviews.moderate | Reject with reason |
| POST | `/review-moderation/:reviewType/:reviewId/flag` | reviews.moderate | Flag for second look |
| POST | `/review-moderation/:reviewType/:reviewId/hide` | reviews.moderate | Hide a published review |
| POST | `/review-moderation/:reviewType/:reviewId/restore` | reviews.moderate | Restore |
| POST | `/review-moderation/:reviewType/:reviewId/reply/approve` | reviews.moderate | Publish a reply |
| POST | `/review-moderation/:reviewType/:reviewId/reply/reject` | reviews.moderate | Reject a reply |
| POST | `/review-moderation/bulk` | reviews.moderate | Bulk approve/reject |
| GET | `/review-flags` | review_flags.resolve | Open reports |
| POST | `/review-flags/:id/resolve` | review_flags.resolve | Uphold or dismiss a report |

## Phase 10 · Trust Score Engine

### [M36](modules/M36-teacher-trust-score.md) Teacher Trust Score

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/trust-scores` | trust_scores.read | Teachers with scores and filters |
| GET | `/trust-scores/distribution` | trust_scores.read | Counts per band, average |
| GET | `/trust-scores/anomalies` | trust_scores.read | Suspicious activity list |
| GET | `/trust-scores/:teacherId` | trust_scores.read | Breakdown |
| POST | `/trust-scores/:teacherId/recalculate` | trust_scores.override | Recalculate now |
| POST | `/trust-scores/:teacherId/freeze` | trust_scores.override | Freeze |
| POST | `/trust-scores/:teacherId/unfreeze` | trust_scores.override | Unfreeze |
| POST | `/trust-scores/:teacherId/override` | trust_scores.override | Temporary override |
| DELETE | `/trust-scores/:teacherId/override` | trust_scores.override | Remove override |
| GET | `/trust-weights` | trust_scores.read | Active + draft weights and history |
| PUT | `/trust-weights/draft` | trust_weights.manage | Save draft weights |
| POST | `/trust-weights/draft/simulate` | trust_weights.manage | Projected distribution |
| POST | `/trust-weights/draft/activate` | trust_weights.manage | Activate and recalculate all |

### [M37](modules/M37-trust-score-history.md) Trust Score History

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/trust-scores/:teacherId/history` | trust_scores.history | Score series and events for a teacher |
| GET | `/trust-score-logs` | trust_scores.history | Global change log |
| GET | `/trust-score-logs/:id` | trust_scores.history | One log entry with breakdown |

## Phase 11 · Leads

### [M38](modules/M38-lead-management.md) Lead Management

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/leads` | leads.read | List with filters |
| GET | `/leads/stats` | leads.read | Funnel and response metrics for the current filters |
| GET | `/leads/:id` | leads.read | Detail with timeline |
| PATCH | `/leads/:id/status` | leads.manage | Correct status (If-Match) |
| POST | `/leads/:id/spam` | leads.manage | Mark as spam |
| POST | `/leads/:id/not-spam` | leads.manage | Undo spam within 7 days |
| PATCH | `/leads/:id/note` | leads.manage | Set internal note |
| GET | `/teachers/:id/leads` | leads.read | Leads for a teacher (tab) |
| GET | `/institutes/:id/leads` | leads.read | Leads for an institute (tab) |
| GET | `/app-users/:userId/leads` | leads.read | Leads sent by a user |

### [M39](modules/M39-demo-class-requests.md) Demo Class Requests

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/demos` | demos.read | List with filters |
| GET | `/demos/stats` | demos.read | Completion, no-show and conversion metrics |
| GET | `/demos/calendar` | demos.read | Demos in a date window for the calendar view |
| GET | `/demos/:id` | demos.read | Detail |
| POST | `/demos/:id/cancel` | demos.manage | Cancel on behalf of a user |
| POST | `/demos/:id/reschedule` | demos.manage | Propose or confirm a new slot |
| POST | `/demos/:id/complete` | demos.manage | Mark completed with outcome |
| POST | `/demos/:id/no-show` | demos.manage | Mark no-show |

## Phase 12 · Payments

### [M40](modules/M40-transactions.md) Transactions

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/transactions` | transactions.read | List with filters and totals |
| GET | `/transactions/:id` | transactions.read | Detail with refunds, webhooks and fulfilment |
| GET | `/transactions/:id/invoice` | transactions.read | Presigned invoice URL |
| POST | `/transactions/:id/sync` | transactions.read | Re-fetch from Razorpay and apply state |
| GET | `/transactions/reconciliation` | transactions.read | Settlement mismatches for a date |
| POST | `/transactions/manual` | refunds.approve | Record an offline payment (needs second-admin confirmation) |
| POST | `/transactions/:id/confirm-manual` | refunds.approve | Second admin confirms a manual payment |
| GET | `/refunds` | transactions.read | Refund queue |
| POST | `/transactions/:id/refunds` | transactions.read | Request a refund (maker) |
| POST | `/refunds/:id/approve` | refunds.approve | Approve and send to Razorpay (checker) |
| POST | `/refunds/:id/deny` | refunds.approve | Deny with reason |
| POST | `/refunds/:id/retry` | refunds.approve | Retry a failed refund |
| GET | `/payment-webhooks` | transactions.read | Webhook events |
| POST | `/payment-webhooks/:id/retry` | refunds.approve | Re-process a failed event |
| POST | `/webhooks/razorpay` | public (signature) | Razorpay webhook receiver (outside /admin; `express.raw()` body) |

### [M41](modules/M41-subscription-payments.md) Subscription Payments

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/subscriptions` | subscriptions.read | All subscriptions with filters |
| GET | `/subscriptions/metrics` | subscriptions.read | Active, trials, conversion, churn, MRR, renewals due |
| GET | `/subscriptions/:id` | subscriptions.read | Detail with payments and history |
| GET | `/app-users/:userId/subscriptions` | subscriptions.read | A user's subscription history |
| POST | `/subscriptions/grant` | subscriptions.manage | Grant complimentary access |
| POST | `/subscriptions/:id/extend` | subscriptions.manage | Extend the live period |
| POST | `/subscriptions/:id/cancel` | subscriptions.manage | Cancel (optionally request refund) |
| POST | `/subscriptions/:id/disable-auto-renew` | subscriptions.manage | Stop auto-renewal |

## Phase 13 · Referrals

### [M42](modules/M42-referral-management.md) Referral Management

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/referrals` | referrals.read | Referrals with filters |
| GET | `/referrals/stats` | referrals.read | Program and campaign metrics |
| GET | `/referrals/top-referrers` | referrals.read | Leaderboard for a period |
| GET | `/referrals/:id` | referrals.read | Detail with fraud flags and transactions |
| POST | `/referrals/:id/release` | referrals.review | Release a held referral |
| POST | `/referrals/:id/reject` | referrals.review | Reject |
| POST | `/referrals/:id/reverse` | referrals.review | Reverse a paid reward |
| GET | `/referral-codes` | referrals.read | Personal and campaign codes |
| POST | `/referral-codes` | referral_codes.manage | Create a campaign code |
| PATCH | `/referral-codes/:id` | referral_codes.manage | Edit limit / expiry / name |
| POST | `/referral-codes/:id/disable` | referral_codes.manage | Disable a code |
| GET | `/app-users/:userId/referrals` | referrals.read | A user's code, invites and rewards |

## Phase 14 · Complaints

### [M43](modules/M43-complaint-management.md) Complaint Management

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/complaints` | complaints.read | Queue with filters and SLA state |
| GET | `/complaints/stats` | complaints.read | Open by severity, breaches, average resolution time |
| GET | `/complaints/:id` | complaints.read | Case with timeline, attachments, related cases |
| POST | `/complaints/:id/assign` | complaints.manage | Assign owner |
| POST | `/complaints/:id/severity` | complaints.manage | Change severity (recomputes SLA) |
| POST | `/complaints/:id/notes` | complaints.manage | Add note |
| POST | `/complaints/:id/request-info` | complaints.manage | Message a party and pause SLA |
| POST | `/complaints/:id/attachments` | complaints.manage | Attach evidence (file ids from Module 0 upload) |
| GET | `/complaints/:id/attachments/:attachmentId` | complaints.read | Presigned URL (60 s) |
| POST | `/complaints/:id/escalate` | complaints.manage | Escalate to Super Admin |
| POST | `/complaints/:id/warn` | complaints.enforce | Warn the reported party |
| POST | `/complaints/:id/suspend` | complaints.enforce | Suspend the reported account |
| POST | `/complaints/:id/lift-suspension` | complaints.enforce | Lift early |
| POST | `/complaints/:id/resolve` | complaints.manage | Resolve |
| POST | `/complaints/:id/dismiss` | complaints.manage | Dismiss |
| POST | `/complaints/:id/reopen` | complaints.manage | Reopen within 30 days |

## Phase 15 · CMS

### [M44](modules/M44-banner-management.md) Banner Management

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/banners` | banners.read | List with filters and CTR |
| GET | `/banners/:id` | banners.read | Detail |
| POST | `/banners` | banners.manage | Create (draft) |
| PATCH | `/banners/:id` | banners.manage | Edit (If-Match) |
| POST | `/banners/:id/publish` | banners.manage | Publish (scheduled or active) |
| POST | `/banners/:id/pause` | banners.manage | Pause |
| POST | `/banners/:id/resume` | banners.manage | Resume |
| POST | `/banners/reorder` | banners.manage | Set order within a placement |
| DELETE | `/banners/:id` | banners.manage | Soft delete (not active) |
| GET | `/banners/preview` | banners.read | What a given audience/city sees per placement |

### [M45](modules/M45-blog-management.md) Blog Management

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/blogs` | blogs.read | List |
| GET | `/blogs/:id` | blogs.read | Detail |
| POST | `/blogs` | blogs.write | Create draft |
| PATCH | `/blogs/:id` | blogs.write | Edit (own drafts; editors any) (If-Match) |
| POST | `/blogs/:id/submit` | blogs.write | Submit for review |
| POST | `/blogs/:id/return` | blogs.publish | Return to draft with comment |
| POST | `/blogs/:id/publish` | blogs.publish | Publish now |
| POST | `/blogs/:id/schedule` | blogs.publish | Schedule |
| POST | `/blogs/:id/archive` | blogs.publish | Archive |
| POST | `/blogs/:id/restore` | blogs.publish | Restore archived to draft |
| DELETE | `/blogs/:id` | blogs.write | Soft delete (drafts only) |
| GET | `/blogs/slug-available` | blogs.write | Check slug |

### [M46](modules/M46-notification-management.md) Notification Management

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/notifications` | notifications.read | Campaigns |
| GET | `/notifications/:id` | notifications.read | Detail with stats |
| GET | `/notifications/:id/recipients` | notifications.read | Recipients (cursor) with status |
| POST | `/notifications` | notifications.send | Create draft |
| PATCH | `/notifications/:id` | notifications.send | Edit draft (If-Match) |
| POST | `/notifications/audience-estimate` | notifications.send | Count for a segment |
| POST | `/notifications/:id/test` | notifications.send | Test send |
| POST | `/notifications/:id/send` | notifications.send | Send now / schedule (Idempotency-Key) |
| POST | `/notifications/:id/approve` | notifications.approve_large | Approve a large campaign |
| POST | `/notifications/:id/cancel` | notifications.send | Cancel scheduled |
| DELETE | `/notifications/:id` | notifications.send | Delete draft |

## Phase 16 · Reporting

### [M47](modules/M47-dashboard-analytics.md) Dashboard Analytics

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/dashboard/summary` | dashboard.read | KPI cards with deltas and sparklines |
| GET | `/dashboard/queues` | dashboard.read | Pending work counts per queue (permission-filtered) |
| GET | `/dashboard/charts/signups` | dashboard.read | Sign-ups by role per day |
| GET | `/dashboard/charts/revenue` | reports.revenue | Revenue per day by purpose |
| GET | `/dashboard/charts/funnel` | dashboard.read | Leads → demos → conversions |
| GET | `/dashboard/cities` | dashboard.read | City breakdown table |
| POST | `/dashboard/refresh` | dashboard.read | Bypass cache (rate-limited) |

### [M48](modules/M48-revenue-reports.md) Revenue Reports

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/reports/revenue/overview` | reports.revenue | Series and totals |
| GET | `/reports/revenue/by-product` | reports.revenue | By fee code / purpose |
| GET | `/reports/revenue/by-segment` | reports.revenue | By payer type, city, state |
| GET | `/reports/revenue/gst` | reports.revenue | GST summary |
| GET | `/reports/revenue/subscriptions` | reports.revenue | MRR, new, renewed, churned |
| GET | `/reports/revenue/ledger` | reports.revenue | Transaction-level rows |
| POST | `/report-exports` | reports.revenue, reports.teachers or reports.institutes (per type) | Request an export |
| GET | `/report-exports` | any reports.* | My exports (all exports for Super Admin) |
| GET | `/report-exports/:id` | any reports.* | Export status |
| GET | `/report-exports/:id/download` | any reports.* | Presigned download URL |

### [M49](modules/M49-teacher-reports.md) Teacher Reports

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/reports/teachers/supply` | reports.teachers | Supply vs demand |
| GET | `/reports/teachers/onboarding` | reports.teachers | Onboarding funnel |
| GET | `/reports/teachers/verification` | reports.teachers | Verification turnaround |
| GET | `/reports/teachers/performance` | reports.teachers | Per-teacher performance |
| GET | `/reports/teachers/products` | reports.teachers | Premium / featured |
| GET | `/reports/teachers/risk` | reports.teachers | Risk list |

### [M50](modules/M50-institute-reports.md) Institute Reports

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/reports/institutes/onboarding` | reports.institutes | Onboarding and verification |
| GET | `/reports/institutes/ratings` | reports.institutes | Rating distribution and calibration |
| GET | `/reports/institutes/performance` | reports.institutes | Per-institute performance |
| GET | `/reports/institutes/capacity` | reports.institutes | Batches and capacity |
| GET | `/reports/institutes/renewals` | reports.institutes | Upcoming renewals |
| GET | `/reports/institutes/risk` | reports.institutes | Risk list |

