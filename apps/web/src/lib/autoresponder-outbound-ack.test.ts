import { describe, expect, it } from 'vitest'
import { isValidOutboxId } from './autoresponder-outbound-ack'

describe('isValidOutboxId', () => {
  it('accepts a well-formed UUID', () => {
    expect(isValidOutboxId('11111111-2222-4333-8444-555555555555')).toBe(true)
  })

  it('accepts uppercase hex too', () => {
    expect(isValidOutboxId('11111111-2222-4333-8444-555555555555'.toUpperCase())).toBe(true)
  })

  it('rejects null/undefined', () => {
    expect(isValidOutboxId(null)).toBe(false)
    expect(isValidOutboxId(undefined)).toBe(false)
  })

  it('rejects an empty string', () => {
    expect(isValidOutboxId('')).toBe(false)
  })

  it('rejects a non-UUID string — must never reach a Postgres UUID-column query', () => {
    expect(isValidOutboxId('not-a-uuid')).toBe(false)
    expect(isValidOutboxId('12345')).toBe(false)
  })

  it('rejects a UUID missing a segment or with wrong segment lengths', () => {
    expect(isValidOutboxId('11111111-2222-4333-8444-55555555555')).toBe(false)  // one char short
    expect(isValidOutboxId('11111111-2222-4333-8444-5555555555555')).toBe(false) // one char long
    expect(isValidOutboxId('11111111-2222-4333-8444')).toBe(false)               // missing segment
  })
})
