import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import { env } from '../config/env.js'
import type { DB } from './types.js'

export const pool = new Pool({
  host: env.DB_HOST,
  port: env.DB_PORT,
  database: env.DB_DATABASE,
  user: env.DB_USERNAME,
  password: env.DB_PASSWORD,
})

export const db = new Kysely<DB>({
  dialect: new PostgresDialect({ pool }),
})
