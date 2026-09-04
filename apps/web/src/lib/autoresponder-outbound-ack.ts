// Pure, DB-independent logic for the AutoResponder outbound-ACK endpoint
// (physical confirmation that a MacroDroid macro ran WhatsApp Send for a
// dispatched messaging_outbox item — Fase 8 "outbound ACK"). Kept separate
// from the route handler so it's directly unit-testable, same rationale as
// autoresponder-media.ts / autoresponder-platform.ts.

// Same shape/reasoning as autoresponder-media.ts's isValidEventId (Fase 7
// Parte B): reject a non-UUID id BEFORE it ever reaches a query against
// messaging_outbox.id (a UUID column) — otherwise Postgres itself throws
// 22P02 (invalid input syntax for type uuid), surfacing as an unhandled 500
// instead of a clean 400.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isValidOutboxId(value: string | null | undefined): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}
