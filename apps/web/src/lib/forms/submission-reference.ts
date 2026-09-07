// Fase 3A — código público de una submission.
//
// Es una REFERENCIA, no una credencial: sirve para correlacionar un mensaje de
// WhatsApp con una fila (Fase 3B). Conocerlo no da acceso a nada — ver
// §10 del spec y el comentario de la columna en la migración.

import { randomInt } from 'node:crypto'

// Sin O/0/I/1: alguien va a leer este código de una pantalla y tipearlo, o
// dictarlo por teléfono. 32^6 ≈ 1.07e9 combinaciones, suficiente para que no
// se pueda adivinar por fuerza bruta razonable y para que las colisiones sean
// raras (y cuando pasan, el UNIQUE + retry las absorbe).
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 6
export const SUBMISSION_REFERENCE_PREFIX = 'SUB-'

// Debe coincidir con form_submissions_reference_format_check en la DB.
export const SUBMISSION_REFERENCE_REGEX = /^SUB-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/

// randomInt (CSPRNG) y no Math.random: el código no autoriza, pero tampoco
// queremos que sea predecible a partir de otro código emitido cerca en el
// tiempo. No secuencial, no derivado del tenant, no revela cuántas
// submissions existen.
export function generateSubmissionReference(): string {
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += ALPHABET[randomInt(0, ALPHABET.length)]
  }
  return SUBMISSION_REFERENCE_PREFIX + code
}

// Normaliza lo que venga de un WhatsApp: la gente escribe en minúscula, mete
// espacios, se olvida el guion. Devuelve null si no es un código válido.
export function normalizeSubmissionReference(raw: string): string | null {
  const cleaned = raw.trim().toUpperCase().replace(/\s+/g, '')
  const withPrefix = cleaned.startsWith(SUBMISSION_REFERENCE_PREFIX)
    ? cleaned
    : SUBMISSION_REFERENCE_PREFIX + cleaned.replace(/^SUB-?/, '')
  return SUBMISSION_REFERENCE_REGEX.test(withPrefix) ? withPrefix : null
}
