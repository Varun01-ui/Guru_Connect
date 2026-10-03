// npm run admin:create -- --email you@example.com --name "Your Name" --super
// Bootstrap CLI (FR-1.11): creates an *invited* admin and prints a one-time invite link. There is no public sign-up.
import { randomBytes } from 'node:crypto'
import { env } from '../config/env.js'
import { db, pool } from '../db/index.js'
import { audit } from '../lib/audit.js'
import { hashPassword } from '../lib/password.js'
import { generateOpaqueToken, sha256Hex } from '../lib/tokens.js'
import * as repo from '../modules/auth/auth.repository.js'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

async function main() {
  const email = arg('email')?.trim().toLowerCase()
  const name = arg('name')?.trim()
  const isSuperAdmin = process.argv.includes('--super')
  if (!email || !name) {
    console.error('Usage: npm run admin:create -- --email <email> --name "<full name>" [--super]')
    process.exitCode = 1
    return
  }
  if (await repo.findAdminByEmail(email)) {
    console.error(`An admin with email ${email} already exists.`)
    process.exitCode = 1
    return
  }

  // The account has no usable password until the invite is accepted: the hash is of random bytes nobody knows.
  const admin = await repo.createInvitedAdmin({
    email,
    fullName: name,
    passwordHash: await hashPassword(randomBytes(32).toString('hex')),
    isSuperAdmin,
  })
  const token = generateOpaqueToken()
  await repo.createPasswordResetToken({
    adminId: admin.id,
    tokenHash: sha256Hex(token),
    purpose: 'invite',
    expiresAt: new Date(Date.now() + 72 * 3_600_000),
    requestedIp: null,
  })
  await audit(db, { actorType: 'system', action: 'auth.admin_bootstrapped', module: 'auth', entityType: 'admin', entityId: admin.id, newValues: { email, isSuperAdmin } })

  console.log(`Created ${isSuperAdmin ? 'super ' : ''}admin ${email} (${admin.id}), status: invited`)
  console.log(`Invite link (valid 72 hours, shown once): ${env.ADMIN_PORTAL_URL.replace(/\/$/, '')}/accept-invite?token=${token}`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => pool.end())
