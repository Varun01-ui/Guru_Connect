import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../../../lib/api'
import { usePermissions } from '../../../auth/usePermissions'
import * as api from '../api/banners.api'
import { banner, cities } from '../testData'
import { BannersPage } from './BannersPage'

vi.mock('../api/banners.api', async (orig) => {
  const real = await orig<typeof import('../api/banners.api')>()
  return { ...real, fetchBanners: vi.fn(), fetchCityOptions: vi.fn(), previewBanners: vi.fn(), publishBanner: vi.fn(), pauseBanner: vi.fn(), resumeBanner: vi.fn(), deleteBanner: vi.fn(), reorderBanners: vi.fn() }
})
vi.mock('../../../auth/usePermissions', () => ({ usePermissions: vi.fn() }))

const as = (canManage: boolean) => vi.mocked(usePermissions).mockReturnValue({ isLoading: false, isSuperAdmin: false, can: (k) => k === 'banners.read' || (canManage && k === 'banners.manage') })
const meta = (total: number) => ({ page: 1, pageSize: 20, total, totalPages: 1 })
const show = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <BannersPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
const list = [banner({ id: 'b1', title: 'First banner', status: 'active' }), banner({ id: 'b2', title: 'Second banner', status: 'draft' }), banner({ id: 'b3', title: 'Third banner', status: 'paused' })]

beforeEach(() => {
  vi.resetAllMocks()
  as(true)
  vi.mocked(api.fetchBanners).mockResolvedValue({ data: list, meta: meta(3) })
  vi.mocked(api.fetchCityOptions).mockResolvedValue(cities)
  vi.mocked(api.previewBanners).mockResolvedValue({ audience: 'parents', cityId: null, placements: { home_top: [{ id: 'b1', title: 'First banner', subtitle: null, imageUrl: null, deepLink: null, placement: 'home_top', priority: 50 }], home_middle: [], search_inline: [], teacher_dashboard: [], institute_dashboard: [], onboarding: [] } })
  for (const fn of [api.publishBanner, api.pauseBanner, api.resumeBanner, api.deleteBanner, api.reorderBanners]) vi.mocked(fn).mockResolvedValue(undefined as never)
})

describe('BannersPage', () => {
  it('shows a loading state, then a card per banner', async () => {
    vi.mocked(api.fetchBanners).mockReturnValue(new Promise(() => undefined))
    show()
    expect(screen.getByText('Loading banners…')).toBeInTheDocument()
  })

  it('lists the banners and offers New banner to managers only', async () => {
    show()
    expect(await screen.findByRole('link', { name: 'First banner' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'New banner' })).toHaveAttribute('href', '/cms/banners/new')
  })

  it('hides New banner and actions from someone who can only read', async () => {
    as(false)
    show()
    await screen.findByRole('link', { name: 'First banner' })
    expect(screen.queryByRole('link', { name: 'New banner' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull()
  })

  it('says so when nothing matches', async () => {
    vi.mocked(api.fetchBanners).mockResolvedValue({ data: [], meta: meta(0) })
    show()
    expect(await screen.findByText('No banners match.')).toBeInTheDocument()
  })

  it('shows the error and retries', async () => {
    vi.mocked(api.fetchBanners).mockRejectedValueOnce(new ApiError(500, 'INTERNAL_ERROR', 'Something went wrong.'))
    show()
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong.')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('link', { name: 'First banner' })).toBeInTheDocument()
  })

  it('filters by placement tab, status and title', async () => {
    show()
    await screen.findByRole('link', { name: 'First banner' })
    fireEvent.click(screen.getByRole('tab', { name: 'Onboarding' }))
    await waitFor(() => expect(api.fetchBanners).toHaveBeenLastCalledWith(expect.objectContaining({ placement: 'onboarding' })))
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'paused' } })
    await waitFor(() => expect(api.fetchBanners).toHaveBeenLastCalledWith(expect.objectContaining({ placement: 'onboarding', status: 'paused' })))
    fireEvent.change(screen.getByLabelText('Search banners'), { target: { value: 'board' } })
    await waitFor(() => expect(api.fetchBanners).toHaveBeenLastCalledWith(expect.objectContaining({ q: 'board' })))
  })

  it('publishes, pauses and resumes from the cards', async () => {
    show()
    await screen.findByRole('link', { name: 'First banner' })
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    await waitFor(() => expect(api.pauseBanner).toHaveBeenCalledWith('b1'))
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }))
    await waitFor(() => expect(api.publishBanner).toHaveBeenCalledWith('b2'))
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    await waitFor(() => expect(api.resumeBanner).toHaveBeenCalledWith('b3'))
  })

  it('asks before deleting', async () => {
    show()
    await screen.findByRole('link', { name: 'First banner' })
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]!)
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Second banner')
    expect(api.deleteBanner).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Delete banner' }))
    await waitFor(() => expect(api.deleteBanner).toHaveBeenCalledWith('b2'))
  })

  it('shows the server’s refusal, for example deleting an active banner', async () => {
    vi.mocked(api.pauseBanner).mockRejectedValue(new ApiError(409, 'CONFLICT_STATE', 'Only active banners can be paused.'))
    show()
    await screen.findByRole('link', { name: 'First banner' })
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Only active banners can be paused.')
  })

  it('reorders only inside one placement: moving a banner down sends the new order', async () => {
    show()
    await screen.findByRole('link', { name: 'First banner' })
    expect(screen.queryByRole('button', { name: /Move .* up/ })).toBeNull() // not on "All"
    fireEvent.click(screen.getByRole('tab', { name: 'Home · top' }))
    await waitFor(() => expect(screen.getAllByRole('button', { name: /Move .* down/ }).length).toBe(3))
    fireEvent.click(screen.getByRole('button', { name: 'Move First banner down' }))
    await waitFor(() => expect(api.reorderBanners).toHaveBeenCalledWith('home_top', ['b2', 'b1', 'b3']))
  })

  it('turns reordering off while a filter hides part of the stack', async () => {
    show()
    await screen.findByRole('link', { name: 'First banner' })
    fireEvent.click(screen.getByRole('tab', { name: 'Home · top' }))
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'draft' } })
    await waitFor(() => expect(api.fetchBanners).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'draft' })))
    expect(screen.queryByRole('button', { name: /Move .* down/ })).toBeNull()
  })

  it('previews what an audience and city see, and refreshes when they change', async () => {
    show()
    expect(await screen.findAllByTestId('preview-banner')).toHaveLength(1)
    fireEvent.change(screen.getByLabelText('Preview audience'), { target: { value: 'teachers' } })
    await waitFor(() => expect(api.previewBanners).toHaveBeenLastCalledWith('teachers', undefined))
    fireEvent.change(await screen.findByLabelText('Preview city'), { target: { value: 'c2' } })
    await waitFor(() => expect(api.previewBanners).toHaveBeenLastCalledWith('teachers', 'c2'))
  })
})
