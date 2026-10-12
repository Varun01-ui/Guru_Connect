import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../../../lib/api'
import { usePermissions } from '../../../auth/usePermissions'
import * as api from '../api/banners.api'
import { banner } from '../testData'
import { BannerEditorPage } from './BannerEditorPage'

vi.mock('../api/banners.api', async (orig) => {
  const real = await orig<typeof import('../api/banners.api')>()
  return { ...real, fetchBanner: vi.fn(), createBanner: vi.fn(), patchBanner: vi.fn(), publishBanner: vi.fn(), pauseBanner: vi.fn(), resumeBanner: vi.fn(), deleteBanner: vi.fn() }
})
// The form has its own tests; here it is a stand-in that lets a test change the values directly.
vi.mock('../components/BannerForm', () => ({
  BannerForm: ({ values, errors, disabled, onChange }: { values: { title: string; imageFileId: string }; errors: Record<string, string>; disabled?: boolean; onChange: (p: object) => void }) => (
    <div>
      <label>
        Title
        <input value={values.title} disabled={disabled} onChange={(e) => onChange({ title: e.target.value })} />
      </label>
      <button type="button" onClick={() => onChange({ imageFileId: 'f1', imageUrl: 'https://cdn.test/f1.png' })}>
        attach image
      </button>
      {Object.entries(errors).map(([k, v]) => (
        <p key={k} role="alert">{`${k}: ${v}`}</p>
      ))}
    </div>
  ),
}))
vi.mock('../../../auth/usePermissions', () => ({ usePermissions: vi.fn() }))

const as = (canManage: boolean) => vi.mocked(usePermissions).mockReturnValue({ isLoading: false, isSuperAdmin: false, can: (k) => k === 'banners.read' || (canManage && k === 'banners.manage') })
const show = (path: string) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/cms/banners" element={<p>banner list</p>} />
          <Route path="/cms/banners/new" element={<BannerEditorPage />} />
          <Route path="/cms/banners/:id" element={<BannerEditorPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
const title = () => screen.getByLabelText('Title') as HTMLInputElement
const type = (value: string) => fireEvent.change(title(), { target: { value } })

beforeEach(() => {
  vi.resetAllMocks()
  as(true)
})

describe('BannerEditorPage · new', () => {
  it('starts empty and cannot be saved without a title and an image', async () => {
    show('/cms/banners/new')
    expect(screen.getByRole('heading', { name: 'New banner' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }))
    expect(await screen.findByText('title: Title must be 3–60 characters.')).toBeInTheDocument()
    expect(screen.getByText('imageFileId: Upload the banner image.')).toBeInTheDocument()
    expect(api.createBanner).not.toHaveBeenCalled()
  })

  it('creates the draft and moves to its page', async () => {
    vi.mocked(api.createBanner).mockResolvedValue(banner({ id: 'new1' }))
    vi.mocked(api.fetchBanner).mockResolvedValue(banner({ id: 'new1' }))
    show('/cms/banners/new')
    type('Board exams in 90 days')
    fireEvent.click(screen.getByRole('button', { name: 'attach image' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }))
    await waitFor(() => expect(api.createBanner).toHaveBeenCalledWith(expect.objectContaining({ title: 'Board exams in 90 days', imageFileId: 'f1', placement: 'home_top', audience: 'all', cityIds: [] })))
    expect(await screen.findByRole('heading', { name: 'Board exams in 90 days' })).toBeInTheDocument()
  })

  it('shows the server’s field errors', async () => {
    vi.mocked(api.createBanner).mockRejectedValue(new ApiError(422, 'VALIDATION_FAILED', 'Use an app link or an approved website.', [{ path: 'deepLink', message: 'Use an app link or an approved website.' }]))
    show('/cms/banners/new')
    type('Board exams in 90 days')
    fireEvent.click(screen.getByRole('button', { name: 'attach image' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }))
    expect(await screen.findByText('deepLink: Use an app link or an approved website.')).toBeInTheDocument()
  })

  it('has a live preview that follows the title', () => {
    show('/cms/banners/new')
    type('Diwali offer')
    expect(screen.getByLabelText('Live preview')).toHaveTextContent('Diwali offer')
  })
})

describe('BannerEditorPage · existing', () => {
  const open = async (b = banner()) => {
    vi.mocked(api.fetchBanner).mockResolvedValue(b)
    show(`/cms/banners/${b.id}`)
    await screen.findByRole('heading', { name: b.title })
  }

  it('shows a loading state and an error with a way back', async () => {
    vi.mocked(api.fetchBanner).mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'Banner not found.'))
    show('/cms/banners/zzz')
    expect(screen.getByText('Loading banner…')).toBeInTheDocument()
    expect(await screen.findByRole('alert')).toHaveTextContent('Banner not found.')
    expect(screen.getByRole('link', { name: 'Back to banners' })).toHaveAttribute('href', '/cms/banners')
  })

  it('loads the banner with its numbers', async () => {
    await open()
    expect(title()).toHaveValue('Board exams in 90 days')
    expect(screen.getByText('draft')).toBeInTheDocument()
    expect(screen.getByText('Impressions').nextSibling).toHaveTextContent('200')
    expect(screen.getByText('Click-through').nextSibling).toHaveTextContent('25%')
  })

  it('saves only what changed, with the banner’s version', async () => {
    vi.mocked(api.patchBanner).mockResolvedValue(banner({ title: 'Renamed banner', updatedAt: '2026-12-03T00:00:00.000Z' }))
    await open()
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled()
    type('Renamed banner')
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(api.patchBanner).toHaveBeenCalledWith('b1', { title: 'Renamed banner' }, '2026-12-02T00:00:00.000Z'))
    expect(await screen.findByRole('heading', { name: 'Renamed banner' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled()
  })

  it('offers to reload after an edit conflict', async () => {
    vi.mocked(api.patchBanner).mockRejectedValue(new ApiError(409, 'VERSION_CONFLICT', 'Someone else changed this banner. Reload.'))
    await open()
    type('Renamed banner')
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByText('Someone else changed this banner. Reload.')).toBeInTheDocument()
    vi.mocked(api.fetchBanner).mockResolvedValue(banner({ title: 'Changed elsewhere', updatedAt: '2026-12-05T00:00:00.000Z' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reload latest' }))
    await waitFor(() => expect(title()).toHaveValue('Changed elsewhere'))
  })

  it('publishes a saved draft', async () => {
    vi.mocked(api.publishBanner).mockResolvedValue(banner({ status: 'active' }))
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }))
    await waitFor(() => expect(api.publishBanner).toHaveBeenCalledWith('b1'))
    expect(await screen.findByText('active')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull()
  })

  it('makes you save pending edits before publishing', async () => {
    await open()
    type('Edited but unsaved')
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }))
    expect(await screen.findByText('Save your changes first.')).toBeInTheDocument()
    expect(api.publishBanner).not.toHaveBeenCalled()
  })

  it('pauses and resumes', async () => {
    vi.mocked(api.pauseBanner).mockResolvedValue(banner({ status: 'paused' }))
    vi.mocked(api.resumeBanner).mockResolvedValue(banner({ status: 'active' }))
    await open(banner({ status: 'active' }))
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Resume' }))
    await waitFor(() => expect(api.resumeBanner).toHaveBeenCalledWith('b1'))
  })

  it('shows the server’s refusal to publish', async () => {
    vi.mocked(api.publishBanner).mockRejectedValue(new ApiError(409, 'CONFLICT_STATE', "This banner's end date has passed."))
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }))
    expect(await screen.findByText("This banner's end date has passed.")).toBeInTheDocument()
  })

  it('deletes after confirmation and returns to the list', async () => {
    vi.mocked(api.deleteBanner).mockResolvedValue(undefined)
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete banner' }))
    await waitFor(() => expect(api.deleteBanner).toHaveBeenCalledWith('b1'))
    expect(await screen.findByText('banner list')).toBeInTheDocument()
  })

  it('is read-only for an expired banner', async () => {
    await open(banner({ status: 'expired' }))
    expect(title()).toBeDisabled()
    expect(screen.getByText(/This banner has ended/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull()
  })

  it('is read-only for someone who cannot manage banners', async () => {
    as(false)
    await open()
    expect(title()).toBeDisabled()
    expect(screen.getByText('You can view banners but not change them.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull()
  })
})
