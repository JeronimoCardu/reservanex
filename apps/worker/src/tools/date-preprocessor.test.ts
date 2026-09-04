import { describe, expect, it } from 'vitest'
import { buildMismatchReply, findDateMismatches } from './date-preprocessor'

const WEEKDAY_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado']

// Mirrors date-preprocessor.ts's own normStr() — the source strips accents
// before matching, so DateMismatch.dayName comes back accent-stripped even
// when the input text used accents (actualDay does NOT, it's read straight
// from the source's own accented WEEKDAY_ES constant).
function stripAccents(s: string): string {
  return s
    .toLowerCase()
    .replace(/[áàâ]/g, 'a').replace(/[éèê]/g, 'e').replace(/[íìî]/g, 'i')
    .replace(/[óòô]/g, 'o').replace(/[úùû]/g, 'u')
    .replace(/ñ/g, 'n').replace(/ü/g, 'u')
}

// Mirrors the source's todayArgentina() (UTC-3, no DST) so expectations stay
// correct regardless of the runner's local timezone or time of day.
function argentinaToday(): Date {
  const localMs = Date.now() - 3 * 60 * 60 * 1000
  const d = new Date(localMs)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

function addDays(base: Date, days: number): Date {
  return new Date(base.getTime() + days * 86400000)
}

describe('findDateMismatches', () => {
  it('returns no mismatches for text without a weekday+day pattern (e.g. relative dates)', () => {
    expect(findDateMismatches('Hola, quiero reservar para mañana')).toEqual([])
    expect(findDateMismatches('¿Tienen para este fin de semana?')).toEqual([])
    expect(findDateMismatches('¿Y el próximo lunes?')).toEqual([])
  })

  it('returns no mismatch when the stated weekday matches the actual calendar day', () => {
    const target    = addDays(argentinaToday(), 3)
    const weekday   = WEEKDAY_ES[target.getUTCDay()]!
    const dayNumber = target.getUTCDate()

    expect(findDateMismatches(`Quiero ir el ${weekday} ${dayNumber}`)).toEqual([])
  })

  it('detects a mismatch when the stated weekday does not match the actual calendar day', () => {
    const target    = addDays(argentinaToday(), 3)
    const actualIdx = target.getUTCDay()
    const wrongIdx  = (actualIdx + 1) % 7
    const wrong     = WEEKDAY_ES[wrongIdx]!
    const dayNumber = target.getUTCDate()

    const mismatches = findDateMismatches(`Quiero ir el ${wrong} ${dayNumber}`)

    expect(mismatches).toHaveLength(1)
    expect(mismatches[0]!.dayName).toBe(stripAccents(wrong))
    expect(mismatches[0]!.actualDay).toBe(WEEKDAY_ES[actualIdx])
    expect(mismatches[0]!.dayNumber).toBe(dayNumber)
  })
})

describe('buildMismatchReply', () => {
  it('returns null when there are no mismatches', () => {
    expect(buildMismatchReply([])).toBeNull()
  })

  it('builds a natural-language reply that mentions the correct calendar day and asks for confirmation', () => {
    const target    = addDays(argentinaToday(), 3)
    const actualIdx = target.getUTCDay()
    const wrong     = WEEKDAY_ES[(actualIdx + 1) % 7]!

    const mismatches = findDateMismatches(`Quiero ir el ${wrong} ${target.getUTCDate()}`)
    const reply       = buildMismatchReply(mismatches)

    expect(reply).not.toBeNull()
    expect(reply).toContain(WEEKDAY_ES[actualIdx])
    expect(reply).toContain('confirmarme')
  })
})
