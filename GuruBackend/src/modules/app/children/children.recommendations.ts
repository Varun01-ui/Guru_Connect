import { getRedis } from '../../../lib/redis.js'

// BR-7.6: any qualifying create/edit (and every delete) drops this child's cached recommendations so a stale list
// can never be served. `rec:` is the M29/M30 cache; the two `home:rec:` keys are the M08 dashboard's per-child rails.
export async function invalidateChildRecommendations(childId: string): Promise<void> {
  const redis = await getRedis()
  if (!redis) return
  try {
    await redis.del(`rec:${childId}`, `home:rec:teacher:${childId}`, `home:rec:institute:${childId}`)
  } catch {
    // Cache invalidation is best effort: every key also has a 6 hour TTL.
  }
}

export type RecommendationPreview = {
  teacherId: string
  fullName: string
  trustScore: number
  score: number
  distanceKm: number | null
  subjectsMatched: string[]
}

// The inline top-3 shown right after a child is saved. Scoring needs the teacher-side tables (teacher_classes,
// teacher_subjects, trust_scores, teacher_locations), which arrive with the teacher modules; until then there is
// nothing to rank, so the contract is honoured with an empty list ("0 teachers found" is a valid, designed state).
export async function computeRecommendationsPreview(_childId: string): Promise<RecommendationPreview[]> {
  return []
}
