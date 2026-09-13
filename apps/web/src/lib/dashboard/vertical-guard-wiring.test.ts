import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { MODULE_VERTICALS } from './module-verticals'

// Fase 3E-C3A1 §23 — "No alcanza con tests de función pura si la ruta real no
// usa el guard".
//
// module-verticals.test.ts prueba la REGLA. Esto prueba el CABLEADO: que cada
// ruta declarada con rubro tenga efectivamente su layout.tsx llamando a
// requireRouteVertical con SU pathname. Sin este test, alguien podría agregar un
// módulo al mapa, verlo desaparecer del nav, y creer que la ruta quedó cerrada
// cuando sigue abierta escribiendo la URL.
//
// Lee el filesystem a propósito: es la única forma de comprobar que el archivo
// existe y contiene la llamada, sin levantar Next.

const DASHBOARD = path.resolve(import.meta.dirname, '..', '..', 'app', '(tenant)', 'dashboard')

/** '/dashboard/table-reservations' → 'table-reservations' */
function segmento(ruta: string): string {
  return ruta.replace(/^\/dashboard\/?/, '')
}

describe('cableado del guard de rubro', () => {
  it('el directorio del dashboard existe donde este test lo busca', () => {
    // Si alguien mueve las rutas, este test tiene que fallar acá con un mensaje
    // claro en vez de dar por bueno que no hay módulos que revisar.
    expect(fs.existsSync(DASHBOARD), DASHBOARD).toBe(true)
  })

  it('hay al menos un módulo con rubro declarado', () => {
    expect(Object.keys(MODULE_VERTICALS).length).toBeGreaterThan(0)
  })

  for (const ruta of Object.keys(MODULE_VERTICALS)) {
    it(`${ruta} tiene layout.tsx con requireRouteVertical('${ruta}')`, () => {
      const layout = path.join(DASHBOARD, segmento(ruta), 'layout.tsx')

      expect(fs.existsSync(layout), `falta ${layout}`).toBe(true)

      const fuente = fs.readFileSync(layout, 'utf8')
      expect(fuente, `${ruta}: el layout no importa el guard`)
        .toContain('requireRouteVertical')
      // El pathname exacto: un layout que llamara al guard con la ruta de otro
      // módulo pasaría el check anterior y no protegería nada.
      expect(fuente, `${ruta}: el guard no se llama con su propio pathname`)
        .toContain(`requireRouteVertical(ctx, '${ruta}')`)
    })
  }

  it('ningún módulo con rubro se quedó sin layout', () => {
    const faltantes = Object.keys(MODULE_VERTICALS).filter(
      (ruta) => !fs.existsSync(path.join(DASHBOARD, segmento(ruta), 'layout.tsx')),
    )
    expect(faltantes).toEqual([])
  })
})
