import { z } from 'zod'

export const INSTITUTE_TYPES = ['coaching_centre', 'tuition_centre', 'school', 'music_school', 'coding_academy', 'language_institute', 'sports_academy', 'other'] as const

const uuid = z.string().uuid()
const mobile = z.string().trim().regex(/^\+91[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number.')

const nameField = z
  .string()
  .trim()
  .min(3, "Enter your institute's name (3–120 characters).")
  .max(120, "Enter your institute's name (3–120 characters).")
  .regex(/^[\p{L}\p{N} .,&'()\-/]+$/u, "Enter your institute's name (3–120 characters).")
  .refine((v) => !/^\d+$/.test(v), "Enter your institute's name (3–120 characters).")

const ownerNameField = z
  .string()
  .trim()
  .min(2, "Enter the owner's full name.")
  .max(100, "Enter the owner's full name.")
  .regex(/^[\p{L} .'-]+$/u, "Enter the owner's full name.")

const instituteFields = {
  name: nameField,
  instituteType: z.enum(INSTITUTE_TYPES, { errorMap: () => ({ message: 'Choose the type of institute.' }) }),
  email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(254, 'Enter a valid email address.'),
  // Normalised and checked in the service (the state check needs the chosen city); empty means "none".
  gstin: z.string().max(40, 'Enter a valid 15-character GSTIN.'),
  addressLine: z.string().trim().min(5, 'Enter the full address (at least 5 characters).').max(200, 'Enter the full address (at least 5 characters).'),
  cityId: z.string().uuid('Choose your city.'),
  areaId: z.string().uuid('Choose your area.'),
  pincode: z.string().trim().regex(/^[1-9][0-9]{5}$/, 'Enter a 6-digit PIN code.'),
  latitude: z.number({ invalid_type_error: "Set your institute's location on the map.", required_error: "Set your institute's location on the map." }).min(-90).max(90),
  longitude: z.number({ invalid_type_error: "Set your institute's location on the map.", required_error: "Set your institute's location on the map." }).min(-180).max(180),
}

const consents = z.object({
  terms: z.literal(true, { errorMap: () => ({ message: 'Please accept the Terms and Privacy Policy.' }) }),
  privacy: z.literal(true, { errorMap: () => ({ message: 'Please accept the Terms and Privacy Policy.' }) }),
  documentVersion: z.string().trim().min(1, 'Please accept the Terms and Privacy Policy.').max(40),
})

export const registerOwnerSchema = z.object({
  mode: z.literal('owner'),
  institute: z.object({
    name: instituteFields.name,
    instituteType: instituteFields.instituteType,
    email: instituteFields.email.nullish(),
    gstin: instituteFields.gstin.nullish(),
    addressLine: instituteFields.addressLine,
    cityId: instituteFields.cityId,
    areaId: instituteFields.areaId,
    pincode: instituteFields.pincode,
    latitude: instituteFields.latitude,
    longitude: instituteFields.longitude,
  }),
  owner: z.object({ fullName: ownerNameField, mobile }),
  consents,
  referralCode: z
    .string()
    .regex(/^[A-Za-z0-9]{4,20}$/, "This referral code isn't valid.")
    .transform((v) => v.toUpperCase())
    .nullish(),
})

export const registerJoinSchema = z.object({
  mode: z.literal('join'),
  inviteId: z.string().uuid('This invite is no longer valid.'),
  fullName: z.string().trim().min(2, 'Enter your full name.').max(100, 'Enter your full name.').regex(/^[\p{L} .'-]+$/u, 'Enter your full name.'),
  consents,
})

export const registerInstituteSchema = z.discriminatedUnion('mode', [registerOwnerSchema, registerJoinSchema])

export const basicsPatchSchema = z
  .object({
    name: instituteFields.name,
    instituteType: instituteFields.instituteType,
    ownerName: ownerNameField,
    email: instituteFields.email.nullable(),
    gstin: instituteFields.gstin.nullable(),
    addressLine: instituteFields.addressLine,
    cityId: instituteFields.cityId,
    areaId: instituteFields.areaId,
    pincode: instituteFields.pincode,
    latitude: instituteFields.latitude,
    longitude: instituteFields.longitude,
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Send at least one field.')
