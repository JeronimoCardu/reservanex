import { describe, it, expect } from 'vitest'
import { computeReorder, type Ordenable } from './reorder'

// Fase 3E-C3A1 §11 — el orden no puede depender de que sort_order sea único ni
// contiguo, porque no lo es.

const filas = (...pares: [string, number][]): Ordenable[] =>
  pares.map(([id, sort_order]) => ({ id, sort_order }))

describe('computeReorder', () => {
  it('sube una fila un lugar', () => {
    const escrituras = computeReorder(filas(['a', 0], ['b', 1], ['c', 2]), 'b', 'up')
    // b pasa a 0 y a baja a 1. c ya está en 2 y no se toca.
    expect(escrituras).toEqual([{ id: 'b', sort_order: 0 }, { id: 'a', sort_order: 1 }])
  })

  it('baja una fila un lugar', () => {
    const escrituras = computeReorder(filas(['a', 0], ['b', 1], ['c', 2]), 'a', 'down')
    expect(escrituras).toEqual([{ id: 'b', sort_order: 0 }, { id: 'a', sort_order: 1 }])
  })

  it('no escribe nada si la fila ya está primera', () => {
    expect(computeReorder(filas(['a', 0], ['b', 1]), 'a', 'up')).toEqual([])
  })

  it('no escribe nada si la fila ya está última', () => {
    expect(computeReorder(filas(['a', 0], ['b', 1]), 'b', 'down')).toEqual([])
  })

  it('no escribe nada si el id no está en el grupo', () => {
    expect(computeReorder(filas(['a', 0], ['b', 1]), 'zzz', 'up')).toEqual([])
  })

  it('no escribe nada con un solo elemento', () => {
    expect(computeReorder(filas(['a', 0]), 'a', 'up')).toEqual([])
    expect(computeReorder(filas(['a', 0]), 'a', 'down')).toEqual([])
  })

  it('funciona cuando TODOS los sort_order son iguales', () => {
    // El caso que rompería un swap de valores: intercambiar 0 por 0 no hace
    // nada. Este es el estado normal de un grupo recién creado.
    const escrituras = computeReorder(filas(['a', 0], ['b', 0], ['c', 0]), 'c', 'up')
    // Orden deseado: a, c, b → a se queda en 0, c pasa a 1, b a 2.
    expect(escrituras).toEqual([{ id: 'c', sort_order: 1 }, { id: 'b', sort_order: 2 }])
  })

  it('normaliza un grupo con huecos', () => {
    // Archivar y reordenar dejan huecos a propósito: 0, 5, 99 es un estado
    // legítimo. La primera reordenada lo normaliza entero.
    const escrituras = computeReorder(filas(['a', 0], ['b', 5], ['c', 99]), 'c', 'up')
    expect(escrituras).toEqual([{ id: 'c', sort_order: 1 }, { id: 'b', sort_order: 2 }])
  })

  it('no muta el arreglo que recibe', () => {
    const entrada = filas(['a', 0], ['b', 1])
    computeReorder(entrada, 'b', 'up')
    expect(entrada.map((f) => f.id)).toEqual(['a', 'b'])
  })

  it('subir y después bajar deja el orden original', () => {
    const original = filas(['a', 0], ['b', 1], ['c', 2])

    const aplicar = (fs: Ordenable[], escrituras: { id: string; sort_order: number }[]) => {
      const porId = new Map(escrituras.map((e) => [e.id, e.sort_order]))
      return [...fs]
        .map((f) => ({ ...f, sort_order: porId.get(f.id) ?? f.sort_order }))
        .sort((x, y) => x.sort_order - y.sort_order)
    }

    const subido = aplicar(original, computeReorder(original, 'c', 'up'))
    expect(subido.map((f) => f.id)).toEqual(['a', 'c', 'b'])

    const bajado = aplicar(subido, computeReorder(subido, 'c', 'down'))
    expect(bajado.map((f) => f.id)).toEqual(['a', 'b', 'c'])
  })
})
