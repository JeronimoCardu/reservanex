'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  ChevronLeftIcon, PencilIcon, PlayIcon, XCircleIcon,
  CheckCircleIcon, PlusIcon, ZapIcon, RefreshCwIcon, CalendarPlusIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction,
} from '@/components/ui/alert-dialog'
import { ContractStatusBadge }       from '@/components/tenant/monthly-rentals/contract-status-badge'
import { CommercialStatusBadge }     from '@/components/tenant/monthly-rentals/commercial-status-badge'
import { ContractFormDialog }        from '@/components/tenant/monthly-rentals/contract-form-dialog'
import { ChargeFormDialog }          from '@/components/tenant/monthly-rentals/charge-form-dialog'
import { GenerateChargesDialog }     from '@/components/tenant/monthly-rentals/generate-charges-dialog'
import { ChargesTable }              from '@/components/tenant/monthly-rentals/charges-table'
import { DebtSummaryCards }          from '@/components/tenant/monthly-rentals/debt-summary-cards'
import { PaymentFormDialog }         from '@/components/tenant/monthly-rentals/payment-form-dialog'
import { PaymentsHistoryTable }      from '@/components/tenant/monthly-rentals/payments-history-table'
import { ContractFollowUpSection }         from '@/components/tenant/monthly-rentals/contract-follow-up-section'
import { MonthlyRentalDocumentsSection }  from '@/components/tenant/monthly-rentals/monthly-rental-documents-section'
import { PaymentProofUploadDialog }       from '@/components/tenant/monthly-rentals/payment-proof-upload-dialog'
import { AccountStatementSection }        from '@/components/tenant/monthly-rentals/account-statement-section'
import { RenewContractDialog }            from '@/components/tenant/monthly-rentals/renew-contract-dialog'
import { ExtendContractDialog }           from '@/components/tenant/monthly-rentals/extend-contract-dialog'
import {
  activateMonthlyRentalContractAction,
  endMonthlyRentalContractAction,
  cancelMonthlyRentalContractAction,
  cancelMonthlyRentalChargeAction,
  voidMonthlyRentalPaymentAction,
  generateMonthlyRentalPaymentReceiptAction,
} from '@/actions/monthly-rentals'
import type { EndContractResult } from '@/actions/monthly-rentals'
import type {
  MonthlyRentalContractDetail,
  RentalPropertyOption,
  RentalContactOption,
  MonthlyRentalDebtSummary,
  MonthlyRentalFollowUpTask,
  MonthlyRentalDocument,
} from '@/lib/repositories/monthly-rentals.repository'
import type { MonthlyRentalChargeRow, MonthlyRentalPaymentRow } from '@orderflow/types'

// ─── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  contract:      MonthlyRentalContractDetail
  properties:    RentalPropertyOption[]
  contacts:      RentalContactOption[]
  debtSummary:   MonthlyRentalDebtSummary
  payments:      MonthlyRentalPaymentRow[]
  followUpTasks: MonthlyRentalFollowUpTask[]
  documents:     MonthlyRentalDocument[]
  isOwner:       boolean
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(d: string | null | undefined) {
  if (!d) return '—'
  const [y, m, day] = d.split('-')
  return `${day}/${m}/${y}`
}

function fmtAmount(n: number | null | undefined, currency?: string | null) {
  if (n === null || n === undefined) return '—'
  return `${n.toLocaleString('es-AR')} ${currency ?? 'ARS'}`
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start gap-4 py-2 border-b last:border-0">
      <span className="text-xs text-muted-foreground w-40 shrink-0 pt-0.5">{label}</span>
      <span className="text-xs font-medium flex-1">{value}</span>
    </div>
  )
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ContractDetailClient({
  contract, properties, contacts, debtSummary, payments, followUpTasks, documents, isOwner,
}: Props) {
  const [isPending, startTrans] = useTransition()
  const router = useRouter()

  // Contract action state
  const [editOpen,      setEditOpen]      = useState(false)
  const [confirmAction, setConfirmAction] = useState<'end' | 'cancel' | null>(null)
  const [renewOpen,     setRenewOpen]     = useState(false)
  const [extendOpen,    setExtendOpen]    = useState(false)

  // Charge state
  const [chargeFormOpen,        setChargeFormOpen]        = useState(false)
  const [editingCharge,         setEditingCharge]         = useState<MonthlyRentalChargeRow | undefined>(undefined)
  const [generateOpen,          setGenerateOpen]          = useState(false)
  const [cancelConfirmChargeId, setCancelConfirmChargeId] = useState<string | null>(null)

  // Payment state
  const [paymentCharge,       setPaymentCharge]       = useState<MonthlyRentalChargeRow | undefined>(undefined)
  const [paymentFormOpen,     setPaymentFormOpen]     = useState(false)
  const [voidConfirmId,       setVoidConfirmId]       = useState<string | null>(null)
  const [receiptLoadingId,    setReceiptLoadingId]    = useState<string | null>(null)
  const [proofDialogPaymentId, setProofDialogPaymentId] = useState<string | null>(null)

  const c = contract

  // Pending balance computed client-side from charges (authoritative check is server-side)
  const pendingBalance = c.charges
    .filter((ch) => ch.status !== 'paid' && ch.status !== 'cancelled')
    .reduce((s, ch) => s + Math.max(0, ch.total_amount - ch.amount_paid), 0)

  // ── Contract actions ───────────────────────────────────────────────────────

  function handleActivate() {
    startTrans(async () => {
      const result = await activateMonthlyRentalContractAction(c.id)
      if (result.success) toast.success('Contrato activado.')
      else                toast.error(result.error ?? 'Error inesperado.')
    })
  }

  function executeConfirmedContract() {
    if (!confirmAction) return
    const type = confirmAction
    setConfirmAction(null)
    startTrans(async () => {
      if (type === 'end') {
        const result: EndContractResult = await endMonthlyRentalContractAction(c.id, {
          confirmDebt: pendingBalance > 0,
        })
        if (result.success) toast.success('Contrato finalizado.')
        else                toast.error(result.error ?? 'Error inesperado.')
      } else {
        const result = await cancelMonthlyRentalContractAction(c.id)
        if (result.success) toast.success('Contrato cancelado.')
        else                toast.error(result.error ?? 'Error inesperado.')
      }
    })
  }

  function handleRenewed(newContractId: string) {
    router.push(`/dashboard/monthly-rentals/${newContractId}`)
  }

  function handleExtended() {
    router.refresh()
  }

  // ── Charge actions ─────────────────────────────────────────────────────────

  function openNewCharge() {
    setEditingCharge(undefined)
    setChargeFormOpen(true)
  }

  function openEditCharge(charge: MonthlyRentalChargeRow) {
    setEditingCharge(charge)
    setChargeFormOpen(true)
  }

  function closeChargeForm() {
    setChargeFormOpen(false)
    setEditingCharge(undefined)
  }

  function executeConfirmedCancelCharge() {
    if (!cancelConfirmChargeId) return
    const id = cancelConfirmChargeId
    setCancelConfirmChargeId(null)
    startTrans(async () => {
      const result = await cancelMonthlyRentalChargeAction(id)
      if (result.success) toast.success('Cuota cancelada.')
      else                toast.error(result.error ?? 'Error inesperado.')
    })
  }

  // ── Payment actions ────────────────────────────────────────────────────────

  function openPaymentForm(charge: MonthlyRentalChargeRow) {
    setPaymentCharge(charge)
    setPaymentFormOpen(true)
  }

  function closePaymentForm() {
    setPaymentFormOpen(false)
    setPaymentCharge(undefined)
  }

  function executeConfirmedVoidPayment() {
    if (!voidConfirmId) return
    const id = voidConfirmId
    setVoidConfirmId(null)
    startTrans(async () => {
      const result = await voidMonthlyRentalPaymentAction(id)
      if (result.success) toast.success('Pago anulado.')
      else                toast.error(result.error ?? 'Error inesperado.')
    })
  }

  async function handleReceiptRequest(paymentId: string) {
    setReceiptLoadingId(paymentId)
    try {
      const result = await generateMonthlyRentalPaymentReceiptAction(paymentId)
      if (result.success) {
        toast.success(`Recibo ${result.data?.receiptNumber ?? ''} generado. Usá el ícono para verlo.`)
      } else {
        toast.error(result.error ?? 'Error al generar el recibo.')
      }
    } finally {
      setReceiptLoadingId(null)
    }
  }

  const canEdit          = isOwner && (c.status === 'draft' || c.status === 'active')
  const canActivate      = isOwner && c.status === 'draft'
  const canEnd           = isOwner && c.status === 'active'
  const canCancel        = isOwner && (c.status === 'draft' || c.status === 'active')
  const canManageCharges = isOwner && (c.status === 'active' || c.status === 'draft')
  const canRenew         = isOwner && (c.status === 'active' || c.status === 'ended')
  const canExtend        = isOwner && (c.status === 'active' || c.status === 'draft')

  const contractForCharge = {
    id:              c.id,
    rent_amount:     c.rent_amount,
    expenses_amount: c.expenses_amount,
    due_day:         c.due_day,
    currency:        c.currency,
  }

  return (
    <div className="flex h-full flex-col">

      {/* ── Header ───────────────────────────────────────── */}
      <div className="border-b px-6 py-4">
        <div className="flex items-center gap-3 mb-3">
          <Link
            href="/dashboard/monthly-rentals"
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <ChevronLeftIcon className="h-3.5 w-3.5" />
            Alquileres mensuales
          </Link>
        </div>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold line-clamp-1">
              {c.property?.title ?? 'Contrato sin propiedad'}
            </h1>
            <div className="flex items-center gap-2 mt-1.5 flex-wrap">
              <ContractStatusBadge status={c.status} />
              {c.property && <CommercialStatusBadge status={c.property.commercial_status} />}
              {c.contact?.name && (
                <span className="text-xs text-muted-foreground">· {c.contact.name}</span>
              )}
            </div>
          </div>
          {isOwner && (
            <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
              {canRenew && (
                <Button size="sm" variant="outline" onClick={() => setRenewOpen(true)} disabled={isPending} className="gap-1.5">
                  <RefreshCwIcon className="h-3.5 w-3.5" />
                  Renovar
                </Button>
              )}
              {canExtend && (
                <Button size="sm" variant="outline" onClick={() => setExtendOpen(true)} disabled={isPending} className="gap-1.5">
                  <CalendarPlusIcon className="h-3.5 w-3.5" />
                  Extender
                </Button>
              )}
              {canEdit && (
                <Button size="sm" variant="outline" onClick={() => setEditOpen(true)} disabled={isPending} className="gap-1.5">
                  <PencilIcon className="h-3.5 w-3.5" />
                  Editar
                </Button>
              )}
              {canActivate && (
                <Button size="sm" onClick={handleActivate} disabled={isPending} className="gap-1.5">
                  <PlayIcon className="h-3.5 w-3.5" />
                  Activar
                </Button>
              )}
              {canEnd && (
                <Button size="sm" variant="outline" onClick={() => setConfirmAction('end')} disabled={isPending} className="gap-1.5">
                  <CheckCircleIcon className="h-3.5 w-3.5" />
                  Finalizar
                </Button>
              )}
              {canCancel && (
                <Button size="sm" variant="destructive" onClick={() => setConfirmAction('cancel')} disabled={isPending} className="gap-1.5">
                  <XCircleIcon className="h-3.5 w-3.5" />
                  Cancelar
                </Button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Body ─────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">

        {/* Resumen de deuda */}
        <section>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Deuda</p>
          <DebtSummaryCards summary={debtSummary} currency={c.currency} />
        </section>

        {/* Partes */}
        <section className="space-y-1">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Partes</p>
          <Row label="Propiedad"  value={c.property?.title ?? '—'} />
          {c.property?.location_label && (
            <Row label="Ubicación" value={c.property.location_label} />
          )}
          {c.property?.public_code && (
            <Row label="Código"    value={c.property.public_code} />
          )}
          <Row label="Inquilino"  value={c.contact?.name  ?? '—'} />
          {c.contact?.phone && <Row label="Teléfono" value={c.contact.phone} />}
          {c.contact?.email && <Row label="Email"    value={c.contact.email} />}
        </section>

        {/* Condiciones */}
        <section className="space-y-1">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Condiciones</p>
          <Row label="Fecha de inicio"    value={fmtDate(c.start_date)} />
          <Row label="Fecha de fin"       value={fmtDate(c.end_date)} />
          <Row label="Alquiler mensual"   value={fmtAmount(c.rent_amount, c.currency)} />
          <Row label="Día de vencimiento" value={c.due_day ? `Día ${c.due_day}` : '—'} />
          <Row label="Depósito"
            value={
              c.deposit_amount
                ? `${fmtAmount(c.deposit_amount, c.currency)} ${c.deposit_paid ? '(pagado)' : '(pendiente)'}`
                : '—'
            }
          />
          <Row label="Expensas" value={fmtAmount(c.expenses_amount, c.currency)} />
          {c.services_notes && <Row label="Servicios" value={c.services_notes} />}
        </section>

        {/* Reajuste */}
        {(c.adjustment_frequency_months || c.adjustment_type) && (
          <section className="space-y-1">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Reajuste</p>
            {c.adjustment_frequency_months && (
              <Row label="Frecuencia" value={`Cada ${c.adjustment_frequency_months} meses`} />
            )}
            {c.adjustment_type && (
              <Row label="Tipo"
                value={
                  c.adjustment_type === 'fixed_percent' ? '% fijo'
                  : c.adjustment_type === 'index_icl'   ? 'Índice ICL'
                  : 'Manual'
                }
              />
            )}
            {c.adjustment_notes && <Row label="Notas" value={c.adjustment_notes} />}
          </section>
        )}

        {/* Notas */}
        {(c.contract_notes || c.internal_notes) && (
          <section className="space-y-1">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Notas</p>
            {c.contract_notes && <Row label="Del contrato" value={c.contract_notes} />}
            {c.internal_notes && <Row label="Internas"     value={c.internal_notes} />}
          </section>
        )}

        {/* Cuotas */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Cuotas</p>
            {canManageCharges && (
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" className="gap-1.5 h-7 text-xs" onClick={() => setGenerateOpen(true)} disabled={isPending}>
                  <ZapIcon className="h-3 w-3" />
                  Generar en lote
                </Button>
                <Button size="sm" className="gap-1.5 h-7 text-xs" onClick={openNewCharge} disabled={isPending}>
                  <PlusIcon className="h-3 w-3" />
                  Nueva cuota
                </Button>
              </div>
            )}
          </div>
          <div className="rounded-lg border overflow-hidden">
            <ChargesTable
              charges={c.charges}
              currency={c.currency}
              isOwner={canManageCharges}
              onEdit={openEditCharge}
              onCancelRequest={(chargeId) => setCancelConfirmChargeId(chargeId)}
              onPayRequest={openPaymentForm}
              onNew={openNewCharge}
            />
          </div>
        </section>

        {/* Pagos */}
        <section>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Pagos registrados</p>
          <div className="rounded-lg border overflow-hidden">
            <div className="px-4 py-2">
              <PaymentsHistoryTable
                payments={payments}
                charges={c.charges}
                currency={c.currency}
                isOwner={isOwner}
                receiptLoadingId={receiptLoadingId}
                onVoidRequest={(paymentId) => setVoidConfirmId(paymentId)}
                onReceiptRequest={handleReceiptRequest}
                onProofRequest={isOwner ? (paymentId) => setProofDialogPaymentId(paymentId) : undefined}
              />
            </div>
          </div>
        </section>

        {/* Estado de cuenta */}
        <AccountStatementSection
          contract={c}
          payments={payments}
        />

        {/* Seguimiento */}
        <ContractFollowUpSection
          contractId={c.id}
          tasks={followUpTasks}
          isOwner={isOwner}
        />

        {/* Documentos */}
        <MonthlyRentalDocumentsSection
          contractId={c.id}
          documents={documents}
          isOwner={isOwner}
        />
      </div>

      {/* ── Renew contract dialog ────────────────────────── */}
      {canRenew && (
        <RenewContractDialog
          open={renewOpen}
          onClose={() => setRenewOpen(false)}
          originalContractId={c.id}
          defaults={{
            rentAmount:     c.rent_amount,
            expensesAmount: c.expenses_amount,
            dueDay:         c.due_day ?? 10,
            currency:       c.currency,
          }}
          onRenewed={handleRenewed}
        />
      )}

      {/* ── Extend contract dialog ────────────────────────── */}
      {canExtend && (
        <ExtendContractDialog
          open={extendOpen}
          onClose={() => setExtendOpen(false)}
          contractId={c.id}
          currentEndDate={c.end_date}
          currency={c.currency}
          onExtended={handleExtended}
        />
      )}

      {/* ── Payment proof upload dialog ───────────────────── */}
      {isOwner && (
        <PaymentProofUploadDialog
          open={proofDialogPaymentId !== null}
          onClose={() => setProofDialogPaymentId(null)}
          paymentId={proofDialogPaymentId}
        />
      )}

      {/* ── Edit contract dialog ──────────────────────────── */}
      {isOwner && canEdit && (
        <ContractFormDialog
          open={editOpen}
          onClose={() => setEditOpen(false)}
          properties={properties}
          contacts={contacts}
          contract={c}
        />
      )}

      {/* ── Charge form dialog ────────────────────────────── */}
      {canManageCharges && (
        <ChargeFormDialog
          key={editingCharge?.id ?? 'new'}
          open={chargeFormOpen}
          onClose={closeChargeForm}
          contract={contractForCharge}
          charge={editingCharge}
        />
      )}

      {/* ── Generate charges dialog ───────────────────────── */}
      {canManageCharges && (
        <GenerateChargesDialog
          open={generateOpen}
          onClose={() => setGenerateOpen(false)}
          contractId={c.id}
        />
      )}

      {/* ── Payment form dialog ───────────────────────────── */}
      {paymentCharge && (
        <PaymentFormDialog
          key={paymentCharge.id}
          open={paymentFormOpen}
          onClose={closePaymentForm}
          charge={paymentCharge}
          currency={c.currency}
        />
      )}

      {/* ── Confirm finalizar ─────────────────────────────── */}
      <AlertDialog
        open={confirmAction === 'end'}
        onOpenChange={(open) => { if (!open) setConfirmAction(null) }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Finalizar contrato</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  ¿Seguro que querés finalizar este contrato? La propiedad volverá a quedar disponible
                  si no tiene otro contrato activo.
                </p>
                {pendingBalance > 0 && (
                  <p className="text-amber-700 dark:text-amber-400 font-medium text-sm">
                    Hay un saldo pendiente de {pendingBalance.toLocaleString('es-AR')} {c.currency}.
                    El contrato se finalizará de todas formas y el saldo quedará registrado.
                  </p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Volver</AlertDialogCancel>
            <AlertDialogAction disabled={isPending} onClick={executeConfirmedContract}>
              Finalizar contrato
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Confirm cancelar contrato ─────────────────────── */}
      <AlertDialog
        open={confirmAction === 'cancel'}
        onOpenChange={(open) => { if (!open) setConfirmAction(null) }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancelar contrato</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  ¿Seguro que querés cancelar este contrato? Las cuotas, pagos y documentos
                  existentes quedarán como historial. Si hay saldo pendiente, considerá
                  finalizar en vez de cancelar.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Volver</AlertDialogCancel>
            <AlertDialogAction
              disabled={isPending}
              onClick={executeConfirmedContract}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Cancelar contrato
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Confirm cancelar cuota ────────────────────────── */}
      <AlertDialog
        open={cancelConfirmChargeId !== null}
        onOpenChange={(open) => { if (!open) setCancelConfirmChargeId(null) }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancelar cuota</AlertDialogTitle>
            <AlertDialogDescription>
              ¿Seguro que querés cancelar esta cuota? La cuota quedará marcada como cancelada
              y no se borrará del historial.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Volver</AlertDialogCancel>
            <AlertDialogAction
              disabled={isPending}
              onClick={executeConfirmedCancelCharge}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Cancelar cuota
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Confirm anular pago ───────────────────────────── */}
      <AlertDialog
        open={voidConfirmId !== null}
        onOpenChange={(open) => { if (!open) setVoidConfirmId(null) }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Anular pago</AlertDialogTitle>
            <AlertDialogDescription>
              ¿Seguro que querés anular este pago? El pago quedará marcado como anulado y la
              deuda de la cuota se recalculará automáticamente.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Volver</AlertDialogCancel>
            <AlertDialogAction
              disabled={isPending}
              onClick={executeConfirmedVoidPayment}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Anular pago
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
