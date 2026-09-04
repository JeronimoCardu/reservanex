'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Building2Icon, GlobeIcon, CalendarIcon, UsersIcon, ExternalLinkIcon, TrendingUpIcon } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@orderflow/supabase/browser'
import { updateConversationLeadStatusAction } from '@/actions/conversations'
import type { ConversationRow, ReservationRow, TenantUserRow, TenantRole, MessageRow } from '@orderflow/types'
import type { NoteWithAuthor } from '@/lib/repositories/notes.repository'
import type { TaskWithDetails } from '@/lib/repositories/tasks.repository'
import type { ReservationForConversation } from '@/lib/repositories/reservations.repository'
import type { OutboundTrackingInfo } from '@/lib/outbound-status'
import { ConversationDetailHeader } from './conversation-detail-header'
import { AssociatePropertyDialog } from './associate-property-dialog'
import { ReservationPanel } from './reservation-panel'
import { RealtimeMessages } from '@/components/tenant/messages/realtime-messages'
import { SendMessageForm, type OptimisticMediaParams } from '@/components/tenant/messages/send-message-form'
import { NoteList } from '@/components/tenant/notes/note-list'
import { AddNoteDialog } from '@/components/tenant/notes/add-note-dialog'
import { TaskList } from '@/components/tenant/tasks/task-list'
import { CreateTaskDialog } from '@/components/tenant/tasks/create-task-dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

type ConversationProperty = {
  id:             string
  title:          string
  city:           string | null
  operation_type: string | null
  slug:           string | null
  published:      boolean | null
}

type ConversationUnit = {
  id:   string
  name: string
}

type ConversationWithContact = ConversationRow & {
  contact?:  { name: string | null; phone: string | null } | null
  property?: ConversationProperty | null
  unit?:     ConversationUnit     | null
}

interface LeadContext {
  public_code?:           string
  property_slug?:         string
  requested_start_date?:  string
  requested_end_date?:    string
  requested_guests?:      number
  requested_nights?:      number
}

function formatLeadDate(s: string): string {
  const [y, m, d] = s.split('-')
  return `${d}/${m}/${y}`
}

function LeadContextPanel({ conversation }: { conversation: ConversationWithContact }) {
  if (conversation.lead_source !== 'public_site') return null

  const lc = (conversation.lead_context ?? {}) as LeadContext
  const property = conversation.property

  if (!property && !lc.public_code) return null

  const hasDates   = lc.requested_start_date && lc.requested_end_date
  const nights     = lc.requested_nights
    ?? (hasDates
      ? Math.round((new Date(lc.requested_end_date!).getTime() - new Date(lc.requested_start_date!).getTime()) / 86400000)
      : null)

  return (
    <div className="shrink-0 border-b px-3 py-2.5 space-y-2 bg-teal-50/60 dark:bg-teal-950/20">
      <div className="flex items-center gap-1.5">
        <GlobeIcon className="h-3.5 w-3.5 shrink-0 text-teal-600 dark:text-teal-400" />
        <span className="text-[11px] font-semibold text-teal-700 dark:text-teal-400 uppercase tracking-wide">
          Consulta web pública
        </span>
      </div>

      {/* Property */}
      {property && (
        <div className="flex items-start justify-between gap-1 min-w-0">
          <div className="min-w-0">
            <p className="text-xs font-medium truncate text-foreground">{property.title}</p>
            {lc.public_code && (
              <p className="font-mono text-[10px] text-muted-foreground">Ref: {lc.public_code}</p>
            )}
          </div>
          <a
            href={`/dashboard/properties/${property.id}`}
            title="Ver propiedad"
            className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
          >
            <ExternalLinkIcon className="h-3.5 w-3.5" />
          </a>
        </div>
      )}

      {/* Dates */}
      {hasDates ? (
        <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <CalendarIcon className="h-3 w-3 shrink-0" />
          <span>{formatLeadDate(lc.requested_start_date!)} → {formatLeadDate(lc.requested_end_date!)}</span>
          {nights !== null && <span className="text-muted-foreground/60">({nights} noche{nights !== 1 ? 's' : ''})</span>}
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground/60 flex items-center gap-1">
          <CalendarIcon className="h-3 w-3 shrink-0" />
          Fechas no indicadas
        </p>
      )}

      {/* Guests */}
      {lc.requested_guests && (
        <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <UsersIcon className="h-3 w-3 shrink-0" />
          <span>{lc.requested_guests} persona{lc.requested_guests !== 1 ? 's' : ''}</span>
        </div>
      )}
    </div>
  )
}

const OP_TYPE_CONFIG: Record<string, { label: string; className: string }> = {
  sale:             { label: 'Venta',            className: 'bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/40 dark:text-orange-400 dark:border-orange-900' },
  long_term_rental: { label: 'Alquiler mensual',  className: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-400 dark:border-blue-900'           },
  temporary_rental: { label: 'Alquiler temporal', className: 'bg-teal-50 text-teal-700 border-teal-200 dark:bg-teal-950/40 dark:text-teal-400 dark:border-teal-900'           },
}

const LEAD_STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: 'new',            label: 'Nuevo'           },
  { value: 'contacted',      label: 'Contactado'      },
  { value: 'interested',     label: 'Interesado'      },
  { value: 'visit_scheduled', label: 'Visita agendada' },
  { value: 'discarded',      label: 'Descartado'      },
  { value: 'converted',      label: 'Convertido'      },
  { value: 'closed',         label: 'Cerrado'         },
]

function LeadPipelinePanel({
  conversation,
  onStatusChange,
  isPending,
}: {
  conversation: ConversationWithContact
  onStatusChange: (status: string) => void
  isPending: boolean
}) {
  const opType   = (conversation.lead_operation_type ?? 'unknown') as string
  const status   = (conversation.lead_status ?? 'new') as string
  const opTypeCfg = OP_TYPE_CONFIG[opType]

  return (
    <div className="shrink-0 border-b px-3 py-2.5 space-y-2">
      <div className="flex items-center gap-1.5">
        <TrendingUpIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
          Lead
        </span>
        {opTypeCfg && (
          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${opTypeCfg.className}`}>
            {opTypeCfg.label}
          </span>
        )}
      </div>

      <div className="flex items-center justify-between gap-2">
        <label htmlFor="lead-status-select" className="text-[11px] text-muted-foreground shrink-0">
          Estado
        </label>
        <select
          id="lead-status-select"
          value={status}
          disabled={isPending}
          onChange={(e) => onStatusChange(e.target.value)}
          className="flex-1 h-7 rounded-md border border-input bg-background px-1.5 text-[11px] text-foreground outline-none focus:ring-1 focus:ring-ring disabled:opacity-50 cursor-pointer"
        >
          {LEAD_STATUS_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>
    </div>
  )
}

type TenantPayment = {
  payment_alias:           string | null
  payment_cbu:             string | null
  payment_account_holder:  string | null
  payment_bank:            string | null
  payment_notes:           string | null
  payment_request_message: string | null
}

type TenantPublicSite = {
  public_site_enabled: boolean
  public_slug:         string | null
}

interface ConversationDetailLayoutProps {
  initialConversation:     ConversationWithContact
  messages:                MessageRow[]
  initialOutboundTracking?: Record<string, OutboundTrackingInfo>
  notes:                   NoteWithAuthor[]
  tasks:                   TaskWithDetails[]
  reservations:            ReservationForConversation[]
  tenantUsers:             TenantUserRow[]
  currentRole:             TenantRole
  currentUserId:           string
  canAssignConversations:  boolean
  canConfirmReservations:  boolean
  tenantId:                string
  tenantPayment?:          TenantPayment | null
  tenantPublicSite?:       TenantPublicSite | null
}

export function ConversationDetailLayout({
  initialConversation,
  messages: initialMessages,
  initialOutboundTracking,
  notes,
  tasks,
  reservations,
  tenantUsers,
  currentRole,
  currentUserId,
  canAssignConversations,
  canConfirmReservations,
  tenantId,
  tenantPayment,
  tenantPublicSite,
}: ConversationDetailLayoutProps) {
  const router = useRouter()
  const [, startTransition]                      = useTransition()
  const [isStatusPending, startStatusTransition] = useTransition()
  const [conversation,      setConversation]      = useState<ConversationWithContact>(initialConversation)
  const [localReservations, setLocalReservations] = useState<ReservationForConversation[]>(reservations)

  // ── Messages state (owned here so SendMessageForm can add optimistic messages) ─
  const [messages, setMessages] = useState<MessageRow[]>(initialMessages)

  // Fase 8 "outbound ACK" — plain object → Map, mirroring the senderMap/
  // savedProofMap "supplementary per-message lookup" pattern. Not refreshed by
  // realtime (messaging_outbox isn't subscribed); a live ACK arriving while
  // the conversation is open only reflects on next refresh/reconnect.
  const outboundTrackingMap = useMemo(
    () => new Map(Object.entries(initialOutboundTracking ?? {})),
    [initialOutboundTracking],
  )

  // Sync from server on reconnect/refresh — merge authoritative server set with any
  // locally-held messages (optimistic or realtime-received) not yet in the snapshot.
  const messagesSyncKey = useMemo(
    () => initialMessages.map((m) => m.id).join(','),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [initialMessages],
  )
  useEffect(() => {
    setMessages((prev) => {
      const serverIds  = new Set(initialMessages.map((m) => m.id))
      const localExtras = prev.filter((m) => !serverIds.has(m.id))
      return [...initialMessages, ...localExtras].sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      )
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messagesSyncKey])

  function handleOptimisticSend(text: string): string {
    const tempId = `temp_${Date.now()}`
    setMessages((prev) => [
      ...prev,
      {
        id:                  tempId,
        content:             text,
        content_type:        'text',
        conversation_id:     initialConversation.id,
        created_at:          new Date().toISOString(),
        media_storage_path:  null,
        metadata:            { delivery_status: 'sending' } as never,
        sender_id:           currentUserId,
        sender_type:         'human',
        tenant_id:           '',
        whatsapp_message_id: null,
      } as MessageRow,
    ])
    return tempId
  }

  function handleSendConfirmed(tempId: string, realId: string, mediaStoragePath?: string | null) {
    setMessages((prev) =>
      prev.map((m) => {
        if (m.id !== tempId) return m
        const existingMeta = (m.metadata as Record<string, unknown> | null) ?? {}
        return {
          ...m,
          id: realId,
          // Set media_storage_path immediately when the action confirms it so the
          // image/doc card switches to /api/media without waiting for realtime UPDATE.
          ...(mediaStoragePath != null ? { media_storage_path: mediaStoragePath } : {}),
          metadata: { ...existingMeta, delivery_status: 'sent' } as never,
        }
      }),
    )
  }

  function handleSendFailed(tempId: string) {
    // Remove the optimistic message; text/file is restored in SendMessageForm.
    setMessages((prev) => prev.filter((m) => m.id !== tempId))
  }

  function handleOptimisticMediaSend(params: OptimisticMediaParams): string {
    const tempId = `temp_${Date.now()}`
    setMessages((prev) => [
      ...prev,
      {
        id:                  tempId,
        content:             params.caption ?? '',
        content_type:        params.contentType,
        conversation_id:     initialConversation.id,
        created_at:          new Date().toISOString(),
        media_storage_path:  null,
        metadata:            {
          delivery_status: 'sending',
          ...(params.localPreviewUrl ? { localPreviewUrl: params.localPreviewUrl } : {}),
          ...(params.caption         ? { caption: params.caption }                 : {}),
          ...(params.mimeType        ? { mime_type: params.mimeType }              : {}),
          ...(params.filename        ? { filename:  params.filename }               : {}),
        } as never,
        sender_id:           currentUserId,
        sender_type:         'human',
        tenant_id:           '',
        whatsapp_message_id: null,
      } as MessageRow,
    ])
    return tempId
  }

  // Sync reservations when server re-renders (e.g. after a new reservation is created).
  useEffect(() => {
    setLocalReservations(reservations)
  }, [reservations])

  // Sync join fields (contact, property, unit) when the server re-renders.
  // Realtime payload carries scalar columns only, not joined rows.
  useEffect(() => {
    setConversation((prev) => ({
      ...prev,
      contact:  initialConversation.contact,
      property: initialConversation.property,
      unit:     initialConversation.unit,
    }))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    initialConversation.contact?.name,
    initialConversation.contact?.phone,
    initialConversation.property_id,
    initialConversation.unit_id,
  ])

  // Subscribe to conversation/notes/tasks/reservations changes in real time.
  useEffect(() => {
    const supabase = createClient()
    const DEV = process.env.NODE_ENV === 'development'

    let destroyed     = false
    let retryCount    = 0
    let retryTimer:     ReturnType<typeof setTimeout> | null = null
    let currentChannel: ReturnType<typeof supabase.channel> | null = null

    function createAndSubscribe(): void {
      const ch = supabase
        .channel(`conv-detail:${initialConversation.id}`)
        .on(
          'postgres_changes',
          {
            event:  'UPDATE',
            schema: 'public',
            table:  'conversations',
            filter: `id=eq.${initialConversation.id}`,
          },
          (payload) => {
            const updated = payload.new as ConversationRow
            setConversation((prev) => ({
              ...updated,
              contact:  prev.contact,  // join field — not in realtime payload
              property: prev.property,
              unit:     prev.unit,
            }))
          },
        )
        // Notes: refresh to get author join
        .on(
          'postgres_changes',
          {
            event:  'INSERT',
            schema: 'public',
            table:  'notes',
            filter: `conversation_id=eq.${initialConversation.id}`,
          },
          () => startTransition(() => router.refresh()),
        )
        // Tasks: refresh to get assignee join
        .on(
          'postgres_changes',
          {
            event:  'UPDATE',
            schema: 'public',
            table:  'tasks',
            filter: `conversation_id=eq.${initialConversation.id}`,
          },
          () => startTransition(() => router.refresh()),
        )
        .on(
          'postgres_changes',
          {
            event:  'INSERT',
            schema: 'public',
            table:  'tasks',
            filter: `conversation_id=eq.${initialConversation.id}`,
          },
          () => startTransition(() => router.refresh()),
        )
        // Reservations UPDATE: update scalar fields (status, notes) in local state.
        // No router.refresh() needed — join fields (property, unit) don't change on UPDATE.
        .on(
          'postgres_changes',
          {
            event:  'UPDATE',
            schema: 'public',
            table:  'reservations',
            filter: `conversation_id=eq.${initialConversation.id}`,
          },
          (payload) => {
            const updated = payload.new as ReservationRow
            if (updated.deleted_at !== null) {
              setLocalReservations((prev) => prev.filter((r) => r.id !== updated.id))
            } else {
              setLocalReservations((prev) =>
                prev.map((r) =>
                  r.id === updated.id
                    ? { ...r, status: updated.status, notes: updated.notes, total_amount: updated.total_amount, payment_status: updated.payment_status }
                    : r,
                ),
              )
            }
          },
        )
        // Reservations INSERT: refresh to get property/unit join fields.
        .on(
          'postgres_changes',
          {
            event:  'INSERT',
            schema: 'public',
            table:  'reservations',
            filter: `conversation_id=eq.${initialConversation.id}`,
          },
          () => startTransition(() => router.refresh()),
        )
        .subscribe((status) => {
          if (DEV) {
            console.log('[realtime-conv-detail] channel status:', status, { retryCount })
          }

          if (status === 'SUBSCRIBED' && retryCount > 0) {
            startTransition(() => router.refresh())
          }

          if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            if (destroyed) return
            if (DEV) {
              console.warn('[realtime-conv-detail] channel failed, retrying', { status, retryCount })
            }
            void supabase.removeChannel(ch)
            currentChannel = null
            const delay = Math.min(1_000 * 2 ** retryCount, 30_000)
            retryCount++
            retryTimer = setTimeout(() => {
              retryTimer = null
              if (!destroyed) createAndSubscribe()
            }, delay)
          }
        })

      currentChannel = ch
    }

    createAndSubscribe()

    return () => {
      destroyed = true
      if (retryTimer) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
      if (currentChannel) {
        void supabase.removeChannel(currentChannel)
        currentChannel = null
      }
    }
  }, [initialConversation.id, router, startTransition])

  const isClosed = conversation.status === 'closed'

  function handleLeadStatusChange(newStatus: string) {
    const prevStatus = (conversation.lead_status ?? 'new') as string
    setConversation((prev) => ({ ...prev, lead_status: newStatus }))
    startStatusTransition(async () => {
      const result = await updateConversationLeadStatusAction(conversation.id, newStatus)
      if (result.success) {
        toast.success('Estado del lead actualizado')
      } else {
        setConversation((prev) => ({ ...prev, lead_status: prevStatus }))
        toast.error(result.error ?? 'Error al actualizar el estado')
      }
    })
  }

  return (
    <div className="flex h-full flex-col">
      <ConversationDetailHeader
        conversation={conversation}
        tenantUsers={tenantUsers}
        currentRole={currentRole}
        currentUserId={currentUserId}
        canAssignConversations={canAssignConversations}
      />

      {/* 2-column layout: messages (left) + sidebar (right) */}
      <div className="flex flex-1 overflow-hidden">
        {/* Messages column */}
        <div className="flex flex-1 flex-col overflow-hidden border-r">
          <RealtimeMessages
            messages={messages}
            setMessages={setMessages}
            conversationId={initialConversation.id}
            currentUserId={currentUserId}
            contact={conversation.contact ?? null}
            tenantUsers={tenantUsers}
            outboundTrackingMap={outboundTrackingMap}
          />
          <SendMessageForm
            conversationId={initialConversation.id}
            disabled={isClosed}
            onOptimisticSend={handleOptimisticSend}
            onOptimisticMediaSend={handleOptimisticMediaSend}
            onSendConfirmed={handleSendConfirmed}
            onSendFailed={handleSendFailed}
            paymentData={tenantPayment ?? null}
            publicLinkData={tenantPublicSite ? {
              siteEnabled:       tenantPublicSite.public_site_enabled,
              siteSlug:          tenantPublicSite.public_slug,
              propertySlug:      conversation.property?.slug ?? null,
              propertyPublished: conversation.property?.published ?? false,
            } : null}
          />
        </div>

        {/* Sidebar: property + notes/tasks/reservations */}
        <div className="hidden w-80 flex-col overflow-hidden lg:flex">
          {/* Lead context from public site */}
          <LeadContextPanel conversation={conversation} />

          {/* Lead pipeline status */}
          <LeadPipelinePanel
            conversation={conversation}
            onStatusChange={handleLeadStatusChange}
            isPending={isStatusPending}
          />

          {/* Property association section */}
          <div className="shrink-0 border-b px-3 py-2.5 space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 min-w-0">
                <Building2Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                {conversation.property ? (
                  <div className="min-w-0">
                    <p className="text-xs font-medium truncate">{conversation.property.title}</p>
                    {conversation.property.city && (
                      <p className="text-[10px] text-muted-foreground truncate">
                        {conversation.property.city}
                        {conversation.unit && ` · ${conversation.unit.name}`}
                      </p>
                    )}
                  </div>
                ) : (
                  <span className="text-xs text-muted-foreground/60 italic">Sin propiedad</span>
                )}
              </div>
              <AssociatePropertyDialog
                conversationId={initialConversation.id}
                currentPropertyId={conversation.property_id ?? null}
                currentUnitId={conversation.unit_id ?? null}
                tenantId={tenantId}
              />
            </div>
          </div>

          {/* Tabs */}
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <Tabs defaultValue="notes" className="flex min-h-0 flex-1 flex-col">
              <TabsList className="shrink-0 border-b rounded-none w-full">
                <TabsTrigger value="notes" className="flex-1 text-xs">Notas ({notes.length})</TabsTrigger>
                <TabsTrigger value="tasks" className="flex-1 text-xs">Tareas ({tasks.length})</TabsTrigger>
                <TabsTrigger value="reservations" className="flex-1 text-xs">Reservas ({reservations.length})</TabsTrigger>
              </TabsList>

              <TabsContent value="notes" className="flex-1 overflow-y-auto p-3 space-y-3">
                <div className="flex justify-end">
                  <AddNoteDialog conversationId={initialConversation.id} />
                </div>
                <NoteList notes={notes} />
              </TabsContent>

              <TabsContent value="tasks" className="flex-1 overflow-y-auto p-3 space-y-3">
                <div className="flex justify-end">
                  <CreateTaskDialog
                    tenantUsers={tenantUsers}
                    conversationId={initialConversation.id}
                  />
                </div>
                <TaskList
                  tasks={tasks}
                  tenantUsers={tenantUsers}
                  currentRole={currentRole}
                  currentUserId={currentUserId}
                />
              </TabsContent>

              <TabsContent value="reservations" className="flex-1 overflow-y-auto p-3 pb-6">
                <ReservationPanel
                  conversationId={initialConversation.id}
                  contactId={initialConversation.contact_id}
                  property={conversation.property ?? null}
                  unit={conversation.unit ?? null}
                  reservations={localReservations}
                  canConfirm={canConfirmReservations}
                />
              </TabsContent>
            </Tabs>
          </div>
        </div>
      </div>
    </div>
  )
}
