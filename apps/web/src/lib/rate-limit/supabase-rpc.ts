// Rate limiting — Fase 1B: la llamada real a rate_limit_hit, con service_role.
//
// rate_limit_hit todavía no está en packages/types/src/database.ts: ese archivo
// se regenera con `pnpm db:types` contra el proyecto vinculado, y la migración
// no está aplicada en el remoto. Hasta entonces la llamada va sin tipar — mismo
// patrón que asRpc en actions/platform-danger.ts — y la forma de la respuesta
// la valida limiter.ts, que no confía en ella.

import { createAdminClient } from '@orderflow/supabase/admin'
import type { RateLimitRpc, RateLimitRpcBucket, RateLimitRpcResult } from './limiter'

export interface RateLimitRpcClient {
  rpc(
    fn:   'rate_limit_hit',
    args: { p_buckets: RateLimitRpcBucket[] },
  ): { abortSignal(signal: AbortSignal): PromiseLike<RateLimitRpcResult> }
}

/**
 * El RateLimitRpc de producción. El signal llega hasta el fetch de PostgREST:
 * cuando el adapter vence su timeout, el request HTTP se cancela de verdad.
 */
export function supabaseRateLimitRpc(
  client: RateLimitRpcClient = createAdminClient() as unknown as RateLimitRpcClient,
): RateLimitRpc {
  return (buckets, signal) => client.rpc('rate_limit_hit', { p_buckets: buckets }).abortSignal(signal)
}
