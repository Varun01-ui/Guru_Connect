import request from 'supertest'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp } from '../../../app.js'
import { pool } from '../../../db/index.js'

const app = createApp()

describe('GET /api/v1/app/bootstrap', () => {
  afterAll(async () => {
    await pool.end()
  })

  it('returns app/auth/legal config read from system_settings', async () => {
    const res = await request(app).get('/api/v1/app/bootstrap')

    expect(res.status).toBe(200)
    const { data } = res.body
    expect(data.app.minVersion).toBe('1.0.0')
    expect(data.auth.phoneOtp).toBe(true)
    expect(data.auth.otpResendAfterSeconds).toBe(30)
    expect(data.legal.termsUrl).toBe('https://guruconnect.in/terms')
    expect(data.maintenance.enabled).toBe(false)
    expect(typeof data.serverTime).toBe('string')
  })
})
