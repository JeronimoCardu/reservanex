'use client'

import Link from 'next/link'
import { ChevronLeftIcon, AlertCircleIcon } from 'lucide-react'
import type { ConversationRow, TenantUserRow, TenantRole, ConversationStatus } from '@orderflow/types'
import { ConversationStatusBadge } from './conversation-status-badge'
import { AiModeDisplay } from './ai-mode-display'
import { AssignConversationDialog } from './assign-conversation-dialog'
import { CloseConversationDialog } from './close-conversation-dialog'
import { EditContactNameDialog } from './edit-contact-name-dialog'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'

interface ConversationDetailHeaderProps {
  conversation:           ConversationRow & { contact?: { name: string | null; phone: string | null } | null }
  tenantUsers:            TenantUserRow[]
  currentRole:            TenantRole
  currentUserId:          string
  canAssignConversations: boolean
}

export function ConversationDetailHeader({
  conversation,
  tenantUsers,
  currentRole,
  currentUserId,
  canAssignConversations,
}: ConversationDetailHeaderProps) {
  const assignedUser = tenantUsers.find((u) => u.id === conversation.assigned_user_id)
  const contactName  = conversation.contact?.name ?? null
  const contactPhone = conversation.contact?.phone ?? null
  const contactLabel = contactName ?? contactPhone ?? 'Contacto'
  const isClosed     = conversation.status === 'closed'

  return (
    <div className={`border-b bg-background px-4 py-3 ${isClosed ? 'opacity-75' : ''}`}>
      <div className="flex items-center justify-between gap-4">
        {/* Left: back + contact info */}
        <div className="flex items-center gap-2 min-w-0">
          <Button variant="ghost" size="icon" className="shrink-0" asChild>
            <Link href="/dashboard/conversations">
              <ChevronLeftIcon className="h-5 w-5" />
            </Link>
          </Button>

          <div className="min-w-0">
            {/* Name + status + needs-attention badge */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-sm truncate">{contactLabel}</span>
              <ConversationStatusBadge status={conversation.status as ConversationStatus} />
              {conversation.needs_human_attention && (
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-500 px-2 py-0.5 text-[10px] font-bold text-white dark:bg-amber-600">
                  <AlertCircleIcon className="h-2.5 w-2.5" />
                  Requiere atención
                </span>
              )}
            </div>

            {/* Phone subtitle + edit contact button */}
            <div className="flex items-center gap-1.5">
              {contactName && contactPhone && (
                <p className="text-xs text-muted-foreground">{contactPhone}</p>
              )}
              <EditContactNameDialog
                contactId={conversation.contact_id}
                currentName={contactName}
                phone={contactPhone}
              />
            </div>

            {/* AI mode + assigned user */}
            <div className="mt-1 flex items-center gap-3 flex-wrap">
              <AiModeDisplay conversation={conversation} currentRole={currentRole} />

              <span className="text-muted-foreground/40 text-xs">·</span>

              {assignedUser ? (
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Avatar className="h-4 w-4">
                    <AvatarFallback className="text-[9px]">
                      {assignedUser.name?.charAt(0).toUpperCase() ?? '?'}
                    </AvatarFallback>
                  </Avatar>
                  <span>{assignedUser.name}</span>
                </div>
              ) : (
                <span className="text-xs text-muted-foreground/60 italic">Sin asignar</span>
              )}
            </div>
          </div>
        </div>

        {/* Right: actions */}
        <div className="flex shrink-0 items-center gap-2">
          <AssignConversationDialog
            conversation={conversation}
            tenantUsers={tenantUsers}
            currentRole={currentRole}
            currentUserId={currentUserId}
            canAssignConversations={canAssignConversations}
          />
          <CloseConversationDialog conversation={conversation} />
        </div>
      </div>
    </div>
  )
}
