import type { AppClaims } from '@orderflow/types'

// Decodes a JWT payload without signature verification.
// Signature verification is handled by getUser() — call that first.
// JWT uses base64url encoding: + → -, / → _, optional padding omitted.
function decodeJWTPayload(token: string): Record<string, unknown> {
  const segment = token.split('.')[1]
  if (!segment) return {}
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  try {
    return JSON.parse(atob(padded)) as Record<string, unknown>
  } catch {
    return {}
  }
}

// Extracts app_metadata from a JWT access token.
//
// WHY access_token and not session.user.app_metadata:
//   Supabase returns two separate objects in the auth response:
//     - access_token: signed JWT whose payload contains the hook's custom claims
//     - user: a database snapshot where app_metadata = raw_app_meta_data (never updated by hooks)
//   @supabase/auth-js stores the API response as-is in the session cookie.
//   session.user.app_metadata is always the DB value — the hook output only lives in the JWT.
export function getJWTAppMetadata(accessToken: string | undefined): Record<string, unknown> {
  if (!accessToken) return {}
  const payload = decodeJWTPayload(accessToken)
  return (payload['app_metadata'] ?? {}) as Record<string, unknown>
}

export function parseAccessTokenClaims(accessToken: string | undefined): AppClaims | null {
  if (!accessToken) return null
  const payload = decodeJWTPayload(accessToken)
  const appMetadata =
    typeof payload.app_metadata === 'object' && payload.app_metadata !== null
      ? (payload.app_metadata as Record<string, unknown>)
      : {}
  return parseClaims(appMetadata)
}

export function parseClaims(appMetadata: Record<string, unknown>): AppClaims | null {
  const userType = appMetadata['user_type']

  if (userType === 'platform_user') {
    const role = appMetadata['role']
    if (role === 'super_admin' || role === 'seller' || role === 'operator') {
      return { user_type: 'platform_user', role }
    }
  }

  if (userType === 'tenant_user') {
    const role = appMetadata['role']
    const tenant_id = appMetadata['tenant_id']
    const workspace_ids = appMetadata['workspace_ids']

    if ((role === 'owner' || role === 'receptionist') && typeof tenant_id === 'string') {
      return {
        user_type: 'tenant_user',
        role,
        tenant_id,
        workspace_ids: Array.isArray(workspace_ids) ? (workspace_ids as string[]) : null,
      }
    }
  }

  return null
}
