import type { FieldErrors, FieldValues, Resolver } from 'react-hook-form'
import type { ZodType } from 'zod'

// react-hook-form resolver for a zod schema. The first issue per field wins, which is what a form shows.
export function zodResolver<T extends FieldValues>(schema: ZodType<T>): Resolver<T> {
  return async (values) => {
    const result = schema.safeParse(values)
    if (result.success) return { values: result.data, errors: {} }
    const errors: Record<string, { type: string; message: string }> = {}
    for (const issue of result.error.issues) {
      const path = issue.path.join('.')
      if (!(path in errors)) errors[path] = { type: issue.code, message: issue.message }
    }
    return { values: {}, errors: errors as FieldErrors<T> }
  }
}
