# 03 · RBAC Matrix

Permissions are `module.action` keys. An admin's effective permissions are the union of their roles' permissions; Super Admin has all keys and cannot be edited. Roles other than Super Admin can be edited or cloned in Module 2; this matrix is the seeded default (`sql/seed/001_rbac.sql`). Keys marked **sensitive** require a reason on use, are highlighted in the audit log, and some require re-authentication within 5 minutes.

## Roles

| Role | Code | Purpose |
| --- | --- | --- |
| Super Admin | `super_admin` | Full access (Sameer Bhaiya). Cannot be edited or deleted. |
| Operations Admin | `operations_admin` | Runs day-to-day marketplace data: masters, teachers, institutes, users, leads, CMS. |
| Verification Admin | `verification_admin` | Reviews teacher and institute documents, evaluates institutes, watches trust scores. |
| Finance Admin | `finance_admin` | Owns pricing, payments, refunds, subscriptions and referral rewards. |
| Support Admin | `support_admin` | Handles reviews, complaints and user support. |

## Matrix

| Module | Permission | Sensitive | Super Admin | Operations Admin | Verification Admin | Finance Admin | Support Admin |
| --- | --- | --- | --- | --- | --- | --- | --- |
| M00 | `audit_logs.read` — View the audit log across all modules | yes | ✓ | · | · | · | · |
| M02 | `roles.read` — View roles and the permission matrix |  | ✓ | · | · | · | · |
| M02 | `roles.manage` — Create, edit and delete custom roles and change role permissions | yes | ✓ | · | · | · | · |
| M02 | `admins.read` — View admin accounts and their roles |  | ✓ | · | · | · | · |
| M02 | `admins.manage` — Invite, edit, disable admins and assign roles | yes | ✓ | · | · | · | · |
| M02 | `sessions.revoke_any` — Force sign-out of another admin | yes | ✓ | · | · | · | · |
| M04 | `settings.read` — View global settings |  | ✓ | ✓ | ✓ | ✓ | ✓ |
| M04 | `settings.update` — Change global settings | yes | ✓ | · | · | · | · |
| M05 | `payment_config.read` — View fees, versions and history |  | ✓ | ✓ | · | ✓ | · |
| M05 | `payment_config.edit` — Create and edit draft fee versions | yes | ✓ | · | · | ✓ | · |
| M05 | `payment_config.publish` — Publish or schedule fee versions (changes what users pay) | yes | ✓ | · | · | ✓ | · |
| M06 | `referral_settings.read` — View referral program rules |  | ✓ | ✓ | · | ✓ | · |
| M06 | `referral_settings.update` — Edit and publish referral program rules | yes | ✓ | · | · | ✓ | · |
| M07 | `locations.read` — View countries, states, cities and areas |  | ✓ | ✓ | ✓ | · | · |
| M07 | `locations.manage` — Create, edit, activate and delete locations |  | ✓ | ✓ | · | · | · |
| M11 | `education_masters.read` — View classes, subjects, boards, teaching modes and teacher categories |  | ✓ | ✓ | ✓ | · | · |
| M11 | `education_masters.manage` — Create, edit, activate and delete education master data |  | ✓ | ✓ | · | · | · |
| M16 | `teachers.read` — View teachers and their verification queue |  | ✓ | ✓ | ✓ | ✓ | ✓ |
| M16 | `teacher_verification.review` — Approve, reject or request re-upload of individual documents; add notes |  | ✓ | · | ✓ | · | · |
| M16 | `teacher_verification.decide` — Approve or reject a teacher application | yes | ✓ | · | ✓ | · | · |
| M16 | `teacher_documents.unmask` — View unmasked Aadhaar/PAN numbers and original files (logged) | yes | ✓ | · | ✓ | · | · |
| M17 | `teachers.update` — Edit teacher profiles and mappings |  | ✓ | ✓ | · | · | · |
| M17 | `teachers.suspend` — Suspend and re-activate teachers | yes | ✓ | ✓ | · | · | · |
| M17 | `teachers.badge` — Grant or revoke the Verified badge | yes | ✓ | · | ✓ | · | · |
| M17 | `teachers.feature` — Mark teachers as featured or premium manually |  | ✓ | ✓ | · | · | · |
| M17 | `teachers.create` — Create a teacher manually on their behalf |  | ✓ | ✓ | · | · | · |
| M21 | `teacher_analytics.read` — View teacher analytics |  | ✓ | ✓ | ✓ | · | · |
| M22 | `institutes.read` — View institutes and the institute queue |  | ✓ | ✓ | ✓ | ✓ | ✓ |
| M22 | `institute_documents.review` — Approve, reject or request re-upload of institute documents |  | ✓ | · | ✓ | · | · |
| M22 | `institute_documents.unmask` — View original institute documents and manager Aadhaar (logged) | yes | ✓ | · | ✓ | · | · |
| M23 | `institute_verification.decide` — Schedule visits, approve or reject institutes, grant the badge | yes | ✓ | · | ✓ | · | · |
| M24 | `institutes.update` — Edit institute profiles, batches and facilities |  | ✓ | ✓ | · | · | · |
| M24 | `institutes.suspend` — Suspend and re-activate institutes | yes | ✓ | ✓ | · | · | · |
| M25 | `institute_managers.read` — View institute managers and counsellors |  | ✓ | ✓ | ✓ | · | · |
| M25 | `institute_managers.manage` — Replace the primary manager, disable staff accounts | yes | ✓ | · | · | · | · |
| M26 | `institute_teachers.read` — View teachers listed under institutes |  | ✓ | ✓ | ✓ | · | ✓ |
| M26 | `institute_teachers.manage` — Support override: add, edit or remove institute teachers |  | ✓ | ✓ | · | · | · |
| M27 | `institute_ratings.read` — View institute evaluations |  | ✓ | ✓ | ✓ | · | · |
| M27 | `institute_ratings.rate` — Create and submit institute evaluations and overall rating | yes | ✓ | · | ✓ | · | · |
| M28 | `parents.read` — View parents (masked contact details) |  | ✓ | ✓ | · | ✓ | ✓ |
| M28 | `parents.update` — Edit parent profiles |  | ✓ | ✓ | · | · | · |
| M28 | `parents.suspend` — Suspend and re-activate parents | yes | ✓ | ✓ | · | · | · |
| M28 | `users.pii` — See full phone numbers and emails of parents, students and requesters (logged) | yes | ✓ | · | · | · | ✓ |
| M29 | `parent_children.read` — View children linked to parents |  | ✓ | ✓ | · | · | ✓ |
| M29 | `parent_children.manage` — Edit or remove children on a parent's behalf |  | ✓ | ✓ | · | · | · |
| M30 | `parent_subscriptions.read` — View parent subscriptions |  | ✓ | ✓ | · | ✓ | ✓ |
| M30 | `parent_subscriptions.manage` — Grant, extend or cancel parent subscriptions | yes | ✓ | · | · | ✓ | · |
| M31 | `students.read` — View students |  | ✓ | ✓ | · | ✓ | ✓ |
| M31 | `students.update` — Edit student profiles |  | ✓ | ✓ | · | · | · |
| M31 | `students.suspend` — Suspend and re-activate students | yes | ✓ | ✓ | · | · | · |
| M32 | `student_subscriptions.read` — View student subscriptions |  | ✓ | ✓ | · | ✓ | ✓ |
| M32 | `student_subscriptions.manage` — Grant, extend or cancel student subscriptions | yes | ✓ | · | · | ✓ | · |
| M33 | `teacher_reviews.read` — View teacher reviews |  | ✓ | ✓ | ✓ | · | ✓ |
| M34 | `institute_reviews.read` — View institute reviews |  | ✓ | ✓ | ✓ | · | ✓ |
| M35 | `reviews.moderate` — Approve, reject, hide and restore reviews and replies |  | ✓ | · | · | · | ✓ |
| M35 | `review_flags.resolve` — Uphold or dismiss review reports |  | ✓ | · | · | · | ✓ |
| M36 | `trust_scores.read` — View trust scores and breakdowns |  | ✓ | ✓ | ✓ | · | ✓ |
| M36 | `trust_scores.override` — Override, freeze or recalculate a teacher's trust score | yes | ✓ | · | · | · | · |
| M36 | `trust_weights.manage` — Change trust score factor weights | yes | ✓ | · | · | · | · |
| M37 | `trust_scores.history` — View trust score history |  | ✓ | · | ✓ | · | · |
| M38 | `leads.read` — View leads |  | ✓ | ✓ | · | · | ✓ |
| M38 | `leads.manage` — Change lead status, mark spam, add notes |  | ✓ | ✓ | · | · | ✓ |
| M39 | `demos.read` — View demo class requests |  | ✓ | ✓ | · | · | ✓ |
| M39 | `demos.manage` — Cancel or reschedule demos on behalf of users |  | ✓ | ✓ | · | · | ✓ |
| M40 | `transactions.read` — View transactions and refunds |  | ✓ | · | · | ✓ | ✓ |
| M40 | `refunds.approve` — Approve or deny refunds | yes | ✓ | · | · | ✓ | · |
| M41 | `subscriptions.read` — View all subscriptions |  | ✓ | ✓ | · | ✓ | ✓ |
| M41 | `subscriptions.manage` — Grant, extend or cancel any subscription | yes | ✓ | · | · | ✓ | · |
| M42 | `referrals.read` — View referrals and codes |  | ✓ | · | · | ✓ | · |
| M42 | `referrals.review` — Release, reject or reverse held referral rewards | yes | ✓ | · | · | ✓ | · |
| M42 | `referral_codes.manage` — Create and disable campaign codes |  | ✓ | · | · | ✓ | · |
| M43 | `complaints.read` — View complaints |  | ✓ | · | ✓ | · | ✓ |
| M43 | `complaints.manage` — Assign, triage, add notes, resolve and dismiss complaints |  | ✓ | · | · | · | ✓ |
| M43 | `complaints.enforce` — Issue warnings and suspend accounts from a complaint | yes | ✓ | · | · | · | ✓ |
| M44 | `banners.read` — View banners |  | ✓ | ✓ | · | · | · |
| M44 | `banners.manage` — Create, edit, schedule, pause and delete banners |  | ✓ | ✓ | · | · | · |
| M45 | `blogs.read` — View blog posts |  | ✓ | ✓ | · | · | · |
| M45 | `blogs.write` — Create and edit drafts |  | ✓ | ✓ | · | · | · |
| M45 | `blogs.publish` — Publish, schedule and archive posts |  | ✓ | ✓ | · | · | · |
| M46 | `notifications.read` — View notification campaigns |  | ✓ | ✓ | · | · | ✓ |
| M46 | `notifications.send` — Create and send / schedule notifications | yes | ✓ | ✓ | · | · | · |
| M46 | `notifications.approve_large` — Approve campaigns to more than 50,000 users | yes | ✓ | · | · | · | · |
| M47 | `dashboard.read` — View the analytics dashboard |  | ✓ | ✓ | ✓ | ✓ | ✓ |
| M48 | `reports.revenue` — View and export revenue reports | yes | ✓ | · | · | ✓ | · |
| M49 | `reports.teachers` — View and export teacher reports |  | ✓ | ✓ | ✓ | · | · |
| M50 | `reports.institutes` — View and export institute reports |  | ✓ | ✓ | ✓ | · | · |

Modules that reuse another module's keys: M08 uses M07, M09 uses M07, M10 uses M07, M12 uses M11, M13 uses M11, M14 uses M11, M15 uses M11, M18 uses M17, M19 uses M17, M20 uses M17.
