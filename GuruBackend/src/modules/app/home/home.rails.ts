// The five parent-home rails (M08 BR-8.1). Ranking needs the teacher/institute-side tables (teacher_classes,
// teacher_subjects, trust_scores, teacher_locations, institutes), which arrive with those modules. Until then every
// rail is genuinely empty, and `loadRail` is the single seam they will fill in — the response shape, cursors and
// caching contract around it are already final, so the app needs no change when real data appears.
export const RAIL_CODES = ['recommended_teachers', 'recommended_institutes', 'nearby_teachers', 'top_rated_teachers', 'verified_teachers'] as const
export type RailCode = (typeof RAIL_CODES)[number]

// Rails that are scoped to one child (and are hidden entirely when the parent has no children).
export const CHILD_RAILS: ReadonlySet<RailCode> = new Set<RailCode>(['recommended_teachers', 'recommended_institutes'])

export type RailContext = {
  parentId: string
  cityId: string | null
  areaId: string | null
  childId: string | null
}

export type RailPage = { items: unknown[]; nextCursor: string | null }

export async function loadRail(_code: RailCode, _ctx: RailContext, _page: { cursor?: string; limit: number }): Promise<RailPage> {
  return { items: [], nextCursor: null }
}
