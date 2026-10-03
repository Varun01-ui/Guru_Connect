import { signAppAccessToken } from '../../../lib/appJwt.js'
import { env } from '../../../config/env.js'
import * as repo from './auth.repository.js'

export type IssueSessionInput = {
  authMethod: 'otp' | 'password' | 'google' | 'email_otp'
  ipAddress: string | null
  userAgent: string | null
}

// Shared by every login/registration path (otp verify, email login, google sign-in, parent
// registration) so a session is always created and shaped the same way — never invent a
// second way to mint an app session.
export async function issueSession(
  userId: string,
  role: 'parent' | 'student' | 'teacher' | 'institute_staff',
  input: IssueSessionInput,
) {
  const { sessionId, refreshToken } = await repo.createSession({
    userId,
    authMethod: input.authMethod,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
  })
  const { profileId, instituteId } = await repo.findProfileForUser(userId, role)
  const accessToken = signAppAccessToken({ sub: userId, role, pid: profileId ?? '', ...(instituteId ? { iid: instituteId } : {}), sid: sessionId })
  return { accessToken, expiresIn: env.APP_ACCESS_TOKEN_TTL_SECONDS, refreshToken, session: { id: sessionId }, profileId }
}
