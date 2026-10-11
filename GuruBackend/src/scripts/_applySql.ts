import { readFileSync } from 'node:fs'
import pg from 'pg'
import { env } from '../config/env.js'
const client = new pg.Client({ host: env.DB_HOST, port: env.DB_PORT, user: env.DB_USERNAME, password: env.DB_PASSWORD, database: env.DB_DATABASE })
await client.connect()
for (const f of process.argv.slice(2)) { await client.query(readFileSync(f, 'utf8')); console.log('applied', f, 'to', env.DB_DATABASE) }
await client.end()
