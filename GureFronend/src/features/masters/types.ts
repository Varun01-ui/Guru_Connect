import type { ReactNode } from 'react'
import type { FieldValues } from 'react-hook-form'
import type { ZodType } from 'zod'

export type MasterRow = {
  id: string
  name: string
  isActive: boolean
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

/** A column key the API accepts in `?sort=<key>:asc|desc`. */
export type SortKey = string

export type SelectOption = { value: string; label: string }

export type MasterField = {
  name: string
  label: string
  kind: 'text' | 'textarea' | 'number' | 'switch' | 'select'
  hint?: string
  placeholder?: string
  maxLength?: number
  /** Fixed choices for a select. */
  options?: SelectOption[]
  /** API path of another master whose active rows (`?active=true&fields=id,name`) fill a select, e.g. '/countries'. */
  optionsFrom?: string
  /** Fixed once the row exists (stable codes the apps key on): shown, but not editable. */
  immutable?: boolean
  /** Only shown while another field has this value (e.g. the state of a board is only asked for state boards). */
  showWhen?: { field: string; equals: string }
  /** What to say when the field is locked on this row (default: it can't be changed after creation). */
  lockedHint?: string
}

export type MasterFilter = {
  /** Query-string parameter, e.g. 'stage'. */
  param: string
  label: string
  allLabel?: string
  options?: SelectOption[]
  optionsFrom?: string
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
  /** Dropdown filters shown next to the search box (stage, country, type ...). */
  filters?: MasterFilter[]
  /** How many live records use this row, and the words for the "Used by" badge. */
  usage: (row: Row) => { count: number; label: string }
  /** API table name -> words for the "in use" dialog, e.g. { states: 'states' }. */
  referenceNames: Record<string, string>
  /** For a select whose current value may be missing from the active options (e.g. an inactive parent). */
  selectedOption?: (row: Row, field: string) => SelectOption | null
  /** Per-row restrictions the API also enforces; the UI just avoids offering what would be refused. */
  rowRules?: {
    canToggle?: (row: Row) => boolean
    canDelete?: (row: Row) => boolean
    /** Field names that cannot be edited on this row. */
    lockedFields?: (row: Row) => string[]
  }
  /**
   * Runs just before a save: return a sentence to make the admin confirm first (e.g. the counts behind "mark as a launch
   * city"), or null to save at once. `payload` is the whole body for a create and only the changed fields for an edit.
   */
  confirmSave?: (args: { row: Row | null; payload: Record<string, unknown> }) => Promise<string | null>
  /** Returns a sentence when switching this row off needs confirming first (e.g. how many teachers it affects). */
  confirmDeactivate?: (row: Row) => string | null
  /** Enables a "Reorder" dialog backed by PUT <apiPath>/order. `sort` is the list order that shows the current sequence. */
  reorder?: { sort: SortKey; warning?: string }
  /** Enables a CSV import dialog backed by POST <apiPath>/import. `allowSkipInvalid` adds a "skip invalid rows" tick. */
  importCsv?: { columns: string; example: string; allowSkipInvalid?: boolean }
  /**
   * Enables a "Merge" row action backed by POST <apiPath>/<id>/merge. `targetKey` is the body field that names the row to
   * merge into; `scope` limits the choices (areas can only merge within their city).
   */
  merge?: { targetKey: string; scope?: (row: Row) => Record<string, string>; warning: string }
}
