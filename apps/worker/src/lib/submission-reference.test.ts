import { describe, expect, it } from 'vitest'
import {
  extractSubmissionReference,
  normalizeSubmissionReference,
  SUBMISSION_REFERENCE_REGEX,
} from './submission-reference'

// §26 A — parse de la referencia.

describe('normalizeSubmissionReference', () => {
  it('acepta un código canónico sin cambiarlo', () => {
    expect(normalizeSubmissionReference('SUB-ABC234')).toBe('SUB-ABC234')
  })

  it('perdona lo que una persona realmente escribe', () => {
    expect(normalizeSubmissionReference('sub-abc234')).toBe('SUB-ABC234')
    expect(normalizeSubmissionReference('  SUB-ABC234  ')).toBe('SUB-ABC234')
    expect(normalizeSubmissionReference('SUB ABC234')).toBe('SUB-ABC234')
    expect(normalizeSubmissionReference('ABC234')).toBe('SUB-ABC234')
    expect(normalizeSubmissionReference('abc234')).toBe('SUB-ABC234')
  })

  it('rechaza lo que no es un código', () => {
    expect(normalizeSubmissionReference('SUB-ABC23')).toBeNull()    // corto
    expect(normalizeSubmissionReference('SUB-ABC2345')).toBeNull()  // largo
    expect(normalizeSubmissionReference('SUB-ABC23O')).toBeNull()   // O excluida
    expect(normalizeSubmissionReference('SUB-ABC231')).toBeNull()   // 1 excluido
    expect(normalizeSubmissionReference('hola')).toBeNull()
    expect(normalizeSubmissionReference('')).toBeNull()
  })
})

describe('extractSubmissionReference', () => {
  it('1. SUB-X72K9A → detecta', () => {
    expect(extractSubmissionReference('SUB-X72K9A')).toBe('SUB-X72K9A')
    expect(extractSubmissionReference('sub-x72k9a')).toBe('SUB-X72K9A')
  })

  it('2. sub x72k9a → detecta (espacio en vez de guion)', () => {
    expect(extractSubmissionReference('sub x72k9a')).toBe('SUB-X72K9A')
    expect(extractSubmissionReference('SUB X72K9A')).toBe('SUB-X72K9A')
  })

  it('3. dentro del mensaje que arma el CTA → detecta', () => {
    const text = 'Hola, completé el formulario en ReservaNex.\nReferencia: SUB-X72K9A'
    expect(extractSubmissionReference(text)).toBe('SUB-X72K9A')
  })

  it('tolera minúsculas y puntuación alrededor', () => {
    expect(extractSubmissionReference('mi referencia es sub-x72k9a, gracias')).toBe('SUB-X72K9A')
    expect(extractSubmissionReference('(SUB-X72K9A)')).toBe('SUB-X72K9A')
    expect(extractSubmissionReference('Referencia: SUB-X72K9A.')).toBe('SUB-X72K9A')
  })

  // ── El prefijo SUB es OBLIGATORIO ────────────────────────────────────────
  // Un código pelado NO se detecta, ni siquiera siendo el mensaje entero.
  // El CTA del formulario siempre emite "Referencia: SUB-XXXXXX", así que no
  // perdemos nada, y ganamos no secuestrar mensajes normales.

  it('4. NO detecta un código pelado, aunque sea el mensaje entero', () => {
    expect(extractSubmissionReference('X72K9A')).toBeNull()
    expect(extractSubmissionReference('  x72k9a  ')).toBeNull()
    expect(extractSubmissionReference('ABC234')).toBeNull()
  })

  // El caso concreto que motivó el cambio: estas son palabras reales de una
  // conversación inmobiliaria, y sus 6 caracteres están TODOS dentro del
  // alfabeto de las referencias. Antes cada una se resolvía como
  // SUB-<palabra> y el cliente recibía "no encontrado" en vez de una
  // respuesta de la IA.
  it('5. NO secuestra palabras normales de 6 caracteres', () => {
    for (const palabra of ['VENTAS', 'FECHAS', 'SEMANA', 'MANANA', 'TARDES', 'PUEDES', 'VENDER', 'CHALET']) {
      expect(extractSubmissionReference(palabra), palabra).toBeNull()
      expect(extractSubmissionReference(palabra.toLowerCase()), palabra).toBeNull()
    }
  })

  it('6. un mensaje normal no dispara la detección (sigue el pipeline de IA)', () => {
    const normales = [
      '¿CUANDO puedo visitarla?',
      'quiero saber el PRECIO final',
      'la semana que viene',
      'hola, buenas tardes',
      'VENTAS',
      'Hola! Tenés algo para 4 personas en enero?',
      'gracias, quedo atento',
    ]
    for (const m of normales) expect(extractSubmissionReference(m), m).toBeNull()
  })

  // Sin separador, "SUB" + 6 caracteres válidos matchea adentro de palabras
  // reales. Por eso el guion/espacio es obligatorio.
  it('no matchea SUB pegado a una palabra', () => {
    expect(extractSubmissionReference('SUBCLASES')).toBeNull()
    expect(extractSubmissionReference('subclases de la propiedad')).toBeNull()
    expect(extractSubmissionReference('SUBGERENTE')).toBeNull()
  })

  it('no matchea SUB precedido por otro carácter alfanumérico', () => {
    expect(extractSubmissionReference('XSUB-ABC234')).toBeNull()
    expect(extractSubmissionReference('9SUB-ABC234')).toBeNull()
  })

  it('no matchea un código con caracteres excluidos', () => {
    expect(extractSubmissionReference('Referencia: SUB-ABC1O0')).toBeNull()
  })

  // Un token más largo que 6 no es un código truncado: debe fallar entero, no
  // matchear los primeros 6. El lookahead rechaza cualquier alfanumérico, no
  // solo los del alfabeto — si mirara únicamente el alfabeto, 'SUB-ABC2340'
  // pasaría (el 0 está excluido) y extraería un código que nunca existió.
  it('no recorta un token demasiado largo para que parezca válido', () => {
    expect(extractSubmissionReference('Referencia: SUB-ABC2345')).toBeNull()
    expect(extractSubmissionReference('Referencia: SUB-ABC2340')).toBeNull()
    expect(extractSubmissionReference('Referencia: SUB-ABC234I')).toBeNull()
  })

  it('devuelve null con texto vacío o ausente', () => {
    expect(extractSubmissionReference('')).toBeNull()
    expect(extractSubmissionReference(null)).toBeNull()
    expect(extractSubmissionReference(undefined)).toBeNull()
  })

  it('todo lo que extrae respeta el formato de la DB', () => {
    const casos = ['SUB-X72K9A', 'sub x72k9a', 'ref SUB-ABC234 ok', 'Referencia: SUB-ZZZ999']
    for (const c of casos) {
      const r = extractSubmissionReference(c)
      expect(r, c).not.toBeNull()
      expect(r!).toMatch(SUBMISSION_REFERENCE_REGEX)
    }
  })
})
