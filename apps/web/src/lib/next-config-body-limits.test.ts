import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// Regresión — "Unexpected end of form" al subir un video de más de 10 MB.
//
// Con middleware configurado (src/middleware.ts corre en /dashboard), Next
// 15.5 clona el body del request para el middleware y lo bufferea hasta
// experimental.middlewareClientMaxBodySize (default 10 MB). Lo que pasa de
// ahí NO falla: se corta en silencio con un warning, y la Server Action
// recibe un multipart truncado que busboy rechaza con "Unexpected end of
// form" — antes de que la acción llegue a correr.
//
// O sea: serverActions.bodySizeLimit ('20mb', declarado para imágenes de
// 5 MB y audios de 16 MB) no servía de nada por encima de 10 MB mientras el
// tope del middleware fuera menor. Los dos tienen que ir juntos.
//
// En Vercel manda igual el tope de plataforma de 4,5 MB por request: esto no
// cambia producción, alinea local/self-hosted con lo que la app declara.

const CONFIG = fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', 'next.config.ts'), 'utf8')

function bytes(size: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)$/i.exec(size.trim())
  if (!m) throw new Error(`tamaño ilegible: ${size}`)
  const unit = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[m[2]!.toLowerCase() as 'b' | 'kb' | 'mb' | 'gb']
  return Number(m[1]) * unit
}

// El valor de una opción: un literal 'NNmb' o una constante del mismo archivo.
function valueOf(option: string): string {
  const m = new RegExp(`${option}\\s*:\\s*([A-Z_]+|'[^']+')`).exec(CONFIG)
  if (!m) throw new Error(`${option} no está configurado en next.config.ts`)
  const raw = m[1]!
  if (raw.startsWith("'")) return raw.slice(1, -1)
  const c = new RegExp(`const\\s+${raw}\\s*=\\s*'([^']+)'`).exec(CONFIG)
  if (!c) throw new Error(`no encontré la constante ${raw}`)
  return c[1]!
}

describe('next.config — límites de body', () => {
  it('serverActions.bodySizeLimit sigue en 20 MB', () => {
    expect(bytes(valueOf('bodySizeLimit'))).toBe(20 * 1024 ** 2)
  })

  it('el middleware no corta bodies que una Server Action acepta', () => {
    expect(bytes(valueOf('middlewareClientMaxBodySize')))
      .toBeGreaterThanOrEqual(bytes(valueOf('bodySizeLimit')))
  })
})
