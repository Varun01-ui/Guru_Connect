import { db } from '../../../db/index.js'
import type { AppTrx } from '../registration/registration.repository.js'

export function findCityWithState(cityId: string) {
  return db
    .selectFrom('cities as c')
    .innerJoin('states as s', 's.id', 'c.state_id')
    .select(['c.id', 'c.name', 'c.latitude', 'c.longitude', 's.code as state_code'])
    .where('c.id', '=', cityId)
    .where('c.is_active', '=', true)
    .where('c.deleted_at', 'is', null)
    .executeTakeFirst()
}

export function findAreaInCity(areaId: string, cityId: string) {
  return db.selectFrom('areas').select(['id', 'name', 'pincodes']).where('id', '=', areaId).where('city_id', '=', cityId).where('is_active', '=', true).where('deleted_at', 'is', null).executeTakeFirst()
}

// Another live institute (not rejected) already uses this GSTIN.
export async function isGstinInUse(gstin: string, exceptInstituteId?: string): Promise<boolean> {
  let q = db.selectFrom('institutes').select('id').where('gstin', '=', gstin).where('deleted_at', 'is', null).where('verification_status', '<>', 'rejected')
  if (exceptInstituteId) q = q.where('id', '<>', exceptInstituteId)
  return Boolean(await q.executeTakeFirst())
}

export async function slugTaken(slug: string, trx: AppTrx, exceptInstituteId?: string): Promise<boolean> {
  let q = trx.selectFrom('institutes').select('id').where('slug', '=', slug).where('deleted_at', 'is', null)
  if (exceptInstituteId) q = q.where('id', '<>', exceptInstituteId)
  return Boolean(await q.executeTakeFirst())
}

export function insertInstituteTx(
  trx: AppTrx,
  input: { name: string; slug: string; instituteType: string; phone: string; email: string | null; gstin: string | null; addressLine: string; cityId: string; areaId: string; pincode: string; latitude: number; longitude: number },
) {
  return trx
    .insertInto('institutes')
    .values({
      name: input.name,
      slug: input.slug,
      institute_type: input.instituteType as 'other',
      phone: input.phone,
      email: input.email,
      gstin: input.gstin,
      address_line: input.addressLine,
      city_id: input.cityId,
      area_id: input.areaId,
      pincode: input.pincode,
      latitude: input.latitude.toFixed(6),
      longitude: input.longitude.toFixed(6),
      verification_status: 'draft',
      account_status: 'active',
    })
    .returning(['id', 'public_code', 'slug', 'name'])
    .executeTakeFirstOrThrow()
}

export function insertOwnerManagerTx(trx: AppTrx, input: { instituteId: string; userId: string; fullName: string; email: string | null; phone: string }) {
  return trx
    .insertInto('institute_managers')
    .values({
      institute_id: input.instituteId,
      user_id: input.userId,
      full_name: input.fullName,
      email: input.email,
      phone: input.phone,
      designation: 'Owner',
      staff_role: 'manager',
      is_primary: true,
      status: 'active',
      invited_at: null,
      accepted_at: new Date(),
    })
    .returning('id')
    .executeTakeFirstOrThrow()
}

export function insertConsentsTx(trx: AppTrx, userId: string, input: { documentVersion: string; ipAddress: string | null; installId: string | null }) {
  const base = { user_id: userId, document_version: input.documentVersion, granted: true, method: 'checkbox' as const, ip_address: input.ipAddress, install_id: input.installId }
  return trx
    .insertInto('user_consents')
    .values([
      { ...base, consent_type: 'terms' as const },
      { ...base, consent_type: 'privacy_policy' as const },
    ])
    .execute()
}

export function findInviteTx(trx: AppTrx, inviteId: string) {
  return trx
    .selectFrom('institute_managers as m')
    .innerJoin('institutes as i', 'i.id', 'm.institute_id')
    .select(['m.id', 'm.institute_id', 'm.phone', 'm.status', 'm.user_id', 'm.staff_role', 'm.invited_at', 'i.name as institute_name', 'i.verification_status', 'i.account_status', 'i.deleted_at as institute_deleted_at'])
    .where('m.id', '=', inviteId)
    .forUpdate('m')
    .executeTakeFirst()
}

export function acceptInviteTx(trx: AppTrx, input: { managerId: string; userId: string; fullName: string }) {
  return trx.updateTable('institute_managers').set({ user_id: input.userId, full_name: input.fullName, status: 'active', accepted_at: new Date() }).where('id', '=', input.managerId).execute()
}

export function findPrimaryManager(instituteId: string) {
  return db.selectFrom('institute_managers').select(['id', 'user_id']).where('institute_id', '=', instituteId).where('is_primary', '=', true).where('status', '=', 'active').executeTakeFirst()
}
