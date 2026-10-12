import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../../../lib/api'
import { uploadAdminFile } from '../../../../lib/adminUpload'
import { fetchCityOptions } from '../api/banners.api'
import { emptyForm } from '../form'
import { cities } from '../testData'
import { BannerForm } from './BannerForm'

vi.mock('../api/banners.api', async (orig) => ({ ...(await orig<typeof import('../api/banners.api')>()), fetchCityOptions: vi.fn() }))
vi.mock('../../../../lib/adminUpload')

const onChange = vi.fn()
const show = (over = {}, errors: Record<string, string> = {}, disabled = false) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <BannerForm values={{ ...emptyForm(), ...over }} errors={errors} disabled={disabled} onChange={onChange} />
    </QueryClientProvider>,
  )
const png = (size = 100) => new File([new Uint8Array(size)], 'b.png', { type: 'image/png' })
const choose = (file: File) => fireEvent.change(screen.getByLabelText('Choose banner image'), { target: { files: [file] } })

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(fetchCityOptions).mockResolvedValue(cities)
  vi.mocked(uploadAdminFile).mockResolvedValue({ fileId: 'f9', status: 'active', publicUrl: 'https://cdn.test/banners/f9.png' })
})
afterEach(() => vi.unstubAllGlobals())

describe('BannerForm', () => {
  it('reports typed fields', () => {
    show()
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Board exams' } })
    expect(onChange).toHaveBeenLastCalledWith({ title: 'Board exams' })
    fireEvent.change(screen.getByLabelText('Where it shows'), { target: { value: 'onboarding' } })
    expect(onChange).toHaveBeenLastCalledWith({ placement: 'onboarding' })
    fireEvent.change(screen.getByLabelText('Who sees it'), { target: { value: 'teachers' } })
    expect(onChange).toHaveBeenLastCalledWith({ audience: 'teachers' })
    fireEvent.change(screen.getByLabelText('Priority (0–100)'), { target: { value: '70' } })
    expect(onChange).toHaveBeenLastCalledWith({ priority: 70 })
  })

  it('shows errors under their fields', () => {
    show({}, { title: 'Title must be 3–60 characters.', endsAt: 'The end must be after the start.' })
    expect(screen.getByText('Title must be 3–60 characters.')).toBeInTheDocument()
    expect(screen.getByLabelText('Title')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText('The end must be after the start.')).toBeInTheDocument()
  })

  it('lists the cities, picks and unpicks, and says none means all', async () => {
    show({ cityIds: ['c1'] })
    expect(await screen.findByRole('checkbox', { name: 'Bengaluru' })).toBeChecked()
    expect(screen.getByText('(1 picked)')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Mumbai' }))
    expect(onChange).toHaveBeenLastCalledWith({ cityIds: ['c1', 'c2'] })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Bengaluru' }))
    expect(onChange).toHaveBeenLastCalledWith({ cityIds: [] })
  })

  it('says "all cities" when none are picked, and filters the list', async () => {
    show()
    expect(await screen.findByRole('checkbox', { name: 'Mumbai' })).toBeInTheDocument()
    expect(screen.getByText('(none picked = all cities)')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Filter cities'), { target: { value: 'mum' } })
    expect(screen.queryByRole('checkbox', { name: 'Bengaluru' })).toBeNull()
  })

  it('shows when the cities cannot be loaded', async () => {
    vi.mocked(fetchCityOptions).mockRejectedValue(new ApiError(500, 'INTERNAL_ERROR', 'x'))
    show()
    expect(await screen.findByText('Could not load the cities.')).toBeInTheDocument()
  })

  it('uploads a chosen image and hands back its id and url', async () => {
    show()
    choose(png())
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ imageFileId: 'f9', imageUrl: 'https://cdn.test/banners/f9.png' }))
    expect(uploadAdminFile).toHaveBeenCalledWith(expect.any(File), 'banner_image')
  })

  it('rejects the wrong type and anything over 500 KB without uploading', async () => {
    show()
    choose(new File(['x'], 'a.gif', { type: 'image/gif' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Upload a JPG, PNG or WebP image.')
    choose(png(500 * 1024 + 1))
    expect(await screen.findByText('Banner images can be up to 500 KB.')).toBeInTheDocument()
    expect(uploadAdminFile).not.toHaveBeenCalled()
  })

  it('rejects an image that is not 1080 × 480 before uploading it', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 800, height: 400 }))
    show()
    choose(png())
    expect(await screen.findByText('Banner images must be 1080 × 480 px.')).toBeInTheDocument()
    expect(uploadAdminFile).not.toHaveBeenCalled()
  })

  it('accepts 1080 × 480 and the ±2 px tolerance', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 1082, height: 478 }))
    show()
    choose(png())
    await waitFor(() => expect(uploadAdminFile).toHaveBeenCalled())
  })

  it('shows the upload error', async () => {
    vi.mocked(uploadAdminFile).mockRejectedValue(new ApiError(422, 'VALIDATION_FAILED', 'Banner images must be 1080 × 480 px.'))
    show()
    choose(png())
    expect(await screen.findByRole('alert')).toHaveTextContent('Banner images must be 1080 × 480 px.')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('shows the current image and "Replace image"', () => {
    show({ imageFileId: 'f1', imageUrl: 'https://cdn.test/banners/f1.png' })
    expect(screen.getByRole('img', { name: 'Banner artwork' })).toHaveAttribute('src', 'https://cdn.test/banners/f1.png')
    expect(screen.getByRole('button', { name: 'Replace image' })).toBeInTheDocument()
  })

  it('disables everything when read-only', () => {
    show({}, {}, true)
    expect(screen.getByLabelText('Title')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Upload image' })).toBeDisabled()
  })
})
