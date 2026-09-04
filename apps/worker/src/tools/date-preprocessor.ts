// Deterministic day-name + date validation for Spanish.
// Runs BEFORE the LLM call in responder.ts to catch contradictions like
// "domingo 25" when 25/07/2026 is Saturday — the LLM cannot be trusted
// to detect these reliably on its own.

const WEEKDAY_INDEX: Record<string, number> = {
  domingo: 0, lunes: 1, martes: 2,
  miercoles: 3,           // accent-stripped form of miércoles
  jueves: 4, viernes: 5,
  sabado: 6,              // accent-stripped form of sábado
}

const WEEKDAY_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado']

const MONTH_ES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
]

function normStr(s: string): string {
  return s
    .toLowerCase()
    .replace(/[áàâ]/g, 'a').replace(/[éèê]/g, 'e').replace(/[íìî]/g, 'i')
    .replace(/[óòô]/g, 'o').replace(/[úùû]/g, 'u')
    .replace(/ñ/g, 'n').replace(/ü/g, 'u')
}

export interface DateMismatch {
  original:  string   // raw matched text, e.g. "domingo 25"
  dayName:   string   // normalised weekday name, e.g. "domingo"
  dayNumber: number   // 25
  isoDate:   string   // resolved calendar date, e.g. "2026-07-25"
  actualDay: string   // what that date really is, e.g. "sábado"
}

/** Returns today's date in America/Argentina/Buenos_Aires (UTC-3, no DST). */
function todayArgentina(): Date {
  const localMs = Date.now() - 3 * 60 * 60 * 1000
  const d       = new Date(localMs)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

export interface ExtractedDatePair {
  original:   string
  dayName:    string
  dayNumber:  number
  isoDate:    string
  actualDay:  string
  matched:    boolean   // true = day name matches calendar, false = mismatch
}

/**
 * Scans `text` for Spanish "DayName N [de Month]" patterns and validates each
 * against the actual calendar.
 *
 * Returns ALL extracted pairs (for logging) plus only the mismatches (for blocking).
 * Resolves day numbers to the nearest upcoming date in Argentina timezone.
 */
function extractAndValidatePairs(text: string): { pairs: ExtractedDatePair[]; mismatches: DateMismatch[] } {
  const today  = todayArgentina()
  const normed = normStr(text)

  // Match: weekday-name + whitespace + 1–2-digit day-number + optional " de <month>"
  const PATTERN =
    /\b(domingo|lunes|martes|miercoles|jueves|viernes|sabado)\s+(\d{1,2})(?:\s+de\s+([a-z]+(?:\s+[a-z]+)?))?/g

  const pairs:      ExtractedDatePair[] = []
  const mismatches: DateMismatch[]      = []
  let   m: RegExpExecArray | null

  while ((m = PATTERN.exec(normed)) !== null) {
    const dayNameNorm = m[1]!
    const dayNumber   = parseInt(m[2]!, 10)
    const monthHint   = m[3]?.trim()

    if (dayNumber < 1 || dayNumber > 31) continue

    // Resolve month (explicit hint wins over current month)
    let month = today.getUTCMonth()
    if (monthHint) {
      const mi = MONTH_ES.findIndex(mn => monthHint.startsWith(mn.slice(0, 3)))
      if (mi >= 0) month = mi
    }

    // Try current year + resolved month
    let year      = today.getUTCFullYear()
    let candidate = new Date(Date.UTC(year, month, dayNumber))
    if (isNaN(candidate.getTime())) continue  // invalid day in month (e.g. Feb 30)

    // If the candidate falls in the past, roll forward one month
    if (candidate < today) {
      const nm = month === 11 ? 0 : month + 1
      const ny = month === 11 ? year + 1 : year
      const nc = new Date(Date.UTC(ny, nm, dayNumber))
      if (!isNaN(nc.getTime())) {
        candidate = nc
        month     = nm
        year      = ny
      }
    }

    const mm      = String(month + 1).padStart(2, '0')
    const dd      = String(dayNumber).padStart(2, '0')
    const isoDate = `${year}-${mm}-${dd}`

    const actualIdx   = candidate.getUTCDay()
    const actualDay   = WEEKDAY_ES[actualIdx]!
    const expectedIdx = WEEKDAY_INDEX[dayNameNorm] ?? -1
    const matched     = expectedIdx === actualIdx

    pairs.push({ original: m[0]!, dayName: dayNameNorm, dayNumber, isoDate, actualDay, matched })

    if (!matched) {
      mismatches.push({ original: m[0]!, dayName: dayNameNorm, dayNumber, isoDate, actualDay })
    }
  }

  return { pairs, mismatches }
}

/**
 * Scans `text` for day-name + day-number pairs and returns only the mismatches.
 * Also emits a structured dev log so you can audit every pair that was checked.
 */
export function findDateMismatches(text: string): DateMismatch[] {
  const { pairs, mismatches } = extractAndValidatePairs(text)

  console.log('[date-preprocessor:v2]', {
    rawText:        text.slice(0, 200),
    extractedPairs: pairs.map(p => ({
      original: p.original,
      isoDate:  p.isoDate,
      actualDay: p.actualDay,
      matched:  p.matched,
    })),
    mismatches: mismatches.map(p => p.original),
  })

  return mismatches
}

/**
 * Builds a natural Spanish reply from the mismatches list.
 * Returns null when there are no mismatches (normal path).
 */
export function buildMismatchReply(mismatches: DateMismatch[]): string | null {
  if (mismatches.length === 0) return null

  const lines = mismatches.map(({ isoDate, dayName, actualDay }) => {
    const [, mm, dd] = isoDate.split('-')
    return `• El ${dd}/${mm} cae en ${actualDay}, no en ${dayName}.`
  })

  return [
    'Hay una confusión con las fechas:',
    '',
    ...lines,
    '',
    '¿Podés confirmarme cuáles son las fechas exactas para poder continuar?',
  ].join('\n')
}
