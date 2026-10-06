import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// apps/marketing no tiene tests propios ni puede importar de apps/web (es una
// app independiente a propósito). Su /api/contact queda cubierto así: el guard
// es una copia byte a byte del de acá, y su ruta es la MISMA que la de
// apps/web/src/app/api/contact salvo los specifiers de import — que es la que
// prueba app/api/contact/route.test.ts.

const DIR  = import.meta.dirname
const WEB  = path.resolve(DIR, '..', '..', '..')
const RAIZ = path.resolve(WEB, '..', '..')
const leer = (rel: string) => fs.readFileSync(path.join(RAIZ, rel), 'utf8')

const sinSpecifiers = (src: string) => src.replace(/from '[^']+'/g, "from '<specifier>'")

describe('apps/marketing — paridad del hardening de /api/contact', () => {
  it('public-post-guard es idéntico en las dos apps', () => {
    expect(leer('apps/marketing/src/lib/public-post-guard.ts')).toBe(
      leer('apps/web/src/lib/http/public-post-guard.ts'),
    )
  })

  it('la ruta de contacto es la misma salvo los imports', () => {
    expect(sinSpecifiers(leer('apps/marketing/src/app/api/contact/route.ts'))).toBe(
      sinSpecifiers(leer('apps/web/src/app/api/contact/route.ts')),
    )
  })

  it('marketing importa SU copia del guard, no la de apps/web', () => {
    const ruta = leer('apps/marketing/src/app/api/contact/route.ts')
    expect(ruta).toMatch(/import \{[^}]*\breadPublicJsonBody\b[^}]*\} from '@\/lib\/public-post-guard'/)
    expect(ruta).not.toContain('lib/http/')
  })
})
