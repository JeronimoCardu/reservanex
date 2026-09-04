'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { ConversationRow, TenantUserRow } from '@orderflow/types'
import { MessageSquareIcon, AlertCircleIcon, UserIcon, GlobeIcon } from 'lucide-react'
import { ClientTimeAgo } from '@/components/tenant/shared/client-time-ago'
import { cn } from '@/lib/utils'

const opTypeBadge: Record<string, { label: string; className: string }> = {
  sale:             { label: 'Venta',    className: 'bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/40 dark:text-orange-400 dark:border-orange-900' },
  long_term_rental: { label: 'Mensual',  className: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-400 dark:border-blue-900'   },
  temporary_rental: { label: 'Temporal', className: 'bg-teal-50 text-teal-700 border-teal-200 dark:bg-teal-950/40 dark:text-teal-400 dark:border-teal-900'   },
}

const leadStatusBadge: Record<string, { label: string; className: string }> = {
  contacted:       { label: 'Contactado',  className: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-400 dark:border-blue-900'         },
  interested:      { label: 'Interesado',  className: 'bg-green-50 text-green-700 border-green-200 dark:bg-green-950/40 dark:text-green-400 dark:border-green-900'   },
  visit_scheduled: { label: 'Visita',      className: 'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/40 dark:text-violet-400 dark:border-violet-900' },
  discarded:       { label: 'Descartado',  className: 'bg-red-50 text-red-600 border-red-200 dark:bg-red-950/40 dark:text-red-400 dark:border-red-900'               },
  converted:       { label: 'Convertido',  className: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-400 dark:border-emerald-900' },
  closed:          { label: 'Cerrado',     className: 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800/40 dark:text-slate-400 dark:border-slate-700'  },
}

const aiModeBadge: Record<string, { label: string; className: string }> = {
  autonomous: { label: 'IA',     className: 'bg-green-50 text-green-700 border-green-200 dark:bg-green-950 dark:text-green-400 dark:border-green-900'  },
  manual:     { label: 'Manual', className: 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700' },
  // 'assisted' intentionally omitted — deprecated legacy mode (see migration 20260709000002)
}

const senderPrefix: Record<string, string> = {
  customer: 'Cliente',
  ai:       'IA',
  human:    'Agente',
}

interface ConversationListProps {
  conversations: (ConversationRow & {
    contact?: { name: string | null; phone: string | null } | null
  })[]
  currentUserId:          string
  tenantUsers:            TenantUserRow[]
  failedReceiptConvIds?:  Set<string>
  pendingPaymentConvIds?: Set<string>
  isFiltered?:            boolean
}

export function ConversationList({ conversations, currentUserId, tenantUsers, failedReceiptConvIds, pendingPaymentConvIds, isFiltered }: ConversationListProps) {
  const pathname = usePathname()

  if (process.env.NODE_ENV === 'development') {
    console.log('[conversation-list] render', conversations.slice(0, 3).map((conv) => ({
      id:                       conv.id,
      last_message_content:     conv.last_message_content,
      last_message_sender_type: conv.last_message_sender_type,
      last_message_at:          conv.last_message_at,
    })))
  }

  if (conversations.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 px-6 text-center">
        <MessageSquareIcon className="mb-3 h-10 w-10 text-muted-foreground/30" />
        <p className="text-sm font-medium text-foreground">
          {isFiltered ? 'Sin resultados' : 'Sin conversaciones'}
        </p>
        <p className="mt-1.5 text-xs text-muted-foreground leading-relaxed max-w-[220px]">
          {isFiltered
            ? 'No hay conversaciones con los filtros aplicados.'
            : 'Cuando un cliente escriba por WhatsApp aparecerá acá.'}
        </p>
      </div>
    )
  }

  return (
    <div className="divide-y">
      {conversations.map((conv) => {
        const contactName  = conv.contact?.name ?? null
        const contactPhone = conv.contact?.phone ?? null
        const label        = contactName ?? contactPhone ?? 'Contacto'
        const modeCfg = conv.ai_mode ? aiModeBadge[conv.ai_mode] : undefined
        const preview = conv.last_message_content
          ? `${senderPrefix[conv.last_message_sender_type ?? ''] ?? conv.last_message_sender_type}: ${conv.last_message_content.slice(0, 80)}`
          : null

        const requiresResponse =
          conv.needs_human_attention === true ||
          (
            conv.needs_human_attention == null &&
            conv.last_message_sender_type === 'customer' &&
            conv.ai_mode !== 'autonomous' &&
            conv.status === 'open'
          )

        const hasFailedReceipt  = failedReceiptConvIds?.has(conv.id)  ?? false
        const hasPendingPayment = pendingPaymentConvIds?.has(conv.id) ?? false

        // Assignment badge
        let assignmentLabel: string
        let assignmentClass: string
        if (conv.assigned_user_id === null) {
          assignmentLabel = 'Sin asignar'
          assignmentClass = 'bg-muted text-muted-foreground border-border'
        } else if (conv.assigned_user_id === currentUserId) {
          assignmentLabel = 'Asignado a mí'
          assignmentClass = 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950 dark:text-blue-400 dark:border-blue-900'
        } else {
          const assignedName = tenantUsers.find((u) => u.id === conv.assigned_user_id)?.name
          assignmentLabel = assignedName ? `Asignado a: ${assignedName}` : 'Asignado'
          assignmentClass = 'bg-muted text-muted-foreground border-border'
        }

        const isClosed  = conv.status === 'closed'
        const isActive  = pathname === `/dashboard/conversations/${conv.id}`
        const initial   = label.charAt(0).toUpperCase()

        return (
          <Link
            key={conv.id}
            href={`/dashboard/conversations/${conv.id}`}
            className={cn(
              'flex items-start gap-3 px-4 py-3 transition-colors',
              isActive
                ? 'bg-muted border-l-4 border-primary'
                : requiresResponse
                  ? 'bg-amber-50/70 border-l-4 border-amber-500 hover:bg-amber-50 dark:bg-amber-950/25 dark:hover:bg-amber-950/35'
                  : 'hover:bg-muted/50 border-l-4 border-transparent',
              isClosed && 'opacity-60',
            )}
          >
            {/* Avatar */}
            <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
              {initial}
            </div>

            {/* Main content */}
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-2">
                {/* Left: name/phone + attention badge */}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-sm font-medium truncate">{label}</span>
                    {requiresResponse && (
                      <span className="shrink-0 inline-flex items-center gap-0.5 text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-500 text-white dark:bg-amber-600">
                        <AlertCircleIcon className="h-2.5 w-2.5" />
                        Responder
                      </span>
                    )}
                  </div>
                  {contactName && contactPhone && (
                    <p className="text-[11px] text-muted-foreground truncate">{contactPhone}</p>
                  )}
                </div>

                {/* Right: timestamp */}
                <ClientTimeAgo
                  date={conv.last_message_at ?? conv.updated_at}
                  className="shrink-0 text-xs text-muted-foreground whitespace-nowrap"
                />
              </div>

              {/* Preview */}
              {preview ? (
                <p className={cn(
                  'mt-0.5 truncate text-xs',
                  requiresResponse ? 'font-medium text-foreground' : 'text-muted-foreground',
                )}>
                  {preview}
                </p>
              ) : (
                <p className="mt-0.5 text-xs text-muted-foreground capitalize">{conv.channel}</p>
              )}

              {/* Badges row */}
              <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
                {hasFailedReceipt && (
                  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded border whitespace-nowrap bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-400 dark:border-red-900">
                    Error recibo
                  </span>
                )}
                {hasPendingPayment && (
                  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded border whitespace-nowrap bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/40 dark:text-orange-400 dark:border-orange-900">
                    Pago pendiente
                  </span>
                )}
                {modeCfg && (
                  <span className={cn('text-[10px] font-medium px-1.5 py-0.5 rounded border whitespace-nowrap', modeCfg.className)}>
                    {modeCfg.label}
                  </span>
                )}
                {/* Operation type badge (when not unknown) */}
                {(() => {
                  const opType = (conv.lead_operation_type ?? 'unknown') as string
                  const cfg = opTypeBadge[opType]
                  return cfg ? (
                    <span className={cn('text-[10px] font-medium px-1.5 py-0.5 rounded border whitespace-nowrap', cfg.className)}>
                      {cfg.label}
                    </span>
                  ) : null
                })()}
                {/* Lead status badge (only when progressed beyond 'new') */}
                {(() => {
                  const status = (conv.lead_status ?? 'new') as string
                  const cfg = leadStatusBadge[status]
                  return cfg ? (
                    <span className={cn('text-[10px] font-medium px-1.5 py-0.5 rounded border whitespace-nowrap', cfg.className)}>
                      {cfg.label}
                    </span>
                  ) : null
                })()}
                {conv.lead_source === 'public_site' && (
                  <span className="inline-flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded border whitespace-nowrap bg-teal-50 text-teal-700 border-teal-200 dark:bg-teal-950/50 dark:text-teal-400 dark:border-teal-800">
                    <GlobeIcon className="h-2.5 w-2.5 shrink-0" />
                    Web pública
                  </span>
                )}
                {isClosed && (
                  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded border bg-muted text-muted-foreground border-border whitespace-nowrap">
                    Cerrada
                  </span>
                )}
                <span className={cn(
                  'inline-flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded border whitespace-nowrap',
                  assignmentClass,
                )}>
                  <UserIcon className="h-2.5 w-2.5 shrink-0" />
                  {assignmentLabel}
                </span>
              </div>
            </div>
          </Link>
        )
      })}
    </div>
  )
}
