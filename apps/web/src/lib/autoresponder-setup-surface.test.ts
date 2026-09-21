import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { getAutoResponderEndpoints, getAutoResponderPublicBaseUrl } from './autoresponder-public-url'

// ════════════════════════════════════════════════════════════════════════════
// La pantalla de setup de WhatsApp en /platform/tenants/[id]/whatsapp, en V2.
//
// V2 pone en marcha un cliente con WhatsApp / WhatsApp Business en un Android
// + AutoResponder for WA. MacroDroid se retiró en Fase 1B/2A y Meta Cloud API
// sigue soportado en el backend pero no es el camino de un alta nueva.
//
// Sin entorno DOM: lo puro se prueba puro y lo de React con aserciones
// estructurales sobre el fuente, con comentarios descartados.
// ════════════════════════════════════════════════════════════════════════════

const SRC  = path.resolve(import.meta.dirname, '..')
const leer = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8')

function soloCodigo(texto: string): string {
  return texto
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
}

const WA = ['app', '(platform)', 'platform', 'tenants', '[id]', 'whatsapp'] as const
const PAGINA = soloCodigo(leer(...WA, 'page.tsx'))
const GUIA   = soloCodigo(leer(...WA, 'android-install-guide.tsx'))

// ── 1. MacroDroid ───────────────────────────────────────────────────────────

describe('1. MacroDroid no forma parte del setup actual', () => {
  it('ningún título ni sección de la pantalla lo nombra', () => {
    expect(PAGINA).not.toMatch(/MacroDroid/)
  })

  it('la guía sólo lo menciona para decir que NO se instala', () => {
    // La única línea viva que lo nombra es la que le ahorra al instalador
    // instalar algo que no sirve. Cualquier otra mención sería una instrucción.
    const menciones = [...GUIA.matchAll(/MacroDroid[^<\n]*/g)].map((m) => m[0])
    expect(menciones.length).toBe(1)
    expect(menciones[0]).toMatch(/ya no se usa/)
  })

  it('el formulario de AutoResponder no pide la URL de MacroDroid', () => {
    const form = soloCodigo(leer(...WA, 'autoresponder-platform-form.tsx'))
    expect(form).not.toMatch(/macrodroid/i)
  })
})

// ── 2 y 3. Meta secundario, AutoResponder primero ───────────────────────────

describe('2 y 3. AutoResponder es el proveedor priorizado', () => {
  it('AutoResponder y su guía van antes que Meta en la página', () => {
    const iAuto = PAGINA.indexOf('AutoResponder for WA')
    const iGuia = PAGINA.indexOf('Instalación Android')
    const iMeta = PAGINA.indexOf('Meta (WhatsApp Cloud API)')
    expect(iAuto).toBeGreaterThan(-1)
    expect(iGuia).toBeGreaterThan(iAuto)
    expect(iMeta).toBeGreaterThan(iGuia)
  })

  it('Meta queda colapsado y marcado como alternativo', () => {
    expect(PAGINA).toContain('<details')
    expect(PAGINA).toContain('proveedor alternativo')
    // Y no se eliminó: sigue montando su formulario.
    expect(PAGINA).toContain('<WhatsAppPlatformForm')
  })

  it('la página explica que un alta AutoResponder no necesita Meta', () => {
    expect(PAGINA).toMatch(/no necesita nada de esta sección/)
  })

  it('crear la cuenta AutoResponder no toca nada de Meta', () => {
    const accion = soloCodigo(leer('actions', 'platform-autoresponder.ts'))
    const i = accion.indexOf('export async function createAutoResponderAccountAction')
    const cuerpo = accion.slice(i, accion.indexOf('export async function', i + 10))
    expect(cuerpo).toContain("provider:               'autoresponder'")
    expect(cuerpo).not.toMatch(/phone_number_id|waba_id|access_token|meta/i)
    // Y tampoco mueve el onboarding.
    expect(cuerpo).not.toContain('onboarding_status')
  })
})

// ── 4 y 5. La URL pública ───────────────────────────────────────────────────

describe('4 y 5. URL pública canónica', () => {
  const original = process.env.AUTORESPONDER_PUBLIC_BASE_URL
  beforeEach(() => { delete process.env.AUTORESPONDER_PUBLIC_BASE_URL })
  afterEach(() => {
    if (original === undefined) delete process.env.AUTORESPONDER_PUBLIC_BASE_URL
    else process.env.AUTORESPONDER_PUBLIC_BASE_URL = original
  })

  it('producción: reservanex.com genera los dos endpoints exactos', () => {
    process.env.AUTORESPONDER_PUBLIC_BASE_URL = 'https://reservanex.com'
    expect(getAutoResponderEndpoints()).toEqual({
      inbound:   'https://reservanex.com/api/webhooks/autoresponder',
      heartbeat: 'https://reservanex.com/api/webhooks/autoresponder/heartbeat',
    })
  })

  it('desarrollo: un túnel HTTPS es aceptado tal cual, con la barra final normalizada', () => {
    process.env.AUTORESPONDER_PUBLIC_BASE_URL = 'https://abc123.ngrok-free.app/'
    expect(getAutoResponderPublicBaseUrl()).toBe('https://abc123.ngrok-free.app')
    expect(getAutoResponderEndpoints().inbound).toBe('https://abc123.ngrok-free.app/api/webhooks/autoresponder')
  })

  it('localhost nunca se presenta como alcanzable por el Android', () => {
    for (const malo of ['https://localhost:3001', 'https://127.0.0.1:3001', 'http://localhost:3001']) {
      process.env.AUTORESPONDER_PUBLIC_BASE_URL = malo
      expect(() => getAutoResponderPublicBaseUrl(), malo).toThrow()
    }
  })

  it('los endpoints cuelgan de la app WEB, no del worker interno', () => {
    // El Android habla con /api/webhooks/autoresponder (Next.js). El worker
    // vive en WORKER_INTERNAL_URL y nunca se expone: la ruta web le reenvía.
    process.env.AUTORESPONDER_PUBLIC_BASE_URL = 'https://x.example'
    const e = getAutoResponderEndpoints()
    expect(e.inbound).toMatch(/\/api\/webhooks\/autoresponder$/)
    expect(e.inbound).not.toMatch(/internal|8788/)
    const ruta = soloCodigo(leer('app', 'api', 'webhooks', 'autoresponder', 'route.ts'))
    expect(ruta).toContain("'/internal/autoresponder/process'")
  })

  it('la página muestra el error de configuración inline en vez de romperse', () => {
    expect(PAGINA).toContain('endpointsResult = { ok: false, error:')
  })
})

// ── 8. La guía es V2 ────────────────────────────────────────────────────────

describe('8. la guía de instalación corresponde a V2', () => {
  it('tiene los cinco pasos, en orden', () => {
    const titulos = [...GUIA.matchAll(/<CollapsibleSection n=\{(\d)\} title="([^"]+)"/g)].map((m) => `${m[1]}. ${m[2]}`)
    expect(titulos).toEqual([
      '1. Preparar Android', '2. WhatsApp Business', '3. AutoResponder', '4. Señal de vida', '5. Probar instalación',
    ])
  })

  it('el handoff humano ocurre en el teléfono, no en un CRM de chat', () => {
    expect(GUIA).toMatch(/Handoff humano[^\n]*WhatsApp Web[^\n]*propio teléfono/)
    expect(GUIA).toMatch(/ya no envía mensajes manuales/)
  })

  it('pantalla apagada y segundo plano siguen en la prueba', () => {
    expect(GUIA).toMatch(/Pantalla apagada/)
    expect(GUIA).toMatch(/segundo plano/)
  })
})

// ── Heartbeat V2: verificación por prueba E2E, endpoint opcional ────────────

describe('heartbeat V2', () => {
  const PASO4 = (() => {
    const i = GUIA.indexOf('<CollapsibleSection n={4}')
    const f = GUIA.indexOf('<CollapsibleSection n={5}')
    return GUIA.slice(i, f)
  })()

  it('F. la guía NO exige un heartbeat periódico', () => {
    expect(PASO4).not.toMatch(/cada \{?\w* ?minutos/)
    expect(PASO4).not.toMatch(/POST cada/)
    expect(GUIA).not.toContain('HEARTBEAT_INTERVAL_MINUTES')
  })

  it('G. la guía NO exige MacroDroid ni scheduler ni app auxiliar', () => {
    // Que lo NIEGUE está bien; que lo INSTRUYA no. La frase vieja era
    // 'Configurá en AutoResponder (o en cualquier scheduler del teléfono)'.
    expect(PASO4).not.toMatch(/en cualquier scheduler|Configur[aá][^.]*scheduler/i)
    expect(PASO4).toMatch(/ningún scheduler/)
    expect(PASO4).not.toMatch(/MacroDroid/)
    expect(PASO4).toMatch(/Ninguna app auxiliar/)
  })

  it('la guía explica que la actividad se registra sola con el inbound autenticado', () => {
    expect(PASO4).toMatch(/registra actividad automáticamente/)
    expect(PASO4).toMatch(/mensaje autenticado al webhook/)
    expect(PASO4).toMatch(/verificado/)
  })

  it('el endpoint de heartbeat se menciona como OPCIONAL y colapsado, no como paso', () => {
    expect(PASO4).toContain('<details')
    expect(PASO4).toMatch(/opcional/i)
    expect(PASO4).toMatch(/no lo necesita/)
    expect(PASO4).toContain('ep.heartbeat')
  })

  it('H. el endpoint de heartbeat sigue existiendo y autenticado por device token', () => {
    const ruta = soloCodigo(leer('app', 'api', 'webhooks', 'autoresponder', 'heartbeat', 'route.ts'))
    expect(ruta).toContain("'x-reservanex-device-token'")
    expect(ruta).toContain('hashDeviceToken(')
    expect(ruta).toContain('last_device_seen_at')
    expect(ruta).toMatch(/status: 401/)
  })

  it('I. el inbound sigue marcando last_device_seen_at en cada request autenticado', () => {
    const ruta = soloCodigo(leer('app', 'api', 'webhooks', 'autoresponder', 'route.ts'))
    expect(ruta).toContain('async markDeviceSeen(accountId)')
    expect(ruta).toContain('.update({ last_device_seen_at: now, last_inbound_at: now })')
  })

  it('J. markDeviceSeen corre DESPUÉS de autenticar: un token inválido no verifica nada', () => {
    const wh = soloCodigo(leer('lib', 'autoresponder-webhook.ts'))
    const iInvalido = wh.indexOf("outcome: 'rejected_invalid_token'")
    const iSinToken = wh.indexOf("outcome: 'rejected_no_token'")
    const iSeen     = wh.indexOf('await deps.markDeviceSeen(account.id)')
    expect(iInvalido).toBeGreaterThan(-1)
    expect(iSinToken).toBeGreaterThan(-1)
    expect(iSeen).toBeGreaterThan(iInvalido)
    expect(iSeen).toBeGreaterThan(iSinToken)
  })

  it('3. los labels de health describen actividad, nunca conectividad física', () => {
    const dh = soloCodigo(leer('lib', 'autoresponder-device-health.ts'))
    const m = dh.match(/DEVICE_STATUS_LABEL: Record<DeviceStatus, string> = \{[\s\S]*?\n\}/)!
    expect(m[0]).not.toMatch(/'Online'|'Offline'/)
    expect(m[0]).toContain("'Actividad reciente'")
    expect(m[0]).toContain("'Sin actividad reciente'")
    expect(m[0]).toContain("'Sin actividad hace tiempo'")
    // Y los umbrales no se tocaron.
    expect(dh).toContain('DEVICE_ONLINE_THRESHOLD_MS = 5 * 60 * 1000')
    expect(dh).toContain('DEVICE_STALE_THRESHOLD_MS  = 15 * 60 * 1000')
  })
})
