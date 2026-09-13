// Fase 3E-C3A1 — reordenar una fila dentro de su grupo, sin depender de que
// sort_order sea único ni contiguo.
//
// ── POR QUÉ NO ES UN SWAP ───────────────────────────────────────────────────
//
// El swap obvio —intercambiar los dos sort_order— falla en silencio cuando los
// dos valen lo mismo, y ese es el estado NORMAL de un grupo recién creado:
// sort_order nace en 0 por default, y aunque el repositorio asigna max+1, un
// grupo migrado o creado por otro camino puede tener todo en 0. Archivar y
// reordenar también dejan huecos a propósito.
//
// En vez de eso se reasigna por POSICIÓN: se calcula el orden deseado y se
// escribe sort_order = índice, solo en las filas cuyo valor cambia. La primera
// reordenada de un grupo lo normaliza entero; las siguientes tocan dos filas.
//
// Pura y sin dependencias para poder testearla sola: el repositorio la aplica y
// el validador la corre contra la base real.

export interface Ordenable {
  id:         string
  sort_order: number
}

export interface EscrituraDeOrden {
  id:         string
  sort_order: number
}

/**
 * Las escrituras necesarias para mover `id` un lugar en `direction`.
 *
 * `filas` tiene que venir YA ordenada como la ve el usuario (sort_order, con un
 * desempate estable). Devuelve `[]` cuando no hay nada que hacer: la fila no
 * está en el grupo, o ya está en el extremo. No es un error — es el caso del
 * botón que el usuario aprieta cuando ya está arriba.
 */
export function computeReorder(
  filas: readonly Ordenable[],
  id: string,
  direction: 'up' | 'down',
): EscrituraDeOrden[] {
  const index = filas.findIndex((f) => f.id === id)
  if (index === -1) return []

  const destino = direction === 'up' ? index - 1 : index + 1
  if (destino < 0 || destino >= filas.length) return []

  const reordenadas = [...filas]
  const [movida] = reordenadas.splice(index, 1)
  reordenadas.splice(destino, 0, movida!)

  const escrituras: EscrituraDeOrden[] = []
  for (let i = 0; i < reordenadas.length; i++) {
    const fila = reordenadas[i]!
    if (fila.sort_order === i) continue
    escrituras.push({ id: fila.id, sort_order: i })
  }
  return escrituras
}
