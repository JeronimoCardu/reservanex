// Fase 2B §22 — pure decision logic for the AI → HUMAN → AI window.
// No DB, no LLM, no wall clock (nowMs is always injected).

import { describe, expect, it, afterEach } from 'vitest'
import {
  decideHumanMode,
  parseHumanHandoffTimeoutMs,
  computeHumanUntilIso,
  getHumanHandoffTimeoutMs,
  HUMAN_HANDOFF_MESSAGE,
  DEFAULT_HUMAN_HANDOFF_TIMEOUT_MS,
  MIN_HUMAN_HANDOFF_TIMEOUT_MS,
  MAX_HUMAN_HANDOFF_TIMEOUT_MS,
  handoffModeForProvider,
} from './human-handoff'

const NOW = 1_800_000_000_000 // fixed instant; never Date.now()

describe('HUMAN_HANDOFF_MESSAGE (§7)', () => {
  it('is the exact contractual sentence, centralised in one place', () => {
    expect(HUMAN_HANDOFF_MESSAGE).toBe('Un asesor te contactará para brindarte una mejor atención.')
  })
})

describe('decideHumanMode (§4)', () => {
  it('autonomous → ai, regardless of any stale human_until', () => {
    expect(decideHumanMode({ ai_mode: 'autonomous', human_until: null }, NOW)).toEqual({ mode: 'ai' })
    expect(decideHumanMode({ ai_mode: 'autonomous', human_until: new Date(NOW + 60_000).toISOString() }, NOW))
      .toEqual({ mode: 'ai' })
  })

  it('manual WITHOUT human_until → manual_no_expiry (a human took it over from the CRM; never auto-reverts)', () => {
    expect(decideHumanMode({ ai_mode: 'manual', human_until: null }, NOW)).toEqual({ mode: 'manual_no_expiry' })
  })

  it('manual WITH a future human_until → human_active', () => {
    const until = new Date(NOW + 60_000).toISOString()
    expect(decideHumanMode({ ai_mode: 'manual', human_until: until }, NOW))
      .toEqual({ mode: 'human_active', humanUntilMs: new Date(until).getTime() })
  })

  it('manual WITH a past human_until → human_expired', () => {
    expect(decideHumanMode({ ai_mode: 'manual', human_until: new Date(NOW - 1).toISOString() }, NOW))
      .toEqual({ mode: 'human_expired' })
  })

  it('exactly at the boundary → expired (the window is closed at human_until)', () => {
    expect(decideHumanMode({ ai_mode: 'manual', human_until: new Date(NOW).toISOString() }, NOW))
      .toEqual({ mode: 'human_expired' })
  })

  it('assisted mode behaves like manual — anything non-autonomous is human attention', () => {
    expect(decideHumanMode({ ai_mode: 'assisted', human_until: new Date(NOW + 60_000).toISOString() }, NOW).mode)
      .toBe('human_active')
  })

  it('§8 fail-safe: an unparseable human_until stays HUMAN rather than handing back to the AI', () => {
    expect(decideHumanMode({ ai_mode: 'manual', human_until: 'not-a-timestamp' }, NOW).mode).toBe('human_active')
  })
})

describe('handoffModeForProvider — Meta must NOT inherit the sliding window', () => {
  it('AutoResponder → temporary (sliding window; the AI returns by timeout)', () => {
    expect(handoffModeForProvider('autoresponder')).toBe('temporary')
  })

  it('Meta → permanent (pre-Fase-2B semantics: manual until explicitly reactivated)', () => {
    expect(handoffModeForProvider('meta')).toBe('permanent')
  })

  it('a permanent handoff never auto-reverts: manual + human_until NULL stays human', () => {
    // This is the exact state a Meta handoff leaves behind. Even far in the
    // future it must never decide 'human_expired'.
    const metaState = { ai_mode: 'manual', human_until: null }
    expect(decideHumanMode(metaState, NOW).mode).toBe('manual_no_expiry')
    expect(decideHumanMode(metaState, NOW + 10 * 365 * 24 * 3_600_000).mode).toBe('manual_no_expiry')
  })
})

describe('timeout configuration (§5)', () => {
  afterEach(() => { delete process.env.HUMAN_HANDOFF_TIMEOUT_MS })

  it('defaults to exactly 1 hour', () => {
    expect(DEFAULT_HUMAN_HANDOFF_TIMEOUT_MS).toBe(3_600_000)
    expect(parseHumanHandoffTimeoutMs(undefined)).toBe(3_600_000)
    expect(parseHumanHandoffTimeoutMs('')).toBe(3_600_000)
  })

  it('accepts a valid override (so a physical test can use 10s instead of an hour)', () => {
    expect(parseHumanHandoffTimeoutMs('10000')).toBe(10_000)
  })

  it('falls back to the default for garbage, and for values outside the safe band', () => {
    expect(parseHumanHandoffTimeoutMs('abc')).toBe(DEFAULT_HUMAN_HANDOFF_TIMEOUT_MS)
    expect(parseHumanHandoffTimeoutMs(String(MIN_HUMAN_HANDOFF_TIMEOUT_MS - 1))).toBe(DEFAULT_HUMAN_HANDOFF_TIMEOUT_MS)
    expect(parseHumanHandoffTimeoutMs(String(MAX_HUMAN_HANDOFF_TIMEOUT_MS + 1))).toBe(DEFAULT_HUMAN_HANDOFF_TIMEOUT_MS)
  })

  it('reads the env lazily, so a test/script can set it after import', () => {
    process.env.HUMAN_HANDOFF_TIMEOUT_MS = '10000'
    expect(getHumanHandoffTimeoutMs()).toBe(10_000)
  })
})

describe('computeHumanUntilIso (§2 sliding window)', () => {
  it('is measured from the given instant, not from the handoff', () => {
    expect(computeHumanUntilIso(NOW, 3_600_000)).toBe(new Date(NOW + 3_600_000).toISOString())
  })

  it('each successive inbound pushes the expiry further out (14:00 → 14:20 → 14:47 example)', () => {
    const handoff = NOW                       // 14:00
    const msg1    = NOW + 20 * 60_000         // 14:20
    const msg2    = NOW + 47 * 60_000         // 14:47
    const hour    = 3_600_000

    const after0 = new Date(computeHumanUntilIso(handoff, hour)).getTime()
    const after1 = new Date(computeHumanUntilIso(msg1, hour)).getTime()
    const after2 = new Date(computeHumanUntilIso(msg2, hour)).getTime()

    expect(after0).toBe(handoff + hour)  // 15:00
    expect(after1).toBe(msg1 + hour)     // 15:20
    expect(after2).toBe(msg2 + hour)     // 15:47
    expect(after1).toBeGreaterThan(after0)
    expect(after2).toBeGreaterThan(after1)

    // And the window really is closed after that last expiry.
    expect(decideHumanMode({ ai_mode: 'manual', human_until: new Date(after2).toISOString() }, after2 + 1).mode)
      .toBe('human_expired')
  })
})
