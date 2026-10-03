import { createApp } from './app.js'
import { env } from './config/env.js'
import { startPaymentJobs } from './modules/app/payments/payments.capture.js'
import { startTeacherVerificationJobs } from './modules/teacherVerification/tv.jobs.js'
import { startNotificationJobs } from './modules/app/notifications/notifications.jobs.js'
import { startUploadJobs } from './modules/app/uploads/uploads.jobs.js'
import { startAuthJobs } from './modules/auth/auth.jobs.js'

const app = createApp()

app.listen(env.PORT, () => {
  console.log(`GuruConnect API listening on port ${env.PORT}`)
  for (const start of [startAuthJobs, startUploadJobs, startPaymentJobs, startNotificationJobs, startTeacherVerificationJobs]) start().catch((err) => console.error('[jobs] failed to start:', err))
})
