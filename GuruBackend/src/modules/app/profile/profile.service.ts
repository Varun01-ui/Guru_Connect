import { db } from '../../../db/index.js'
import { audit } from '../../../lib/audit.js'
import { notFound, validationFailed, versionConflict } from '../../../lib/errors.js'
import { cdnUrl, maskEmail, maskPhone } from '../../../lib/present.js'
import { storage } from '../../../lib/storage.js'
import type { Bucket } from '../../../lib/storage.js'
import { softDeleteFile } from '../uploads/uploads.repository.js'
import * as repo from './profile.repository.js'
import type { UpdateProfileBody } from './profile.schemas.js'

export type ProfileContext = { parentId: string; userId: string; ip: string | null }

export async function getProfile(ctx: ProfileContext) {
  const row = await repo.findParentProfile(ctx.parentId)
  if (!row) throw notFound('Profile not found.')
  const [childrenCount, unreadNotifications] = await Promise.all([repo.countChildren(ctx.parentId), repo.countUnreadNotifications(ctx.userId)])

  return {
    id: row.id,
    publicCode: row.public_code,
    fullName: row.full_name,
    photoUrl: cdnUrl(row.photo_key),
    phoneMasked: maskPhone(row.user_phone),
    emailMasked: maskEmail(row.user_email),
    city: row.city_id ? { id: row.city_id, name: row.city_name } : null,
    area: row.area_id ? { id: row.area_id, name: row.area_name } : null,
    childrenCount,
    unreadNotifications,
    memberSince: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function updateProfile(ctx: ProfileContext, version: Date, body: UpdateProfileBody) {
  // The photo being replaced or removed, cleaned up after the transaction commits.
  let orphanedFileId: string | null = null

  await db.transaction().execute(async (trx) => {
    const existing = await repo.findParentProfile(ctx.parentId, trx)
    if (!existing) throw notFound('Profile not found.')
    // Checked first so a stale form gets VERSION_CONFLICT rather than a field error.
    if (Math.abs(existing.updated_at.getTime() - version.getTime()) > 1) throw versionConflict()

    const cityChanged = body.cityId !== undefined && body.cityId !== existing.city_id
    const effectiveCityId = body.cityId ?? existing.city_id

    // Changing the city clears the area unless a new area (in the new city) is sent in the same request.
    let nextAreaId: string | null | undefined
    if (body.areaId !== undefined) nextAreaId = body.areaId
    else if (cityChanged) nextAreaId = null

    const values: Parameters<typeof repo.updateParentIfVersion>[3] = {}
    if (body.fullName !== undefined) values.full_name = body.fullName

    if (cityChanged) {
      const city = await repo.findActiveCity(body.cityId!, trx)
      if (!city) throw validationFailed([{ path: 'cityId', message: 'Choose a city.' }])
      values.city_id = city.id
      values.state_id = city.state_id // board rules (M07) compare against the parent's state
    }

    if (nextAreaId) {
      const area = effectiveCityId ? await repo.findActiveAreaInCity(nextAreaId, effectiveCityId, trx) : undefined
      if (!area) {
        const cityName = cityChanged ? (await repo.findActiveCity(body.cityId!, trx))?.name : existing.city_name
        throw validationFailed([{ path: 'areaId', message: `Choose an area in ${cityName ?? 'your city'}, or leave it blank.` }])
      }
    }
    if (nextAreaId !== undefined) values.area_id = nextAreaId

    let photoChanged = false
    if (body.profilePhotoFileId !== undefined) {
      if (body.profilePhotoFileId !== null && !(await repo.findOwnAvatarFile(body.profilePhotoFileId, ctx.userId, trx))) {
        throw validationFailed([{ path: 'profilePhotoFileId', message: "That photo didn't upload. Try again." }])
      }
      photoChanged = body.profilePhotoFileId !== existing.profile_photo_file_id
    }

    if (!(await repo.updateParentIfVersion(trx, ctx.parentId, version, values))) throw versionConflict()
    if (body.fullName !== undefined) await repo.updateUserFullName(trx, ctx.userId, body.fullName)
    if (photoChanged) {
      await repo.updateUserPhoto(trx, ctx.userId, body.profilePhotoFileId ?? null)
      if (existing.profile_photo_file_id) {
        orphanedFileId = existing.profile_photo_file_id
        await softDeleteFile(existing.profile_photo_file_id, trx)
      }
    }

    await audit(trx, {
      actorType: 'app_user',
      actorId: ctx.userId,
      action: 'app.parent_profile_updated',
      module: 'app.parent_profile',
      entityType: 'parent',
      entityId: ctx.parentId,
      newValues: { changedFields: Object.keys(body), areaCleared: cityChanged && nextAreaId === null, photoChanged },
      ip: ctx.ip,
    })
  })

  // Best effort: the row is already soft-deleted, so a failure here only leaves an unreferenced object behind.
  if (orphanedFileId) {
    const file = await repo.findFileLocation(orphanedFileId)
    if (file) await storage.delete(file.bucket as Bucket, file.object_key).catch(() => undefined)
  }

  const profile = await getProfile(ctx)
  return {
    id: profile.id,
    fullName: profile.fullName,
    photoUrl: profile.photoUrl,
    city: profile.city,
    area: profile.area,
    updatedAt: profile.updatedAt,
  }
}
