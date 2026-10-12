import type { NextFunction, Request, Response } from 'express'
import { ApiError } from '../lib/errors.js'
import { isMaintenanceOn } from '../lib/settingsCache.js'

// M04 FR-4.4: while app.maintenance_mode is on, the mobile API answers 503 MAINTENANCE. The bootstrap and public
// settings calls stay open (the app needs them to show the maintenance screen) and so does sign-in, so a user
// who is already in the middle of OTP login isn't dropped. The admin portal never passes through this gate.
const OPEN_PATHS = [/^\/bootstrap\/?$/, /^\/settings\/?$/, /^\/auth(\/|$)/, /^\/dev-storage(\/|$)/]

export async function maintenanceGate(req: Request, _res: Response, next: NextFunction) {
  if (OPEN_PATHS.some((p) => p.test(req.path))) return next()
  if (await isMaintenanceOn()) throw new ApiError(503, 'MAINTENANCE', 'GuruConnect is down for maintenance. Please try again shortly.')
  next()
}
