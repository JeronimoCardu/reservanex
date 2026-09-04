'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  KeyRoundIcon, PlusIcon, FileTextIcon, CalendarClockIcon,
  AlertCircleIcon, ClockIcon, SearchIcon, AlertTriangleIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button }  from '@/components/ui/button'
import { Input }   from '@/components/ui/input'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction,
} from '@/components/ui/alert-dialog'
import { ContractStatusBadge }    from '@/components/tenant/monthly-rentals/contract-status-badge'
import { CommercialStatusBadge }  from '@/components/tenant/monthly-rentals/commercial-status-badge'
import { ContractFormDialog }     from '@/components/tenant/monthly-rentals/contract-form-dialog'
import { RentalAlertsPanel }      from '@/components/tenant/monthly-rentals/rental-alerts-panel'
import {
  activateMonthlyRentalContractAction,
  endMonthlyRentalContractAction,
  cancelMonthlyRentalContractAction,
} from '@/actions/monthly-rentals'
import type {
  MonthlyRentalStats,
  MonthlyRentalContractWithDetails,
  RentalPropertyOption,
  RentalContactOption,
  MonthlyRentalAlertCharge,
  MonthlyRentalAlertContract,
} from '@/lib/repositories/monthly-rentals.repository'

// ─── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  stats:            MonthlyRentalStats
  contracts:        MonthlyRentalContractWithDetails[]
  properties:       RentalPropertyOption[]
  contacts:         RentalContactOption[]
  isOwner:          boolean
  overdueCharges:   MonthlyRentalAlertCharge[]
  upcomingCharges:  MonthlyRentalAlertCharge[]
  endingContracts:  MonthlyRentalAlertContract[]
  expiredContracts: MonthlyRentalAlertContract[]
}

// ─── Confirm state ────────────────────────────────────────────────────────────

type ConfirmAction = { type: 'end' | 'cancel'; contractId: string } | null

// ─── Stat card ────────────────────────────────────────────────────────────────

function StatCard({
  label, value, icon: Icon, description, alert = false,
}: {
  label: string; value: number; icon: React.ElementType
  description: string; alert?: boolean
}) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <Icon className={`h-4 w-4 ${alert ? 'text-destructive/60' : 'text-muted-foreground/50'}`} />
      </div>
      <p className={`text-2xl font-bold tabular-nums ${alert && value > 0 ? 'text-destructive' : ''}`}>
        {value}
      </p>
      <p className="text-xs text-muted-foreground/60 mt-0.5">{description}</p>
    </div>
  )
}

// ─── Format helpers ────────────────────────────────────────────────────────────

function fmtDate(d: string | null | undefined) {
  if (!d) return '—'
  const [y, m, day] = d.split('-')
  return `${day}/${m}/${y}`
}

function fmtAmount(n: number | null | undefined, currency?: string | null) {
  if (n === null || n === undefined) return '—'
  return `${n.toLocaleString('es-AR')} ${currency ?? 'ARS'}`
}

// ─── Component ────────────────────────────────────────────────────────────────

export function MonthlyRentalsClient({
  stats, contracts, properties, contacts, isOwner,
  overdueCharges, upcomingCharges, endingContracts, expiredContracts,
}: Props) {
  const router = useRouter()
  const [isPending, startTrans] = useTransition()

  const [createOpen,     setCreateOpen]     = useState(false)
  const [search,         setSearch]         = useState('')
  const [statusFilter,   setStatusFilter]   = useState<string>('all')
  const [confirmAction,  setConfirmAction]  = useState<ConfirmAction>(null)

  const visible = contracts.filter((c) => {
    if (statusFilter !== 'all' && c.status !== statusFilter) return false
    if (!search) return true
    const q = search.toLowerCase()
    return (
      c.property?.title?.toLowerCase().includes(q) ||
      c.contact?.name?.toLowerCase().includes(q)   ||
      c.contact?.phone?.includes(q)
    )
  })

  function handleRowClick(id: string) {
    router.push(`/dashboard/monthly-rentals/${id}`)
  }

  function handleActivate(e: React.MouseEvent, contractId: string) {
    e.stopPropagation()
    startTrans(async () => {
      const result = await activateMonthlyRentalContractAction(contractId)
      if (result.success) {
        toast.success('Contrato activado.')
      } else {
        toast.error(result.error ?? 'Error al activar.')
      }
    })
  }

  function requestConfirm(e: React.MouseEvent, type: 'end' | 'cancel', contractId: string) {
    e.stopPropagation()
    setConfirmAction({ type, contractId })
  }

  function executeConfirmed() {
    if (!confirmAction) return
    const { type, contractId } = confirmAction
    setConfirmAction(null)

    startTrans(async () => {
      if (type === 'end') {
        // confirmDebt:true because the user has already confirmed in the dialog.
        // Pending balance is preserved in DB — not deleted.
        const result = await endMonthlyRentalContractAction(contractId, { confirmDebt: true })
        if (result.success) toast.success('Contrato finalizado.')
        else                toast.error(result.error ?? 'Error inesperado.')
      } else {
        const result = await cancelMonthlyRentalContractAction(contractId)
        if (result.success) toast.success('Contrato cancelado.')
        else                toast.error(result.error ?? 'Error inesperado.')
      }
    })
  }

  return (
    <div className="flex h-full flex-col">
      {/* ── Header ───────────────────────────────────────── */}
      <div className="border-b px-6 py-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <KeyRoundIcon className="h-5 w-5 text-muted-foreground" />
            <div>
              <h1 className="text-lg font-semibold">Alquileres mensuales</h1>
              <p className="text-sm text-muted-foreground mt-0.5">
                {contracts.length} contrato{contracts.length !== 1 ? 's' : ''}
              </p>
            </div>
          </div>
          {isOwner && (
            <Button size="sm" onClick={() => setCreateOpen(true)} className="gap-1.5">
              <PlusIcon className="h-3.5 w-3.5" />
              Nuevo contrato
            </Button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
        {/* ── Stats ─────────────────────────────────────── */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <StatCard label="Activos"           value={stats.activeContracts}        icon={FileTextIcon}       description="En curso" />
          <StatCard label="Por vencer"        value={stats.endingSoonContracts}    icon={ClockIcon}          description="En los próximos 60 días" />
          <StatCard label="Cuotas vencidas"   value={stats.overdueCharges}         icon={AlertCircleIcon}    description="Sin pago" alert />
          <StatCard label="Cuotas próximas"   value={stats.upcomingCharges}        icon={CalendarClockIcon}  description="Vencen en 5 días" />
          <StatCard label="Contratos vencidos" value={stats.expiredActiveContracts} icon={AlertTriangleIcon}  description="Activos con fecha pasada" alert />
        </div>

        {/* ── Alerts ────────────────────────────────────── */}
        <RentalAlertsPanel
          overdueCharges={overdueCharges}
          upcomingCharges={upcomingCharges}
          endingContracts={endingContracts}
          expiredContracts={expiredContracts}
        />

        {/* ── Filters ───────────────────────────────────── */}
        <div className="flex gap-2">
          <div className="relative flex-1 max-w-xs">
            <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar propiedad o inquilino..."
              className="h-8 pl-8 text-xs"
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="h-8 text-xs w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-background border shadow-md">
              <SelectItem value="all"       className="text-xs">Todos</SelectItem>
              <SelectItem value="active"    className="text-xs">Activos</SelectItem>
              <SelectItem value="draft"     className="text-xs">Borradores</SelectItem>
              <SelectItem value="ended"     className="text-xs">Finalizados</SelectItem>
              <SelectItem value="cancelled" className="text-xs">Cancelados</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* ── Table ─────────────────────────────────────── */}
        {visible.length === 0 ? (
          <div className="rounded-lg border border-dashed p-10 text-center">
            <KeyRoundIcon className="mx-auto mb-3 h-8 w-8 text-muted-foreground/30" />
            <p className="text-sm text-muted-foreground">
              {contracts.length === 0
                ? 'Todavía no hay contratos de alquiler mensual.'
                : 'No hay contratos que coincidan con el filtro.'}
            </p>
            {isOwner && contracts.length === 0 && (
              <Button size="sm" variant="outline" className="mt-3" onClick={() => setCreateOpen(true)}>
                Crear primer contrato
              </Button>
            )}
          </div>
        ) : (
          <div className="rounded-lg border overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-muted/40 border-b">
                <tr>
                  <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Propiedad</th>
                  <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Inquilino</th>
                  <th className="px-4 py-2.5 text-left font-medium text-muted-foreground hidden sm:table-cell">Inicio</th>
                  <th className="px-4 py-2.5 text-left font-medium text-muted-foreground hidden md:table-cell">Fin</th>
                  <th className="px-4 py-2.5 text-right font-medium text-muted-foreground hidden lg:table-cell">Alquiler</th>
                  <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Estado</th>
                  {isOwner && <th className="px-4 py-2.5 text-right font-medium text-muted-foreground w-28" />}
                </tr>
              </thead>
              <tbody className="divide-y">
                {visible.map((c) => (
                  <tr
                    key={c.id}
                    onClick={() => handleRowClick(c.id)}
                    className="cursor-pointer hover:bg-muted/30 transition-colors"
                  >
                    <td className="px-4 py-3 font-medium">
                      <span className="line-clamp-1">{c.property?.title ?? '—'}</span>
                      {c.property?.location_label && (
                        <span className="block text-muted-foreground font-normal line-clamp-1">
                          {c.property.location_label}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className="line-clamp-1">{c.contact?.name ?? '—'}</span>
                      {c.contact?.phone && (
                        <span className="block text-muted-foreground line-clamp-1">{c.contact.phone}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground hidden sm:table-cell whitespace-nowrap">
                      {fmtDate(c.start_date)}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground hidden md:table-cell whitespace-nowrap">
                      {fmtDate(c.end_date)}
                    </td>
                    <td className="px-4 py-3 text-right hidden lg:table-cell whitespace-nowrap font-medium tabular-nums">
                      {fmtAmount(c.rent_amount, c.currency)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <ContractStatusBadge status={c.status} />
                        {c.property && (
                          <CommercialStatusBadge status={c.property.commercial_status} />
                        )}
                      </div>
                    </td>
                    {isOwner && (
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          {c.status === 'draft' && (
                            <Button
                              size="sm" variant="outline"
                              className="h-6 px-2 text-[10px]"
                              disabled={isPending}
                              onClick={(e) => handleActivate(e, c.id)}
                            >
                              Activar
                            </Button>
                          )}
                          {c.status === 'active' && (
                            <Button
                              size="sm" variant="outline"
                              className="h-6 px-2 text-[10px]"
                              disabled={isPending}
                              onClick={(e) => requestConfirm(e, 'end', c.id)}
                            >
                              Finalizar
                            </Button>
                          )}
                          {(c.status === 'draft' || c.status === 'active') && (
                            <Button
                              size="sm" variant="ghost"
                              className="h-6 px-2 text-[10px] text-destructive hover:text-destructive"
                              disabled={isPending}
                              onClick={(e) => requestConfirm(e, 'cancel', c.id)}
                            >
                              Cancelar
                            </Button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Create dialog ─────────────────────────────────── */}
      {isOwner && (
        <ContractFormDialog
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          properties={properties}
          contacts={contacts}
        />
      )}

      {/* ── Confirm end ───────────────────────────────────── */}
      <AlertDialog
        open={confirmAction?.type === 'end'}
        onOpenChange={(open) => { if (!open) setConfirmAction(null) }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Finalizar contrato</AlertDialogTitle>
            <AlertDialogDescription>
              ¿Seguro que querés finalizar este contrato? La propiedad volverá a quedar disponible
              si no tiene otro contrato activo.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Volver</AlertDialogCancel>
            <AlertDialogAction disabled={isPending} onClick={executeConfirmed}>
              Finalizar contrato
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Confirm cancel ────────────────────────────────── */}
      <AlertDialog
        open={confirmAction?.type === 'cancel'}
        onOpenChange={(open) => { if (!open) setConfirmAction(null) }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancelar contrato</AlertDialogTitle>
            <AlertDialogDescription>
              ¿Seguro que querés cancelar este contrato? Esta acción no borra el historial, pero
              cambiará el estado del contrato.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Volver</AlertDialogCancel>
            <AlertDialogAction
              disabled={isPending}
              onClick={executeConfirmed}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Cancelar contrato
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
