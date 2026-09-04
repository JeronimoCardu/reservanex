'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { addMonths, getDaysInMonth } from 'date-fns'
import { requireTenantContext } from '@/lib/auth/require-tenant-context'
import { createClient } from '@orderflow/supabase/server'
import { createAdminClient } from '@orderflow/supabase/admin'
import { createContact } from '@/lib/repositories/contacts.repository'
import { countOtherActiveContracts } from '@/lib/repositories/monthly-rentals.repository'
import { generateMonthlyRentalReceiptPdf } from '@/lib/generate-monthly-rental-receipt-pdf'
import type { ActionResult } from '@/lib/action-result'

// ─── Path helpers ──────────────────────────────────────────────────────────────

const LIST_PATH   = '/dashboard/monthly-rentals'
const DETAIL_PATH = (id: string) => `/dashboard/monthly-rentals/${id}`

// ─── Zod schemas ───────────────────────────────────────────────────────────────

const optionalEmail = z.preprocess(
  (v) => (v === '' || v === null || v === undefined ? undefined : v),
  z.string().email('Email inválido').optional(),
)

const optionalPositiveNumber = z.preprocess(
  (v) => (v === '' || v === null || v === undefined ? null : Number(v)),
  z.number().min(0).nullable().optional(),
)

// Base object — no refines — so we can derive updateContractSchema with .omit()
const contractBaseObject = z.object({
  property_id:                  z.string().uuid('Propiedad inválida'),
  contact_id:                   z.string().uuid().optional(),
  new_contact_name:             z.string().min(1).max(200).optional(),
  new_contact_phone:            z.string().max(50).optional(),
  new_contact_email:            optionalEmail,
  start_date:                   z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha de inicio inválida'),
  end_date:                     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  rent_amount:                  z.preprocess(Number, z.number().min(0, 'El monto debe ser 0 o mayor')),
  currency:                     z.string().default('ARS'),
  due_day:                      z.preprocess(Number, z.number().int().min(1).max(31)),
  deposit_amount:               optionalPositiveNumber,
  deposit_paid:                 z.boolean().default(false),
  expenses_amount:              optionalPositiveNumber,
  services_notes:               z.string().max(2000).nullable().optional(),
  adjustment_frequency_months:  z.preprocess(
    (v) => (v === '' || v === null || v === undefined ? null : Number(v)),
    z.number().int().min(1).nullable().optional(),
  ),
  adjustment_type:              z.enum(['fixed_percent', 'index_icl', 'manual']).nullable().optional(),
  adjustment_notes:             z.string().max(2000).nullable().optional(),
  contract_notes:               z.string().max(5000).nullable().optional(),
  internal_notes:               z.string().max(5000).nullable().optional(),
  activate:                     z.boolean().default(false),
})

// For create: add cross-field refines
const contractSchema = contractBaseObject
  .refine(
    (d) => d.contact_id || d.new_contact_name,
    { message: 'Seleccioná un inquilino existente o ingresá el nombre de uno nuevo.' },
  )
  .refine(
    (d) => !d.end_date || d.end_date >= d.start_date,
    { message: 'La fecha de fin debe ser igual o posterior a la fecha de inicio.' },
  )

// For update: derived from the base object (no refines) so .omit() works
const updateContractSchema = contractBaseObject
  .omit({ activate: true, new_contact_name: true, new_contact_phone: true, new_contact_email: true })
  .partial()
  .extend({
    contact_id: z.string().uuid().optional(),
  })

// ─── Helpers ───────────────────────────────────────────────────────────────────

async function validateProperty(
  supabase: Awaited<ReturnType<typeof createClient>>,
  tenantId: string,
  propertyId: string,
  requireAvailable: boolean,
): Promise<{ ok: true; property: { id: string; operation_type: string; commercial_status: string } } | { ok: false; error: string }> {
  const { data: property } = await supabase
    .from('properties')
    .select('id, operation_type, commercial_status')
    .eq('id', propertyId)
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .maybeSingle()

  if (!property) return { ok: false, error: 'Propiedad no encontrada.' }
  if (property.operation_type !== 'long_term_rental')
    return { ok: false, error: 'La propiedad debe ser de alquiler mensual (long_term_rental).' }
  if (requireAvailable && property.commercial_status !== 'available')
    return {
      ok: false,
      error: 'No podés activar este contrato porque la propiedad no está marcada como Disponible. Cambiá el estado de la propiedad a "Disponible" antes de continuar.',
    }

  return { ok: true, property: property as { id: string; operation_type: string; commercial_status: string } }
}

async function syncPropertyStatus(
  supabase: Awaited<ReturnType<typeof createClient>>,
  tenantId:   string,
  propertyId: string,
  newStatus:  'available' | 'rented',
): Promise<void> {
  const { error } = await supabase
    .from('properties')
    .update({ commercial_status: newStatus })
    .eq('id', propertyId)
    .eq('tenant_id', tenantId)

  if (error) {
    // Non-critical — contract is already updated. Log and continue.
    console.warn('[monthly-rentals] property commercial_status sync failed', { propertyId, newStatus, error: error.message })
  }
}

// ─── CREATE ────────────────────────────────────────────────────────────────────

export async function createMonthlyRentalContractAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }
  if (ctx.role !== 'owner') {
    return { success: false, error: 'Solo los owners pueden crear contratos mensuales.' }
  }

  const parsed = contractSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.errors[0]?.message ?? 'Datos inválidos.' }
  }

  const d        = parsed.data
  const supabase = await createClient()

  // Validate property type only — commercial_status check is deferred when activating
  const propCheck = await validateProperty(supabase, ctx.tenantId, d.property_id, false)
  if (!propCheck.ok) return { success: false, error: propCheck.error }

  // Resolve or create contact
  let contactId = d.contact_id
  if (!contactId) {
    try {
      const newContact = await createContact(ctx.tenantId, {
        name:   d.new_contact_name!,
        phone:  d.new_contact_phone || 'Sin teléfono',
        email:  d.new_contact_email,
        source: 'manual',
      })
      contactId = newContact.id
    } catch (err) {
      if (err instanceof Error && err.message === 'DUPLICATE_PHONE') {
        return { success: false, error: 'Ya existe un contacto con ese teléfono.' }
      }
      return { success: false, error: 'Error al crear el contacto.' }
    }
  } else {
    // Verify contact belongs to tenant
    const { data: contact } = await supabase
      .from('contacts')
      .select('id')
      .eq('id', contactId)
      .eq('tenant_id', ctx.tenantId)
      .is('deleted_at', null)
      .maybeSingle()
    if (!contact) return { success: false, error: 'Contacto no encontrado.' }
  }

  // If activating: check for another active contract first (clearer message), then commercial_status
  if (d.activate) {
    const others = await countOtherActiveContracts(ctx.tenantId, d.property_id)
    if (others > 0) {
      return {
        success: false,
        error: 'No podés activar este contrato porque la propiedad ya tiene otro contrato activo. Finalizá el contrato actual antes de activar este nuevo.',
      }
    }
    if (propCheck.property.commercial_status !== 'available') {
      return {
        success: false,
        error: 'No podés activar este contrato porque la propiedad no está marcada como Disponible. Cambiá el estado de la propiedad a "Disponible" antes de continuar.',
      }
    }
  }

  const status = d.activate ? 'active' : 'draft'

  const { data: contract, error } = await supabase
    .from('monthly_rental_contracts')
    .insert({
      tenant_id:                   ctx.tenantId,
      property_id:                 d.property_id,
      contact_id:                  contactId,
      status,
      start_date:                  d.start_date,
      end_date:                    d.end_date ?? null,
      rent_amount:                 d.rent_amount,
      currency:                    d.currency,
      due_day:                     d.due_day,
      deposit_amount:              d.deposit_amount ?? null,
      deposit_paid:                d.deposit_paid,
      expenses_amount:             d.expenses_amount ?? null,
      services_notes:              d.services_notes  ?? null,
      adjustment_frequency_months: d.adjustment_frequency_months ?? null,
      adjustment_type:             d.adjustment_type ?? null,
      adjustment_notes:            d.adjustment_notes ?? null,
      contract_notes:              d.contract_notes  ?? null,
      internal_notes:              d.internal_notes  ?? null,
      created_by:                  ctx.userId,
    })
    .select('id')
    .single()

  if (error) return { success: false, error: 'Error al crear el contrato.' }

  if (d.activate) {
    await syncPropertyStatus(supabase, ctx.tenantId, d.property_id, 'rented')
  }

  revalidatePath(LIST_PATH)
  return { success: true, data: { id: contract.id } }
}

// ─── UPDATE ────────────────────────────────────────────────────────────────────

export async function updateMonthlyRentalContractAction(
  contractId: string,
  input: unknown,
): Promise<ActionResult> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }
  if (ctx.role !== 'owner') {
    return { success: false, error: 'Solo los owners pueden editar contratos.' }
  }

  const parsed = updateContractSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.errors[0]?.message ?? 'Datos inválidos.' }
  }

  const d        = parsed.data
  const supabase = await createClient()

  const { data: current } = await supabase
    .from('monthly_rental_contracts')
    .select('id, status, property_id')
    .eq('id', contractId)
    .eq('tenant_id', ctx.tenantId)
    .is('deleted_at', null)
    .maybeSingle()

  if (!current) return { success: false, error: 'Contrato no encontrado.' }
  if (current.status === 'ended' || current.status === 'cancelled') {
    return { success: false, error: 'No se puede editar un contrato finalizado o cancelado.' }
  }

  // Validate new contact_id — must belong to this tenant
  if (d.contact_id) {
    const { data: contactCheck } = await supabase
      .from('contacts')
      .select('id')
      .eq('id', d.contact_id)
      .eq('tenant_id', ctx.tenantId)
      .is('deleted_at', null)
      .maybeSingle()
    if (!contactCheck) return { success: false, error: 'Contacto no encontrado.' }
  }

  // If property_id changed for an active contract, block it
  if (current.status === 'active' && d.property_id && d.property_id !== current.property_id) {
    return { success: false, error: 'No se puede cambiar la propiedad de un contrato activo.' }
  }

  // Validate new property if changed
  if (d.property_id && d.property_id !== current.property_id) {
    const propCheck = await validateProperty(supabase, ctx.tenantId, d.property_id, false)
    if (!propCheck.ok) return { success: false, error: propCheck.error }
  }

  const patch = {
    ...(d.property_id                 !== undefined ? { property_id:                 d.property_id                 } : {}),
    ...(d.contact_id                  !== undefined ? { contact_id:                  d.contact_id                  } : {}),
    ...(d.start_date                  !== undefined ? { start_date:                  d.start_date                  } : {}),
    ...(d.end_date                    !== undefined ? { end_date:                    d.end_date   ?? null           } : {}),
    ...(d.rent_amount                 !== undefined ? { rent_amount:                 d.rent_amount                 } : {}),
    ...(d.currency                    !== undefined ? { currency:                    d.currency                    } : {}),
    ...(d.due_day                     !== undefined ? { due_day:                     d.due_day                     } : {}),
    ...(d.deposit_amount              !== undefined ? { deposit_amount:              d.deposit_amount  ?? null     } : {}),
    ...(d.deposit_paid                !== undefined ? { deposit_paid:                d.deposit_paid                } : {}),
    ...(d.expenses_amount             !== undefined ? { expenses_amount:             d.expenses_amount ?? null     } : {}),
    ...(d.services_notes              !== undefined ? { services_notes:              d.services_notes  ?? null     } : {}),
    ...(d.adjustment_frequency_months !== undefined ? { adjustment_frequency_months: d.adjustment_frequency_months ?? null } : {}),
    ...(d.adjustment_type             !== undefined ? { adjustment_type:             d.adjustment_type ?? null     } : {}),
    ...(d.adjustment_notes            !== undefined ? { adjustment_notes:            d.adjustment_notes ?? null    } : {}),
    ...(d.contract_notes              !== undefined ? { contract_notes:              d.contract_notes  ?? null     } : {}),
    ...(d.internal_notes              !== undefined ? { internal_notes:              d.internal_notes  ?? null     } : {}),
  }

  const { error } = await supabase
    .from('monthly_rental_contracts')
    .update(patch)
    .eq('id', contractId)
    .eq('tenant_id', ctx.tenantId)

  if (error) return { success: false, error: 'Error al actualizar el contrato.' }

  revalidatePath(LIST_PATH)
  revalidatePath(DETAIL_PATH(contractId))
  return { success: true }
}

// ─── ACTIVATE ──────────────────────────────────────────────────────────────────

export async function activateMonthlyRentalContractAction(
  contractId: string,
): Promise<ActionResult> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }
  if (ctx.role !== 'owner') {
    return { success: false, error: 'Solo los owners pueden activar contratos.' }
  }

  const supabase = await createClient()

  const { data: contract } = await supabase
    .from('monthly_rental_contracts')
    .select('id, status, property_id')
    .eq('id', contractId)
    .eq('tenant_id', ctx.tenantId)
    .is('deleted_at', null)
    .maybeSingle()

  if (!contract) return { success: false, error: 'Contrato no encontrado.' }
  if (contract.status !== 'draft') {
    const STATUS_LABEL: Record<string, string> = { active: 'Activo', ended: 'Finalizado', cancelled: 'Cancelado' }
    const label = STATUS_LABEL[contract.status] ?? contract.status
    return { success: false, error: `Solo se pueden activar contratos en estado Borrador. Este contrato está ${label}.` }
  }

  // Check for another active contract first — gives a clearer message than the commercial_status check
  const others = await countOtherActiveContracts(ctx.tenantId, contract.property_id, contractId)
  if (others > 0) {
    return {
      success: false,
      error: 'No podés activar este contrato porque la propiedad ya tiene otro contrato activo. Finalizá el contrato actual antes de activar este nuevo.',
    }
  }

  const propCheck = await validateProperty(supabase, ctx.tenantId, contract.property_id, true)
  if (!propCheck.ok) return { success: false, error: propCheck.error }

  const { error } = await supabase
    .from('monthly_rental_contracts')
    .update({ status: 'active' })
    .eq('id', contractId)
    .eq('tenant_id', ctx.tenantId)

  if (error) return { success: false, error: 'Error al activar el contrato.' }

  await syncPropertyStatus(supabase, ctx.tenantId, contract.property_id, 'rented')

  revalidatePath(LIST_PATH)
  revalidatePath(DETAIL_PATH(contractId))
  return { success: true }
}

// ─── END ───────────────────────────────────────────────────────────────────────

export type EndContractResult =
  | { success: true }
  | { success: false; error: string; pendingBalance?: number }

export async function endMonthlyRentalContractAction(
  contractId: string,
  opts: { confirmDebt?: boolean } = {},
): Promise<EndContractResult> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }
  if (ctx.role !== 'owner') {
    return { success: false, error: 'Solo los owners pueden finalizar contratos.' }
  }

  const supabase = await createClient()

  const { data: contract } = await supabase
    .from('monthly_rental_contracts')
    .select('id, status, property_id, currency')
    .eq('id', contractId)
    .eq('tenant_id', ctx.tenantId)
    .is('deleted_at', null)
    .maybeSingle()

  if (!contract) return { success: false, error: 'Contrato no encontrado.' }
  if (contract.status !== 'active') {
    return { success: false, error: 'Solo se pueden finalizar contratos activos.' }
  }

  // Check pending balance
  const { data: chargeRows } = await supabase
    .from('monthly_rental_charges')
    .select('total_amount, amount_paid, status')
    .eq('contract_id', contractId)
    .eq('tenant_id', ctx.tenantId)

  const pendingBalance = (chargeRows ?? [])
    .filter((r) => r.status !== 'cancelled')
    .reduce((s, r) => s + Math.max(0, (r.total_amount as number) - (r.amount_paid as number)), 0)

  if (pendingBalance > 0 && !opts.confirmDebt) {
    return {
      success: false,
      error: `Este contrato tiene saldo pendiente de ${pendingBalance.toLocaleString('es-AR')} ${(contract as unknown as { currency: string }).currency}. Finalizar no borra la deuda ni los pagos.`,
      pendingBalance,
    }
  }

  const { error } = await supabase
    .from('monthly_rental_contracts')
    .update({ status: 'ended' })
    .eq('id', contractId)
    .eq('tenant_id', ctx.tenantId)

  if (error) return { success: false, error: 'Error al finalizar el contrato.' }

  // Restore property to available only if no other active contract exists
  const others = await countOtherActiveContracts(ctx.tenantId, contract.property_id, contractId)
  if (others === 0) {
    await syncPropertyStatus(supabase, ctx.tenantId, contract.property_id, 'available')
  }

  revalidatePath(LIST_PATH)
  revalidatePath(DETAIL_PATH(contractId))
  return { success: true }
}

// ─── CANCEL ────────────────────────────────────────────────────────────────────

export async function cancelMonthlyRentalContractAction(
  contractId: string,
): Promise<ActionResult> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }
  if (ctx.role !== 'owner') {
    return { success: false, error: 'Solo los owners pueden cancelar contratos.' }
  }

  const supabase = await createClient()

  const { data: contract } = await supabase
    .from('monthly_rental_contracts')
    .select('id, status, property_id')
    .eq('id', contractId)
    .eq('tenant_id', ctx.tenantId)
    .is('deleted_at', null)
    .maybeSingle()

  if (!contract) return { success: false, error: 'Contrato no encontrado.' }
  if (contract.status !== 'draft' && contract.status !== 'active') {
    return { success: false, error: 'Solo se pueden cancelar contratos en borrador o activos.' }
  }

  // Block cancellation if active payments exist — suggest ending instead
  const { count: activePayments } = await supabase
    .from('monthly_rental_payments')
    .select('id', { count: 'exact', head: true })
    .eq('contract_id', contractId)
    .eq('tenant_id', ctx.tenantId)
    .eq('status', 'active')

  if (activePayments && activePayments > 0) {
    return {
      success: false,
      error: `No podés cancelar un contrato con ${activePayments} pago${activePayments !== 1 ? 's' : ''} registrado${activePayments !== 1 ? 's' : ''}. Finalizalo para conservar el historial.`,
    }
  }

  const wasActive = contract.status === 'active'

  const { error } = await supabase
    .from('monthly_rental_contracts')
    .update({ status: 'cancelled' })
    .eq('id', contractId)
    .eq('tenant_id', ctx.tenantId)

  if (error) return { success: false, error: 'Error al cancelar el contrato.' }

  // Restore property only if it was active and no other active contract exists
  if (wasActive) {
    const others = await countOtherActiveContracts(ctx.tenantId, contract.property_id, contractId)
    if (others === 0) {
      await syncPropertyStatus(supabase, ctx.tenantId, contract.property_id, 'available')
    }
  }

  revalidatePath(LIST_PATH)
  revalidatePath(DETAIL_PATH(contractId))
  return { success: true }
}

// ─── RENEW ─────────────────────────────────────────────────────────────────────

const renewContractSchema = z.object({
  startDate:      z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha de inicio inválida'),
  endDate:        z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  rentAmount:     z.preprocess(Number, z.number().min(1, 'El alquiler debe ser mayor a 0')),
  dueDay:         z.preprocess(Number, z.number().int().min(1).max(31)),
  expensesAmount: optionalPositiveNumber,
  depositAmount:  optionalPositiveNumber,
  contractNotes:  z.string().max(5000).nullable().optional(),
})

export async function renewMonthlyRentalContractAction(
  originalContractId: string,
  input: unknown,
): Promise<ActionResult<{ newContractId: string }>> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }
  if (ctx.role !== 'owner') return { success: false, error: 'Solo los owners pueden renovar contratos.' }

  const parsed = renewContractSchema.safeParse(input)
  if (!parsed.success) return { success: false, error: parsed.error.errors[0]?.message ?? 'Datos inválidos.' }

  const d        = parsed.data
  const supabase = await createClient()

  const { data: original } = await supabase
    .from('monthly_rental_contracts')
    .select('id, status, property_id, contact_id, currency, tenant_id')
    .eq('id', originalContractId)
    .eq('tenant_id', ctx.tenantId)
    .is('deleted_at', null)
    .maybeSingle()

  if (!original) return { success: false, error: 'Contrato original no encontrado.' }
  if (original.status !== 'active' && original.status !== 'ended') {
    return { success: false, error: 'Solo se pueden renovar contratos activos o finalizados.' }
  }

  // Validate property still belongs to tenant
  const { data: prop } = await supabase
    .from('properties')
    .select('id')
    .eq('id', original.property_id)
    .eq('tenant_id', ctx.tenantId)
    .is('deleted_at', null)
    .maybeSingle()
  if (!prop) return { success: false, error: 'La propiedad ya no está disponible.' }

  // Create new draft contract — the original contract is NOT modified here.
  // The user must finalize the current contract separately to avoid leaving
  // the property in 'available' state during the transition.
  const { data: newContract, error: createErr } = await supabase
    .from('monthly_rental_contracts')
    .insert({
      tenant_id:      ctx.tenantId,
      property_id:    original.property_id,
      contact_id:     original.contact_id,
      status:         'draft',
      start_date:     d.startDate,
      end_date:       d.endDate ?? null,
      rent_amount:    d.rentAmount,
      currency:       (original as unknown as { currency: string }).currency,
      due_day:        d.dueDay,
      expenses_amount: d.expensesAmount ?? null,
      deposit_amount:  d.depositAmount  ?? null,
      contract_notes:  d.contractNotes  ?? null,
      created_by:      ctx.userId,
    })
    .select('id')
    .single()

  if (createErr || !newContract) return { success: false, error: 'Error al crear el nuevo contrato.' }

  revalidatePath(LIST_PATH)
  revalidatePath(DETAIL_PATH(originalContractId))
  return { success: true, data: { newContractId: newContract.id } }
}

// ─── EXTEND ────────────────────────────────────────────────────────────────────

const extendContractSchema = z.object({
  newEndDate:    z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha de fin inválida'),
  newRentAmount: z.preprocess(
    (v) => (v === '' || v === null || v === undefined ? undefined : Number(v)),
    z.number().min(0).optional(),
  ),
  notes: z.string().max(5000).nullable().optional(),
})

export async function extendMonthlyRentalContractAction(
  contractId: string,
  input: unknown,
): Promise<ActionResult> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }
  if (ctx.role !== 'owner') return { success: false, error: 'Solo los owners pueden extender contratos.' }

  const parsed = extendContractSchema.safeParse(input)
  if (!parsed.success) return { success: false, error: parsed.error.errors[0]?.message ?? 'Datos inválidos.' }

  const d        = parsed.data
  const supabase = await createClient()

  const { data: contract } = await supabase
    .from('monthly_rental_contracts')
    .select('id, status, end_date, internal_notes')
    .eq('id', contractId)
    .eq('tenant_id', ctx.tenantId)
    .is('deleted_at', null)
    .maybeSingle()

  if (!contract) return { success: false, error: 'Contrato no encontrado.' }
  if (contract.status !== 'active' && contract.status !== 'draft') {
    return { success: false, error: 'Solo se pueden extender contratos activos o en borrador.' }
  }

  // When a current end_date exists, the new one must be strictly later
  const currentEnd = (contract as unknown as { end_date: string | null }).end_date
  if (currentEnd && d.newEndDate <= currentEnd) {
    return {
      success: false,
      error: `La nueva fecha de fin debe ser posterior a la actual (${currentEnd.split('-').reverse().join('/')}).`,
    }
  }

  const patch: { end_date: string; rent_amount?: number; internal_notes?: string } = {
    end_date: d.newEndDate,
  }
  if (d.newRentAmount !== undefined) patch.rent_amount = d.newRentAmount
  if (d.notes) {
    const prev = (contract as unknown as { internal_notes: string | null }).internal_notes ?? ''
    const timestamp = new Date().toLocaleDateString('es-AR')
    patch.internal_notes = prev
      ? `${prev}\n[${timestamp}] Extensión: ${d.notes}`
      : `[${timestamp}] Extensión: ${d.notes}`
  }

  const { error } = await supabase
    .from('monthly_rental_contracts')
    .update(patch)
    .eq('id', contractId)
    .eq('tenant_id', ctx.tenantId)

  if (error) return { success: false, error: 'Error al extender el contrato.' }

  revalidatePath(LIST_PATH)
  revalidatePath(DETAIL_PATH(contractId))
  return { success: true }
}

// ════════════════════════════════════════════════════════════════════════════════
// CHARGE ACTIONS
// ════════════════════════════════════════════════════════════════════════════════

// ─── Schemas ───────────────────────────────────────────────────────────────────

const chargeInputSchema = z.object({
  periodYear:        z.coerce.number().int().min(2000).max(2100),
  periodMonth:       z.coerce.number().int().min(1).max(12),
  dueDate:           z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha de vencimiento inválida'),
  rentAmount:        z.coerce.number().min(0, 'Alquiler debe ser 0 o mayor'),
  expensesAmount:    z.coerce.number().min(0).default(0),
  servicesAmount:    z.coerce.number().min(0).default(0),
  adjustmentsAmount: z.coerce.number().min(0).default(0),
  lateFeeAmount:     z.coerce.number().min(0).default(0),
  notes:             z.string().max(2000).nullable().optional(),
})

const generateChargesSchema = z.object({
  fromYear:    z.coerce.number().int().min(2000).max(2100),
  fromMonth:   z.coerce.number().int().min(1).max(12),
  monthsCount: z.coerce.number().int().min(1).max(24),
})

// ─── Helper: compute status from due_date ─────────────────────────────────────

function chargeStatusFromDate(dueDate: string): 'pending' | 'overdue' {
  const today = new Date().toISOString().split('T')[0]!
  return dueDate < today ? 'overdue' : 'pending'
}

// ─── Helper: load contract for charge operations ──────────────────────────────

async function loadContractForCharge(
  supabase:   Awaited<ReturnType<typeof createClient>>,
  tenantId:   string,
  contractId: string,
) {
  const { data } = await supabase
    .from('monthly_rental_contracts')
    .select('id, tenant_id, status, rent_amount, expenses_amount, due_day')
    .eq('id', contractId)
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .maybeSingle()
  return data as {
    id: string; tenant_id: string; status: string
    rent_amount: number; expenses_amount: number | null; due_day: number
  } | null
}

// ─── CREATE CHARGE ─────────────────────────────────────────────────────────────

export async function createMonthlyRentalChargeAction(
  contractId: string,
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }
  if (ctx.role !== 'owner') return { success: false, error: 'Solo los owners pueden crear cuotas.' }

  const parsed = chargeInputSchema.safeParse(input)
  if (!parsed.success) return { success: false, error: parsed.error.errors[0]?.message ?? 'Datos inválidos.' }

  const d        = parsed.data
  const supabase = await createClient()

  const contract = await loadContractForCharge(supabase, ctx.tenantId, contractId)
  if (!contract) return { success: false, error: 'Contrato no encontrado.' }
  if (contract.status !== 'draft' && contract.status !== 'active') {
    return { success: false, error: 'Solo se pueden agregar cuotas a contratos en borrador o activos.' }
  }

  const { data: existing } = await supabase
    .from('monthly_rental_charges')
    .select('id')
    .eq('contract_id', contractId)
    .eq('period_year', d.periodYear)
    .eq('period_month', d.periodMonth)
    .neq('status', 'cancelled')
    .maybeSingle()
  if (existing) {
    return { success: false, error: `Ya existe una cuota para ${String(d.periodMonth).padStart(2, '0')}/${d.periodYear}.` }
  }

  const total  = d.rentAmount + d.expensesAmount + d.servicesAmount + d.adjustmentsAmount + d.lateFeeAmount
  const status = chargeStatusFromDate(d.dueDate)

  const { data: charge, error } = await supabase
    .from('monthly_rental_charges')
    .insert({
      tenant_id: ctx.tenantId, contract_id: contractId,
      period_year: d.periodYear, period_month: d.periodMonth,
      due_date: d.dueDate, rent_amount: d.rentAmount,
      expenses_amount: d.expensesAmount, services_amount: d.servicesAmount,
      adjustments_amount: d.adjustmentsAmount, late_fee_amount: d.lateFeeAmount,
      total_amount: total, amount_paid: 0, status,
      notes: d.notes ?? null,
    })
    .select('id')
    .single()

  if (error) return { success: false, error: 'Error al crear la cuota.' }

  revalidatePath(LIST_PATH)
  revalidatePath(DETAIL_PATH(contractId))
  return { success: true, data: { id: charge.id } }
}

// ─── UPDATE CHARGE ─────────────────────────────────────────────────────────────

export async function updateMonthlyRentalChargeAction(
  chargeId: string,
  input: unknown,
): Promise<ActionResult> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }
  if (ctx.role !== 'owner') return { success: false, error: 'Solo los owners pueden editar cuotas.' }

  const parsed = chargeInputSchema.safeParse(input)
  if (!parsed.success) return { success: false, error: parsed.error.errors[0]?.message ?? 'Datos inválidos.' }

  const d        = parsed.data
  const supabase = await createClient()

  const { data: charge } = await supabase
    .from('monthly_rental_charges')
    .select('id, tenant_id, contract_id, status, period_year, period_month, amount_paid')
    .eq('id', chargeId)
    .eq('tenant_id', ctx.tenantId)
    .maybeSingle()

  if (!charge) return { success: false, error: 'Cuota no encontrada.' }
  if (charge.status === 'cancelled') return { success: false, error: 'No se puede editar una cuota cancelada.' }

  const contract = await loadContractForCharge(supabase, ctx.tenantId, charge.contract_id)
  if (!contract) return { success: false, error: 'Contrato asociado no encontrado.' }

  const periodChanged = d.periodYear !== charge.period_year || d.periodMonth !== charge.period_month
  if (periodChanged) {
    const { data: dup } = await supabase
      .from('monthly_rental_charges')
      .select('id')
      .eq('contract_id', charge.contract_id)
      .eq('period_year', d.periodYear)
      .eq('period_month', d.periodMonth)
      .neq('id', chargeId)
      .neq('status', 'cancelled')
      .maybeSingle()
    if (dup) return { success: false, error: `Ya existe una cuota para ${String(d.periodMonth).padStart(2, '0')}/${d.periodYear}.` }
  }

  const total             = d.rentAmount + d.expensesAmount + d.servicesAmount + d.adjustmentsAmount + d.lateFeeAmount
  const currentAmountPaid = (charge.amount_paid as number) ?? 0

  if (total < currentAmountPaid) {
    return { success: false, error: 'No podés dejar el total de la cuota por debajo de lo ya pagado.' }
  }

  const status            = currentAmountPaid >= total
    ? 'paid'
    : currentAmountPaid > 0
      ? 'partially_paid'
      : chargeStatusFromDate(d.dueDate)

  const { error } = await supabase
    .from('monthly_rental_charges')
    .update({
      period_year: d.periodYear, period_month: d.periodMonth,
      due_date: d.dueDate, rent_amount: d.rentAmount,
      expenses_amount: d.expensesAmount, services_amount: d.servicesAmount,
      adjustments_amount: d.adjustmentsAmount, late_fee_amount: d.lateFeeAmount,
      total_amount: total, status, notes: d.notes ?? null,
    })
    .eq('id', chargeId)
    .eq('tenant_id', ctx.tenantId)

  if (error) return { success: false, error: 'Error al actualizar la cuota.' }

  revalidatePath(LIST_PATH)
  revalidatePath(DETAIL_PATH(charge.contract_id))
  return { success: true }
}

// ─── CANCEL CHARGE ─────────────────────────────────────────────────────────────

export async function cancelMonthlyRentalChargeAction(
  chargeId: string,
): Promise<ActionResult> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }
  if (ctx.role !== 'owner') return { success: false, error: 'Solo los owners pueden cancelar cuotas.' }

  const supabase = await createClient()

  const { data: charge } = await supabase
    .from('monthly_rental_charges')
    .select('id, tenant_id, contract_id, status')
    .eq('id', chargeId)
    .eq('tenant_id', ctx.tenantId)
    .maybeSingle()

  if (!charge) return { success: false, error: 'Cuota no encontrada.' }
  if (charge.status === 'cancelled') return { success: false, error: 'La cuota ya está cancelada.' }
  if (charge.status === 'paid')      return { success: false, error: 'No se puede cancelar una cuota pagada.' }

  const { count: activePayments } = await supabase
    .from('monthly_rental_payments')
    .select('id', { count: 'exact', head: true })
    .eq('charge_id', chargeId)
    .eq('tenant_id', ctx.tenantId)
    .eq('status', 'active')

  if (activePayments && activePayments > 0) {
    return { success: false, error: 'No podés cancelar una cuota con pagos registrados. Anulá los pagos primero.' }
  }

  const { error } = await supabase
    .from('monthly_rental_charges')
    .update({ status: 'cancelled' })
    .eq('id', chargeId)
    .eq('tenant_id', ctx.tenantId)

  if (error) return { success: false, error: 'Error al cancelar la cuota.' }

  revalidatePath(LIST_PATH)
  revalidatePath(DETAIL_PATH(charge.contract_id))
  return { success: true }
}

// ─── GENERATE CHARGES ──────────────────────────────────────────────────────────

export async function generateMonthlyRentalChargesAction(
  contractId: string,
  input: unknown,
): Promise<ActionResult<{
  createdCount:   number
  skippedCount:   number
  createdPeriods: string[]
  skippedPeriods: string[]
}>> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }
  if (ctx.role !== 'owner') return { success: false, error: 'Solo los owners pueden generar cuotas.' }

  const parsed = generateChargesSchema.safeParse(input)
  if (!parsed.success) return { success: false, error: parsed.error.errors[0]?.message ?? 'Datos inválidos.' }

  const d        = parsed.data
  const supabase = await createClient()

  const contract = await loadContractForCharge(supabase, ctx.tenantId, contractId)
  if (!contract) return { success: false, error: 'Contrato no encontrado.' }
  if (contract.status !== 'draft' && contract.status !== 'active') {
    return { success: false, error: 'Solo se pueden generar cuotas para contratos en borrador o activos.' }
  }

  // Fetch existing non-cancelled periods to detect duplicates in bulk
  const { data: existingCharges } = await supabase
    .from('monthly_rental_charges')
    .select('period_year, period_month')
    .eq('tenant_id', ctx.tenantId)
    .eq('contract_id', contractId)
    .neq('status', 'cancelled')

  const existingPeriods = new Set(
    (existingCharges ?? []).map((c) => `${c.period_year}-${c.period_month}`),
  )

  const today    = new Date().toISOString().split('T')[0]!
  const baseDate = new Date(d.fromYear, d.fromMonth - 1, 1)
  const rentAmt  = contract.rent_amount
  const expAmt   = contract.expenses_amount ?? 0

  const createdPeriods: string[] = []
  const skippedPeriods: string[] = []
  const toInsert: {
    tenant_id: string; contract_id: string; period_year: number; period_month: number
    due_date: string; rent_amount: number; expenses_amount: number
    services_amount: number; adjustments_amount: number; late_fee_amount: number
    total_amount: number; amount_paid: number; status: string
  }[] = []

  for (let i = 0; i < d.monthsCount; i++) {
    const periodDate = addMonths(baseDate, i)
    const year       = periodDate.getFullYear()
    const month      = periodDate.getMonth() + 1
    const key        = `${year}-${month}`
    const label      = `${year}-${String(month).padStart(2, '0')}`

    if (existingPeriods.has(key)) {
      skippedPeriods.push(label)
      continue
    }

    const daysInThisMonth = getDaysInMonth(periodDate)
    const day             = Math.min(contract.due_day, daysInThisMonth)
    const dueDate         = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    const status          = dueDate < today ? 'overdue' : 'pending'
    const total           = rentAmt + expAmt

    toInsert.push({
      tenant_id: ctx.tenantId, contract_id: contractId,
      period_year: year, period_month: month, due_date: dueDate,
      rent_amount: rentAmt, expenses_amount: expAmt,
      services_amount: 0, adjustments_amount: 0, late_fee_amount: 0,
      total_amount: total, amount_paid: 0, status,
    })
    createdPeriods.push(label)
    existingPeriods.add(key)
  }

  if (toInsert.length > 0) {
    const { error } = await supabase.from('monthly_rental_charges').insert(toInsert)
    if (error) return { success: false, error: 'Error al generar las cuotas.' }
  }

  revalidatePath(LIST_PATH)
  revalidatePath(DETAIL_PATH(contractId))

  return {
    success: true,
    data: {
      createdCount:  createdPeriods.length,
      skippedCount:  skippedPeriods.length,
      createdPeriods,
      skippedPeriods,
    },
  }
}

// ─── RECORD PAYMENT ────────────────────────────────────────────────────────────

const paymentInputSchema = z.object({
  amount:        z.coerce.number().positive('El monto debe ser mayor a 0'),
  paidAt:        z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida'),
  paymentMethod: z.enum(['transfer', 'cash', 'check', 'card', 'other']),
  notes:         z.string().max(2000).nullable().optional(),
})

export async function recordMonthlyRentalPaymentAction(
  chargeId: string,
  input:    unknown,
): Promise<ActionResult<{ paymentId: string; amountPaid: number; newStatus: string }>> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }
  if (ctx.role !== 'owner') return { success: false, error: 'Solo los owners pueden registrar pagos.' }

  const parsed = paymentInputSchema.safeParse(input)
  if (!parsed.success) return { success: false, error: parsed.error.errors[0]?.message ?? 'Datos inválidos.' }

  const d        = parsed.data
  const supabase = await createClient()

  // Validate charge belongs to this tenant (extra guard before calling RPC)
  const { data: chargeCheck } = await supabase
    .from('monthly_rental_charges')
    .select('id, tenant_id, contract_id, status, total_amount, amount_paid')
    .eq('id', chargeId)
    .eq('tenant_id', ctx.tenantId)
    .maybeSingle()

  if (!chargeCheck)                   return { success: false, error: 'Cuota no encontrada.' }
  if (chargeCheck.status === 'cancelled') return { success: false, error: 'No se puede registrar un pago en una cuota cancelada.' }
  if (chargeCheck.status === 'paid')      return { success: false, error: 'La cuota ya está completamente pagada.' }

  const saldo = chargeCheck.total_amount - chargeCheck.amount_paid
  if (d.amount > saldo) {
    return { success: false, error: `El monto (${d.amount}) supera el saldo pendiente (${saldo}).` }
  }

  const { data: result, error } = await supabase.rpc('record_monthly_rental_payment', {
    p_charge_id:      chargeId,
    p_amount:         d.amount,
    p_paid_at:        d.paidAt,
    p_payment_method: d.paymentMethod,
    p_notes:          d.notes ?? undefined,
  })

  if (error) {
    console.error('[recordMonthlyRentalPaymentAction] RPC error:', error.message)
    return { success: false, error: error.message ?? 'Error al registrar el pago.' }
  }

  const rpcResult = result as { payment_id: string; amount_paid: number; new_status: string } | null
  if (!rpcResult) return { success: false, error: 'Error al registrar el pago.' }

  revalidatePath(LIST_PATH)
  revalidatePath(DETAIL_PATH(chargeCheck.contract_id))

  return {
    success: true,
    data: {
      paymentId:  rpcResult.payment_id,
      amountPaid: rpcResult.amount_paid,
      newStatus:  rpcResult.new_status,
    },
  }
}

// ─── VOID PAYMENT ──────────────────────────────────────────────────────────────

export async function voidMonthlyRentalPaymentAction(
  paymentId: string,
  reason?:   string,
): Promise<ActionResult<{ chargeId: string; amountPaid: number; newStatus: string }>> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }
  if (ctx.role !== 'owner') return { success: false, error: 'Solo los owners pueden anular pagos.' }

  const supabase = await createClient()

  // Validate payment belongs to this tenant
  const { data: paymentCheck } = await supabase
    .from('monthly_rental_payments')
    .select('id, tenant_id, contract_id, charge_id, status')
    .eq('id', paymentId)
    .eq('tenant_id', ctx.tenantId)
    .maybeSingle()

  if (!paymentCheck)                    return { success: false, error: 'Pago no encontrado.' }
  if (paymentCheck.status === 'voided') return { success: false, error: 'El pago ya está anulado.' }

  const { data: result, error } = await supabase.rpc('void_monthly_rental_payment', {
    p_payment_id: paymentId,
    p_reason:     reason ?? 'Anulado desde CRM',
  })

  if (error) {
    console.error('[voidMonthlyRentalPaymentAction] RPC error:', error.message)
    return { success: false, error: error.message ?? 'Error al anular el pago.' }
  }

  const rpcResult = result as { charge_id: string; amount_paid: number; new_status: string } | null
  if (!rpcResult) return { success: false, error: 'Error al anular el pago.' }

  revalidatePath(LIST_PATH)
  revalidatePath(DETAIL_PATH(paymentCheck.contract_id))

  return {
    success: true,
    data: {
      chargeId:   rpcResult.charge_id,
      amountPaid: rpcResult.amount_paid,
      newStatus:  rpcResult.new_status,
    },
  }
}

// ─── GENERATE PAYMENT RECEIPT ──────────────────────────────────────────────────

export type MonthlyRentalReceiptResult = {
  documentId:    string
  receiptNumber: string
  name:          string
  fileUrl:       string
}

export async function generateMonthlyRentalPaymentReceiptAction(
  paymentId: string,
): Promise<ActionResult<MonthlyRentalReceiptResult>> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }
  if (ctx.role !== 'owner') return { success: false, error: 'Solo los owners pueden generar recibos.' }

  const admin = createAdminClient()

  // 1. Load payment
  const { data: payment } = await admin
    .from('monthly_rental_payments')
    .select('id, tenant_id, contract_id, charge_id, amount, paid_at, payment_method, notes, status, receipt_document_id, created_at')
    .eq('id', paymentId)
    .eq('tenant_id', ctx.tenantId)
    .maybeSingle()

  if (!payment)                    return { success: false, error: 'Pago no encontrado.' }
  if (payment.status === 'voided') return { success: false, error: 'No se puede generar un recibo para un pago anulado.' }

  // 2. Deduplication: return existing receipt if storage file still exists;
  //    track it for restoration if the DB row exists but the file is gone.
  let existingDocToRestore: {
    id: string; name: string; file_url: string; receipt_number: string | null; storage_path: string
  } | null = null

  if (payment.receipt_document_id) {
    const { data: existingDoc } = await admin
      .from('documents')
      .select('id, name, file_url, receipt_number, storage_path')
      .eq('id', payment.receipt_document_id)
      .eq('tenant_id', ctx.tenantId)
      .maybeSingle()

    if (existingDoc?.storage_path) {
      const rawPath   = existingDoc.storage_path as string
      const lastSlash = rawPath.lastIndexOf('/')
      const folder    = rawPath.slice(0, lastSlash)
      const filename  = rawPath.slice(lastSlash + 1)
      const { data: listed } = await admin.storage
        .from('reservation-docs')
        .list(folder, { search: filename, limit: 1 })
      const fileExists = listed?.some(f => f.name === filename) ?? false

      if (fileExists) {
        return {
          success: true,
          data: {
            documentId:    existingDoc.id,
            receiptNumber: (existingDoc as { receipt_number?: string | null }).receipt_number ?? '',
            name:          existingDoc.name,
            fileUrl:       existingDoc.file_url,
          },
        }
      }
      // Storage file missing — regenerate and re-upload, reusing the existing document row
      existingDocToRestore = {
        id:             existingDoc.id,
        name:           existingDoc.name,
        file_url:       existingDoc.file_url,
        receipt_number: (existingDoc as { receipt_number?: string | null }).receipt_number ?? null,
        storage_path:   rawPath,
      }
    }
  }

  // 3. Load charge, contract, tenant in parallel
  const [chargeRes, contractRes, tenantRes] = await Promise.all([
    admin.from('monthly_rental_charges')
      .select('period_year, period_month, due_date, rent_amount, expenses_amount, services_amount, adjustments_amount, late_fee_amount, total_amount')
      .eq('id', payment.charge_id)
      .eq('tenant_id', ctx.tenantId)
      .maybeSingle(),
    admin.from('monthly_rental_contracts')
      .select('contact_id, property_id, start_date, end_date, currency')
      .eq('id', payment.contract_id)
      .eq('tenant_id', ctx.tenantId)
      .maybeSingle(),
    admin.from('tenants')
      .select('name, public_name, receipt_footer_text')
      .eq('id', ctx.tenantId)
      .maybeSingle(),
  ])

  const charge   = chargeRes.data
  const contract = contractRes.data
  const tenant   = tenantRes.data

  if (!charge)   return { success: false, error: 'Cuota no encontrada.' }
  if (!contract) return { success: false, error: 'Contrato no encontrado.' }

  // 4. Load contact, property, and other active payments for paidBefore calculation
  const [contactRes, propertyRes, otherPaymentsRes] = await Promise.all([
    admin.from('contacts').select('name, phone, email').eq('id', contract.contact_id).maybeSingle(),
    admin.from('properties').select('title, location_label').eq('id', contract.property_id).maybeSingle(),
    // Fetch all OTHER active payments for this charge to compute what was paid before this one
    admin.from('monthly_rental_payments')
      .select('id, amount, created_at')
      .eq('charge_id', payment.charge_id)
      .eq('status', 'active')
      .neq('id', paymentId),
  ])

  const contact = contactRes.data
  const property = propertyRes.data

  // Payments before this one in stable (created_at, id) order — excludes later payments
  const thisCreatedAt = payment.created_at as string
  const paidBefore    = (otherPaymentsRes.data ?? [])
    .filter(r => {
      const rAt = r.created_at as string
      return rAt < thisCreatedAt || (rAt === thisCreatedAt && (r.id as string) < paymentId)
    })
    .reduce((s, r) => s + (r.amount as number), 0)

  // accumulatedPaid = all paid through this payment (inclusive); used for isPartial + remaining balance
  const accumulatedPaid = paidBefore + (payment.amount as number)

  // 5. Receipt number — reuse existing when restoring storage, else generate new (atomic)
  let receiptNumber: string
  if (existingDocToRestore?.receipt_number) {
    receiptNumber = existingDocToRestore.receipt_number
  } else {
    const { data: rpcNum, error: rpcError } = await admin.rpc('next_receipt_number', {
      p_tenant_id: ctx.tenantId,
    })
    if (rpcError || !rpcNum) {
      console.error('[generateMonthlyRentalPaymentReceiptAction] next_receipt_number failed:', rpcError?.message)
      return { success: false, error: 'Error al generar número de recibo.' }
    }
    receiptNumber = rpcNum
  }

  // 6. Generate PDF buffer
  const now = new Date().toISOString()
  let pdfBuffer: Buffer
  try {
    pdfBuffer = await generateMonthlyRentalReceiptPdf({
      receiptNumber,
      emittedAt:           now,
      tenantName:          tenant?.name ?? 'Inmobiliaria',
      tenantPublicName:    tenant?.public_name,
      receiptFooterText:   (tenant as { receipt_footer_text?: string | null } | null)?.receipt_footer_text,
      contactName:         contact?.name ?? 'Inquilino',
      contactPhone:        contact?.phone,
      contactEmail:        contact?.email,
      propertyTitle:       property?.title ?? null,
      propertyLocation:    (property as { location_label?: string | null } | null)?.location_label ?? null,
      contractStartDate:   contract.start_date,
      contractEndDate:     contract.end_date,
      periodYear:          charge.period_year as number,
      periodMonth:         charge.period_month as number,
      dueDate:             charge.due_date,
      currency:            contract.currency ?? 'ARS',
      rentAmount:          charge.rent_amount as number,
      expensesAmount:      charge.expenses_amount as number | null,
      servicesAmount:      charge.services_amount as number | null,
      adjustmentsAmount:   charge.adjustments_amount as number | null,
      lateFeeAmount:       charge.late_fee_amount as number | null,
      chargeTotalAmount:   charge.total_amount as number,
      amountPaidInPayment: payment.amount as number,
      accumulatedPaid,
      paymentMethod:       payment.payment_method,
      paidAt:              payment.paid_at,
      notes:               payment.notes,
    })
  } catch (err) {
    console.error('[generateMonthlyRentalPaymentReceiptAction] PDF generation failed:', err)
    return { success: false, error: 'Error al generar el PDF.' }
  }

  // 7. Upload to reservation-docs bucket (reuse existing path when restoring)
  const storagePath = existingDocToRestore?.storage_path
    ?? `${ctx.tenantId}/monthly-rentals/${payment.contract_id}/receipts/${paymentId}.pdf`

  const { error: uploadError } = await admin.storage
    .from('reservation-docs')
    .upload(storagePath, pdfBuffer, { contentType: 'application/pdf', upsert: true })

  if (uploadError) {
    console.error('[generateMonthlyRentalPaymentReceiptAction] upload failed:', uploadError.message)
    return { success: false, error: 'Error al subir el recibo al almacenamiento.' }
  }

  // 8a. Storage restore path: update file_size on existing doc and return early
  if (existingDocToRestore) {
    await admin.from('documents')
      .update({ file_size_bytes: pdfBuffer.byteLength })
      .eq('id', existingDocToRestore.id)
      .eq('tenant_id', ctx.tenantId)

    revalidatePath(LIST_PATH)
    revalidatePath(DETAIL_PATH(payment.contract_id))

    return {
      success: true,
      data: {
        documentId:    existingDocToRestore.id,
        receiptNumber,
        name:          existingDocToRestore.name,
        fileUrl:       existingDocToRestore.file_url,
      },
    }
  }

  // 8b. Insert document row
  const docId   = crypto.randomUUID()
  const fileUrl = `/api/documents/${docId}`
  const docName = `Recibo ${receiptNumber} — Alquiler mensual`

  const { error: insertError } = await admin
    .from('documents')
    .insert({
      id:                         docId,
      tenant_id:                  ctx.tenantId,
      contact_id:                 contract.contact_id,
      property_id:                contract.property_id,
      monthly_rental_contract_id: payment.contract_id,
      document_type:              'receipt',
      source:                     'generated',
      storage_bucket:             'reservation-docs',
      storage_path:               storagePath,
      file_url:                   fileUrl,
      mime_type:                  'application/pdf',
      file_size_bytes:            pdfBuffer.byteLength,
      receipt_number:             receiptNumber,
      name:                       docName,
    })

  if (insertError) {
    await admin.storage.from('reservation-docs').remove([storagePath])
    console.error('[generateMonthlyRentalPaymentReceiptAction] document insert failed:', insertError.message)
    return { success: false, error: 'Error al registrar el recibo.' }
  }

  // 9. Link document to payment
  const { error: updateError } = await admin
    .from('monthly_rental_payments')
    .update({ receipt_document_id: docId })
    .eq('id', paymentId)
    .eq('tenant_id', ctx.tenantId)

  if (updateError) {
    // Clean up document and storage so the user can retry cleanly
    await admin.from('documents').delete().eq('id', docId)
    await admin.storage.from('reservation-docs').remove([storagePath])
    console.error('[generateMonthlyRentalPaymentReceiptAction] payment update failed:', updateError.message)
    return { success: false, error: 'Error al vincular el recibo al pago.' }
  }

  revalidatePath(LIST_PATH)
  revalidatePath(DETAIL_PATH(payment.contract_id))

  return {
    success: true,
    data: { documentId: docId, receiptNumber, name: docName, fileUrl },
  }
}

// ─── Document upload / delete ──────────────────────────────────────────────────

const ALLOWED_DOC_MIMES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]
const MAX_DOC_SIZE = 10 * 1024 * 1024 // 10 MB

const uploadDocumentSchema = z.object({
  document_type: z.enum(['contract', 'regulation', 'policy', 'manual', 'identity_document', 'guarantee']),
  notes:         z.string().max(2000).optional(),
})

export async function uploadMonthlyRentalDocumentAction(
  contractId: string,
  formData:   FormData,
): Promise<ActionResult<{ id: string }>> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }
  if (ctx.role !== 'owner') return { success: false, error: 'Solo los owners pueden subir documentos.' }

  const file = formData.get('file')
  if (!(file instanceof File) || file.size === 0) return { success: false, error: 'Archivo requerido.' }
  if (!ALLOWED_DOC_MIMES.includes(file.type)) return { success: false, error: 'Tipo de archivo no permitido. Usá PDF, imagen o Word.' }

  const bytes  = await file.arrayBuffer()
  const buffer = Buffer.from(bytes)
  if (buffer.byteLength > MAX_DOC_SIZE) return { success: false, error: 'El archivo supera el límite de 10 MB.' }

  const parsed = uploadDocumentSchema.safeParse({
    document_type: formData.get('document_type')?.toString(),
    notes:         formData.get('notes')?.toString() || undefined,
  })
  if (!parsed.success) return { success: false, error: parsed.error.errors[0]?.message ?? 'Datos inválidos.' }

  const supabase = await createClient()

  const { data: contract } = await supabase
    .from('monthly_rental_contracts')
    .select('id, property_id, contact_id')
    .eq('id', contractId)
    .eq('tenant_id', ctx.tenantId)
    .is('deleted_at', null)
    .maybeSingle()

  if (!contract) return { success: false, error: 'Contrato no encontrado.' }

  const admin  = createAdminClient()
  const docId  = crypto.randomUUID()
  const ext    = file.name.split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') ?? 'bin'
  const storagePath = `${ctx.tenantId}/monthly-rentals/${contractId}/documents/${docId}.${ext}`

  const { error: uploadError } = await admin.storage
    .from('reservation-docs')
    .upload(storagePath, buffer, { contentType: file.type, upsert: false })

  if (uploadError) {
    console.error('[uploadMonthlyRentalDocumentAction] upload:', uploadError.message)
    return { success: false, error: 'Error al subir el archivo.' }
  }

  const { error: insertError } = await admin.from('documents').insert({
    id:                         docId,
    tenant_id:                  ctx.tenantId,
    contact_id:                 (contract.contact_id as string | null) ?? null,
    property_id:                (contract.property_id as string | null) ?? null,
    monthly_rental_contract_id: contractId,
    document_type:              parsed.data.document_type,
    source:                     'manual',
    storage_bucket:             'reservation-docs',
    storage_path:               storagePath,
    file_url:                   `/api/documents/${docId}`,
    mime_type:                  file.type,
    file_size_bytes:            buffer.byteLength,
    name:                       file.name.slice(0, 255),
    notes:                      parsed.data.notes ?? null,
  })

  if (insertError) {
    await admin.storage.from('reservation-docs').remove([storagePath])
    console.error('[uploadMonthlyRentalDocumentAction] insert:', insertError.message)
    return { success: false, error: 'Error al registrar el documento.' }
  }

  revalidatePath(LIST_PATH)
  revalidatePath(DETAIL_PATH(contractId))
  return { success: true, data: { id: docId } }
}

export async function uploadMonthlyRentalPaymentProofAction(
  paymentId: string,
  formData:  FormData,
): Promise<ActionResult<{ documentId: string }>> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }
  if (ctx.role !== 'owner') return { success: false, error: 'Solo los owners pueden subir comprobantes.' }

  const file = formData.get('file')
  if (!(file instanceof File) || file.size === 0) return { success: false, error: 'Archivo requerido.' }
  if (!ALLOWED_DOC_MIMES.includes(file.type)) return { success: false, error: 'Tipo de archivo no permitido. Usá PDF o imagen.' }

  const bytes  = await file.arrayBuffer()
  const buffer = Buffer.from(bytes)
  if (buffer.byteLength > MAX_DOC_SIZE) return { success: false, error: 'El archivo supera el límite de 10 MB.' }

  const admin = createAdminClient()

  const { data: payment } = await admin
    .from('monthly_rental_payments')
    .select('id, tenant_id, contract_id, status, proof_document_id')
    .eq('id', paymentId)
    .eq('tenant_id', ctx.tenantId)
    .maybeSingle()

  if (!payment) return { success: false, error: 'Pago no encontrado.' }
  if (payment.status === 'voided') return { success: false, error: 'No se puede subir un comprobante para un pago anulado.' }
  if (payment.proof_document_id)  return { success: false, error: 'Este pago ya tiene un comprobante cargado.' }

  const { data: contract } = await admin
    .from('monthly_rental_contracts')
    .select('property_id, contact_id')
    .eq('id', payment.contract_id as string)
    .eq('tenant_id', ctx.tenantId)
    .maybeSingle()

  const docId = crypto.randomUUID()
  const ext   = file.name.split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') ?? 'bin'
  const storagePath = `${ctx.tenantId}/monthly-rentals/${payment.contract_id}/payment-proofs/${paymentId}-${docId}.${ext}`

  const { error: uploadError } = await admin.storage
    .from('reservation-docs')
    .upload(storagePath, buffer, { contentType: file.type, upsert: false })

  if (uploadError) {
    console.error('[uploadMonthlyRentalPaymentProofAction] upload:', uploadError.message)
    return { success: false, error: 'Error al subir el archivo.' }
  }

  const { error: insertError } = await admin.from('documents').insert({
    id:                         docId,
    tenant_id:                  ctx.tenantId,
    contact_id:                 (contract?.contact_id as string | null) ?? null,
    property_id:                (contract?.property_id as string | null) ?? null,
    monthly_rental_contract_id: payment.contract_id as string,
    document_type:              'payment_proof',
    source:                     'manual',
    storage_bucket:             'reservation-docs',
    storage_path:               storagePath,
    file_url:                   `/api/documents/${docId}`,
    mime_type:                  file.type,
    file_size_bytes:            buffer.byteLength,
    name:                       `Comprobante — ${file.name.slice(0, 200)}`,
    notes:                      null,
  })

  if (insertError) {
    await admin.storage.from('reservation-docs').remove([storagePath])
    console.error('[uploadMonthlyRentalPaymentProofAction] insert:', insertError.message)
    return { success: false, error: 'Error al registrar el comprobante.' }
  }

  const { error: updateError } = await admin
    .from('monthly_rental_payments')
    .update({ proof_document_id: docId })
    .eq('id', paymentId)
    .eq('tenant_id', ctx.tenantId)

  if (updateError) {
    await admin.from('documents').delete().eq('id', docId)
    await admin.storage.from('reservation-docs').remove([storagePath])
    console.error('[uploadMonthlyRentalPaymentProofAction] update:', updateError.message)
    return { success: false, error: 'Error al vincular el comprobante al pago.' }
  }

  revalidatePath(LIST_PATH)
  revalidatePath(DETAIL_PATH(payment.contract_id as string))
  return { success: true, data: { documentId: docId } }
}

export async function deleteMonthlyRentalDocumentAction(
  documentId: string,
): Promise<ActionResult> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }
  if (ctx.role !== 'owner') return { success: false, error: 'Solo los owners pueden eliminar documentos.' }

  const admin = createAdminClient()

  const { data: doc } = await admin
    .from('documents')
    .select('id, source, document_type, storage_bucket, storage_path, monthly_rental_contract_id')
    .eq('id', documentId)
    .eq('tenant_id', ctx.tenantId)
    .not('monthly_rental_contract_id', 'is', null)
    .maybeSingle()

  if (!doc) return { success: false, error: 'Documento no encontrado.' }

  // 1. Block if linked as receipt_document_id in any payment (regardless of source)
  const { data: linkedReceipt } = await admin
    .from('monthly_rental_payments')
    .select('id')
    .eq('receipt_document_id', documentId)
    .eq('tenant_id', ctx.tenantId)
    .limit(1)
    .maybeSingle()

  if (linkedReceipt) {
    return { success: false, error: 'No podés eliminar un recibo generado. Queda guardado como comprobante histórico del pago.' }
  }

  // 2. Belt-and-suspenders: block any generated document
  if (doc.source === 'generated') {
    return { success: false, error: 'No se pueden eliminar documentos generados automáticamente.' }
  }

  // 3. MVP: block payment_proof deletion if currently linked to a payment
  if (doc.document_type === 'payment_proof') {
    const { data: linkedProof } = await admin
      .from('monthly_rental_payments')
      .select('id')
      .eq('proof_document_id', documentId)
      .eq('tenant_id', ctx.tenantId)
      .limit(1)
      .maybeSingle()

    if (linkedProof) {
      return { success: false, error: 'Este comprobante está asociado a un pago activo. No se puede eliminar mientras esté vinculado.' }
    }
  }

  // 4. Delete DB row first — if it fails, storage and state are untouched
  const { error: deleteError } = await admin
    .from('documents')
    .delete()
    .eq('id', documentId)
    .eq('tenant_id', ctx.tenantId)

  if (deleteError) {
    console.error('[deleteMonthlyRentalDocumentAction] delete:', deleteError.message)
    return { success: false, error: 'Error al eliminar el documento.' }
  }

  // 5. Storage cleanup — best-effort after DB row is gone (orphan file acceptable)
  await admin.storage
    .from((doc.storage_bucket as string) ?? 'reservation-docs')
    .remove([doc.storage_path as string])

  const contractId = doc.monthly_rental_contract_id as string
  revalidatePath(LIST_PATH)
  revalidatePath(DETAIL_PATH(contractId))
  return { success: true }
}

// ─── Follow-up task ────────────────────────────────────────────────────────────

const followUpTaskSchema = z.object({
  title:        z.string().min(1, 'El título es requerido').max(300, 'Máximo 300 caracteres'),
  description:  z.string().max(2000).optional(),
  due_date:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  priority:     z.enum(['low', 'medium', 'high']).default('medium'),
})

export async function createMonthlyRentalFollowUpTaskAction(
  contractId: string,
  input: unknown,
): Promise<ActionResult<{ id: string; reused?: boolean }>> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }

  if (ctx.role !== 'owner') {
    return { success: false, error: 'Solo el propietario puede crear tareas de seguimiento.' }
  }

  if (!contractId) return { success: false, error: 'Contrato no especificado.' }

  const parsed = followUpTaskSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.errors[0]?.message ?? 'Datos inválidos.' }
  }

  const supabase = await createClient()

  // Verify contract belongs to this tenant
  const { data: contract } = await supabase
    .from('monthly_rental_contracts')
    .select('id')
    .eq('id', contractId)
    .eq('tenant_id', ctx.tenantId)
    .is('deleted_at', null)
    .maybeSingle()

  if (!contract) return { success: false, error: 'Contrato no encontrado.' }

  // Anti-duplicate: check for open task with same contract + title
  // "Open" = status NOT IN ('completed', 'cancelled')
  // Two tasks for different periods (different titles) are allowed.
  const { data: existing } = await supabase
    .from('tasks')
    .select('id')
    .eq('tenant_id', ctx.tenantId)
    .eq('monthly_rental_contract_id', contractId)
    .eq('title', parsed.data.title)
    .not('status', 'in', '("completed","cancelled")')
    .maybeSingle()

  if (existing) {
    revalidatePath(DETAIL_PATH(contractId))
    return { success: true, data: { id: existing.id, reused: true } }
  }

  const { data: task, error } = await supabase
    .from('tasks')
    .insert({
      tenant_id:                  ctx.tenantId,
      created_by:                 ctx.userId,
      title:                      parsed.data.title,
      description:                parsed.data.description ?? null,
      due_date:                   parsed.data.due_date    ?? null,
      priority:                   parsed.data.priority,
      status:                     'pending',
      monthly_rental_contract_id: contractId,
    })
    .select('id')
    .single()

  if (error) {
    console.error('[createMonthlyRentalFollowUpTaskAction]', error.message)
    return { success: false, error: 'Error al crear la tarea.' }
  }

  revalidatePath(LIST_PATH)
  revalidatePath(DETAIL_PATH(contractId))

  return { success: true, data: { id: task.id, reused: false } }
}
