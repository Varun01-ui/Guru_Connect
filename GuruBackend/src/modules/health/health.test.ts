import request from 'supertest'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp } from '../../app.js'
import { pool } from '../../db/index.js'

const app = createApp()

describe('GET /health', () => {
  afterAll(async () => {
    await pool.end()
  })

  it('reports ok when the database is reachable', async () => {
    const res = await request(app).get('/health')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ data: { status: 'ok' } })
  })
})
