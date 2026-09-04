/**
 * Deterministic weekday validator.
 *
 * When the client says "lunes 20" or "martes 22", the AI must confirm the day-of-week
 * matches the numeric date before proceeding. A mismatch means the client gave a wrong
 * date and must clarify — otherwise a reservation would be created on the wrong date.
 *
 * Usage:
 *   validateWeekday('martes', '2026-07-22')  // 2026-07-22 is a Wednesday → mismatch
 *   validateWeekday('miércoles', '2026-07-22')  // → ok
 */

const WEEKDAY_NAMES: Record<string, number> = {
  // Full names
  domingo:   0,
  lunes:     1,
  martes:    2,
  miercoles: 3,
  miércoles: 3,
  jueves:    4,
  viernes:   5,
  sabado:    6,
  sábado:    6,
  // Abbreviations
  dom: 0,
  lun: 1,
  mar: 2,
  mie: 3,
  mié: 3,
  jue: 4,
  vie: 5,
  sab: 6,
  sáb: 6,
}

function normalizeAccents(s: string): string {
  return s
    .toLowerCase()
    .replace(/[àáâ]/g, 'a')
    .replace(/[èéê]/g, 'e')
    .replace(/[ìíî]/g, 'i')
    .replace(/[òóô]/g, 'o')
    .replace(/[ùúû]/g, 'u')
    .replace(/ñ/g, 'n')
}

export interface WeekdayValidationResult {
  ok:           boolean
  error?:       'WEEKDAY_DATE_MISMATCH' | 'UNKNOWN_WEEKDAY'
  stated_day?:  string
  actual_day?:  string
  date?:        string
}

/**
 * Returns { ok: true } if dayName matches the ISO date string,
 * or an error object describing the mismatch.
 */
export function validateWeekday(
  dayName: string | undefined | null,
  isoDate: string | undefined | null,
): WeekdayValidationResult {
  if (!dayName || !isoDate) return { ok: true }

  const normalized = normalizeAccents(dayName.trim())
  const expectedDay = WEEKDAY_NAMES[normalized]

  if (expectedDay === undefined) {
    return { ok: true } // unrecognised day name — let LLM validate instead
  }

  // Parse the ISO date as UTC midnight to avoid TZ shifts on day boundary
  const dateObj = new Date(`${isoDate}T00:00:00Z`)
  if (isNaN(dateObj.getTime())) return { ok: true }

  const actualDay = dateObj.getUTCDay()

  if (actualDay !== expectedDay) {
    const NAMES_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado']
    return {
      ok:          false,
      error:       'WEEKDAY_DATE_MISMATCH',
      stated_day:  dayName,
      actual_day:  NAMES_ES[actualDay],
      date:        isoDate,
    }
  }

  return { ok: true }
}
