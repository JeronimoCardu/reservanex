'use client'

import { useState, Suspense } from 'react'
import { usePathname } from 'next/navigation'
import { SearchIcon } from 'lucide-react'
import type { ConversationRow, TenantUserRow, TenantRole } from '@orderflow/types'
import { Input } from '@/components/ui/input'
import { RealtimeConversationList } from './realtime-conversation-list'
import { cn } from '@/lib/utils'

type ConversationWithContact = ConversationRow & {
  contact?: { name: string | null; phone: string | null } | null
}

type StatusFilter    = 'all' | 'open' | 'closed'
type AssignFilter    = 'all' | 'unassigned' | 'mine' | 'assigned'
type OperationFilter = 'all' | 'sale' | 'long_term_rental' | 'temporary_rental' | 'unknown'
type LeadStatusFilter = 'all' | 'new' | 'contacted' | 'interested' | 'visit_scheduled' | 'discarded' | 'converted' | 'closed'

const STATUS_TABS: { value: StatusFilter; label: string }[] = [
  { value: 'all',    label: 'Todas'    },
  { value: 'open',   label: 'Abiertas' },
  { value: 'closed', label: 'Cerradas' },
]

interface ConversationSplitPaneProps {
  conversations:          ConversationWithContact[]
  tenantId:               string
  currentUserId:          string
  currentRole:            TenantRole
  tenantUsers:            TenantUserRow[]
  children:               React.ReactNode
  failedReceiptConvIds?:  Set<string>
  pendingPaymentConvIds?: Set<string>
}

export function ConversationSplitPane({
  conversations,
  tenantId,
  currentUserId,
  currentRole,
  tenantUsers,
  children,
  failedReceiptConvIds,
  pendingPaymentConvIds,
}: ConversationSplitPaneProps) {
  const pathname = usePathname()
  const [statusFilter, setStatusFilter]         = useState<StatusFilter>('open')
  const [assignFilter, setAssignFilter]         = useState<AssignFilter>('all')
  const [search, setSearch]                     = useState('')
  const [operationFilter, setOperationFilter]   = useState<OperationFilter>('all')
  const [leadStatusFilter, setLeadStatusFilter] = useState<LeadStatusFilter>('all')

  const selectedId    = pathname.split('/dashboard/conversations/')[1]
  const hasConversation = !!selectedId

  const assignTabs: { value: AssignFilter; label: string }[] = [
    { value: 'all',        label: 'Todas'       },
    { value: 'unassigned', label: 'Sin asignar' },
    { value: 'mine',       label: 'Yo'          },
    ...(currentRole === 'owner' ? [{ value: 'assigned' as AssignFilter, label: 'Asignadas' }] : []),
  ]

  return (
    <div className="flex h-full overflow-hidden">
      {/* ── LEFT PANEL ── conversation list */}
      <div
        className={cn(
          'flex shrink-0 flex-col border-r bg-background',
          hasConversation ? 'hidden lg:flex lg:w-80' : 'flex w-full lg:w-80',
        )}
      >
        {/* Sidebar header + filters */}
        <div className="border-b px-4 py-3 space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Conversaciones</h2>
          </div>

          <div className="relative">
            <SearchIcon className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Buscar..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 pl-8 text-sm"
            />
          </div>

          {/* Status filter */}
          <div className="flex gap-1">
            {STATUS_TABS.map((tab) => (
              <button
                key={tab.value}
                onClick={() => setStatusFilter(tab.value)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                  statusFilter === tab.value
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Assignment filter */}
          <div className="flex gap-1">
            {assignTabs.map((tab) => (
              <button
                key={tab.value}
                onClick={() => setAssignFilter(tab.value)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                  assignFilter === tab.value
                    ? 'bg-secondary text-secondary-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Operation type + lead status filters */}
          <div className="flex gap-1.5">
            <select
              value={operationFilter}
              onChange={(e) => setOperationFilter(e.target.value as OperationFilter)}
              className="flex-1 h-7 rounded-md border border-input bg-background px-1.5 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="all">Tipo: Todos</option>
              <option value="sale">Venta</option>
              <option value="long_term_rental">Mensual</option>
              <option value="temporary_rental">Temporal</option>
              <option value="unknown">Sin tipo</option>
            </select>
            <select
              value={leadStatusFilter}
              onChange={(e) => setLeadStatusFilter(e.target.value as LeadStatusFilter)}
              className="flex-1 h-7 rounded-md border border-input bg-background px-1.5 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="all">Estado: Todos</option>
              <option value="new">Nuevo</option>
              <option value="contacted">Contactado</option>
              <option value="interested">Interesado</option>
              <option value="visit_scheduled">Visita agendada</option>
              <option value="discarded">Descartado</option>
              <option value="converted">Convertido</option>
              <option value="closed">Cerrado</option>
            </select>
          </div>
        </div>

        {/* Scrollable conversation list */}
        <div className="flex-1 overflow-y-auto">
          <RealtimeConversationList
            conversations={conversations}
            tenantId={tenantId}
            statusFilter={statusFilter}
            assignFilter={assignFilter}
            search={search}
            operationFilter={operationFilter}
            leadStatusFilter={leadStatusFilter}
            currentUserId={currentUserId}
            tenantUsers={tenantUsers}
            failedReceiptConvIds={failedReceiptConvIds}
            pendingPaymentConvIds={pendingPaymentConvIds}
          />
        </div>
      </div>

      {/* ── RIGHT PANEL ── selected conversation or empty state */}
      <main
        className={cn(
          'flex min-w-0 flex-1 flex-col overflow-hidden',
          !hasConversation && 'hidden lg:flex',
        )}
      >
        <Suspense fallback={null}>
          {children}
        </Suspense>
      </main>
    </div>
  )
}
