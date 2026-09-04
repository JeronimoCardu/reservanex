import { createClient } from '@orderflow/supabase/server'

export async function getFailedReceiptConvIds(tenantId: string): Promise<Set<string>> {
  const supabase = await createClient()

  const { data } = await supabase
    .from('messages')
    .select('conversation_id')
    .eq('tenant_id', tenantId)
    .eq('content_type', 'document')
    .eq('sender_type', 'human')
    .eq('metadata->>delivery_status', 'failed')
    .not('metadata->>document_id', 'is', null)

  const ids = (data ?? []).map((m) => m.conversation_id).filter(Boolean) as string[]
  return new Set(ids)
}

export async function getPendingPaymentConvIds(tenantId: string): Promise<Set<string>> {
  const supabase = await createClient()

  const { data } = await supabase
    .from('reservations')
    .select('conversation_id')
    .eq('tenant_id', tenantId)
    .in('payment_status', ['pending', 'deposit_paid'])
    .not('conversation_id', 'is', null)
    .neq('status', 'cancelled')
    .neq('status', 'completed')
    .is('deleted_at', null)

  const ids = (data ?? []).map((r) => r.conversation_id).filter(Boolean) as string[]
  return new Set(ids)
}
