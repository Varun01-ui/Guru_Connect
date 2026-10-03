import { forbidden, notFound } from '../../../lib/errors.js'
import { cdnUrl } from '../../../lib/present.js'
import { listChildRows } from '../children/children.repository.js'
import { CHILD_RAILS, loadRail, RAIL_CODES } from './home.rails.js'
import type { RailCode } from './home.rails.js'
import * as repo from './home.repository.js'
import type { HomeQuery } from './home.schemas.js'

export type HomeContext = { parentId: string }

const BANNER_LIMITS = { home_top: 3, home_middle: 2 } as const
const COMBINED_RAIL_LIMIT = 10
const RAIL_PAGE_LIMIT = 20

export async function banners(cityId: string | null, audiences?: string[]) {
  const rows = await repo.listHomeBanners(cityId, audiences)
  const pick = (placement: 'home_top' | 'home_middle') =>
    rows
      .filter((r) => r.placement === placement)
      .slice(0, BANNER_LIMITS[placement])
      .map((r) => ({ id: r.id, title: r.title, subtitle: r.subtitle, imageUrl: cdnUrl(r.object_key), deepLink: r.deep_link }))
  return { home_top: pick('home_top'), home_middle: pick('home_middle') }
}

export async function getHome(ctx: HomeContext, query: HomeQuery) {
  const [location, childRows] = await Promise.all([repo.findParentLocation(ctx.parentId), listChildRows(ctx.parentId)])
  if (!location) throw notFound('Profile not found.')

  // childId must be one of this parent's live children; anything else is someone else's (or gone): 403, never a leak.
  if (query.childId && !childRows.some((c) => c.id === query.childId)) throw forbidden("You can't do that.")
  const selectedChildId = query.childId ?? childRows[0]?.id ?? null
  const railContext = { parentId: ctx.parentId, cityId: location.city_id, areaId: location.area_id, childId: selectedChildId }

  // "See all" / single-rail refresh: one rail's page, cursor in meta.
  if (query.rail) {
    const page = CHILD_RAILS.has(query.rail) && !selectedChildId
      ? { items: [], nextCursor: null }
      : await loadRail(query.rail, railContext, { cursor: query.cursor, limit: query.limit ?? RAIL_PAGE_LIMIT })
    return { data: { items: page.items }, meta: { nextCursor: page.nextCursor } }
  }

  const cachedAt = new Date().toISOString()
  const limit = query.limit ?? COMBINED_RAIL_LIMIT
  const rails: Record<RailCode, { items: unknown[]; nextCursor: string | null; cachedAt: string } | null> = {
    recommended_teachers: null,
    recommended_institutes: null,
    nearby_teachers: null,
    top_rated_teachers: null,
    verified_teachers: null,
  }
  for (const code of RAIL_CODES) {
    // With no children the per-child rails are hidden (null); the other three don't need a child.
    if (CHILD_RAILS.has(code) && !selectedChildId) continue
    const page = await loadRail(code, railContext, { limit })
    rails[code] = { items: page.items, nextCursor: page.nextCursor, cachedAt }
  }

  return {
    data: {
      children: childRows.map((c) => ({ id: c.id, childName: c.child_name, classLabel: c.class_name, sortOrder: c.sort_order })),
      selectedChildId,
      banners: await banners(location.city_id),
      rails,
    },
    meta: {
      rails: Object.fromEntries(RAIL_CODES.filter((code) => rails[code]).map((code) => [code, { cachedAt }])),
    },
  }
}
