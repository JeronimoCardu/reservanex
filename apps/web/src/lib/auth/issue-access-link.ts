import { createAdminClient } from '@orderflow/supabase/admin'
import { getAuthRedirectTo } from '@/lib/site-url'

// ════════════════════════════════════════════════════════════════════════════
// Emitir un link de acceso SIN que Supabase mande el email.
//
// ensureInvitedUser() usa inviteUserByEmail(), que acuña el token Y envía el
// template global del Dashboard. Sirve, pero ata el diseño del email a una
// caja de texto fuera del repo y manda lo mismo a un owner, a una recepcionista
// y a un seller.
//
// generateLink() hace exactamente la otra mitad: acuña el token y NO envía
// nada — el SDK lo documenta como "generates email links and OTPs to be sent
// via a custom email provider". Con eso, el email lo arma ReservaNex y lo
// entrega Resend.
//
// LO QUE NO CAMBIA, y es el punto:
//
//   · El token lo sigue acuñando GoTrue: un solo uso, su propia expiración,
//     ligado al usuario correcto. Acá NO se fabrica ningún token.
//   · La URL es la canónica de siempre — getAuthRedirectTo() + token_hash +
//     type — y la canjea /auth/confirm con verifyOtp, igual que hoy.
//   · El rol NO viaja en el token ni concede nada: la autorización sigue en
//     platform_users / tenant_users y en custom_access_token_hook.
//
// ensureInvitedUser() queda intacta y en uso para los flujos no migrados.
// Los clasificadores de error están duplicados a propósito: son privados de
// ese módulo y exportarlos habría significado tocarlo. Es deuda conocida y
// menor; la alternativa era modificar un camino probado en producción.
// ════════════════════════════════════════════════════════════════════════════

export const ACCESS_LINK_RATE_LIMIT       = 'ACCESS_LINK_RATE_LIMIT'
export const ACCESS_LINK_REDIRECT_INVALID = 'ACCESS_LINK_REDIRECT_INVALID'
/** El usuario ya está confirmado y quien llama pidió NO degradar a recovery. */
export const ACCESS_LINK_CONFIRMED_OTHER  = 'ACCESS_LINK_USER_CONFIRMED_OTHER_CONTEXT'
export const ACCESS_LINK_FAILED           = 'ACCESS_LINK_FAILED'

export type AccessLinkKind = 'invite' | 'recovery'

export interface AccessLink {
  /** auth.users.id — lo necesitan platform_users / tenant_users. */
  userId: string
  kind:   AccessLinkKind
  /** URL completa de /auth/confirm. SECRETO: nunca loguear ni persistir. */
  url:    string
  /**
   * El usuario de Auth se creó en ESTA llamada.
   *
   * Lo usa el alta de tenant_users para decidir si, ante un fallo posterior,
   * puede borrar el usuario de Auth: si ya existía (por ejemplo, porque
   * pertenece a otro tenant), borrarlo destruiría su cuenta en otro lado.
   * Mismo criterio y misma ventana que ensureInvitedUser.
   */
  isNewUser: boolean
}

/** Ventana para considerar que el usuario nació en esta request. */
const NEW_USER_WINDOW_MS = 30_000

function bornNow(createdAt: string | undefined): boolean {
  if (!createdAt) return false
  const ms = new Date(createdAt).getTime()
  return Number.isFinite(ms) && Date.now() - ms < NEW_USER_WINDOW_MS
}

type AuthErr = { message?: string; code?: string; status?: number } | null | undefined

// ── Clasificadores (copia de ensure-invited-user.ts, ver cabecera) ──────────

function isRateLimit(e: AuthErr): boolean {
  if (!e) return false
  const msg  = (e.message ?? '').toLowerCase()
  const code = e.code ?? ''
  return (e.status ?? 0) === 429
      || msg.includes('rate limit')
      || msg.includes('too many')
      || code === 'over_email_send_rate_limit'
}

function isAlreadyExists(e: AuthErr): boolean {
  if (!e) return false
  const msg  = (e.message ?? '').toLowerCase()
  const code = e.code ?? ''
  return msg.includes('already been registered')
      || msg.includes('already registered')
      || msg.includes('already exists')
      || code === 'email_exists'
      || code === 'user_already_exists'
}

function isRedirectInvalid(e: AuthErr): boolean {
  if (!e) return false
  const msg = (e.message ?? '').toLowerCase()
  return msg.includes('redirect')
      || msg.includes('not allowed')
      || msg.includes('invalid url')
}

/** Log sanitizado: código, estado y un recorte del mensaje. NUNCA el token. */
function logStep(op: string, err: AuthErr, extra?: Record<string, unknown>): void {
  if (!err) return
  console.warn(`[issue-access-link] ${op} failed`, {
    code: err.code, status: err.status, message: (err.message ?? '').slice(0, 300), ...extra,
  })
}

/**
 * La URL canónica de canje. Un solo lugar la arma, y usa el helper de siempre
 * para el origen — nada de magic strings ni de `properties.action_link` (que
 * apunta a /auth/v1/verify y devuelve el token en el fragmento, ilegible
 * server-side: es justamente el bug que costó varias rondas en su momento).
 */
function buildAccessUrl(hashedToken: string, kind: AccessLinkKind): string {
  const params = new URLSearchParams({ token_hash: hashedToken, type: kind })
  return `${getAuthRedirectTo()}?${params.toString()}`
}

/**
 * Emite el link de acceso para `email`, creando el usuario de Auth si hace
 * falta. NO envía ningún email.
 *
 * Reproduce la matriz de ensureInvitedUser() para los flujos migrados:
 *
 *   A/B  usuario nuevo o invitación pendiente  → generateLink('invite')   → kind 'invite'
 *   C/D  usuario ya confirmado                 → generateLink('recovery') → kind 'recovery'
 *        …salvo que allowRecoveryForConfirmed sea false, y entonces se corta
 *        con ACCESS_LINK_CONFIRMED_OTHER — el mismo bloqueo que hoy aplica el
 *        alta de usuarios de tenant.
 *
 * @throws ACCESS_LINK_RATE_LIMIT | ACCESS_LINK_REDIRECT_INVALID |
 *         ACCESS_LINK_CONFIRMED_OTHER | ACCESS_LINK_FAILED
 */
export async function issueAccessLink(
  email: string,
  options: { allowRecoveryForConfirmed: boolean },
): Promise<AccessLink> {
  const admin      = createAdminClient()
  const redirectTo = getAuthRedirectTo()

  // ── Paso 1: invite ────────────────────────────────────────────────────────
  // generateLink con type 'invite' crea el usuario si no existe y refresca el
  // token si existe pero no confirmó. No manda nada.
  const { data: inviteData, error: inviteErr } = await admin.auth.admin.generateLink({
    type: 'invite',
    email,
    options: { redirectTo },
  })

  if (!inviteErr && inviteData?.user?.id && inviteData.properties?.hashed_token) {
    return {
      userId:    inviteData.user.id,
      kind:      'invite',
      url:       buildAccessUrl(inviteData.properties.hashed_token, 'invite'),
      isNewUser: bornNow(inviteData.user.created_at),
    }
  }

  logStep('generateLink(invite)', inviteErr, { email })

  if (isRateLimit(inviteErr))       throw new Error(ACCESS_LINK_RATE_LIMIT)
  if (isRedirectInvalid(inviteErr)) throw new Error(ACCESS_LINK_REDIRECT_INVALID)

  // ── Paso 2: el usuario ya está confirmado ────────────────────────────────
  if (isAlreadyExists(inviteErr)) {
    if (!options.allowRecoveryForConfirmed) {
      throw new Error(ACCESS_LINK_CONFIRMED_OTHER)
    }

    const { data: recData, error: recErr } = await admin.auth.admin.generateLink({
      type: 'recovery',
      email,
      options: { redirectTo },
    })

    if (!recErr && recData?.user?.id && recData.properties?.hashed_token) {
      return {
        userId:    recData.user.id,
        kind:      'recovery',
        url:       buildAccessUrl(recData.properties.hashed_token, 'recovery'),
        // Un recovery implica que la cuenta ya existía y estaba confirmada.
        isNewUser: false,
      }
    }

    logStep('generateLink(recovery)', recErr, { email })
    if (isRateLimit(recErr))       throw new Error(ACCESS_LINK_RATE_LIMIT)
    if (isRedirectInvalid(recErr)) throw new Error(ACCESS_LINK_REDIRECT_INVALID)
    throw new Error(ACCESS_LINK_FAILED)
  }

  // Cualquier otro fallo: no se inventa un link ni se sigue como si nada.
  throw new Error(ACCESS_LINK_FAILED)
}
