# Module 49 · Teacher Reports

> **Phase 16 · Reporting** · **Depends on:** M16–M21, M33, M36, M38, M39, M41, M48 (exports) · **Owns tables:** none · **Reads:** `teachers`, `teacher_documents`, `teacher_subjects`, `teacher_locations`, `teacher_daily_stats`, `leads`, `demo_requests`, `teacher_reviews`, `trust_scores`, `subscriptions`, `complaints`, `report_exports` · **Build estimate:** 3 days

## 1. Module Overview

Operational and quality reports about teachers: supply (by city, subject, class, mode), onboarding funnel and verification turnaround, performance (views, leads, response rate, demos, conversions, ratings, trust), paid products (premium/featured uptake), and risk (complaints, low trust). Owns no tables — it reads module tables and `teacher_daily_stats` and uses the shared export system from Module 48.

## 2. Business Purpose

Operations decides where to recruit teachers, whom to promote, and whom to coach or remove. These decisions need consistent, exportable numbers rather than ad-hoc queries.

## 3. User Stories

- As **Operations Admin**, I want subject × city supply versus parent demand so that I can recruit where parents can't find teachers.
- As **Verification Admin**, I want average approval turnaround and rejection reasons so that I can improve the process.
- As **Operations Admin**, I want the top and bottom 50 teachers by response rate and conversion so that I can reward or coach them.

## 4. Functional Requirements & Business Logic

**FR-49.1 Reports.**

| Report | Endpoint | Content |
| --- | --- | --- |
| Supply | `/reports/teachers/supply` | approved teachers by city × subject (or class, mode, category); demand = parent children needing that subject/class in the city (Module 29); gap ratio = demand ÷ supply |
| Onboarding funnel | `/reports/teachers/onboarding` | signed up → profile complete → documents submitted → paid → approved; drop-off %; median time per step |
| Verification | `/reports/teachers/verification` | decisions per day, median/p90 turnaround (submitted → decision), rejection reasons, per-verifier throughput |
| Performance | `/reports/teachers/performance` | per teacher: profile views, leads, response rate 24 h, median response, demos, no-shows, conversions, rating, reviews, trust score; sortable, with percentiles |
| Paid products | `/reports/teachers/products` | premium/featured purchases, active count, renewal rate, performance lift (leads per day before vs during) |
| Risk | `/reports/teachers/risk` | teachers with trust < 60, upheld complaints, many declines, no-shows ≥ 2 in 30 days, suspended |

**FR-49.2 Data sources.** Daily counters (`teacher_daily_stats`: views, leads, contacts, demos) are summed for performance; statuses and ratings come from current rows; turnarounds from `teacher_verification_logs`.

**FR-49.3 Thresholds.** Performance report hides teachers with < 5 leads in the period from rate rankings (shown with "not enough data").

**FR-49.4 Drill-down.** Every teacher row links to the teacher page (Module 17) with the same date range applied to its Analytics tab (Module 21).

**FR-49.5 Export.** All reports exportable via Module 48 (`reportType` `teachers` or `teacher_performance`).

## 5. Validation Rules

| Field | Rule |
| --- | --- |
| from / to | required; ≤ 366 days |
| dimension (supply) | subject, class, mode, category |
| cityId / subjectId / classId / categoryId | valid ids |
| minLeads (performance) | 0–1,000, default 5 |
| sort (performance) | leads, responseRate, conversionRate, rating, trustScore, views |

## 6. API Endpoints

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | /reports/teachers/supply | reports.teachers | Supply vs demand |
| GET | /reports/teachers/onboarding | reports.teachers | Onboarding funnel |
| GET | /reports/teachers/verification | reports.teachers | Verification turnaround |
| GET | /reports/teachers/performance | reports.teachers | Per-teacher performance |
| GET | /reports/teachers/products | reports.teachers | Premium / featured |
| GET | /reports/teachers/risk | reports.teachers | Risk list |

## 7. Request Payloads

```json
// GET /reports/teachers/supply?from=2026-09-01&to=2026-09-26&dimension=subject&cityId=<bengaluru>
// GET /reports/teachers/performance?from=2026-09-01&to=2026-09-26&cityId=…&subjectId=…&minLeads=5&sort=responseRate:asc&page=1&pageSize=50
```

## 8. Response Payloads

```json
// 200 GET /reports/teachers/supply
{ "data": { "rows": [ { "cityId": "…", "city": "Bengaluru", "key": "Physics", "supply": 212, "demand": 1840, "gapRatio": 8.7 },
                      { "cityId": "…", "city": "Bengaluru", "key": "Mathematics", "supply": 540, "demand": 2610, "gapRatio": 4.8 } ], "asOf": "…" } }

// 200 GET /reports/teachers/performance
{ "data": [ { "teacherId": "…", "name": "Dr. Ananya Iyer", "city": "Bengaluru", "views": 1840, "leads": 96, "responseRate24hPct": 97.9, "medianResponseMinutes": 22,
  "demos": 41, "noShows": 0, "conversions": 18, "conversionRatePct": 18.8, "rating": 4.9, "reviews": 312, "trustScore": 94.1 } ],
  "meta": { "page": 1, "pageSize": 50, "total": 3120, "percentiles": { "responseRate24hPct": { "p25": 62, "p50": 80, "p75": 92 } } } }
```

## 9. PostgreSQL Tables

No new tables. This module works on: `teachers`, `teacher_documents`, `teacher_subjects`, `teacher_locations`, `teacher_daily_stats`, `leads`, `demo_requests`, `teacher_reviews`, `trust_scores`, `subscriptions`, `complaints`, `report_exports`.

## 10. Column Definitions

No new columns. See the modules that own `teachers`, `teacher_documents`, `teacher_subjects`, `teacher_locations`, `teacher_daily_stats`, `leads`, `demo_requests`, `teacher_reviews`, `trust_scores`, `subscriptions`, `complaints`, `report_exports`.

## 11. Relationships

No relationships of its own.

## 12. Indexing Strategy


No tables of its own. Relies on `teacher_daily_stats (teacher_id, stat_date)` PK, `idx_leads_teacher`, `idx_demo_requests_teacher_time`, `teacher_verification_logs (teacher_id, created_at)`, and the teacher mapping indexes. For supply × demand at scale, add materialised view `mv_teacher_supply (city_id, subject_id, class_id, approved_count)` refreshed nightly.

## 13. Permissions

| Permission key | Allows | Sensitive | Super | Ops | Verif. | Finance | Support |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `reports.teachers` | View and export teacher reports | — | ✓ | ✓ | ✓ | — | — |

## 14. UI Screens & React Page Structure

| Route | Page | Content |
| --- | --- | --- |
| `/reports/teachers` | TeacherReportsPage | Tabs Supply · Onboarding · Verification · Performance · Products · Risk; shared filters; export |

```
src/features/reports/teachers/
  pages/TeacherReportsPage.tsx
  components/SupplyHeatmap.tsx, OnboardingFunnel.tsx, TurnaroundChart.tsx, PerformanceTable.tsx, ProductsTable.tsx, RiskTable.tsx
```

## 15. UI Components

- `SupplyHeatmap` — city × subject grid coloured by gap ratio with a legend and numeric values in cells (not colour alone).
- `PerformanceTable` — sticky first column, percentile badges, "not enough data" state.

## 16. Filters

Date range, city, area, subject, class, teaching mode, category, verified badge, premium/featured, trust band.

## 17. Search Capabilities

Teacher name/code on Performance and Risk tabs.

## 18. Pagination Requirements

Performance and Risk: offset, default 50, max 100. Supply, funnel, verification, products: aggregates (no pagination; supply capped at 500 rows, sorted by gap).

## 19. Audit Logs

Read-only; exports and downloads are audited by Module 48.

## 20. Error Scenarios

| Scenario | HTTP | Code | Message |
| --- | --- | --- | --- |
| Range too long | 422 | VALIDATION_FAILED | "Pick a range of up to one year." |
| Invalid dimension | 422 | VALIDATION_FAILED | "Choose subject, class, mode or category." |
| Query timeout (statement_timeout 15 s) | 503 | QUERY_TIMEOUT | "This report is taking too long. Narrow the filters or export it." |

## 21. Future Scalability Notes & Enhancements

Recruitment targets per city; teacher cohort retention; NPS by teacher; automatic coaching nudges for low responders.

## 22. Security Considerations

Teacher contact details are not included in on-screen reports; exports include them only with `users.pii`.
