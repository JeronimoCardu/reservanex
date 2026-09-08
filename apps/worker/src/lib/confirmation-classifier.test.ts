import { describe, expect, it } from 'vitest'
import { classifyConfirmation } from './confirmation-classifier'

// §26 J/K/L/M/N — clasificación de la respuesta del cliente.

describe('classifyConfirmation — CONFIRM', () => {
  it('J. español', () => {
    for (const t of ['sí', 'si', 'Sí', 'SI', 'sip', 'dale', 'correcto', 'confirmo', 'ok', 'perfecto', 'exacto']) {
      expect(classifyConfirmation(t), t).toBe('confirm')
    }
  })

  it('K. portugués', () => {
    for (const t of ['sim', 'Sim', 'SIM', 'certo', 'correto', 'isso']) {
      expect(classifyConfirmation(t), t).toBe('confirm')
    }
  })

  it('L. inglés', () => {
    for (const t of ['yes', 'Yes', 'YES', 'yeah', 'yep', 'correct', 'confirm']) {
      expect(classifyConfirmation(t), t).toBe('confirm')
    }
  })

  it('frases cortas de confirmación', () => {
    for (const t of ['está bien', 'es correcto', 'así es', 'todo bien', 'de acuerdo', 'sin cambios', 'tudo certo', 'looks good']) {
      expect(classifyConfirmation(t), t).toBe('confirm')
    }
  })

  it('ignora puntuación y tildes', () => {
    expect(classifyConfirmation('¡Sí!')).toBe('confirm')
    expect(classifyConfirmation('si.')).toBe('confirm')
    expect(classifyConfirmation('Sí, correcto')).toBe('confirm')
  })
})

describe('classifyConfirmation — REJECT', () => {
  it('M. rechazo explícito', () => {
    for (const t of ['no', 'No', 'NO', 'nop', 'incorrecto', 'está mal', 'hay un error', 'quiero cambiarlo', 'não', 'errado', 'wrong']) {
      expect(classifyConfirmation(t), t).toBe('reject')
    }
  })

  // Casi toda frase de rechazo contiene una de confirmación negada. Si el
  // orden de evaluación se invirtiera, estos se leerían como un sí — que es
  // el peor error posible acá.
  it('un rechazo que CONTIENE una frase de confirmación sigue siendo rechazo', () => {
    expect(classifyConfirmation('no está bien')).toBe('reject')
    expect(classifyConfirmation('no es correcto')).toBe('reject')
    expect(classifyConfirmation('no, está mal')).toBe('reject')
    expect(classifyConfirmation('não está certo')).toBe('reject')
    expect(classifyConfirmation('not correct')).toBe('reject')
  })
})

describe('classifyConfirmation — AMBIGUOUS', () => {
  it('N. respuestas que no son sí ni no', () => {
    for (const t of ['hola', '¿cuánto sale?', 'gracias', 'mmm', '???', 'a qué hora?']) {
      expect(classifyConfirmation(t), t).toBe('ambiguous')
    }
  })

  it('vacío o nulo', () => {
    expect(classifyConfirmation('')).toBe('ambiguous')
    expect(classifyConfirmation('   ')).toBe('ambiguous')
    expect(classifyConfirmation(null)).toBe('ambiguous')
    expect(classifyConfirmation(undefined)).toBe('ambiguous')
  })

  // Un "sí" enterrado en una consulta no es una confirmación limpia. Preferimos
  // volver a preguntar antes que confirmar algo que el cliente no quiso
  // confirmar (§17 — nunca asumir intención positiva).
  it('un mensaje largo que contiene "sí" NO confirma', () => {
    expect(classifyConfirmation('sí, pero quería preguntarte si incluye las expensas')).toBe('ambiguous')
    expect(classifyConfirmation('si me confirmás el precio te digo mañana temprano')).toBe('ambiguous')
  })

  // El motivo de comparar tokens y no substrings.
  it('NO confunde "si"/"no" dentro de otra palabra', () => {
    expect(classifyConfirmation('siempre')).toBe('ambiguous')
    expect(classifyConfirmation('nosotros')).toBe('ambiguous')
    expect(classifyConfirmation('nomas')).toBe('ambiguous')
    expect(classifyConfirmation('sino')).toBe('ambiguous')
  })
})
