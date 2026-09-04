import type { ReactNode } from 'react'
import { redirect } from 'next/navigation'
import { requireTenantContext } from '@/lib/auth/require-tenant-context'
import { listConversations } from '@/lib/repositories/conversations.repository'
import { listActiveTenantUsers } from '@/lib/repositories/tenant-users.repository'
import { getFailedReceiptConvIds, getPendingPaymentConvIds } from '@/lib/repositories/conversation-badges.repository'
import { ConversationSplitPane } from '@/components/tenant/conversations/conversation-split-pane'

export default async function ConversationsLayout({ children }: { children: ReactNode }) {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') redirect('/dashboard/properties')

  const [conversations, tenantUsers, failedReceiptConvIds, pendingPaymentConvIds] = await Promise.all([
    listConversations(ctx.tenantId),
    listActiveTenantUsers(ctx.tenantId),
    getFailedReceiptConvIds(ctx.tenantId),
    getPendingPaymentConvIds(ctx.tenantId),
  ])

  return (
    <ConversationSplitPane
      conversations={conversations}
      tenantId={ctx.tenantId}
      currentUserId={ctx.userId}
      currentRole={ctx.role}
      tenantUsers={tenantUsers}
      failedReceiptConvIds={failedReceiptConvIds}
      pendingPaymentConvIds={pendingPaymentConvIds}
    >
      {children}
    </ConversationSplitPane>
  )
}
