import type { ReactNode } from 'react'
import type { FieldValues } from 'react-hook-form'
import type { ZodType } from 'zod'

export type MasterRow = {
  id: string
  name: string
  isActive: boolean
  sortOrder: number
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

export type SortKey = 'name' | 'sortOrder' | 'createdAt'

export type MasterField = {
  name: string
  label: string
  kind: 'text' | 'number' | 'switch'
  hint?: string
  placeholder?: string
  maxLength?: number
}

export type MasterColumn<Row> = {
  id: string
  header: string
  cell: (row: Row) => ReactNode
  sortKey?: SortKey
  align?: 'right'
}

// Everything a master-data page needs, declared once per module (spec section 14: MasterListPage + <module>.config.ts).
export type MasterConfig<Row extends MasterRow, Form extends FieldValues> = {
  /** react-query key prefix, also the cache bucket other screens invalidate. */
  key: string
  singular: string
  plural: string
  title: string
  description: string
  apiPath: string
  readPermission: string
  managePermission: string
  searchPlaceholder: string
  fields: MasterField[]
  schema: ZodType<Form>
  defaultValues: Form
  toFormValues: (row: Row) => Form
  toPayload: (values: Form) => Record<string, unknown>
  columns: MasterColumn<Row>[]
  /** How many live records use this row (what blocks a delete). */
  usageCount: (row: Row) => number
  usageLabel: (count: number) => string
  /** API table name -> words for the "in use" dialog, e.g. { states: 'states' }. */
  referenceNames: Record<string, string>
}
