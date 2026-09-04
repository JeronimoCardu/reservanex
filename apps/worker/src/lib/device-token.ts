import { createHash } from 'node:crypto'

// Deterministic hash (not a slow password hash like bcrypt) — required because
// the webhook resolves an account BY token via an indexed equality query
// (whatsapp_accounts.inbound_token_hash = <hash>), the same standard pattern
// used for API-key lookups generally (a salted/slow hash can't support an
// indexed equality lookup). The token itself is a long random secret (see
// seed-autoresponder-account.ts) — never log or persist the raw token
// anywhere, only this hash. The DB's indexed equality comparison is the
// lookup mechanism; no separate constant-time comparison step is needed
// since nothing in the request path compares two hashes in application code.
export function hashDeviceToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex')
}
