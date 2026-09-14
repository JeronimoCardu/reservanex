import { describe, expect, it } from 'vitest'
import {
  MAX_MONEY_CENTS,
  isMoneyString,
  moneyStringSchema,
  moneyStringToCents,
  dbMoneyNumberToCents,
  centsToMoneyString,
  multiplyMoneyCents,
  addMoneyCents,
  formatMoneyString,
} from './money'

// ════════════════════════════════════════════════════════════════════════════
// Fase 3E-C3B1 — la aritmética de plata.
//
// Los dos casos que motivaron todo esto están abajo con nombre propio: son los
// que se midieron en la auditoría de C3B y los que un `parseFloat` habría
// metido en la evidencia de un pedido real.
// ════════════════════════════════════════════════════════════════════════════

describe('el problema que esto resuelve', () => {
  it('float miente: 2000.10 * 9 y 0.10 * 3', () => {
    // No es una hipótesis. Si esto alguna vez deja de fallar, el comentario del
    // módulo quedó obsoleto y conviene revisarlo.
    expect(2000.10 * 9).not.toBe(18000.90)
    expect(2000.10 * 9).toBeCloseTo(18000.899999999998, 10)
    expect(0.10 * 3).not.toBe(0.30)
  })

  it('en centavos enteros da exacto', () => {
    const unit = moneyStringToCents('2000.10')!
    expect(centsToMoneyString(multiplyMoneyCents(unit, 9)!)).toBe('18000.90')

    const diez = moneyStringToCents('0.10')!
    expect(centsToMoneyString(multiplyMoneyCents(diez, 3)!)).toBe('0.30')
  })
})

describe('formato canónico', () => {
  it('acepta exactamente dos decimales', () => {
    expect(isMoneyString('10000.00')).toBe(true)
    expect(isMoneyString('0.00')).toBe(true)
    expect(isMoneyString('999999999999.99')).toBe(true)
  })

  it('rechaza todo lo que no sea canónico', () => {
    for (const malo of [
      '10000',            // sin decimales
      '10000.0',          // un decimal
      '10000.000',        // tres decimales
      '1e4',              // notación científica
      '-10.00',           // negativo
      '10,00',            // coma
      ' 10.00',           // espacio
      '10.00 ',
      '',
      '.00',
      '1000000000000.00', // 13 dígitos enteros: no entra en NUMERIC(14,2)
      'abc',
    ]) {
      expect(isMoneyString(malo), malo).toBe(false)
      expect(moneyStringSchema.safeParse(malo).success, malo).toBe(false)
    }
  })

  it('el schema valida sobre el STRING, no sobre un number', () => {
    // Si internamente hiciera Number(), 10000.000 y 10000.00 serían el mismo
    // valor y el "tres decimales" de arriba pasaría.
    expect(moneyStringSchema.safeParse(10000).success).toBe(false)
    expect(moneyStringSchema.safeParse(null).success).toBe(false)
  })
})

describe('moneyStringToCents', () => {
  it('parte el string, no multiplica floats', () => {
    expect(moneyStringToCents('12500.50')).toBe(1_250_050)
    expect(moneyStringToCents('0.00')).toBe(0)
    expect(moneyStringToCents('0.01')).toBe(1)
    expect(moneyStringToCents('1.10')).toBe(110)
    expect(moneyStringToCents('999999999999.99')).toBe(MAX_MONEY_CENTS)
  })

  it('devuelve null en vez de NaN cuando el string no sirve', () => {
    // NaN se propagaría en silencio por toda la aritmética siguiente.
    expect(moneyStringToCents('10000')).toBeNull()
    expect(moneyStringToCents('x')).toBeNull()
  })
})

describe('dbMoneyNumberToCents', () => {
  it('convierte lo que devuelve supabase-js', () => {
    expect(dbMoneyNumberToCents(10000)).toBe(1_000_000)
    expect(dbMoneyNumberToCents(2000.1)).toBe(200_010)
    expect(dbMoneyNumberToCents(0)).toBe(0)
    expect(dbMoneyNumberToCents(0.1)).toBe(10)
  })

  it('el redondeo recupera el entero exacto cuando el float deriva', () => {
    // Medido, no supuesto: hay montos de dos decimales donde n * 100 NO cae en
    // el entero. Math.round lo recupera, y puede hacerlo porque la columna ya
    // garantiza que el valor tiene a lo sumo dos decimales.
    expect(0.07 * 100).not.toBe(7)
    expect(0.29 * 100).not.toBe(29)
    expect(dbMoneyNumberToCents(0.07)).toBe(7)
    expect(dbMoneyNumberToCents(0.29)).toBe(29)
    expect(dbMoneyNumberToCents(0.55)).toBe(55)
  })

  it('un truncado en vez de un redondeo perdería un centavo', () => {
    // Math.trunc(0.29 * 100) daría 28. El test fija el redondeo, no el truncado.
    expect(Math.trunc(0.29 * 100)).toBe(28)
    expect(dbMoneyNumberToCents(0.29)).toBe(29)
  })

  it('rechaza lo que no es un monto representable', () => {
    expect(dbMoneyNumberToCents(NaN)).toBeNull()
    expect(dbMoneyNumberToCents(Infinity)).toBeNull()
    expect(dbMoneyNumberToCents(-1)).toBeNull()
    expect(dbMoneyNumberToCents(1e13)).toBeNull()
  })
})

describe('centsToMoneyString', () => {
  it('siempre dos decimales', () => {
    expect(centsToMoneyString(0)).toBe('0.00')
    expect(centsToMoneyString(5)).toBe('0.05')
    expect(centsToMoneyString(50)).toBe('0.50')
    expect(centsToMoneyString(1_250_050)).toBe('12500.50')
    expect(centsToMoneyString(MAX_MONEY_CENTS)).toBe('999999999999.99')
  })

  it('ida y vuelta es identidad', () => {
    for (const s of ['0.00', '0.01', '1.10', '12500.50', '999999999999.99']) {
      expect(centsToMoneyString(moneyStringToCents(s)!)).toBe(s)
    }
  })

  it('lanza si le llega algo fuera de rango', () => {
    expect(() => centsToMoneyString(-1)).toThrow(RangeError)
    expect(() => centsToMoneyString(MAX_MONEY_CENTS + 1)).toThrow(RangeError)
    expect(() => centsToMoneyString(1.5)).toThrow(RangeError)
  })
})

describe('overflow — se verifica ANTES de operar', () => {
  it('multiplicar dentro del rango', () => {
    expect(multiplyMoneyCents(1_000_000, 99)).toBe(99_000_000)
    expect(multiplyMoneyCents(MAX_MONEY_CENTS, 1)).toBe(MAX_MONEY_CENTS)
  })

  it('multiplicar fuera del rango devuelve null, no un entero inseguro', () => {
    const r = multiplyMoneyCents(MAX_MONEY_CENTS, 2)
    expect(r).toBeNull()
    // El punto: nunca se llegó a calcular MAX*2, que ya pasa de lo que
    // NUMERIC(14,2) admite.
    expect(multiplyMoneyCents(Math.floor(MAX_MONEY_CENTS / 99) + 1, 99)).toBeNull()
  })

  it('el mayor unitario que entra con cada cantidad', () => {
    const q = 99
    const tope = Math.floor(MAX_MONEY_CENTS / q)
    expect(multiplyMoneyCents(tope, q)).not.toBeNull()
    expect(multiplyMoneyCents(tope + 1, q)).toBeNull()
  })

  it('sumar dentro y fuera del rango', () => {
    expect(addMoneyCents(100, 200)).toBe(300)
    expect(addMoneyCents(MAX_MONEY_CENTS, 0)).toBe(MAX_MONEY_CENTS)
    expect(addMoneyCents(MAX_MONEY_CENTS, 1)).toBeNull()
  })

  it('todo resultado válido es un entero seguro', () => {
    expect(Number.isSafeInteger(MAX_MONEY_CENTS)).toBe(true)
    expect(MAX_MONEY_CENTS).toBeLessThan(Number.MAX_SAFE_INTEGER)
  })

  it('rechaza cantidades que no son enteros positivos', () => {
    expect(multiplyMoneyCents(100, 0)).toBeNull()
    expect(multiplyMoneyCents(100, -1)).toBeNull()
    expect(multiplyMoneyCents(100, 1.5)).toBeNull()
  })
})

describe('subtotal de varias líneas', () => {
  it('suma exacta con montos que en float derivarían', () => {
    const lineas = [
      { unit: '2000.10', qty: 9 },   // 18000.90
      { unit: '0.10',    qty: 3 },   //     0.30
      { unit: '10000.00', qty: 2 },  // 20000.00
    ]
    let subtotal = 0
    for (const l of lineas) {
      const total = multiplyMoneyCents(moneyStringToCents(l.unit)!, l.qty)!
      subtotal = addMoneyCents(subtotal, total)!
    }
    expect(centsToMoneyString(subtotal)).toBe('38001.20')
  })
})

describe('formatMoneyString', () => {
  it('es-AR: punto para miles, coma para decimales', () => {
    expect(formatMoneyString('20000.00', 'ARS')).toBe('ARS 20.000,00')
    expect(formatMoneyString('0.00', 'ARS')).toBe('ARS 0,00')
    expect(formatMoneyString('999.99', 'ARS')).toBe('ARS 999,99')
    expect(formatMoneyString('1000.50', 'ARS')).toBe('ARS 1.000,50')
    expect(formatMoneyString('1234567.89', 'USD')).toBe('USD 1.234.567,89')
    expect(formatMoneyString('999999999999.99', 'ARS')).toBe('ARS 999.999.999.999,99')
  })

  it('no depende de Intl', () => {
    // Es manipulación de string pura: el worker tiene su propia copia y tiene
    // que dar exactamente lo mismo sin importar el ICU del runtime.
    expect(formatMoneyString('18000.90', 'ARS')).toBe('ARS 18.000,90')
  })
})
