import { z } from 'zod'

export const DOC_TYPES = ['aadhaar', 'pan', 'education_certificate', 'professional_certificate', 'experience_letter', 'photo'] as const
export type DocType = (typeof DOC_TYPES)[number]

export const IDENTITY_TYPES: readonly DocType[] = ['aadhaar', 'pan', 'photo']
export const MULTI_SLOT_TYPES: readonly DocType[] = ['education_certificate', 'professional_certificate', 'experience_letter']
export const MAX_SLOTS = 5

export const createDocumentSchema = z.object({
  docType: z.enum(DOC_TYPES),
  fileId: z.string().uuid(),
  title: z.string().trim().min(2, 'Give this document a short title').max(120, 'Give this document a short title').nullish(),
  docNumber: z.string().trim().max(40).nullish(),
  qualificationId: z.string().uuid().nullish(),
})

export const submitSchema = z.object({ transactionId: z.string().uuid('Payment not found.').nullish() })

export const documentIdParamSchema = z.object({ id: z.string().uuid() })

// Strips spaces/dashes and upper-cases, so "4912 3456 7890" and "abcde1234f" compare and hash consistently.
export const normaliseDocNumber = (value: string) => value.replace(/[\s-]/g, '').toUpperCase()
export const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/

export function maskDocNumber(type: 'aadhaar' | 'pan', normalised: string): string {
  if (type === 'aadhaar') return `XXXX XXXX ${normalised.slice(-4)}`
  return `${normalised[0]}XXXXX${normalised.slice(-4)}`
}
