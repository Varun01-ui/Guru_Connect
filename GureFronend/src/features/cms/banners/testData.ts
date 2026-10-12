import type { Banner } from './api/banners.api'

export const banner = (over: Partial<Banner> = {}): Banner => ({
  id: 'b1',
  status: 'draft',
  title: 'Board exams in 90 days',
  subtitle: 'Book a free demo',
  image: { fileId: 'f1', url: 'https://cdn.test/banners/b1.png' },
  placement: 'home_top',
  audience: 'parents',
  cities: [{ id: 'c1', name: 'Bengaluru' }],
  deepLink: 'gc://plans',
  priority: 50,
  startsAt: '2027-01-01T00:00:00.000Z',
  endsAt: '2027-01-31T00:00:00.000Z',
  impressions: 200,
  clicks: 50,
  ctrPct: 25,
  createdAt: '2026-12-01T00:00:00.000Z',
  updatedAt: '2026-12-02T00:00:00.000Z',
  ...over,
})

export const cities = [
  { id: 'c1', name: 'Bengaluru' },
  { id: 'c2', name: 'Mumbai' },
]
