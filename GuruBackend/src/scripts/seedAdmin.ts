import { db, pool } from '../db/index.js'
import { hashPassword } from '../lib/password.js'

const EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'sameer@gmail.com'
const PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? 'demo@123'
const PHONE = process.env.SEED_ADMIN_PHONE ?? '+919999999999'
const FULL_NAME = process.env.SEED_ADMIN_NAME ?? 'Sameer Bhaiya'

async function main() {
  const existing = await db.selectFrom('admins').select(['id']).where('email', '=', EMAIL).executeTakeFirst()

  let adminId: string
  if (existing) {
    adminId = existing.id
    await db
      .updateTable('admins')
      .set({ password_hash: await hashPassword(PASSWORD), status: 'active', is_super_admin: true, locked_until: null, failed_login_count: 0 })
      .where('id', '=', adminId)
      .execute()
    console.log(`Updated existing admin ${EMAIL} (${adminId})`)
  } else {
    const inserted = await db
      .insertInto('admins')
      .values({
        email: EMAIL,
        password_hash: await hashPassword(PASSWORD),
        full_name: FULL_NAME,
        status: 'active',
        is_super_admin: true,
      })
      .returning(['id'])
      .executeTakeFirstOrThrow()
    adminId = inserted.id
    console.log(`Created admin ${EMAIL} (${adminId})`)
  }

  await db
    .insertInto('admin_profiles')
    .values({ admin_id: adminId, display_name: FULL_NAME, phone: PHONE })
    .onConflict((oc) => oc.column('admin_id').doUpdateSet({ phone: PHONE, display_name: FULL_NAME }))
    .execute()

  console.log(`Login with email ${EMAIL} / password ${PASSWORD}, or mobile OTP with ${PHONE}`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => pool.end())
