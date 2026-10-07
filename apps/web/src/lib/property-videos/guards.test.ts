import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// Property Videos Fase 2A — guards estructurales. Leen el código fuente (sin
// comentarios) para que la migración de la Fase 2B/2C no reintroduzca lo que
// esta fase separó:
//   · el nuevo flujo TUS nunca manda el File a una Server Action ni a ReservaNex;
//   · el inspector nunca trae el video entero (storage.download) ni conoce Supabase;
//   · el token de subida firmada nunca va a logs ni se persiste;
//   · los límites tienen una sola fuente;
//   · mientras tanto, uploadPropertyVideoAction sigue siendo la subida productiva.

const SRC = path.resolve(import.meta.dirname, '..', '..')
const LIB = path.join(SRC, 'lib', 'property-videos')

function soloCodigo(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n')
}

function leer(file: string): string {
  return soloCodigo(fs.readFileSync(file, 'utf8'))
}

function archivosFuente(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return archivosFuente(full)
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [full] : []
  })
}

// Código que se publica: src/ sin tests ni helpers de test (src/testing).
const FUENTES = archivosFuente(SRC)
  .map((file) => ({ file, rel: path.relative(SRC, file).replace(/\\/g, '/'), code: leer(file) }))
  .filter(({ rel }) => !rel.startsWith('testing/'))
const importan = (modulo: RegExp) => FUENTES.filter(({ code }) => modulo.test(code))

const UPLOADER = 'lib/property-videos/resumable-upload.ts'
const INSPECTOR = [
  'lib/property-videos/range-reader.ts',
  'lib/property-videos/inspect-video.ts',
  'lib/property-videos/inspect-isobmff.ts',
  'lib/property-videos/inspect-webm.ts',
  'lib/property-videos/inspection-types.ts',
  'lib/property-videos/validation.ts',
]
const codigoDe = (rel: string) => FUENTES.find((f) => f.rel === rel)!.code

describe('guard — el flujo TUS nunca manda el File a una Server Action ni a ReservaNex', () => {
  const uploader = codigoDe(UPLOADER)

  it('el uploader no usa fetch, FormData, acciones ni "use server"', () => {
    expect(uploader).not.toMatch(/\bfetch\s*\(/)
    expect(uploader).not.toMatch(/\bFormData\b/)
    expect(uploader).not.toMatch(/@\/actions/)
    expect(uploader).not.toMatch(/['"]use server['"]/)
    expect(uploader).not.toMatch(/['"]\/api\//)
  })

  it('tus-js-client se importa sólo desde el uploader', () => {
    expect(importan(/^import (?!type\b)[^\n]*from ['"]tus-js-client['"]/m).map((f) => f.rel)).toEqual([UPLOADER])
  })

  it('ningún archivo "use server" importa el uploader ni tus-js-client', () => {
    const servidor = FUENTES.filter(({ code }) => /^\s*['"]use server['"]/.test(code))
    expect(servidor.length).toBeGreaterThan(0)
    for (const { rel, code } of servidor) {
      expect(code, rel).not.toMatch(/resumable-upload|tus-js-client/)
    }
  })

  it('quien use el uploader no puede usar también uploadPropertyVideoAction ni armar FormData', () => {
    for (const { rel, code } of importan(/property-videos\/resumable-upload['"]/)) {
      expect(code, rel).not.toMatch(/uploadPropertyVideoAction/)
      expect(code, rel).not.toMatch(/new FormData\b/)
    }
  })

  it('Fase 2A: ningún componente productivo usa todavía el uploader (se conecta en 2B/2C)', () => {
    expect(importan(/property-videos\/resumable-upload['"]/).map((f) => f.rel)).toEqual([])
  })
})

describe('guard — endpoint TUS cerrado al proyecto', () => {
  const uploader = codigoDe(UPLOADER)

  it('la entrada productiva recibe projectRef, no un endpoint/URL', () => {
    const contrato = /export interface ResumableVideoUploadInput \{([\s\S]*?)\n\}/.exec(uploader)?.[1] ?? ''
    expect(contrato).toMatch(/projectRef: string/)
    expect(contrato).not.toMatch(/endpoint|url|origin|host/i)
  })

  it('el endpoint se arma sólo con el host de Storage del proyecto, por https', () => {
    expect(uploader).toMatch(/`https:\/\/\$\{projectRef\}\.storage\.supabase\.co\$\{SUPABASE_RESUMABLE_UPLOAD_PATH\}`/)
    expect(uploader).not.toMatch(/http:\/\/|localhost|127\.0\.0\.1/)
  })

  it('toda request pasa por el control de destino antes de enviarse', () => {
    expect(uploader).toMatch(/onBeforeRequest: \(req\) => assertUploadDestination\(req\.getURL\(\), endpoint\)/)
  })

  it('el seam de tests (pila HTTP inyectable) sólo se usa desde tests', () => {
    expect(FUENTES.filter(({ rel, code }) => rel !== UPLOADER && /ForTesting|ResumableUploadTestSeam/.test(code)).map((f) => f.rel)).toEqual([])
  })

  it('sin otras credenciales: ni Authorization, ni apikey, ni anon/service key', () => {
    expect(uploader).not.toMatch(/authorization|apikey|anon|service.?role|SUPABASE_[A-Z_]*KEY/i)
  })
})

describe('guard — el inspector lee por rangos y no conoce Supabase', () => {
  it.each(INSPECTOR)('%s: sin download, sin Supabase, sin fetch, sin logs', (rel) => {
    const code = codigoDe(rel)
    expect(code).not.toMatch(/\.download\s*\(/)
    expect(code).not.toMatch(/@supabase|@orderflow\/supabase|createClient|createAdminClient/)
    expect(code).not.toMatch(/\.storage\b/)
    expect(code).not.toMatch(/\bfetch\s*\(/)
    expect(code).not.toMatch(/\bconsole\./)
  })

  it('arrayBuffer sólo aparece en el adapter de Blob, sobre un slice', () => {
    for (const rel of INSPECTOR) {
      const lines = codigoDe(rel).split('\n').filter((line) => /arrayBuffer\s*\(/.test(line))
      for (const line of lines) expect(line, rel).toMatch(/\.slice\(start, end\)\.arrayBuffer\(\)/)
    }
  })
})

describe('guard — el token de subida firmada no va a logs ni se persiste', () => {
  const uploader = codigoDe(UPLOADER)

  it('el uploader no escribe en consola ni activa el log de tus-js-client', () => {
    expect(uploader).not.toMatch(/\bconsole\./)
    expect(uploader).not.toMatch(/enableDebugLog/)
  })

  it('el uploader no toca storage del browser y desactiva el fingerprint de tus', () => {
    expect(uploader).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/)
    expect(uploader).toMatch(/storeFingerprintForResuming:\s*false/)
    expect(uploader).toMatch(/urlStorage:\s*NO_URL_STORAGE/)
  })

  it('el token sólo viaja en el header x-signature (nunca en la URL)', () => {
    const usos = uploader.split('\n').filter((line) => /signedUploadToken/.test(line)).map((line) => line.trim())
    expect(usos).toEqual([
      'signedUploadToken: string',
      "'x-signature': input.signedUploadToken,",
      "if (!input.signedUploadToken) throw new TypeError('falta el token de subida firmada')",
    ])
    expect(uploader).not.toMatch(/searchParams|[?&]token=/)
  })

  it('ningún módulo de property-videos escribe en consola', () => {
    for (const file of archivosFuente(LIB)) {
      expect(leer(file), path.basename(file)).not.toMatch(/\bconsole\./)
    }
  })
})

describe('guard — límites con una sola fuente', () => {
  it('fuera de lib/property-videos nadie redeclara la lista de MIME ni 80 MB', () => {
    for (const { rel, code } of FUENTES) {
      if (rel.startsWith('lib/property-videos/')) continue
      expect(code, rel).not.toMatch(/video\/quicktime/)
      expect(code, rel).not.toMatch(/80\s*\*\s*1024\s*\*\s*1024|\b80\s?MB\b/)
    }
  })

  it('la UI y la Server Action toman los límites de limits.ts', () => {
    for (const rel of ['components/tenant/properties/property-video-manager.tsx', 'actions/properties.ts']) {
      expect(codigoDe(rel), rel).toMatch(/from ['"]@\/lib\/property-videos\/limits['"]/)
    }
  })
})

describe('guard — límite de transporte legacy (TEMPORAL) vs límite final', () => {
  const LEGACY_FLOW = ['components/tenant/properties/property-video-manager.tsx', 'actions/properties.ts']
  const NEW_PRIMITIVES = [UPLOADER, ...INSPECTOR]

  it('mientras la subida sea la Server Action, la UI y la acción usan el límite legacy, no el final', () => {
    for (const rel of LEGACY_FLOW) {
      const code = codigoDe(rel)
      expect(code, rel).toMatch(/LEGACY_VIDEO_UPLOAD_MAX_BYTES/)
      expect(code, rel).not.toMatch(/MAX_VIDEO_SIZE_BYTES|MAX_VIDEO_SIZE_LABEL|VIDEO_LIMIT_MESSAGES\.tooLarge\b/)
    }
  })

  it('toda comparación de tamaño del video en el flujo legacy es contra LEGACY_VIDEO_UPLOAD_MAX_BYTES', () => {
    const ui = codigoDe('components/tenant/properties/property-video-manager.tsx')
    const action = /export async function uploadPropertyVideoAction\([\s\S]*?\n\}\n/.exec(codigoDe('actions/properties.ts'))?.[0] ?? ''
    for (const [nombre, code] of [['UI', ui], ['uploadPropertyVideoAction', action]] as const) {
      const comparaciones = code.match(/file\.size\s*>=?\s*[^)\n]+/g) ?? []
      expect(comparaciones, nombre).toEqual(['file.size > LEGACY_VIDEO_UPLOAD_MAX_BYTES'])
    }
  })

  it('la UI muestra "máx. 4 MB" (el label legacy), no 50 MB', () => {
    const ui = codigoDe('components/tenant/properties/property-video-manager.tsx')
    expect(ui).toMatch(/máx\. \{LEGACY_VIDEO_UPLOAD_MAX_LABEL\}/)
    expect(ui).not.toMatch(/50\s?MB/)
  })

  it('las primitivas nuevas (TUS, inspección, validación) nunca usan el límite legacy', () => {
    for (const rel of NEW_PRIMITIVES) expect(codigoDe(rel), rel).not.toMatch(/LEGACY_/)
    for (const rel of [UPLOADER, 'lib/property-videos/validation.ts']) expect(codigoDe(rel), rel).toMatch(/MAX_VIDEO_SIZE_BYTES/)
  })

  it('el límite legacy vive en un conjunto acotado de archivos (para borrarlo al integrar TUS)', () => {
    expect(FUENTES.filter(({ code }) => /LEGACY_VIDEO_UPLOAD_MAX/.test(code)).map((f) => f.rel).sort()).toEqual([
      'actions/properties.ts',
      'components/tenant/properties/property-video-manager.tsx',
      'lib/property-videos/limits.ts',
    ])
  })
})

describe('guard — la subida productiva actual sigue intacta hasta la Fase 2B/2C', () => {
  it('uploadPropertyVideoAction existe y PropertyVideoManager la sigue usando', () => {
    expect(codigoDe('actions/properties.ts')).toMatch(/export async function uploadPropertyVideoAction\(/)
    expect(codigoDe('components/tenant/properties/property-video-manager.tsx')).toMatch(/await uploadPropertyVideoAction\(propertyId, fd\)/)
  })
})
