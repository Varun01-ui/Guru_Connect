import { Router } from 'express'
import { appAuthRouter } from './auth/auth.routes.js'
import { bootstrapRouter } from './bootstrap/bootstrap.routes.js'
import { childrenRouter } from './children/children.routes.js'
import { homeRouter } from './home/home.routes.js'
import { platformRouter } from './platform/platform.routes.js'
import { profileRouter } from './profile/profile.routes.js'
import { devStorageRouter } from './uploads/devStorage.routes.js'
import { uploadsRouter } from './uploads/uploads.routes.js'
import { storageIsConfigured } from '../../lib/storage.js'
import { registrationRouter } from './registration/registration.routes.js'
import { studentRouter } from './student/student.routes.js'
import { paymentsRouter } from './payments/payments.routes.js'
import { subscriptionsRouter } from './subscriptions/subscriptions.routes.js'
import { teacherRouter } from './teacher/teacher.routes.js'
import { teacherVerificationRouter } from './teacherVerification/verification.routes.js'
import { teacherDocsRouter } from './teacherDocs/docs.routes.js'
import { teacherAvailabilityRouter } from './teacherAvailability/availability.routes.js'
import { teacherProfileRouter } from './teacherProfile/profile.routes.js'
import { instituteRouter } from './institute/institute.routes.js'
import { teacherDashboardRouter } from './teacherDashboard/dashboard.routes.js'
import { notificationPreferencesRouter } from './notifications/preferences.routes.js'

// Mounted at /api/v1/app in app.ts — the mobile app's API, separate from /api/v1/admin.
export const mobileAppRouter = Router()

mobileAppRouter.use(bootstrapRouter)
mobileAppRouter.use(platformRouter)
mobileAppRouter.use(appAuthRouter)
mobileAppRouter.use(registrationRouter)
mobileAppRouter.use(studentRouter)
mobileAppRouter.use(teacherRouter)
mobileAppRouter.use(teacherDocsRouter)
mobileAppRouter.use(teacherVerificationRouter)
mobileAppRouter.use(teacherAvailabilityRouter)
mobileAppRouter.use(teacherProfileRouter)
mobileAppRouter.use(instituteRouter)
mobileAppRouter.use(teacherDashboardRouter)
mobileAppRouter.use(notificationPreferencesRouter)
mobileAppRouter.use(paymentsRouter)
mobileAppRouter.use(subscriptionsRouter)
mobileAppRouter.use(childrenRouter)
mobileAppRouter.use(homeRouter)
mobileAppRouter.use(profileRouter)
mobileAppRouter.use(uploadsRouter)
// Local-disk stand-in for R2's presigned endpoints: development/test only (production must use a real storage driver).
if (storageIsConfigured()) mobileAppRouter.use(devStorageRouter)
