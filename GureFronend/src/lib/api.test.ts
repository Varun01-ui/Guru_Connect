import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { authStore } from '../features/auth/authStore'
import { apiFetch, apiFetchPage, ApiError } from './api'

const admin = { id: '1', email: 'a@b.co', fullName: 'A B', isSuperAdmin: false, avatarUrl: null }

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  authStore.setSession('old-token', admin)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('apiFetch', () => {
  it('unwraps the data envelope and sends the bearer token', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: { hello: 'world' } }))
    await expect(apiFetch('/thing')).resolves.toEqual({ hello: 'world' })
    expect(fetchMock.mock.calls[0]![1].headers.Authorization).toBe('Bearer old-token')
  })

  it('returns undefined for a 204 response', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
    await expect(apiFetch('/thing', { method: 'DELETE' })).resolves.toBeUndefined()
  })

  it('throws an ApiError carrying the code, message and details', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(423, { error: { code: 'AUTH_ACCOUNT_LOCKED', message: 'Locked', details: { lockedUntil: 'x' }, requestId: 'r1' } }),
    )
    const err = await apiFetch('/thing').catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 423, code: 'AUTH_ACCOUNT_LOCKED', message: 'Locked', details: { lockedUntil: 'x' }, requestId: 'r1' })
  })

  it('refreshes once on AUTH_TOKEN_EXPIRED and retries with the new token', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { error: { code: 'AUTH_TOKEN_EXPIRED', message: 'expired' } }))
      .mockResolvedValueOnce(jsonResponse(200, { data: { accessToken: 'new-token', admin } }))
      .mockResolvedValueOnce(jsonResponse(200, { data: { ok: true } }))

    await expect(apiFetch('/thing')).resolves.toEqual({ ok: true })
    expect(fetchMock.mock.calls[1]![0]).toContain('/auth/refresh')
    expect(fetchMock.mock.calls[2]![1].headers.Authorization).toBe('Bearer new-token')
    expect(authStore.getState().status).toBe('authenticated')
  })

  it('marks the session expired when the refresh fails', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { error: { code: 'AUTH_TOKEN_EXPIRED', message: 'expired' } }))
      .mockResolvedValueOnce(jsonResponse(401, { error: { code: 'AUTH_REFRESH_INVALID', message: 'ended' } }))

    await expect(apiFetch('/thing')).rejects.toMatchObject({ code: 'AUTH_TOKEN_EXPIRED' })
    expect(authStore.getState().status).toBe('expired')
  })

  it('marks the session expired when the server says the session is gone (AUTH_REQUIRED)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { error: { code: 'AUTH_REQUIRED', message: 'Your session ended. Sign in again.' } }))
    await expect(apiFetch('/thing')).rejects.toMatchObject({ code: 'AUTH_REQUIRED' })
    expect(authStore.getState().status).toBe('expired')
  })

  it('does not treat a wrong-password login as an expired session', async () => {
    authStore.clear()
    fetchMock.mockResolvedValue(jsonResponse(401, { error: { code: 'AUTH_INVALID_CREDENTIALS', message: 'Email or password is incorrect.' } }))
    await expect(apiFetch('/auth/login', { method: 'POST' })).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' })
    expect(authStore.getState().status).toBe('anonymous')
  })
})

describe('apiFetchPage', () => {
  it('returns the rows together with the pagination meta', async () => {
    const meta = { page: 2, pageSize: 20, total: 45, totalPages: 3 }
    fetchMock.mockResolvedValue(jsonResponse(200, { data: [{ id: 'a' }], meta }))
    await expect(apiFetchPage('/countries?page=2')).resolves.toEqual({ data: [{ id: 'a' }], meta })
    expect(fetchMock.mock.calls[0]![1].headers.Authorization).toBe('Bearer old-token')
  })

  it('throws an ApiError on failure just like apiFetch', async () => {
    fetchMock.mockResolvedValue(jsonResponse(403, { error: { code: 'FORBIDDEN', message: 'No.' } }))
    const err = await apiFetchPage('/countries').catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 403, code: 'FORBIDDEN' })
  })
})
