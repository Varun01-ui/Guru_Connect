import { sql } from 'kysely'
import { db } from '../../../db/index.js'

export async function findParentLocation(parentId: string) {
  return db.selectFrom('parents').select(['city_id', 'area_id']).where('id', '=', parentId).where('deleted_at', 'is', null).executeTakeFirst()
}

// M44's serving rules (BR-8.8): active, inside its window, audience all/parents, city-targeted or city-agnostic,
// highest priority first. The whole home screen is one round trip, so this is embedded rather than a second endpoint.
export function listHomeBanners(cityId: string | null, audiences: string[] = ['all', 'parents']) {
  const now = new Date()
  return db
    .selectFrom('banners as b')
    .innerJoin('files as f', (join) => join.onRef('f.id', '=', 'b.image_file_id').on('f.deleted_at', 'is', null).on('f.status', '=', 'uploaded').on('f.visibility', '=', 'public'))
    .select(['b.id', 'b.title', 'b.subtitle', 'b.placement', 'b.deep_link', 'f.object_key'])
    .where('b.status', '=', 'active')
    .where('b.deleted_at', 'is', null)
    .where('b.placement', 'in', ['home_top', 'home_middle'])
    .where('b.audience', 'in', audiences as never[])
    .where('b.starts_at', '<=', now)
    .where((eb) => eb.or([eb('b.ends_at', 'is', null), eb('b.ends_at', '>', now)]))
    .where(cityId ? sql<boolean>`(cardinality(b.city_ids) = 0 or ${cityId}::uuid = any(b.city_ids))` : sql<boolean>`cardinality(b.city_ids) = 0`)
    .orderBy('b.priority', 'desc')
    .orderBy('b.starts_at', 'desc')
    .execute()
}
