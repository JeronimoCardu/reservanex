import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { requireTenantContext } from '@/lib/auth/require-tenant-context'
import { createClient } from '@orderflow/supabase/server'
import { getConversationById } from '@/lib/repositories/conversations.repository'
import { listMessages, getOutboundTrackingForMessages } from '@/lib/repositories/messages.repository'
import { listNotes } from '@/lib/repositories/notes.repository'
import { listTasks } from '@/lib/repositories/tasks.repository'
import { listActiveTenantUsers } from '@/lib/repositories/tenant-users.repository'
import { listReservationsByConversation } from '@/lib/repositories/reservations.repository'
import { ConversationDetailLayout } from '@/components/tenant/conversations/conversation-detail-layout'

export const metadata: Metadata = { title: 'Conversación — ReservaNex' }

export default async function ConversationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const ctx    = await requireTenantContext()
  const { id } = await params

  const conversation = await getConversationById(ctx.tenantId, id)
  if (!conversation) notFound()

  const [messages, notes, tasks, tenantUsers, reservations, tenantData] = await Promise.all([
    listMessages(ctx.tenantId, id),
    listNotes(ctx.tenantId, { conversationId: id }),
    listTasks(ctx.tenantId, { conversationId: id }),
    listActiveTenantUsers(ctx.tenantId),
    listReservationsByConversation(ctx.tenantId, id),
    (async () => {
      const supabase = await createClient()
      const { data } = await supabase
        .from('tenants')
        .select('payment_alias, payment_cbu, payment_account_holder, payment_bank, payment_notes, payment_request_message, public_site_enabled, public_slug')
        .eq('id', ctx.tenantId)
        .maybeSingle()
      return data
    })(),
  ])

  // Fase 2B — is this conversation's channel AutoResponder? Human replies
  // for that provider happen in WhatsApp / WhatsApp Web, so the CRM composer
  // must not offer to send from here (§16). Resolved from the conversation's
  // canonical account; a legacy conversation with no account (or a Meta one)
  // keeps the composer.
  const isAutoResponderChannel = await (async () => {
    if (!conversation.whatsapp_account_id) return false
    const supabase = await createClient()
    const { data } = await supabase
      .from('whatsapp_accounts')
      .select('provider')
      .eq('id', conversation.whatsapp_account_id)
      .maybeSingle()
    return data?.provider === 'autoresponder'
  })()

  // Fase 8 "outbound ACK" — fetched after messages resolve since it's keyed
  // by their ids. Only outbound (human/ai) messages will ever have a row;
  // inbound customer messages simply won't appear in the returned map.
  const outboundTracking = await getOutboundTrackingForMessages(ctx.tenantId, messages.map((m) => m.id))

  return (
    <ConversationDetailLayout
      initialConversation={conversation}
      messages={messages}
      initialOutboundTracking={outboundTracking}
      notes={notes}
      tasks={tasks}
      reservations={reservations}
      tenantUsers={tenantUsers}
      currentRole={ctx.role}
      currentUserId={ctx.userId}
      canAssignConversations={ctx.canAssignConversations}
      canConfirmReservations={ctx.role === 'owner' || ctx.canConfirmReservations}
      tenantId={ctx.tenantId}
      tenantPayment={tenantData ?? null}
      tenantPublicSite={tenantData ?? null}
      isAutoResponderChannel={isAutoResponderChannel}
    />
  )
}
