// Safety guard for one-off dev/ops scripts (validate-*, generate-invite-link,
// cleanup-auth-users) that mutate data using the service-role key.
//
// Duplicated from apps/worker/src/lib/assert-safe-target.ts — apps/web
// cannot import apps/worker code (independently deployed processes; see the
// established cross-app duplication precedent for hashDeviceToken/phone
// normalization). Logic must stay identical between the two copies.
//
// Call assertSafeSupabaseTarget() as the first statement in main(), before
// creating any Supabase client or touching the database. It never prints
// the service-role key.

// The original ReservaNex project. This copy (reservanex-autoresponder) must never write to it.
const BLOCKED_PROJECT_REF = 'veqkuriobordivdxvuhj'

// The only project this copy is allowed to write to.
const EXPECTED_PROJECT_REF = 'akvaswvkdqfguksinrwa'

function extractProjectRef(url: string): string | null {
  const match = /^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/i.exec(url.trim())
  return match?.[1]?.toLowerCase() ?? null
}

export function assertSafeSupabaseTarget(): void {
  const url = (process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim()
  const ref = extractProjectRef(url)

  if (!ref) {
    throw new Error(
      '[safety-guard] No se pudo determinar el proyecto Supabase destino a partir de ' +
      'SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL (valor ausente o con formato inesperado). ' +
      'Abortando por seguridad: este script escribe datos y no puede confirmar que el ' +
      'destino sea el correcto. Verificá que .env.local esté cargado y tenga esas variables.',
    )
  }

  if (ref === BLOCKED_PROJECT_REF) {
    throw new Error(
      `[safety-guard] SUPABASE_URL apunta al proyecto ORIGINAL de ReservaNex (${BLOCKED_PROJECT_REF}). ` +
      'Este script tiene operaciones que escriben o borran datos y está bloqueado explícitamente ' +
      'para ese proyecto. Revisá qué archivo de entorno se está cargando — debería ser el ' +
      '.env.local de esta copia (reservanex-autoresponder), no el .env original.',
    )
  }

  if (ref !== EXPECTED_PROJECT_REF) {
    throw new Error(
      `[safety-guard] SUPABASE_URL apunta a un proyecto inesperado (${ref}). ` +
      `Esta copia (reservanex-autoresponder) solo debe operar sobre ${EXPECTED_PROJECT_REF}. ` +
      'Abortando por seguridad.',
    )
  }
}
