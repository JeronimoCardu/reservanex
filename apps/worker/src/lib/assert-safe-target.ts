// Safety guard for one-off dev/ops scripts (seed, demo, register-whatsapp,
// link-user, validate-*) that mutate data using the service-role key.
//
// These scripts read their Supabase target from SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL
// at runtime (not from the Supabase CLI's local link state), so a stale or misconfigured
// .env file is enough to silently point a mutating script at the wrong project.
//
// Call assertSafeSupabaseTarget() as the first statement in main(), before
// creating any Supabase client or touching the database. It never prints
// the service-role key.

// Fase 1B — every retired/foreign project this codebase has touched, each
// with its own explicit reason so a misconfigured .env fails with a message
// that actually explains WHICH old project it is, not just "unexpected".
// Never write to any of these from this repo again.
const BLOCKED_PROJECT_REFS: Record<string, string> = {
  veqkuriobordivdxvuhj: 'el proyecto ORIGINAL de ReservaNex',
  akvaswvkdqfguksinrwa: 'la copia anterior AutoResponder + MacroDroid (reservanex-autoresponder)',
}

// The only project this repo (the new AutoResponder-sin-MacroDroid version)
// is allowed to write to. Updated Fase 1B — was akvaswvkdqfguksinrwa
// (the previous copy) until the dedicated new Supabase project for this
// version was confirmed.
const EXPECTED_PROJECT_REF = 'tjqfysbcmpqlwmzdvynr'

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

  const blockedReason = BLOCKED_PROJECT_REFS[ref]
  if (blockedReason) {
    throw new Error(
      `[safety-guard] SUPABASE_URL apunta a ${blockedReason} (${ref}). ` +
      'Este script tiene operaciones que escriben o borran datos y está bloqueado explícitamente ' +
      'para ese proyecto. Revisá qué archivo de entorno se está cargando — debería ser el ' +
      `.env.local de esta versión nueva, apuntando a ${EXPECTED_PROJECT_REF}.`,
    )
  }

  if (ref !== EXPECTED_PROJECT_REF) {
    throw new Error(
      `[safety-guard] SUPABASE_URL apunta a un proyecto inesperado (${ref}). ` +
      `Esta versión solo debe operar sobre ${EXPECTED_PROJECT_REF}. ` +
      'Abortando por seguridad.',
    )
  }
}
