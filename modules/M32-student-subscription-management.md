# Module 32 · Student Subscription Management

> **Phase 8 · Students** · **Depends on:** M5, M31, M40, M41 · **Owns tables:** none · **Reads:** `subscriptions`, `transactions`, `payment_configurations`, `students` · **Build estimate:** 1–2 days

## 1. Module Overview

The student-focused view of subscriptions (free trial → paid membership), mirroring Module 30 for `subscriber_type = 'student'`: list, per-student history, funnel stats, and admin actions (grant, extend, cancel, auto-renew off).

## 2. Business Purpose

Students have their own pricing (Module 5) and trial rules. Finance and support need the same tools as for parents, filtered to students, to answer questions and measure trial-to-paid conversion.

## 3. User Stories

- As **Finance Admin**, I want to see how many student trials converted to paid last month so that I can judge student pricing.
- As **Support Admin**, I want to extend an exam aspirant's membership by a week during a platform outage.
- As **Finance Admin**, I want to grant a scholarship student complimentary access for a year.

## 4. Functional Requirements & Business Logic

**FR-32.1** Same list, detail, stats and actions as FR-30.1–30.5 with `subscriber_type = 'student'` and fee codes `STUDENT_SUBSCRIPTION_MONTHLY` / `STUDENT_SUBSCRIPTION_YEARLY`.

**FR-32.2 Free trial rules for students.** Trial length and free contacts come from the active student fee version (`trial_days`) and `system_settings` (`limits.student_trial_free_contacts`, default 5). One trial per phone number and per device fingerprint (app-side); a second account on the same device gets no trial row at all — the app goes straight to the paid plans, and the reason is logged as an app event (`trial_blocked: device_reused`).

**FR-32.3 Scholarship grants.** `POST /students/:studentId/subscriptions/grant { feeCode, days, reason, programTag: 'scholarship' }` — tagged grants are reported separately in the funnel.

**FR-32.4 Parent-linked students.** If a linked parent has an active parent membership, the student inherits contact access (read-only indicator "Covered by parent's plan"); no student subscription is required.

## 5. Validation Rules

As Module 30, with student fee codes; `programTag` optional one of `scholarship`, `goodwill`, `partner`.

## 6. API Endpoints

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | /student-subscriptions | student_subscriptions.read | Student subscriptions (latest per student) |
| GET | /student-subscriptions/stats | student_subscriptions.read | Funnel and plan mix |
| GET | /students/:studentId/subscriptions | student_subscriptions.read | History for one student |
| POST | /students/:studentId/subscriptions/grant | student_subscriptions.manage | Complimentary access |
| POST | /subscriptions/:id/extend | student_subscriptions.manage (for student subscriptions) | Extend |
| POST | /subscriptions/:id/cancel | student_subscriptions.manage | Cancel |
| POST | /subscriptions/:id/auto-renew | student_subscriptions.manage | Turn auto-renew off |

## 7. Request Payloads

```json
// POST /students/:studentId/subscriptions/grant
{ "feeCode": "STUDENT_SUBSCRIPTION_YEARLY", "days": 365, "reason": "Merit scholarship — Class 12 topper, Patna", "programTag": "scholarship" }
```

## 8. Response Payloads

```json
// 200 GET /student-subscriptions/stats?from=2026-08-01&to=2026-08-31
{ "data": { "trialsStarted": 3104, "convertedToPaid": 512, "conversionPct": 16.5, "activeByPlan": { "STUDENT_SUBSCRIPTION_MONTHLY": 1720, "STUDENT_SUBSCRIPTION_YEARLY": 610 }, "churned": 184, "grants": { "scholarship": 22, "goodwill": 9 }, "mrrPaise": 44660000 } }
```

## 9. PostgreSQL Tables

No new tables. This module works on: `subscriptions`, `transactions`, `payment_configurations`, `students`.

## 10. Column Definitions

No new columns. See the modules that own `subscriptions`, `transactions`, `payment_configurations`, `students`.

## 11. Relationships

No relationships of its own.

## 12. Indexing Strategy


Module 41 indexes (`idx_subscriptions_type_status`, `idx_subscriptions_user`, `idx_subscriptions_expiry`).

## 13. Permissions

| Permission key | Allows | Sensitive | Super | Ops | Verif. | Finance | Support |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `student_subscriptions.read` | View student subscriptions | — | ✓ | ✓ | — | ✓ | ✓ |
| `student_subscriptions.manage` | Grant, extend or cancel student subscriptions | yes | ✓ | — | — | ✓ | — |

## 14. UI Screens & React Page Structure

| Route | Page | Content |
| --- | --- | --- |
| `/payments/subscriptions/students` | StudentSubscriptionsPage | Same layout as parents; "Covered by parent" column |
| `/users/students/:id` → Subscription tab | StudentSubscriptionTab | Card, actions, history |
Reuses `src/features/subscriptions/*` components with `subscriberType="student"`.

## 15. UI Components

Shared with Module 30; `CoveredByParentBadge`; `programTag` select in `GrantDialog`.

## 16. Filters

Status, plan, auto-renew, ends within, program tag, class, city.

## 17. Search Capabilities

Student name, code, phone (as Module 31).

## 18. Pagination Requirements

Offset, default 20; sort endsAt, startsAt, pricePaise.

## 19. Audit Logs

Same events as Module 30 with `subscriber_type = student` in `new_values`, plus program tag.

## 20. Error Scenarios

Same as Module 30, plus:

| Scenario | HTTP | Code | Message |
| --- | --- | --- | --- |
| Grant when covered by parent's plan | 409 | CONFLICT_STATE | "This student is covered by their parent's membership." |

## 21. Future Scalability Notes & Enhancements

Exam-season plans (e.g., 90-day JEE crash plan) as additional fee codes; institutional (school) bulk licences.

## 22. Security Considerations

Same as Module 30.
