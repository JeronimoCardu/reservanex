// Fase 1B §1/§2/§16 — this guard had no test file before. Verifies the
// updated EXPECTED_PROJECT_REF (the new Supabase project for this version)
// and that both historical projects are explicitly, individually rejected
// with a clear reason — not silently lumped into a generic "unexpected".
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { assertSafeSupabaseTarget } from './assert-safe-target'

function withSupabaseUrl(ref: string | undefined): void {
  if (ref === undefined) {
    delete process.env.SUPABASE_URL
    delete process.env.NEXT_PUBLIC_SUPABASE_URL
  } else {
    process.env.SUPABASE_URL = `https://${ref}.supabase.co`
  }
}

const ORIGINAL_SUPABASE_URL       = process.env.SUPABASE_URL
const ORIGINAL_NEXT_PUBLIC_URL    = process.env.NEXT_PUBLIC_SUPABASE_URL

beforeEach(() => {
  delete process.env.SUPABASE_URL
  delete process.env.NEXT_PUBLIC_SUPABASE_URL
})
afterEach(() => {
  if (ORIGINAL_SUPABASE_URL !== undefined) process.env.SUPABASE_URL = ORIGINAL_SUPABASE_URL
  if (ORIGINAL_NEXT_PUBLIC_URL !== undefined) process.env.NEXT_PUBLIC_SUPABASE_URL = ORIGINAL_NEXT_PUBLIC_URL
})

describe('assertSafeSupabaseTarget — Fase 1B: only the new project is accepted', () => {
  it('accepts the new Supabase project (tjqfysbcmpqlwmzdvynr) without throwing', () => {
    withSupabaseUrl('tjqfysbcmpqlwmzdvynr')
    expect(() => assertSafeSupabaseTarget()).not.toThrow()
  })

  it('rejects the ORIGINAL ReservaNex project with a specific, named reason', () => {
    withSupabaseUrl('veqkuriobordivdxvuhj')
    expect(() => assertSafeSupabaseTarget()).toThrow(/ORIGINAL de ReservaNex/)
  })

  it('rejects the previous AutoResponder+MacroDroid copy with a specific, named reason', () => {
    withSupabaseUrl('akvaswvkdqfguksinrwa')
    expect(() => assertSafeSupabaseTarget()).toThrow(/copia anterior AutoResponder \+ MacroDroid/)
  })

  it('rejects any other unrecognized project with a generic "unexpected" reason', () => {
    withSupabaseUrl('someotherrandomref12')
    expect(() => assertSafeSupabaseTarget()).toThrow(/proyecto inesperado/)
  })

  it('rejects a missing SUPABASE_URL entirely', () => {
    withSupabaseUrl(undefined)
    expect(() => assertSafeSupabaseTarget()).toThrow(/No se pudo determinar/)
  })

  it('never throws an error whose message contains a service-role key or any secret-shaped value', () => {
    withSupabaseUrl('akvaswvkdqfguksinrwa')
    try {
      assertSafeSupabaseTarget()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      expect(message).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/) // no JWT-shaped substring
    }
  })
})
