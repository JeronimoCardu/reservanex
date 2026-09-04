import { createAdminClient } from '@orderflow/supabase/admin'
import { createClient } from '@orderflow/supabase/server'

// ─── Sentinels ─────────────────────────────────────────────────────────────────
// Thrown by ensureInvitedUser so callers can map to user-facing messages.
export const ENSURE_RATE_LIMIT       = 'ENSURE_INVITE_RATE_LIMIT'
export const ENSURE_REDIRECT_INVALID = 'ENSURE_REDIRECT_URL_INVALID'
// Thrown when sendRecoveryToConfirmed=false and user is already confirmed elsewhere.
export const ENSURE_CONFIRMED_OTHER  = 'ENSURE_USER_CONFIRMED_OTHER_CONTEXT'

// ─── Types ─────────────────────────────────────────────────────────────────────

export type EnsureInvitedStatus =
  | 'invited'        // Case A: new user created + invite email sent
                     // Case B: unconfirmed existing user — invite email resent
  | 'recovery_sent'  // Case C/D: confirmed user — recovery/magic link email sent
  | 'email_not_sent' // Fallback: generateLink used, no email sent (warn user)

export type EnsureInvitedResult = {
  status:    EnsureInvitedStatus
  authUserId: string
  isNewUser:  boolean // true only when auth user was created in this call (for rollback guard)
  // Only set when status === 'email_not_sent' (Supabase couldn't deliver the
  // email itself, e.g. SMTP not configured yet). A same-origin, one-time
  // confirm link built from a freshly generated hashed_token — NOT the raw
  // Supabase action_link, which routes through supabase.co/auth/v1/verify
  // and can surface a confusing "otp_expired" page (see the standalone
  // scripts/generate-invite-link.ts this replaces for real-client use).
  // Callers must treat this as a bearer secret: surface it once to the
  // platform admin, never log it, never persist it.
  inviteLink?: string
  // Only set when status === 'email_not_sent' — the SANITIZED (code/status/
  // message only, never a token) reason the actual send attempt failed, so
  // callers can show the admin something more useful than a bare "no se
  // pudo enviar" (see sanitizeAuthErr below — this is the fix for a real
  // bug where an unclassified Supabase/SMTP error was silently swallowed
  // and never reached any log or UI).
  lastErrorCode?:    string
  lastErrorMessage?: string
}

// Same-origin confirm link (not Supabase's own action_link — see
// EnsureInvitedResult.inviteLink doc comment above for why). Exported only
// for unit testing — not part of the module's intended public surface.
export function buildLocalConfirmLink(redirectTo: string, hashedToken: string, type: 'invite' | 'magiclink'): string {
  const origin = new URL(redirectTo).origin
  return `${origin}/auth/confirm?token_hash=${encodeURIComponent(hashedToken)}&type=${type}`
}

// ─── Error classifiers ─────────────────────────────────────────────────────────

type AuthErr = { message?: string; status?: number; code?: string } | null | undefined

function isRateLimit(e: AuthErr): boolean {
  if (!e) return false
  const msg  = (e.message ?? '').toLowerCase()
  const code = e.code ?? ''
  return (
    (e.status ?? 0) === 429 ||
    msg.includes('rate limit') ||
    code.includes('rate_limit') ||
    code === 'over_email_send_rate_limit' ||
    code === 'over_request_rate_limit'
  )
}

function isAlreadyExists(e: AuthErr): boolean {
  if (!e) return false
  const msg  = (e.message ?? '').toLowerCase()
  const code = e.code ?? ''
  return (
    msg.includes('already been registered') ||
    msg.includes('already registered') ||
    code === 'user_already_exists'
  )
}

function isRedirectInvalid(e: AuthErr): boolean {
  if (!e) return false
  const msg = (e.message ?? '').toLowerCase()
  return (
    msg.includes('redirect') ||
    msg.includes('not allowed') ||
    msg.includes('invalid url') ||
    msg.includes('redirect_to')
  )
}

// Sanitized (code/status/message only) shape for logs and for
// EnsureInvitedResult.lastError* — NEVER a token, action_link, token_hash,
// or service-role key; none of those ever reach this function's inputs in
// the first place, but this exists as the one place error text from
// Supabase is turned into something safe to log/display.
type SanitizedAuthErr = { code?: string; status?: number; message?: string }

function sanitizeAuthErr(e: AuthErr): SanitizedAuthErr | undefined {
  if (!e) return undefined
  return {
    code:    e.code,
    status:  e.status,
    message: (e.message ?? '').slice(0, 300),
  }
}

// Every branch of ensureInvitedUser logs through here — including the ones
// that don't match any of the three known classifiers below. Previously,
// an error that wasn't a rate limit / invalid redirect / "already exists"
// match was silently discarded (never logged anywhere), which is exactly
// what hid the real cause of a resend landing on status='email_not_sent'
// with zero visibility — see the Fase 8 "resend invite" report.
function logAuthStep(op: string, err: AuthErr, extra?: Record<string, unknown>): void {
  if (!err) return
  console.warn(`[ensure-invited-user] ${op} failed`, { ...sanitizeAuthErr(err), ...extra })
}

// ─── Helper ────────────────────────────────────────────────────────────────────

/**
 * Idempotent invite helper. Covers five cases:
 *
 *   A  New user (not in auth.users)                → inviteUserByEmail → 'invited'
 *   B  Unconfirmed pending invite                  → inviteUserByEmail resend → 'invited'
 *   C  Confirmed, has logged in                    → resetPasswordForEmail → 'recovery_sent'
 *   D  Confirmed, never logged in                  → resetPasswordForEmail → 'recovery_sent'
 *   E  Rate limit hit                              → throws ENSURE_RATE_LIMIT
 *      All-fail fallback                           → generateLink → 'email_not_sent'
 *
 * Case B was audited directly against the real linked Supabase project
 * (Fase 8 "resend invite" report): calling inviteUserByEmail again on an
 * unconfirmed existing user genuinely IS the correct native resend — it
 * issues a fresh token/expiry with no error, no special handling required.
 * A real bug this function used to have was NOT in that premise — it was
 * that any inviteUserByEmail/generateLink/resetPasswordForEmail failure that
 * didn't match one of the three named classifiers (isRateLimit /
 * isRedirectInvalid / isAlreadyExists) was silently discarded with zero
 * logging, so a genuine SMTP/Auth-provider rejection was indistinguishable
 * from "nothing went wrong, here's a fallback link." Every branch now logs
 * through logAuthStep() (sanitized — code/status/message only, never a
 * token) and the most relevant failure's code/message is returned via
 * EnsureInvitedResult.lastErrorCode/lastErrorMessage whenever status is
 * 'email_not_sent', so callers can show something more useful than a bare
 * "no se pudo enviar el email."
 *
 * @param email       Normalized (lowercase, trimmed) email address.
 * @param redirectTo  Auth callback URL for the invite/recovery link.
 * @param options.sendRecoveryToConfirmed
 *   When `false`, throws ENSURE_CONFIRMED_OTHER for already-confirmed users
 *   instead of sending a recovery email. Use in CREATE flows where inviting a
 *   confirmed user from another context should be blocked.
 */
export async function ensureInvitedUser(
  email: string,
  redirectTo: string,
  options: { sendRecoveryToConfirmed: boolean } = { sendRecoveryToConfirmed: true },
): Promise<EnsureInvitedResult> {
  const admin = createAdminClient()

  // ── Step 1: inviteUserByEmail — handles Case A (new) and Case B (unconfirmed) ──
  // Verified empirically (Fase 8 "resend invite" audit) that calling this
  // again on an unconfirmed existing user IS Supabase's real, correct resend
  // mechanism — it succeeds and issues a fresh token/expiry, no special-casing
  // needed. The bug this fixes was never in that premise; it was that ANY
  // failure here that isn't one of the three classifiers below used to be
  // silently discarded with zero logging, so a real SMTP/Auth rejection
  // (e.g. a Custom SMTP provider refusing the recipient) looked identical to
  // "everything's fine, here's a copyable link" with no way to tell why.
  const { data: inviteData, error: inviteErr } = await admin.auth.admin.inviteUserByEmail(
    email,
    { redirectTo },
  )

  if (!inviteErr && inviteData?.user?.id) {
    const user      = inviteData.user
    const createdAt = user.created_at ? new Date(user.created_at).getTime() : 0
    const isNewUser = Date.now() - createdAt < 30_000
    return { status: 'invited', authUserId: user.id, isNewUser }
  }

  // Log EVERY failure here, classified or not — this is the fix.
  logAuthStep('inviteUserByEmail', inviteErr, { email })
  const inviteErrSanitized = sanitizeAuthErr(inviteErr)

  // ── Classify first error ─────────────────────────────────────────────────────
  if (isRateLimit(inviteErr))       throw new Error(ENSURE_RATE_LIMIT)
  if (isRedirectInvalid(inviteErr)) throw new Error(ENSURE_REDIRECT_INVALID)

  // ── Step 2: User already confirmed (Case C / D) ──────────────────────────────
  if (isAlreadyExists(inviteErr)) {
    if (!options.sendRecoveryToConfirmed) {
      throw new Error(ENSURE_CONFIRMED_OTHER)
    }

    // Get user ID via generateLink (magiclink type, does not send email)
    const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
      type:    'magiclink',
      email,
      options: { redirectTo },
    })
    logAuthStep('generateLink(magiclink)', linkErr, { email })

    if (!linkErr && linkData?.user?.id) {
      const authUserId = linkData.user.id
      // Send recovery email through Supabase's configured email provider
      const supabase = await createClient()
      const { error: recovErr } = await supabase.auth.resetPasswordForEmail(email, { redirectTo })
      if (!recovErr) {
        return { status: 'recovery_sent', authUserId, isNewUser: false }
      }
      // Previously silent — this is the other half of the fix: recovErr was
      // never logged or returned to the caller at all.
      logAuthStep('resetPasswordForEmail', recovErr, { email })
      const recovErrSanitized = sanitizeAuthErr(recovErr)
      // Email send failed — return id (+ a copyable link) so callers can
      // still register the user and hand the admin something usable.
      const hashedToken = linkData.properties?.hashed_token
      return {
        status: 'email_not_sent',
        authUserId,
        isNewUser: false,
        inviteLink: hashedToken ? buildLocalConfirmLink(redirectTo, hashedToken, 'magiclink') : undefined,
        lastErrorCode:    recovErrSanitized?.code,
        lastErrorMessage: recovErrSanitized?.message,
      }
    }

    // magiclink generateLink also failed — fall back to invite type for the user ID
    const { data: invData, error: invErr2 } = await admin.auth.admin.generateLink({
      type:    'invite',
      email,
      options: { redirectTo },
    })
    logAuthStep('generateLink(invite, after magiclink failure)', invErr2, { email })
    if (!invErr2 && invData?.user?.id) {
      const hashedToken = invData.properties?.hashed_token
      const linkErrSanitized = sanitizeAuthErr(linkErr)
      return {
        status: 'email_not_sent',
        authUserId: invData.user.id,
        isNewUser: false,
        inviteLink: hashedToken ? buildLocalConfirmLink(redirectTo, hashedToken, 'invite') : undefined,
        lastErrorCode:    linkErrSanitized?.code,
        lastErrorMessage: linkErrSanitized?.message,
      }
    }

    throw new Error('No se pudo obtener el ID del usuario confirmado. Intentá de nuevo.')
  }

  // ── Step 3: Unknown error from inviteUserByEmail → generateLink fallback ─────
  const { data: fbData, error: fbErr } = await admin.auth.admin.generateLink({
    type:    'invite',
    email,
    options: { redirectTo },
  })
  logAuthStep('generateLink(invite, fallback)', fbErr, { email })

  if (!fbErr && fbData?.user?.id) {
    const hashedToken = fbData.properties?.hashed_token
    return {
      status: 'email_not_sent',
      authUserId: fbData.user.id,
      isNewUser: false,
      inviteLink: hashedToken ? buildLocalConfirmLink(redirectTo, hashedToken, 'invite') : undefined,
      // The inviteUserByEmail failure from Step 1 is the actually-useful
      // reason here — the fallback generateLink succeeding tells us nothing
      // about WHY the real send failed.
      lastErrorCode:    inviteErrSanitized?.code,
      lastErrorMessage: inviteErrSanitized?.message,
    }
  }

  if (isRateLimit(fbErr)) throw new Error(ENSURE_RATE_LIMIT)
  throw new Error('Error al generar la invitación. Intentá de nuevo.')
}
