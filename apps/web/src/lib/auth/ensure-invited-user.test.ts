import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('@orderflow/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('@orderflow/supabase/server', () => ({ createClient: vi.fn() }))

import { createAdminClient } from '@orderflow/supabase/admin'
import { createClient } from '@orderflow/supabase/server'
import {
  ensureInvitedUser,
  buildLocalConfirmLink,
  ENSURE_RATE_LIMIT,
  ENSURE_REDIRECT_INVALID,
  ENSURE_CONFIRMED_OTHER,
} from './ensure-invited-user'

const EMAIL       = 'owner@example.test'
const REDIRECT_TO = 'http://localhost:3001/auth/confirm'

describe('buildLocalConfirmLink', () => {
  it('builds a same-origin /auth/confirm link with the token and type as query params', () => {
    const link = buildLocalConfirmLink('https://app.example.com/api/auth/callback', 'abc123', 'invite')
    expect(link).toBe('https://app.example.com/auth/confirm?token_hash=abc123&type=invite')
  })

  it('derives the origin from redirectTo regardless of its path', () => {
    const link = buildLocalConfirmLink('https://app.example.com/some/other/path', 'tok', 'invite')
    expect(link.startsWith('https://app.example.com/auth/confirm?')).toBe(true)
  })

  it('supports the magiclink type for already-confirmed users (Case C/D fallback)', () => {
    const link = buildLocalConfirmLink('https://app.example.com/api/auth/callback', 'tok', 'magiclink')
    expect(link).toContain('type=magiclink')
  })

  it('URL-encodes the hashed token', () => {
    const link = buildLocalConfirmLink('https://app.example.com/api/auth/callback', 'a b+c/d', 'invite')
    expect(link).toContain(`token_hash=${encodeURIComponent('a b+c/d')}`)
    expect(link).not.toContain('token_hash=a b+c/d')
  })

  it('produces the same link whether redirectTo is getAuthRedirectTo()\'s current /auth/confirm target or the legacy /api/auth/callback one — only the origin is ever used', () => {
    const viaNewTarget    = buildLocalConfirmLink('https://reservanex.com/auth/confirm', 'tok', 'invite')
    const viaLegacyTarget = buildLocalConfirmLink('https://reservanex.com/api/auth/callback', 'tok', 'invite')
    expect(viaNewTarget).toBe('https://reservanex.com/auth/confirm?token_hash=tok&type=invite')
    expect(viaNewTarget).toBe(viaLegacyTarget)
  })
})

// Fase 8 "resend invite" audit — traces the exact branch ensureInvitedUser()
// takes for each real state (new email / unconfirmed existing / confirmed
// existing), and specifically covers the bug found in production: a
// resend that failed at the actual Supabase/SMTP layer for a reason that
// didn't match any of the three named classifiers (isRateLimit /
// isRedirectInvalid / isAlreadyExists) used to be silently swallowed —
// zero logging, zero detail in the returned result — landing on
// status='email_not_sent' with no way to tell why. See ensure-invited-user.ts's
// own doc comment for the full narrative; these tests assert the fix.
describe('ensureInvitedUser', () => {
  type MockAdmin = {
    auth: {
      admin: {
        inviteUserByEmail: ReturnType<typeof vi.fn>
        generateLink:      ReturnType<typeof vi.fn>
      }
    }
  }

  function mockAdmin(overrides: Partial<{
    inviteUserByEmail: unknown
    generateLink:      unknown
  }> = {}): MockAdmin {
    const admin: MockAdmin = {
      auth: {
        admin: {
          inviteUserByEmail: vi.fn().mockResolvedValue(overrides.inviteUserByEmail ?? { data: null, error: { message: 'not mocked' } }),
          generateLink:      vi.fn().mockResolvedValue(overrides.generateLink ?? { data: null, error: { message: 'not mocked' } }),
        },
      },
    }
    vi.mocked(createAdminClient).mockReturnValue(admin as never)
    return admin
  }

  function mockServerClient(resetPasswordResult: { error: unknown }) {
    const resetPasswordForEmail = vi.fn().mockResolvedValue(resetPasswordResult)
    vi.mocked(createClient).mockResolvedValue({ auth: { resetPasswordForEmail } } as never)
    return resetPasswordForEmail
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('Case A — a brand new email: inviteUserByEmail succeeds → status=invited, isNewUser=true', async () => {
    mockAdmin({
      inviteUserByEmail: {
        data: { user: { id: 'user-1', created_at: new Date().toISOString() } },
        error: null,
      },
    })
    const result = await ensureInvitedUser(EMAIL, REDIRECT_TO)
    expect(result).toMatchObject({ status: 'invited', authUserId: 'user-1', isNewUser: true })
  })

  it('Case B — unconfirmed existing user (pending invite): a plain inviteUserByEmail resend succeeds → status=invited, isNewUser=false', async () => {
    mockAdmin({
      inviteUserByEmail: {
        data: { user: { id: 'user-2', created_at: new Date(Date.now() - 3_600_000).toISOString() } },
        error: null,
      },
    })
    const result = await ensureInvitedUser(EMAIL, REDIRECT_TO)
    expect(result).toMatchObject({ status: 'invited', authUserId: 'user-2', isNewUser: false })
  })

  it('resend generates a fresh token each call — inviteUserByEmail is actually invoked again, not skipped/cached', async () => {
    const admin = mockAdmin({
      inviteUserByEmail: { data: { user: { id: 'user-2', created_at: new Date().toISOString() } }, error: null },
    })
    await ensureInvitedUser(EMAIL, REDIRECT_TO)
    await ensureInvitedUser(EMAIL, REDIRECT_TO)
    expect(admin.auth.admin.inviteUserByEmail).toHaveBeenCalledTimes(2)
  })

  it('THE BUG: inviteUserByEmail fails with an unclassified error (e.g. SMTP/Auth-provider rejection) on a resend → falls through to the generateLink fallback (status=email_not_sent), but now surfaces the ORIGINAL sanitized error instead of silently discarding it', async () => {
    mockAdmin({
      inviteUserByEmail: { data: null, error: { message: 'SMTP provider rejected the request', status: 500, code: 'unexpected_failure' } },
      generateLink: { data: { user: { id: 'user-3' }, properties: { hashed_token: 'hash-abc' } }, error: null },
    })
    const result = await ensureInvitedUser(EMAIL, REDIRECT_TO)
    expect(result.status).toBe('email_not_sent')
    expect(result.authUserId).toBe('user-3')
    expect(result.inviteLink).toBe(`${new URL(REDIRECT_TO).origin}/auth/confirm?token_hash=hash-abc&type=invite`)
    // The fix: the real reason is no longer swallowed.
    expect(result.lastErrorCode).toBe('unexpected_failure')
    expect(result.lastErrorMessage).toContain('SMTP provider rejected')
  })

  it('logs the unclassified inviteUserByEmail failure server-side, sanitized (never a token/action_link/service-role value)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockAdmin({
      inviteUserByEmail: { data: null, error: { message: 'SMTP provider rejected the request', status: 500, code: 'unexpected_failure' } },
      generateLink: { data: { user: { id: 'user-3' }, properties: { hashed_token: 'super-secret-hash' } }, error: null },
    })
    await ensureInvitedUser(EMAIL, REDIRECT_TO)

    const loggedCalls = warnSpy.mock.calls.map((c) => JSON.stringify(c))
    expect(loggedCalls.some((c) => c.includes('unexpected_failure'))).toBe(true)
    expect(loggedCalls.some((c) => c.includes('SMTP provider rejected'))).toBe(true)
    // Never logs the hashed_token or any secret-shaped value.
    expect(loggedCalls.some((c) => c.includes('super-secret-hash'))).toBe(false)
    warnSpy.mockRestore()
  })

  it('Case C — confirmed existing owner: inviteUserByEmail reports "already registered" → magiclink + resetPasswordForEmail succeed → status=recovery_sent', async () => {
    mockAdmin({
      inviteUserByEmail: { data: null, error: { message: 'User already registered', code: 'user_already_exists' } },
      generateLink:      { data: { user: { id: 'user-4' }, properties: { hashed_token: 'hash-xyz' } }, error: null },
    })
    mockServerClient({ error: null })

    const result = await ensureInvitedUser(EMAIL, REDIRECT_TO)
    expect(result).toMatchObject({ status: 'recovery_sent', authUserId: 'user-4', isNewUser: false })
  })

  it('never creates a second/duplicate auth user for an already-existing owner — the magiclink lookup id is reused, no createUser call happens anywhere in this path', async () => {
    const admin = mockAdmin({
      inviteUserByEmail: { data: null, error: { message: 'User already registered', code: 'user_already_exists' } },
      generateLink:      { data: { user: { id: 'user-4' }, properties: { hashed_token: 'hash-xyz' } }, error: null },
    })
    mockServerClient({ error: null })
    const result = await ensureInvitedUser(EMAIL, REDIRECT_TO)
    expect(result.authUserId).toBe('user-4')
    expect((admin.auth.admin as unknown as { createUser?: unknown }).createUser).toBeUndefined()
  })

  it('Case C failure: magiclink succeeds but resetPasswordForEmail fails → status=email_not_sent with the real (sanitized) reason, not silently discarded', async () => {
    mockAdmin({
      inviteUserByEmail: { data: null, error: { message: 'User already registered', code: 'user_already_exists' } },
      generateLink:      { data: { user: { id: 'user-5' }, properties: { hashed_token: 'hash-recovery' } }, error: null },
    })
    mockServerClient({ error: { message: 'Email rate limit exceeded', status: 429, code: 'over_email_send_rate_limit' } })

    const result = await ensureInvitedUser(EMAIL, REDIRECT_TO)
    expect(result.status).toBe('email_not_sent')
    expect(result.authUserId).toBe('user-5')
    expect(result.lastErrorCode).toBe('over_email_send_rate_limit')
    expect(result.lastErrorMessage).toContain('rate limit')
  })

  it('sendRecoveryToConfirmed=false blocks re-inviting an already-confirmed user instead of sending a recovery email', async () => {
    mockAdmin({
      inviteUserByEmail: { data: null, error: { message: 'User already registered', code: 'user_already_exists' } },
    })
    await expect(
      ensureInvitedUser(EMAIL, REDIRECT_TO, { sendRecoveryToConfirmed: false }),
    ).rejects.toThrow(ENSURE_CONFIRMED_OTHER)
  })

  it('a rate-limited inviteUserByEmail throws ENSURE_RATE_LIMIT — never silently falls through', async () => {
    mockAdmin({
      inviteUserByEmail: { data: null, error: { message: 'Email rate limit exceeded', status: 429, code: 'over_email_send_rate_limit' } },
    })
    await expect(ensureInvitedUser(EMAIL, REDIRECT_TO)).rejects.toThrow(ENSURE_RATE_LIMIT)
  })

  it('an invalid redirect URL throws ENSURE_REDIRECT_INVALID — never silently falls through', async () => {
    mockAdmin({
      inviteUserByEmail: { data: null, error: { message: 'Redirect URL not allowed for this project', status: 400 } },
    })
    await expect(ensureInvitedUser(EMAIL, REDIRECT_TO)).rejects.toThrow(ENSURE_REDIRECT_INVALID)
  })

  it('the returned result never contains a raw action_link (only our own constructed inviteLink) or any service-role-shaped value', async () => {
    mockAdmin({
      inviteUserByEmail: { data: null, error: { message: 'User already registered', code: 'user_already_exists' } },
      generateLink: {
        data: {
          user: { id: 'user-6' },
          properties: { hashed_token: 'hash-final', action_link: 'https://project.supabase.co/auth/v1/verify?token=RAW_SECRET_TOKEN' },
        },
        error: null,
      },
    })
    mockServerClient({ error: { message: 'delivery failed' } })

    const result = await ensureInvitedUser(EMAIL, REDIRECT_TO)
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('RAW_SECRET_TOKEN')
    expect(serialized).not.toContain('supabase.co/auth/v1/verify')
    expect(serialized).not.toMatch(/service_role/i)
  })
})
