import compression from 'compression'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import express from 'express'
import 'express-async-errors'
import helmet from 'helmet'
import { randomUUID } from 'node:crypto'
import { pinoHttp } from 'pino-http'
import { env } from './config/env.js'
import { errorHandler } from './middleware/errorHandler.js'
import { storageIsConfigured } from './lib/storage.js'
import { mobileAppRouter } from './modules/app/router.js'
import { devCdnRouter } from './modules/app/uploads/devStorage.routes.js'
import { authRouter } from './modules/auth/auth.routes.js'
import { healthRouter } from './modules/health/health.routes.js'
import { rbacRouter } from './modules/rbac/rbac.routes.js'
import { teacherVerificationRouter } from './modules/teacherVerification/tv.routes.js'
import { countriesRouter } from './modules/countries/countries.routes.js'
import { classesRouter } from './modules/classes/classes.routes.js'
import { areasRouter } from './modules/areas/areas.routes.js'
import { citiesRouter } from './modules/cities/cities.routes.js'
import { boardsRouter } from './modules/boards/boards.routes.js'
import { statesRouter } from './modules/states/states.routes.js'
import { teacherCategoriesRouter } from './modules/teacherCategories/teacherCategories.routes.js'
import { teachingModesRouter } from './modules/teachingModes/teachingModes.routes.js'

export function createApp() {
  const app = express()

  app.set('trust proxy', 1)
  app.use(helmet())
  app.use(cors({ origin: env.CORS_ORIGIN, credentials: true }))
  app.use(compression())
  app.use(express.json())
  app.use(cookieParser())
  app.use(
    pinoHttp({
      genReqId: (req) => req.headers['x-request-id']?.toString() ?? randomUUID(),
    }),
  )

  app.use(healthRouter)
  if (storageIsConfigured()) app.use('/cdn', devCdnRouter) // dev stand-in for cdn.guruconnect.in
  app.use('/api/v1/admin', authRouter)
  app.use('/api/v1/admin', rbacRouter)
  app.use('/api/v1/admin', teacherVerificationRouter)
  app.use('/api/v1/admin', countriesRouter)
  app.use('/api/v1/admin', classesRouter)
  app.use('/api/v1/admin', areasRouter)
  app.use('/api/v1/admin', citiesRouter)
  app.use('/api/v1/admin', boardsRouter)
  app.use('/api/v1/admin', statesRouter)
  app.use('/api/v1/admin', teacherCategoriesRouter)
  app.use('/api/v1/admin', teachingModesRouter)
  app.use('/api/v1/app', mobileAppRouter)

  app.use(errorHandler)

  return app
}
