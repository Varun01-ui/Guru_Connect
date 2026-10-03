import { z } from 'zod'
import { UPLOAD_PURPOSE_NAMES } from './uploads.config.js'

// Type/size rules depend on the purpose, so they are enforced in the service (with the purpose's own limits and the
// FILE_TYPE_NOT_ALLOWED / FILE_TOO_LARGE codes); this schema only checks the shape.
export const presignSchema = z.object({
  purpose: z.enum(UPLOAD_PURPOSE_NAMES),
  mimeType: z.string().trim().toLowerCase().min(1).max(100),
  sizeBytes: z.number().int().min(1, 'The file is empty.').max(Number.MAX_SAFE_INTEGER),
  fileName: z
    .string()
    .transform((v) => v.replace(/[\\/\u0000-\u001f]/g, '_').trim())
    .pipe(z.string().min(1).max(255)),
})
