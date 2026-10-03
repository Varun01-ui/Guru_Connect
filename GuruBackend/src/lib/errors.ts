export class ApiError extends Error {
  status: number
  code: string
  details?: unknown

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

export const notFound = (message = 'Resource not found') => new ApiError(404, 'NOT_FOUND', message)
export const forbidden = (message = 'Missing permission') => new ApiError(403, 'FORBIDDEN', message)
export const validationFailed = (details: unknown, message = 'Some fields need attention.') =>
  new ApiError(422, 'VALIDATION_FAILED', message, details)

export const authRequired = (message = 'Sign in to continue.') => new ApiError(401, 'AUTH_REQUIRED', message)
export const authTokenExpired = (message = 'Your session expired.') => new ApiError(401, 'AUTH_TOKEN_EXPIRED', message)
export const authInvalidCredentials = (message = 'Email or password is incorrect.') =>
  new ApiError(401, 'AUTH_INVALID_CREDENTIALS', message)
export const authAccountLocked = (lockedUntil: string, message: string) =>
  new ApiError(423, 'AUTH_ACCOUNT_LOCKED', message, { lockedUntil })
export const authAccountDisabled = (message = 'Your access has been removed. Contact the Super Admin.') =>
  new ApiError(403, 'AUTH_ACCOUNT_DISABLED', message)
export const authRefreshInvalid = (message = 'Your session ended. Sign in again.') =>
  new ApiError(401, 'AUTH_REFRESH_INVALID', message)
export const authLinkExpired = (message = 'This link has expired. Request a new one.') =>
  new ApiError(410, 'AUTH_LINK_EXPIRED', message)
export const otpInvalid = (message = 'That code is incorrect.', details?: unknown) => new ApiError(422, 'OTP_INVALID', message, details)
export const otpExpired = (message = 'This code has expired. Request a new one.') =>
  new ApiError(410, 'OTP_EXPIRED', message)
export const otpLocked = (message = 'Too many wrong attempts. Request a new code.') => new ApiError(429, 'OTP_LOCKED', message)
export const rateLimited = (retryAfterSeconds: number, message = 'Please wait before trying again.') =>
  new ApiError(429, 'RATE_LIMITED', message, { retryAfterSeconds })
export const limitReached = (limit: number, current: number, message = `You can add up to ${limit} children.`, reason = 'max_children') =>
  new ApiError(409, 'LIMIT_REACHED', message, { reason, limit, current })
export const fileTooLarge = (message = 'That file is too large.', details?: unknown) => new ApiError(413, 'FILE_TOO_LARGE', message, details)
export const fileTypeNotAllowed = (message = "That file type isn't allowed.", details?: unknown) => new ApiError(415, 'FILE_TYPE_NOT_ALLOWED', message, details)
export const gatewayError = (message = 'Something went wrong on our side. Try again.') => new ApiError(502, 'GATEWAY_ERROR', message)
export const versionConflict = (message = 'Updated on another device. Review and save again.') =>
  new ApiError(409, 'VERSION_CONFLICT', message, {})
export const conflictDuplicate = (message = 'This already exists.') => new ApiError(409, 'CONFLICT_DUPLICATE', message)
export const registrationRequired = (registrationToken: string, contactType: string, expiresInSeconds: number) =>
  new ApiError(409, 'REGISTRATION_REQUIRED', 'Verified — finish creating your account.', {
    registrationToken,
    contactType,
    expiresInSeconds,
  })
export const roleMismatch = (actualRole: string, message = 'This account is registered under a different role.') =>
  new ApiError(409, 'ROLE_MISMATCH', message, { actualRole })
export const conflictState = (message = 'This action is not allowed right now.', details?: unknown) => new ApiError(409, 'CONFLICT_STATE', message, details)
export const paymentFailed = (message = "We couldn't confirm this payment.", details?: unknown) => new ApiError(402, 'PAYMENT_FAILED', message, details)
export const subscriptionRequired = (message = 'You need an active plan for this.') => new ApiError(402, 'SUBSCRIPTION_REQUIRED', message)
