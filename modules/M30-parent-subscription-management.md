# Module 30 · Parent Subscription Management

> **Phase 7 · Parents** · **Depends on:** M5, M28, M40, M41 (create the M40–M41 tables before building this module's API) · **Owns tables:** none · **Reads:** `subscriptions`, `transactions`, `payment_configurations`, `parents` · **Build estimate:** 2 days

## 1. Module Overview

The parent-specific view of subscriptions: current plan (trial, monthly, yearly, free access), history, renewals and payments for each parent, plus admin actions — grant complimentary access, extend, cancel, and switch auto-renew off. It is a filtered, parent-focused UI over the shared `subscriptions` engine owned by Module 41.

## 2. Business Purpose

Parents call support about trials ending, renewals and refunds. Support and finance need parent-level answers and tools without learning the whole subscription engine.

## 3. User Stories

- As **Support Admin**, I want to see when a parent's trial ends and whether auto-renew is on so that I can answer "why was I charged?".
- As **Finance Admin**, I want to extend a parent's membership by 15 days after a service failure so that we keep their goodwill.
- As **Finance Admin**, I want to cancel auto-renew at a parent's request so that they aren't charged again.
- As **Operations Admin**, I want counts of parents by subscription status so that I can track conversion from trial.

## 4. Functional Requirements & Business Logic

**FR-30.1 Parent subscription list.** `GET /parent-subscriptions` — one row per parent's latest subscription (`subscriber_type = 'parent'`): parent, plan, status, started, ends, trial ends, auto-renew, price paid, last transaction.

**FR-30.2 Parent subscription detail.** `GET /parents/:parentId/subscriptions` — all periods (history), related transactions and refunds.

**FR-30.3 Admin actions** (implemented by Module 41 services, called with `subscriber_type = 'parent'`):
- **Grant complimentary** `POST /parents/:parentId/subscriptions/grant { feeCode, days, reason }` — creates an `active` subscription with `price_paise = 0`, `granted_by`.
- **Extend** `POST /subscriptions/:id/extend { days, reason }` — adds days to `ends_at` (active/grace/trial only).
- **Cancel** `POST /subscriptions/:id/cancel { mode: at_period_end|immediately, reason, refund? }` — `immediately` ends access now; refunds go through Module 40.
- **Auto-renew off** `POST /subscriptions/:id/auto-renew { enabled: false, reason }` — cancels the Razorpay subscription mandate.

**FR-30.4 Fee switched off.** When both parent subscription fees are disabled (Module 5), new parents get `free_access` and the list shows them under "Free access". Re-enabling fees does not remove `free_access` automatically; a scheduled job converts them to a `trial` of `trial_days` starting on the re-enable date and notifies them (behaviour behind the setting `subscriptions.free_access_to_trial_on_enable`, default true).

**FR-30.5 Funnel.** `GET /parent-subscriptions/stats?from&to` — trials started, converted to paid, conversion %, active by plan, churned, MRR from parents.

## 5. Validation Rules

| Field | Rule |
| --- | --- |
| feeCode (grant) | PARENT_SUBSCRIPTION_MONTHLY or PARENT_SUBSCRIPTION_YEARLY |
| days | 1–365 |
| reason | 10–500 |
| cancel.mode | at_period_end, immediately |
| refund | optional `{ amountPaise }` ≤ captured − refunded |
| Preconditions | extend/cancel only on trial, active, grace; one live subscription per parent (M41 constraint) |

## 6. API Endpoints

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | /parent-subscriptions | parent_subscriptions.read | Parent subscriptions (latest per parent) |
| GET | /parent-subscriptions/stats | parent_subscriptions.read | Funnel and plan mix |
| GET | /parents/:parentId/subscriptions | parent_subscriptions.read | History for one parent |
| POST | /parents/:parentId/subscriptions/grant | parent_subscriptions.manage | Complimentary access |
| POST | /subscriptions/:id/extend | parent_subscriptions.manage (for parent subscriptions) | Extend |
| POST | /subscriptions/:id/cancel | parent_subscriptions.manage | Cancel |
| POST | /subscriptions/:id/auto-renew | parent_subscriptions.manage | Turn auto-renew off |

## 7. Request Payloads

```json
// POST /subscriptions/:id/extend
{ "days": 15, "reason": "Booked teacher didn't start; goodwill extension" }

// POST /subscriptions/:id/cancel
{ "mode": "immediately", "reason": "Parent moved abroad", "refund": { "amountPaise": 99900 } }
```

## 8. Response Payloads

```json
// 200 GET /parents/:parentId/subscriptions
{ "data": [ { "id": "…", "feeCode": "PARENT_SUBSCRIPTION_YEARLY", "status": "active", "pricePaise": 199900, "startsAt": "2026-09-26T10:48:00Z", "endsAt": "2027-09-26T10:48:00Z",
  "trialEndsAt": null, "autoRenew": true, "lastTransaction": { "code": "TXN-7702210", "status": "captured" } },
  { "id": "…", "feeCode": "PARENT_SUBSCRIPTION_MONTHLY", "status": "expired", "pricePaise": 29900, "startsAt": "…", "endsAt": "…" } ] }
```

## 9. PostgreSQL Tables

No new tables. This module works on: `subscriptions`, `transactions`, `payment_configurations`, `parents`.

## 10. Column Definitions

No new columns. See the modules that own `subscriptions`, `transactions`, `payment_configurations`, `parents`.

## 11. Relationships

No relationships of its own.

## 12. Indexing Strategy


Uses Module 41 indexes: `idx_subscriptions_user`, `idx_subscriptions_type_status`, `uq_subscriptions_one_live`.

## 13. Permissions

| Permission key | Allows | Sensitive | Super | Ops | Verif. | Finance | Support |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `parent_subscriptions.read` | View parent subscriptions | — | ✓ | ✓ | — | ✓ | ✓ |
| `parent_subscriptions.manage` | Grant, extend or cancel parent subscriptions | yes | ✓ | — | — | ✓ | — |

Actions check `parent_subscriptions.manage` when the subscription's `subscriber_type` is `parent`; `subscriptions.manage` (Module 41) also allows them.

## 14. UI Screens & React Page Structure

| Route | Page | Content |
| --- | --- | --- |
| `/payments/subscriptions/parents` | ParentSubscriptionsPage | Funnel tiles (trials, conversion, active, churn), status tabs, table |
| `/users/parents/:id` → Subscription tab | ParentSubscriptionTab | Current plan card, actions, history, payments |

```
src/features/subscriptions/ (shared with M32 and M41)
  pages/ParentSubscriptionsPage.tsx
  components/SubscriptionCard.tsx, GrantDialog.tsx, ExtendDialog.tsx, CancelSubscriptionDialog.tsx, SubscriptionHistory.tsx, FunnelTiles.tsx
```

## 15. UI Components

- `SubscriptionCard` — plan, status badge, dates with countdown, auto-renew state, action menu.
- `CancelSubscriptionDialog` — at period end vs now, refund amount (prefilled pro-rata), reason.

## 16. Filters

Status, plan, auto-renew, ends within (7/30 days), started date range, city.

## 17. Search Capabilities

Parent name, code, phone (as Module 28).

## 18. Pagination Requirements

Offset, default 20; sort by endsAt (default asc for "expiring soon"), startsAt, pricePaise.

## 19. Audit Logs

| Event | Details |
| --- | --- |
| `subscription.granted` | parent, plan, days, reason |
| `subscription.extended` | days, old/new end, reason |
| `subscription.cancelled` | mode, refund, reason |
| `subscription.auto_renew_disabled` | reason |

## 20. Error Scenarios

| Scenario | HTTP | Code | Message |
| --- | --- | --- | --- |
| Parent already has a live subscription (grant) | 409 | CONFLICT_STATE | "Extend the current plan instead." |
| Extend an expired/cancelled subscription | 409 | CONFLICT_STATE | "Only live subscriptions can be extended." |
| Refund above paid amount | 422 | VALIDATION_FAILED | "Refund can't exceed ₹{x}." |
| Razorpay mandate cancel failed | 502 | GATEWAY_ERROR | "Couldn't reach Razorpay. Auto-renew is still on; try again." |

## 21. Future Scalability Notes & Enhancements

Family plans covering multiple children; pause subscription; win-back offers for churned parents.

## 22. Security Considerations

Money-affecting actions need `parent_subscriptions.manage` (sensitive) and a reason; refunds flow through Module 40 approval rules.
