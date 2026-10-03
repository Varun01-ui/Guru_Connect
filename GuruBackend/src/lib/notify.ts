import type { Kysely } from 'kysely'
import type { DB } from '../db/types.js'

export type NotificationCategory = 'account' | 'verification' | 'leads' | 'demos' | 'reviews' | 'payments' | 'subscription' | 'referral' | 'complaints' | 'recommendations' | 'announcements'

// Writes the in-app inbox row (user_notifications). Push delivery (FCM) is out of scope for now: the row's
// `push_status` records what the sender should do. A category the user switched off still gets its inbox row, with
// `skipped_pref` (M20 BR / section 16). Quiet hours (delay, never drop; `urgent` bypasses) belong to the sender, which
// reads the same preference row, so rows stay `pending` here.
// `dedupeKey` makes a repeated event a no-op. Returns true when a new row was written.
export async function createNotification(
  executor: Kysely<DB>,
  input: { userId: string; category: NotificationCategory; eventType: string; title: string; body: string; deepLink?: string; data?: Record<string, unknown>; dedupeKey?: string; urgent?: boolean },
): Promise<boolean> {
  const pref = await executor.selectFrom('user_notification_preferences').select('push_enabled').where('user_id', '=', input.userId).where('category', '=', input.category).executeTakeFirst()

  const row = await executor
    .insertInto('user_notifications')
    .values({
      user_id: input.userId,
      category: input.category,
      event_type: input.eventType,
      title: input.title,
      body: input.body,
      deep_link: input.deepLink ?? null,
      data: { ...(input.data ?? {}), ...(input.urgent ? { urgent: true } : {}) } as never,
      dedupe_key: input.dedupeKey ?? null,
      push_status: pref && !pref.push_enabled ? 'skipped_pref' : 'pending',
    })
    .onConflict((oc) => oc.doNothing())
    .returning('id')
    .executeTakeFirst()
  return Boolean(row)
}
