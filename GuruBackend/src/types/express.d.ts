declare global {
  namespace Express {
    interface Request {
      admin?: {
        id: string
        email: string
        isSuperAdmin: boolean
        sessionId: string
      }
      appAuth?: {
        userId: string
        role: 'parent' | 'student' | 'teacher' | 'institute_staff'
        profileId: string | null
        instituteId: string | null
        sessionId: string
      }
      parent?: { id: string; userId: string }
      student?: { id: string; userId: string }
      teacher?: { id: string; userId: string }
      instituteManager?: { id: string; userId: string; instituteId: string; staffRole: 'manager' | 'counsellor'; isPrimary: boolean }
      registration?: {
        sub: string
        contactType: 'phone' | 'email' | 'google'
        prefill?: { fullName?: string; photoUrl?: string }
        jti: string
      }
      validatedQuery?: unknown
    }
  }
}

export {}
