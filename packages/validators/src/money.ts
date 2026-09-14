import { z } from 'zod'

// ═══════════════════════════════════════════════════════════════════════════
// Fase 3E-C3B1 — dinero en CENTAVOS ENTEROS.
//
// ── POR QUÉ NO FLOAT ────────────────────────────────────────────────────────
//
// Medido durante la auditoría de C3B, no supuesto:
//
//   2000.10 * 9  →  18000.899999999998
//   0.10 * 3     →  0.30000000000000004
//
// Un subtotal con ese valor se persiste en la evidencia del pedido y se le lee
// al cliente por WhatsApp. Así que la aritmética de plata NO pasa por float:
// todo se convierte a centavos enteros, se opera con enteros, y se vuelve a
// string canónico al final.
//
// ── EL RANGO ────────────────────────────────────────────────────────────────
//
// La columna de precio es NUMERIC(14,2): el máximo representable es
// 999999999999.99, o sea 99_999_999_999_999 centavos. Ese número es ~1.1e14,
// muy por debajo de Number.MAX_SAFE_INTEGER (~9.0e15), así que mientras cada
// operación se mantenga bajo el tope NUNCA se llega a un entero inseguro.
//
// Por eso los helpers de abajo verifican ANTES de operar, no después: un
// chequeo posterior ya se haría sobre un número posiblemente redondeado.
// ═══════════════════════════════════════════════════════════════════════════

/** 999999999999.99 expresado en centavos — el techo de NUMERIC(14,2). */
export const MAX_MONEY_CENTS = 99_999_999_999_999

/**
 * Un monto canónico: dígitos, punto, EXACTAMENTE dos decimales.
 *
 * "10000.00" sí · "10000" no · "10000.0" no · "10000.000" no · "1e4" no
 *
 * Los dos decimales obligatorios no son capricho: hacen que la comparación de
 * precios sea comparación de strings idénticos, sin normalizar nada, y que un
 * "10000" del browser no pueda pasar por equivalente a "10000.00" por accidente
 * de parseo.
 */
export const MONEY_STRING_PATTERN = /^\d{1,12}\.\d{2}$/

export function isMoneyString(value: unknown): value is string {
  return typeof value === 'string' && MONEY_STRING_PATTERN.test(value)
}

/**
 * Schema de monto canónico.
 *
 * NO usa z.coerce.number() ni parseFloat: la validación es sobre el STRING. En
 * cuanto un monto se convierte a number pierde justamente lo que hay que
 * verificar (cuántos decimales escribió quien lo mandó).
 */
export const moneyStringSchema = z
  .string({ required_error: 'Falta el importe.', invalid_type_error: 'Importe inválido.' })
  .regex(MONEY_STRING_PATTERN, 'Importe inválido. Se espera un monto con dos decimales, por ejemplo 10000.00')

/**
 * "12500.50" → 1_250_050
 *
 * Se parte el string por el punto y se arma el entero con las dos mitades. No
 * hay multiplicación por 100 sobre un float en ningún momento.
 *
 * Devuelve null si el string no es canónico — nunca NaN, que se propagaría en
 * silencio por toda la aritmética.
 */
export function moneyStringToCents(value: string): number | null {
  if (!isMoneyString(value)) return null
  const punto = value.indexOf('.')
  const enteros   = Number(value.slice(0, punto))
  const decimales = Number(value.slice(punto + 1))
  const cents = enteros * 100 + decimales
  return cents > MAX_MONEY_CENTS ? null : cents
}

/**
 * El precio tal como lo devuelve supabase-js → centavos.
 *
 * `numeric` llega como number de JS. Math.round(n * 100) es aceptable ACÁ y solo
 * acá porque la base ya garantiza NUMERIC(14,2): el valor tiene a lo sumo dos
 * decimales, así que n * 100 está a menos de medio centavo del entero correcto y
 * el redondeo lo recupera exacto. A partir de este punto se trabaja únicamente
 * con enteros.
 *
 * Devuelve null para cualquier cosa que no sea un monto representable: NaN,
 * Infinity, negativos, o algo fuera del rango de la columna.
 */
export function dbMoneyNumberToCents(value: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (value < 0) return null
  const cents = Math.round(value * 100)
  if (!Number.isSafeInteger(cents) || cents > MAX_MONEY_CENTS) return null
  return cents
}

/**
 * 1_250_050 → "12500.50"
 *
 * División entera y resto: sin float en el camino de vuelta tampoco.
 */
export function centsToMoneyString(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0 || cents > MAX_MONEY_CENTS) {
    throw new RangeError(`Centavos fuera de rango: ${cents}`)
  }
  const enteros   = Math.floor(cents / 100)
  const decimales = cents - enteros * 100
  return `${enteros}.${String(decimales).padStart(2, '0')}`
}

/**
 * unitCents × quantity, verificando el techo ANTES de multiplicar.
 *
 * La comprobación es `unitCents <= MAX / quantity` en vez de mirar el producto:
 * si se multiplicara primero para después comparar, el producto ya podría haber
 * pasado de Number.MAX_SAFE_INTEGER y el chequeo sería sobre un valor mentiroso.
 *
 * null = no entra en NUMERIC(14,2). No lanza: el llamador lo convierte en un
 * error determinístico de su capa.
 */
export function multiplyMoneyCents(unitCents: number, quantity: number): number | null {
  if (!Number.isSafeInteger(unitCents) || unitCents < 0 || unitCents > MAX_MONEY_CENTS) return null
  if (!Number.isSafeInteger(quantity)  || quantity  < 1) return null
  if (unitCents > Math.floor(MAX_MONEY_CENTS / quantity)) return null
  return unitCents * quantity
}

/**
 * a + b, verificando el techo ANTES de sumar, por la misma razón.
 */
export function addMoneyCents(a: number, b: number): number | null {
  if (!Number.isSafeInteger(a) || a < 0 || a > MAX_MONEY_CENTS) return null
  if (!Number.isSafeInteger(b) || b < 0 || b > MAX_MONEY_CENTS) return null
  if (a > MAX_MONEY_CENTS - b) return null
  return a + b
}

/**
 * Un monto canónico, listo para leerle a una persona: "20000.00" → "ARS 20.000,00"
 *
 * Formato es-AR (punto para miles, coma para decimales) hecho a mano en vez de
 * con Intl.NumberFormat, a propósito: este formateo se usa en el resumen
 * determinístico de WhatsApp, que el worker arma con su propia copia standalone.
 * Intl depende del ICU que traiga el runtime; una cadena de caracteres no
 * depende de nada y da el mismo resultado en los dos lados.
 */
export function formatMoneyString(value: string, currency: string): string {
  if (!isMoneyString(value)) return `${currency} ${value}`
  const punto     = value.indexOf('.')
  const enteros   = value.slice(0, punto)
  const decimales = value.slice(punto + 1)
  const agrupado  = enteros.replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return `${currency} ${agrupado},${decimales}`
}
