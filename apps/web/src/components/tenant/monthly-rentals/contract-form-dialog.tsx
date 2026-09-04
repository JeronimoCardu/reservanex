'use client'

import { useState, useTransition } from 'react'
import { PlusIcon } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { Button }   from '@/components/ui/button'
import { Input }    from '@/components/ui/input'
import { Label }    from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  createMonthlyRentalContractAction,
  updateMonthlyRentalContractAction,
} from '@/actions/monthly-rentals'
import type {
  MonthlyRentalContractRow,
  RentalPropertyOption,
  RentalContactOption,
} from '@/lib/repositories/monthly-rentals.repository'

// ─── Props ─────────────────────────────────────────────────────────────────────

interface ContractFormDialogProps {
  open:       boolean
  onClose:    () => void
  properties: RentalPropertyOption[]
  contacts:   RentalContactOption[]
  contract?:  MonthlyRentalContractRow
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function str(n: number | null | undefined) {
  return n !== null && n !== undefined ? String(n) : ''
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ContractFormDialog({
  open, onClose, properties, contacts, contract,
}: ContractFormDialogProps) {
  const isEdit = Boolean(contract)
  const [isPending, startTrans] = useTransition()

  const [propertyId, setPropertyId] = useState(contract?.property_id ?? '')
  const [contactId,  setContactId]  = useState(contract?.contact_id  ?? '')
  const [newContactMode, setNewContactMode] = useState(false)
  const [newName,  setNewName]  = useState('')
  const [newPhone, setNewPhone] = useState('')
  const [newEmail, setNewEmail] = useState('')

  const [startDate,  setStartDate]  = useState(contract?.start_date ?? '')
  const [endDate,    setEndDate]    = useState(contract?.end_date   ?? '')
  const [rentAmount, setRentAmount] = useState(str(contract?.rent_amount))
  const [currency,   setCurrency]   = useState(contract?.currency   ?? 'ARS')
  const [dueDay,     setDueDay]     = useState(str(contract?.due_day) || '10')

  const [depositAmount,  setDepositAmount]  = useState(str(contract?.deposit_amount))
  const [depositPaid,    setDepositPaid]    = useState(contract?.deposit_paid ?? false)
  const [expensesAmount, setExpensesAmount] = useState(str(contract?.expenses_amount))
  const [servicesNotes,  setServicesNotes]  = useState(contract?.services_notes ?? '')

  const [adjFreq,  setAdjFreq]  = useState(str(contract?.adjustment_frequency_months))
  const [adjType,  setAdjType]  = useState(contract?.adjustment_type ?? '')
  const [adjNotes, setAdjNotes] = useState(contract?.adjustment_notes ?? '')

  const [contractNotes, setContractNotes] = useState(contract?.contract_notes ?? '')
  const [internalNotes, setInternalNotes] = useState(contract?.internal_notes ?? '')
  const [activateNow,   setActivateNow]   = useState(false)

  const selectedProp      = properties.find((p) => p.id === propertyId)
  const canChangeProperty = !isEdit || contract?.status === 'draft'

  function buildPayload() {
    return {
      property_id:                  propertyId,
      contact_id:                   !newContactMode && contactId ? contactId : undefined,
      new_contact_name:              newContactMode ? newName  : undefined,
      new_contact_phone:             newContactMode ? newPhone : undefined,
      new_contact_email:             newContactMode ? (newEmail || undefined) : undefined,
      start_date:                   startDate,
      end_date:                     endDate || null,
      rent_amount:                  Number(rentAmount),
      currency,
      due_day:                      Number(dueDay),
      deposit_amount:               depositAmount  !== '' ? Number(depositAmount)  : null,
      deposit_paid:                 depositPaid,
      expenses_amount:              expensesAmount !== '' ? Number(expensesAmount) : null,
      services_notes:               servicesNotes  || null,
      adjustment_frequency_months:  adjFreq !== '' ? Number(adjFreq) : null,
      adjustment_type:              adjType || null,
      adjustment_notes:             adjNotes || null,
      contract_notes:               contractNotes || null,
      internal_notes:               internalNotes || null,
      activate:                     activateNow,
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const payload = buildPayload()

    startTrans(async () => {
      if (isEdit && contract) {
        const result = await updateMonthlyRentalContractAction(contract.id, payload)
        if (result.success) {
          toast.success('Contrato actualizado.')
          onClose()
        } else {
          toast.error(result.error ?? 'Error al actualizar.')
        }
      } else {
        const result = await createMonthlyRentalContractAction(payload)
        if (result.success) {
          toast.success(activateNow ? 'Contrato creado y activado.' : 'Contrato guardado como borrador.')
          onClose()
        } else {
          toast.error(result.error ?? 'Error al crear el contrato.')
        }
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-6 pt-6 pb-4 border-b">
          <DialogTitle className="text-sm">
            {isEdit ? 'Editar contrato' : 'Nuevo contrato mensual'}
          </DialogTitle>
        </DialogHeader>

        {/* form wraps scrollable body + sticky footer so type="submit" works */}
        <form onSubmit={handleSubmit} className="flex-1 min-h-0 flex flex-col">
          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">

            {/* ── Propiedad ─────────────────────────────────────── */}
            <section className="space-y-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Propiedad</p>
              <div className="space-y-1.5">
                <Label htmlFor="cf-property" className="text-xs">
                  Propiedad <span className="text-destructive">*</span>
                </Label>
                {canChangeProperty ? (
                  <Select value={propertyId} onValueChange={setPropertyId} disabled={isPending}>
                    <SelectTrigger id="cf-property" className="h-8 text-xs">
                      <SelectValue placeholder="Seleccioná una propiedad..." />
                    </SelectTrigger>
                    <SelectContent className="bg-background border shadow-md max-h-56">
                      {properties.map((p) => (
                        <SelectItem key={p.id} value={p.id} className="text-xs">
                          {p.title}
                          {p.location_label ? ` · ${p.location_label}` : ''}
                          {p.public_code    ? ` (${p.public_code})`    : ''}
                        </SelectItem>
                      ))}
                      {properties.length === 0 && (
                        <SelectItem value="__none" disabled className="text-xs text-muted-foreground">
                          No hay propiedades disponibles
                        </SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                ) : (
                  <p className="text-xs text-muted-foreground rounded border bg-muted px-3 py-2">
                    No se puede cambiar la propiedad de un contrato activo.
                  </p>
                )}
                {selectedProp && (
                  <p className="text-[10px] text-muted-foreground">
                    Precio sugerido:{' '}
                    {selectedProp.monthly_rent_price
                      ? `${selectedProp.monthly_rent_price.toLocaleString('es-AR')} ${currency}/mes`
                      : 'a consultar'}
                    {selectedProp.expenses_amount
                      ? ` · Expensas: ${selectedProp.expenses_amount.toLocaleString('es-AR')}`
                      : ''}
                  </p>
                )}
                {canChangeProperty && (
                  <p className="text-[10px] text-muted-foreground">
                    Solo propiedades de alquiler mensual disponibles.
                  </p>
                )}
              </div>
            </section>

            {/* ── Inquilino ─────────────────────────────────────── */}
            <section className="space-y-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Inquilino</p>
              {!newContactMode ? (
                <div className="space-y-1.5">
                  <Label htmlFor="cf-contact" className="text-xs">
                    Contacto <span className="text-destructive">*</span>
                  </Label>
                  <Select value={contactId} onValueChange={setContactId} disabled={isPending}>
                    <SelectTrigger id="cf-contact" className="h-8 text-xs">
                      <SelectValue placeholder="Seleccioná un contacto..." />
                    </SelectTrigger>
                    <SelectContent className="bg-background border shadow-md max-h-56">
                      {contacts.map((c) => (
                        <SelectItem key={c.id} value={c.id} className="text-xs">
                          {c.name ?? 'Sin nombre'}{c.phone ? ` · ${c.phone}` : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <button
                    type="button"
                    onClick={() => setNewContactMode(true)}
                    className="flex items-center gap-1 text-[10px] text-primary hover:underline"
                    disabled={isPending}
                  >
                    <PlusIcon className="h-2.5 w-2.5" />
                    Crear nuevo contacto
                  </button>
                </div>
              ) : (
                <div className="space-y-2 rounded border p-3">
                  <p className="text-xs font-medium">Nuevo contacto</p>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label className="text-xs">Nombre <span className="text-destructive">*</span></Label>
                      <Input
                        value={newName} onChange={(e) => setNewName(e.target.value)}
                        className="h-8 text-xs" placeholder="Nombre y apellido"
                        disabled={isPending}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Teléfono</Label>
                      <Input
                        value={newPhone} onChange={(e) => setNewPhone(e.target.value)}
                        className="h-8 text-xs" placeholder="54 9 11..."
                        disabled={isPending}
                      />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Email</Label>
                    <Input
                      type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)}
                      className="h-8 text-xs" placeholder="email@ejemplo.com"
                      disabled={isPending}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => setNewContactMode(false)}
                    className="text-[10px] text-muted-foreground hover:underline"
                    disabled={isPending}
                  >
                    ← Seleccionar contacto existente
                  </button>
                </div>
              )}
            </section>

            {/* ── Condiciones ───────────────────────────────────── */}
            <section className="space-y-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Condiciones del contrato</p>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="cf-start" className="text-xs">
                    Fecha inicio <span className="text-destructive">*</span>
                  </Label>
                  <Input id="cf-start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="h-8 text-xs" required disabled={isPending} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="cf-end" className="text-xs">Fecha fin (opcional)</Label>
                  <Input id="cf-end" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="h-8 text-xs" disabled={isPending} />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1.5 col-span-2">
                  <Label htmlFor="cf-rent" className="text-xs">
                    Alquiler mensual <span className="text-destructive">*</span>
                  </Label>
                  <Input id="cf-rent" type="number" min="0" step="0.01" value={rentAmount} onChange={(e) => setRentAmount(e.target.value)} className="h-8 text-xs" required disabled={isPending} placeholder="0" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="cf-currency" className="text-xs">Moneda</Label>
                  <Select value={currency} onValueChange={setCurrency} disabled={isPending}>
                    <SelectTrigger id="cf-currency" className="h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent className="bg-background border shadow-md">
                      <SelectItem value="ARS" className="text-xs">ARS</SelectItem>
                      <SelectItem value="USD" className="text-xs">USD</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="cf-dueday" className="text-xs">Día vencimiento</Label>
                  <Input id="cf-dueday" type="number" min="1" max="31" value={dueDay} onChange={(e) => setDueDay(e.target.value)} className="h-8 text-xs" disabled={isPending} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="cf-deposit" className="text-xs">Depósito</Label>
                  <Input id="cf-deposit" type="number" min="0" step="0.01" value={depositAmount} onChange={(e) => setDepositAmount(e.target.value)} className="h-8 text-xs" disabled={isPending} placeholder="0" />
                </div>
                <div className="flex flex-col justify-end pb-1">
                  <label className="flex items-center gap-2 cursor-pointer h-8">
                    <input
                      type="checkbox" checked={depositPaid}
                      onChange={(e) => setDepositPaid(e.target.checked)}
                      disabled={isPending} className="h-3.5 w-3.5"
                    />
                    <span className="text-xs">Depósito pagado</span>
                  </label>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="cf-expenses" className="text-xs">Expensas</Label>
                  <Input id="cf-expenses" type="number" min="0" step="0.01" value={expensesAmount} onChange={(e) => setExpensesAmount(e.target.value)} className="h-8 text-xs" disabled={isPending} placeholder="0" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Notas de servicios</Label>
                  <Input value={servicesNotes} onChange={(e) => setServicesNotes(e.target.value)} className="h-8 text-xs" placeholder="Agua, luz, gas..." disabled={isPending} />
                </div>
              </div>
            </section>

            {/* ── Reajuste ──────────────────────────────────────── */}
            <section className="space-y-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Reajuste (opcional)</p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Cada N meses</Label>
                  <Input type="number" min="1" value={adjFreq} onChange={(e) => setAdjFreq(e.target.value)} className="h-8 text-xs" disabled={isPending} placeholder="Ej: 6" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Tipo de ajuste</Label>
                  <Select value={adjType} onValueChange={setAdjType} disabled={isPending}>
                    <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Sin ajuste" /></SelectTrigger>
                    <SelectContent className="bg-background border shadow-md">
                      <SelectItem value="" className="text-xs">Sin ajuste</SelectItem>
                      <SelectItem value="fixed_percent" className="text-xs">% fijo</SelectItem>
                      <SelectItem value="index_icl"     className="text-xs">Índice ICL</SelectItem>
                      <SelectItem value="manual"        className="text-xs">Manual</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Notas de ajuste</Label>
                <Input value={adjNotes} onChange={(e) => setAdjNotes(e.target.value)} className="h-8 text-xs" disabled={isPending} placeholder="Ej: 15% cada 6 meses" />
              </div>
            </section>

            {/* ── Notas ─────────────────────────────────────────── */}
            <section className="space-y-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Notas</p>
              <div className="space-y-1.5">
                <Label className="text-xs">Notas del contrato</Label>
                <Textarea value={contractNotes} onChange={(e) => setContractNotes(e.target.value)} rows={2} maxLength={5000} disabled={isPending} className="text-xs resize-none" placeholder="Condiciones especiales, aclaraciones..." />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Notas internas</Label>
                <Textarea value={internalNotes} onChange={(e) => setInternalNotes(e.target.value)} rows={2} maxLength={5000} disabled={isPending} className="text-xs resize-none" placeholder="Solo visible para el equipo..." />
              </div>
            </section>

            {/* ── Activar (solo create) ─────────────────────────── */}
            {!isEdit && (
              <section>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox" checked={activateNow}
                    onChange={(e) => setActivateNow(e.target.checked)}
                    disabled={isPending} className="h-3.5 w-3.5"
                  />
                  <span className="text-xs font-medium">Crear y activar el contrato ahora</span>
                </label>
                {activateNow && (
                  <p className="text-[10px] text-muted-foreground mt-1 ml-5">
                    La propiedad pasará a estado &quot;Alquilada&quot; inmediatamente.
                  </p>
                )}
              </section>
            )}
          </div>

          {/* footer inside form — type="submit" button works correctly */}
          <DialogFooter className="px-6 py-4 border-t gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={isPending}>
              Cancelar
            </Button>
            <Button type="submit" size="sm" disabled={isPending}>
              {isPending
                ? (isEdit ? 'Guardando…' : 'Creando…')
                : isEdit
                  ? 'Guardar cambios'
                  : activateNow ? 'Crear y activar' : 'Guardar borrador'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
