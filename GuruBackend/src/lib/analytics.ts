// Analytics events are event-name-only (no PII). There is no analytics pipeline yet, so this is the single seam
// to wire one into; until then events are dropped.
export function trackEvent(_name: string, _props?: Record<string, string | number | boolean>): void {}
