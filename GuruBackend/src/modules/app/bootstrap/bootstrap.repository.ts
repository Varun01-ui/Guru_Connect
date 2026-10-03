import { db } from '../../../db/index.js'

export async function getPublicSettingsMap(): Promise<Record<string, unknown>> {
  const rows = await db.selectFrom('system_settings').select(['key', 'value']).where('is_public', '=', true).execute()
  const map: Record<string, unknown> = {}
  for (const row of rows) map[row.key] = row.value
  return map
}

export async function getSettingByKey(key: string): Promise<unknown | undefined> {
  const row = await db.selectFrom('system_settings').select('value').where('key', '=', key).executeTakeFirst()
  return row?.value
}
