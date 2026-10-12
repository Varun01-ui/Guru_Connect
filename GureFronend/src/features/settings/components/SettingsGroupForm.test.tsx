import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../../lib/api'
import { saveSettings } from '../api/settings.api'
import { androidLatest, androidMin, domains, maintenance, supportEmail, supportPhone } from '../testData'
import { SettingsGroupForm } from './SettingsGroupForm'

vi.mock('../api/settings.api')
// The history drawer has its own tests; here it only needs to exist.
vi.mock('./SettingHistoryDrawer', () => ({ SettingHistoryDrawer: ({ settingKey }: { settingKey: string }) => <div>history for {settingKey}</div> }))

const onSaved = vi.fn()
const onReload = vi.fn()

function show(group: string, settings = [supportEmail, supportPhone], props: Partial<Parameters<typeof SettingsGroupForm>[0]> = {}) {
  render(<SettingsGroupForm group={group} settings={settings} canEdit onSaved={onSaved} onReload={onReload} {...props} />)
}
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
const savedGroup = { updated: 1, group: { group: 'contact', settings: [supportEmail, supportPhone] } }

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(saveSettings).mockResolvedValue(savedGroup)
})

describe('SettingsGroupForm', () => {
  it('shows a field per setting and no save bar until something changes', () => {
    show('contact')
    expect(screen.getByLabelText('Support email')).toHaveValue('support@guruconnect.in')
    expect(screen.getByLabelText('Support phone')).toHaveValue('+918047182200')
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull()
  })

  it('sends only the changed keys, with the newest updatedAt among them as the version', async () => {
    show('contact')
    type('Support phone', '+919876543210')
    expect(screen.getByText('1 unsaved change')).toBeInTheDocument()
    save()
    await waitFor(() => expect(saveSettings).toHaveBeenCalled())
    expect(saveSettings).toHaveBeenCalledWith({ group: 'contact', values: { 'contact.support_phone': '+919876543210' } }, supportPhone.updatedAt)
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(savedGroup.group))
    // The bar goes away once saved.
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull()
  })

  it('sends several changes together', async () => {
    show('contact')
    type('Support email', 'help@guruconnect.in')
    type('Support phone', '+919876543210')
    expect(screen.getByText('2 unsaved changes')).toBeInTheDocument()
    save()
    await waitFor(() => expect(saveSettings).toHaveBeenCalled())
    const [body, version] = vi.mocked(saveSettings).mock.calls[0]!
    expect(body.values).toEqual({ 'contact.support_email': 'help@guruconnect.in', 'contact.support_phone': '+919876543210' })
    expect(version).toBe(supportPhone.updatedAt) // the later of the two
  })

  it('treats typing the original value back as no change', () => {
    show('contact')
    type('Support email', 'x@y.co')
    type('Support email', 'support@guruconnect.in')
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull()
  })

  it('shows a mistake next to the field and sends nothing', async () => {
    show('contact')
    type('Support email', 'not-an-email')
    save()
    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument()
    expect(saveSettings).not.toHaveBeenCalled()
  })

  it('discards the edits', () => {
    show('contact')
    type('Support email', 'other@guruconnect.in')
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(screen.getByLabelText('Support email')).toHaveValue('support@guruconnect.in')
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull()
  })

  it('asks for a reason when an app.* setting changed, and sends it', async () => {
    show('app_versions', [androidLatest, androidMin])
    type('Latest Android version', '1.3.0')
    save()
    expect(await screen.findByText('Add a reason for this change.')).toBeInTheDocument()
    expect(saveSettings).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Reason for this change'), { target: { value: 'Security fix in 1.3.0' } })
    save()
    await waitFor(() => expect(saveSettings).toHaveBeenCalled())
    expect(saveSettings).toHaveBeenCalledWith({ group: 'app_versions', values: { 'app.android_latest_version': '1.3.0' }, reason: 'Security fix in 1.3.0' }, androidLatest.updatedAt)
  })

  it('does not ask for a reason on ordinary settings', () => {
    show('contact')
    type('Support email', 'help@guruconnect.in')
    expect(screen.queryByLabelText('Reason for this change')).toBeNull()
  })

  it('turns maintenance mode on only after the typed confirmation, and tells the server it was confirmed', async () => {
    show('app_versions', [maintenance])
    fireEvent.click(screen.getByRole('switch', { name: 'Maintenance mode' }))
    fireEvent.change(screen.getByLabelText('Type MAINTENANCE to confirm'), { target: { value: 'MAINTENANCE' } })
    fireEvent.click(screen.getByRole('button', { name: 'Switch on' }))
    expect(screen.getByRole('switch', { name: 'Maintenance mode' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.change(screen.getByLabelText('Reason for this change'), { target: { value: 'Database migration' } })
    save()
    await waitFor(() => expect(saveSettings).toHaveBeenCalled())
    expect(saveSettings).toHaveBeenCalledWith({ group: 'app_versions', values: { 'app.maintenance_mode': true }, reason: 'Database migration', confirmMaintenance: true }, maintenance.updatedAt)
  })

  it('maps the server’s field errors onto the fields', async () => {
    vi.mocked(saveSettings).mockRejectedValue(new ApiError(422, 'VALIDATION_FAILED', "Minimum version can't be higher than the latest version.", [{ path: 'app.android_min_version', message: "Minimum version can't be higher than the latest version." }]))
    show('app_versions', [androidLatest, androidMin])
    type('Minimum Android version', '9.0.0')
    fireEvent.change(screen.getByLabelText('Reason for this change'), { target: { value: 'Force update' } })
    save()
    expect(await screen.findByText("Minimum version can't be higher than the latest version.")).toBeInTheDocument()
    // Fixing the field clears its error.
    type('Minimum Android version', '1.0.0')
    expect(screen.queryByText("Minimum version can't be higher than the latest version.")).toBeNull()
  })

  it('offers to reload when the settings changed in the meantime', async () => {
    vi.mocked(saveSettings).mockRejectedValue(new ApiError(409, 'VERSION_CONFLICT', 'Settings changed since you opened this page. Reload.'))
    show('contact')
    type('Support email', 'help@guruconnect.in')
    save()
    expect(await screen.findByText('Settings changed since you opened this page. Reload.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reload latest' }))
    expect(onReload).toHaveBeenCalled()
  })

  it('shows any other failure above the buttons and keeps the edits', async () => {
    vi.mocked(saveSettings).mockRejectedValue(new ApiError(409, 'CONFLICT_STATE', 'This setting is managed by deployments.'))
    show('contact')
    type('Support email', 'help@guruconnect.in')
    save()
    expect(await screen.findByText('This setting is managed by deployments.')).toBeInTheDocument()
    expect(screen.getByLabelText('Support email')).toHaveValue('help@guruconnect.in')
  })

  it('does not offer to save half-typed JSON, and saves once it parses', async () => {
    vi.mocked(saveSettings).mockResolvedValue({ updated: 1, group: { group: 'limits', settings: [domains] } })
    show('limits', [domains])
    type('Allowed banner link domains', '["a.in",')
    expect(await screen.findByText('Enter valid JSON.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull()
    type('Allowed banner link domains', '["a.in","b.in"]')
    expect(screen.queryByText('Enter valid JSON.')).toBeNull()
    save()
    await waitFor(() => expect(saveSettings).toHaveBeenCalled())
    expect(vi.mocked(saveSettings).mock.calls[0]![0].values).toEqual({ 'banners.allowed_domains': ['a.in', 'b.in'] })
  })

  it('is read-only for someone who cannot edit', () => {
    show('contact', [supportEmail], { canEdit: false })
    expect(screen.getByLabelText('Support email')).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull()
  })

  it('filters by label or key but keeps edits to hidden fields', () => {
    const { rerender } = render(<SettingsGroupForm group="contact" settings={[supportEmail, supportPhone]} canEdit filter="" onSaved={onSaved} onReload={onReload} />)
    fireEvent.change(screen.getByLabelText('Support email'), { target: { value: 'help@guruconnect.in' } })
    rerender(<SettingsGroupForm group="contact" settings={[supportEmail, supportPhone]} canEdit filter="phone" onSaved={onSaved} onReload={onReload} />)
    expect(screen.queryByLabelText('Support email')).toBeNull()
    expect(screen.getByLabelText('Support phone')).toBeInTheDocument()
    expect(screen.getByText('1 unsaved change')).toBeInTheDocument()
    rerender(<SettingsGroupForm group="contact" settings={[supportEmail, supportPhone]} canEdit filter="nothing like this" onSaved={onSaved} onReload={onReload} />)
    expect(screen.getByText('No settings match your search.')).toBeInTheDocument()
  })

  it('opens the history of one setting', () => {
    show('contact')
    fireEvent.click(screen.getByRole('button', { name: 'History for Support email' }))
    expect(screen.getByText('history for contact.support_email')).toBeInTheDocument()
  })
})
