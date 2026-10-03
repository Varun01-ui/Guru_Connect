# Module 50 · Institute Reports

> **Phase 16 · Reporting** · **Depends on:** M22–M27, M34, M38, M41, M48 (exports) · **Owns tables:** none · **Reads:** `institutes`, `institute_documents`, `institute_verification_logs`, `institute_ratings`, `institute_teachers`, `institute_batches`, `institute_reviews`, `leads`, `subscriptions`, `complaints`, `report_exports` · **Build estimate:** 2 days

## 1. Module Overview

Reports about institutes: onboarding and verification funnel, rating distribution and criteria scores, lead and enquiry performance, batches and capacity, teacher counts, subscription status and risk. Owns no tables; uses the shared export system from Module 48.

## 2. Business Purpose

Institutes are a newer, higher-value segment. Operations needs to see verification speed, rating quality and whether institutes get enough enquiries to renew.

## 3. User Stories

- As **Verification Admin**, I want the distribution of institute ratings and the average of each criterion so that ratings stay calibrated between evaluators.
- As **Operations Admin**, I want enquiries per institute per month and response rate so that I can help institutes that don't respond.
- As **Finance Admin**, I want institutes whose registration expires in the next 30 days with their lead counts so that renewal calls are informed.

## 4. Functional Requirements & Business Logic

**FR-50.1 Reports.**

| Report | Endpoint | Content |
| --- | --- | --- |
| Onboarding & verification | `/reports/institutes/onboarding` | draft → submitted → under evaluation → approved/rejected counts, median turnaround, rejection reasons, per-evaluator throughput |
| Ratings | `/reports/institutes/ratings` | distribution of `overall_rating` (0.5 buckets), criterion averages, evaluator calibration (each evaluator's mean vs overall mean, override frequency) |
| Performance | `/reports/institutes/performance` | per institute: page views, leads, response rate, median response, campus visits, conversions, user rating, reviews, teachers, active batches |
| Capacity | `/reports/institutes/capacity` | batches by subject/class/mode, seats, fill rate (enrolled ÷ capacity where tracked) |
| Renewals | `/reports/institutes/renewals` | registrations expiring in N days with last-90-day leads and conversions |
| Risk | `/reports/institutes/risk` | upheld complaints, rating ≤ 2.5, suspended, response rate < 50 % |

**FR-50.2 Calibration.** Evaluator mean deviation > 0.5 stars from the overall mean (min 10 ratings) is highlighted for Super Admin review.

**FR-50.3 Drill-down.** Rows link to the institute page (Module 24) with the date range applied.

**FR-50.4 Export.** Via Module 48 (`reportType` `institutes` or `institute_ratings`).

## 5. Validation Rules

| Field | Rule |
| --- | --- |
| from / to | required; ≤ 366 days |
| expiringInDays (renewals) | 7, 15, 30, 60, 90 |
| cityId / subjectId / classId | valid ids |
| minRatings (calibration) | 1–100, default 10 |

## 6. API Endpoints

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | /reports/institutes/onboarding | reports.institutes | Onboarding and verification |
| GET | /reports/institutes/ratings | reports.institutes | Rating distribution and calibration |
| GET | /reports/institutes/performance | reports.institutes | Per-institute performance |
| GET | /reports/institutes/capacity | reports.institutes | Batches and capacity |
| GET | /reports/institutes/renewals | reports.institutes | Upcoming renewals |
| GET | /reports/institutes/risk | reports.institutes | Risk list |

## 7. Request Payloads

```json
// GET /reports/institutes/ratings?from=2026-01-01&to=2026-09-26&cityId=…
// GET /reports/institutes/renewals?expiringInDays=30
```

## 8. Response Payloads

```json
// 200 GET /reports/institutes/ratings
{ "data": { "distribution": { "5.0": 21, "4.5": 64, "4.0": 118, "3.5": 90, "3.0": 41, "2.5": 12, "≤2.0": 6 }, "criteria": { "infrastructure": 7.4, "faculty": 7.9, "feedback": 8.1, "trust": 8.6 },
  "overallMean": 3.9, "evaluators": [ { "adminId": "…", "name": "Rahul (Verification)", "ratings": 48, "mean": 4.5, "deviation": 0.6, "overrides": 9, "flagged": true } ] } }

// 200 GET /reports/institutes/renewals
{ "data": [ { "instituteId": "…", "name": "Brilliant Minds Academy", "city": "Chennai", "expiresAt": "2026-10-14", "leads90d": 212, "conversions90d": 38, "autoRenew": false } ], "meta": { "page": 1, "pageSize": 50, "total": 17 } }
```

## 9. PostgreSQL Tables

No new tables. This module works on: `institutes`, `institute_documents`, `institute_verification_logs`, `institute_ratings`, `institute_teachers`, `institute_batches`, `institute_reviews`, `leads`, `subscriptions`, `complaints`, `report_exports`.

## 10. Column Definitions

No new columns. See the modules that own `institutes`, `institute_documents`, `institute_verification_logs`, `institute_ratings`, `institute_teachers`, `institute_batches`, `institute_reviews`, `leads`, `subscriptions`, `complaints`, `report_exports`.

## 11. Relationships

No relationships of its own.

## 12. Indexing Strategy


No tables of its own. Uses `idx_leads_institute`, institute rating indexes (current rating per institute), `idx_subscriptions_expiry` (renewals), `institute_verification_logs (institute_id, created_at)`.

## 13. Permissions

| Permission key | Allows | Sensitive | Super | Ops | Verif. | Finance | Support |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `reports.institutes` | View and export institute reports | — | ✓ | ✓ | ✓ | — | — |

## 14. UI Screens & React Page Structure

| Route | Page | Content |
| --- | --- | --- |
| `/reports/institutes` | InstituteReportsPage | Tabs Onboarding · Ratings · Performance · Capacity · Renewals · Risk; shared filters; export |

```
src/features/reports/institutes/
  pages/InstituteReportsPage.tsx
  components/RatingHistogram.tsx, CriteriaBars.tsx, CalibrationTable.tsx, InstitutePerformanceTable.tsx, RenewalsTable.tsx
```

## 15. UI Components

- `CalibrationTable` — evaluator, count, mean, deviation (flag icon + text when > 0.5), overrides.
- `RatingHistogram` — half-star buckets with counts labelled.

## 16. Filters

Date range, city, area, subject, class, rating band, status, subscription status, expiring within.

## 17. Search Capabilities

Institute name/code on Performance, Renewals and Risk tabs.

## 18. Pagination Requirements

Per-institute tables: offset, default 50, max 100. Aggregates are unpaginated.

## 19. Audit Logs

Read-only; exports and downloads are audited by Module 48.

## 20. Error Scenarios

| Scenario | HTTP | Code | Message |
| --- | --- | --- | --- |
| Range too long | 422 | VALIDATION_FAILED | "Pick a range of up to one year." |
| Invalid expiringInDays | 422 | VALIDATION_FAILED | "Choose 7, 15, 30, 60 or 90 days." |
| Query timeout | 503 | QUERY_TIMEOUT | "This report is taking too long. Narrow the filters or export it." |

## 21. Future Scalability Notes & Enhancements

Institute-facing analytics in the institute app; benchmarking against similar institutes; seat-fill tracking once batches support enrolment.

## 22. Security Considerations

Evaluator calibration is visible only to Super Admin (other roles see aggregate criteria only); institute contact data follows the `users.pii` rule in exports.
