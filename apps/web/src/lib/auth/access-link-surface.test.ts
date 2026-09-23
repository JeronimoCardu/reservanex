import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// ════════════════════════════════════════════════════════════════════════════
// Invitaciones V2 — el contrato estructural de los flujos migrados.
//
// Lo que se cuida acá no se puede cuidar con un test de unidad: que un flujo
// migrado NO mande dos emails (el de Supabase y el nuestro), que el token no
// se loguee, y que la URL de canje siga siendo la canónica.
//
// La prohibición es acotada a propósito: inviteUserByEmail sigue siendo
// legítimo dentro de ensureInvitedUser, que queda intacto para lo no migrado.
// ════════════════════════════════════════════════════════════════════════════

const DIR = import.meta.dirname
const WEB = path.resolve(DIR, '..', '..', '..')
const leer = (rel: string) => fs.readFileSync(path.join(WEB, rel), 'utf8')

function soloCodigo(texto: string): string {
  return texto
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
}

/** Los archivos que implementan los tres flujos migrados. */
const FLUJOS_MIGRADOS = [
  'src/actions/platform.ts',                  // createSeller, resendSellerInvite, invitePrimaryTenantOwner
  'src/lib/repositories/users.repository.ts', // createTenantUser, resendUserAccess
]

describe('doble email — prohibido en los flujos migrados', () => {
  it.each(FLUJOS_MIGRADOS)('%s no llama inviteUserByEmail', (rel) => {
    expect(soloCodigo(leer(rel))).not.toContain('inviteUserByEmail')
  })

  it.each(FLUJOS_MIGRADOS)('%s tampoco usa ensureInvitedUser (que sí envía)', (rel) => {
    expect(soloCodigo(leer(rel))).not.toContain('ensureInvitedUser')
  })

  it.each(FLUJOS_MIGRADOS)('%s emite el acceso con issueAccessLink y envía con sendAccessEmail', (rel) => {
    const src = soloCodigo(leer(rel))
    expect(src).toContain('issueAccessLink(')
    expect(src).toContain('sendAccessEmail(')
  })

  it('exactamente un sender por flujo: tantos sendAccessEmail como issueAccessLink', () => {
    for (const rel of FLUJOS_MIGRADOS) {
      const src   = soloCodigo(leer(rel))
      const emite = (src.match(/issueAccessLink\(/g) ?? []).length
      const manda = (src.match(/sendAccessEmail\(/g) ?? []).length
      expect(manda, rel).toBe(emite)
    }
  })

  it('la prohibición NO es global: ensureInvitedUser sigue existiendo intacto', () => {
    const ensure = leer('src/lib/auth/ensure-invited-user.ts')
    expect(ensure).toContain('export async function ensureInvitedUser')
    expect(ensure).toContain('inviteUserByEmail')
  })
})

describe('issueAccessLink — contrato de seguridad', () => {
  const src = soloCodigo(leer('src/lib/auth/issue-access-link.ts'))

  it('usa generateLink (no envía) y nunca inviteUserByEmail (envía)', () => {
    expect(src).toContain('generateLink(')
    expect(src).not.toContain('inviteUserByEmail')
  })

  it('la URL sale del helper canónico + el hashed_token de Supabase', () => {
    expect(src).toContain('getAuthRedirectTo()')
    expect(src).toContain('hashed_token')
    expect(src).toContain("URLSearchParams({ token_hash: hashedToken, type: kind })")
  })

  it('NO usa action_link ni arma el origen a mano', () => {
    expect(src).not.toContain('action_link')
    expect(src).not.toContain('/auth/v1/verify')
    expect(src).not.toMatch(/['"`]\/auth\/confirm\?/)
  })

  it('no fabrica tokens: nada de crypto ni random para el secreto', () => {
    expect(src).not.toMatch(/randomBytes|randomUUID|createHash|jwt\.sign/)
  })

  it('los logs no pueden filtrar el token ni la URL', () => {
    // Cada console.* del módulo, con sus argumentos, no menciona el secreto.
    const logs = src.match(/console\.\w+\([\s\S]{0,320}?\)\n/g) ?? []
    expect(logs.length).toBeGreaterThan(0)
    for (const log of logs) {
      expect(log).not.toMatch(/hashed_token|\burl\b|accessUrl|buildAccessUrl/)
    }
  })

  it('los dos tipos posibles son exactamente los que /auth/confirm acepta', () => {
    expect(src).toContain("type: 'invite'")
    expect(src).toContain("type: 'recovery'")
    const confirm = leer('src/app/(auth)/auth/confirm/route.ts')
    expect(confirm).toContain("'invite'")
    expect(confirm).toContain("'recovery'")
    expect(confirm).toContain('verifyOtp')
  })

  it('el bloqueo del alta de tenant users se conserva', () => {
    expect(src).toContain('ACCESS_LINK_CONFIRMED_OTHER')
    expect(src).toContain('allowRecoveryForConfirmed')
    const repo = soloCodigo(leer('src/lib/repositories/users.repository.ts'))
    // El alta NO degrada a recovery; el reenvío sí.
    expect(repo).toContain('allowRecoveryForConfirmed: false')
    expect(repo).toContain('allowRecoveryForConfirmed: true')
  })
})

describe('sendAccessEmail — orden y secretos', () => {
  const src = soloCodigo(leer('src/lib/auth/send-access-email.ts'))

  it('no loguea la URL de acceso', () => {
    const logs = src.match(/console\.\w+\([\s\S]{0,320}?\)\n/g) ?? []
    for (const log of logs) expect(log).not.toMatch(/accessUrl|\burl\b/)
  })

  it('el sender es inyectable, así que ningún test automático manda de verdad', () => {
    expect(src).toContain('sender?:')
    expect(src).toContain('params.sender ?? createResendEmailSender()')
  })

  it('sin proveedor configurado no intenta enviar', () => {
    expect(src).toContain('isTransactionalEmailConfigured()')
    expect(src).toContain("reason: 'not_configured'")
  })
})

describe('orden de operaciones: persistir antes de enviar', () => {
  it('seller: el upsert de platform_users ocurre antes del envío', () => {
    const src = soloCodigo(leer('src/actions/platform.ts'))
    const i = src.indexOf('export async function createSellerAction')
    const cuerpo = src.slice(i, src.indexOf('export async function', i + 10))
    expect(cuerpo.indexOf("from('platform_users')\n    .upsert")).toBeGreaterThan(-1)
    expect(cuerpo.indexOf('.upsert(')).toBeLessThan(cuerpo.indexOf('sendAccessEmail('))
  })

  it('tenant user: el insert de tenant_users ocurre antes del envío', () => {
    const src = soloCodigo(leer('src/lib/repositories/users.repository.ts'))
    const i = src.indexOf('export async function createTenantUser')
    const cuerpo = src.slice(i, src.indexOf('export async function resendUserAccess'))
    expect(cuerpo.indexOf(".from('tenant_users')\n      .insert(")).toBeLessThan(cuerpo.indexOf('sendAccessEmail('))
  })

  it('owner: el upsert de tenant_users ocurre antes del envío', () => {
    const src = soloCodigo(leer('src/actions/platform.ts'))
    const i = src.indexOf('export async function invitePrimaryTenantOwnerAction')
    const cuerpo = src.slice(i, src.indexOf('export async function createSellerAction'))
    const upsert = cuerpo.lastIndexOf('.upsert(')
    const envio  = cuerpo.lastIndexOf('sendAccessEmail(')
    expect(upsert).toBeGreaterThan(-1)
    expect(upsert).toBeLessThan(envio)
  })

  it('owner: markOwnerInvited conserva su semántica — se marca aunque el email falle', () => {
    const src = soloCodigo(leer('src/actions/platform.ts'))
    const i = src.indexOf('export async function invitePrimaryTenantOwnerAction')
    const cuerpo = src.slice(i, src.indexOf('export async function createSellerAction'))
    // En el alta: marcar va ANTES de enviar, así que no depende del resultado.
    expect(cuerpo.lastIndexOf('markOwnerInvited')).toBeLessThan(cuerpo.lastIndexOf('sendAccessEmail('))
    // Y nunca condicionado al envío.
    expect(cuerpo).not.toMatch(/if\s*\([^)]*envio\.ok[^)]*\)\s*\{?\s*await repo\.markOwnerInvited/)
  })
})
