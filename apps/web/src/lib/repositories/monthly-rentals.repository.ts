import type { MonthlyRentalContractRow, MonthlyRentalChargeRow, MonthlyRentalPaymentRow } from '@orderflow/types'
import { createClient } from '@orderflow/supabase/server'

// ─── Charge types ─────────────────────────────────────────────────────────────

export type MonthlyRentalDebtSummary = {
  totalDebt:      number
  overdueDebt:    number
  pendingDebt:    number
  paidAmount:     number
  overdueCount:   number
  pendingCount:   number
  cancelledCount: number
  nextDueDate:    string | null
  nextDueAmount:  number | null
}

// ─── Public types ──────────────────────────────────────────────────────────────

export type { MonthlyRentalContractRow, MonthlyRentalChargeRow, MonthlyRentalPaymentRow }

export type ContractProperty = {
  id:                 string
  title:              string
  public_code:        string | null
  location_label:     string | null
  commercial_status:  string
}

export type ContractContact = {
  id:    string
  name:  string | null
  phone: string | null
  email: string | null
}

export type MonthlyRentalContractWithDetails = MonthlyRentalContractRow & {
  property: ContractProperty | null
  contact:  ContractContact  | null
}

export type MonthlyRentalContractDetail = MonthlyRentalContractWithDetails & {
  charges: MonthlyRentalChargeRow[]
}

export type MonthlyRentalStats = {
  activeContracts:       number
  draftContracts:        number
  endingSoonContracts:   number
  overdueCharges:        number
  upcomingCharges:       number
  expiredActiveContracts: number
}

export type MonthlyRentalAlertCharge = {
  id:            string
  contract_id:   string
  due_date:      string
  period_month:  number
  period_year:   number
  total_amount:  number
  amount_paid:   number
  status:        string
  property_title: string | null
  contact_name:   string | null
}

export type MonthlyRentalAlertContract = {
  id:             string
  end_date:       string | null
  status:         string
  property_title: string | null
  contact_name:   string | null
}

export type MonthlyRentalFollowUpTask = {
  id:                          string
  title:                       string
  description:                 string | null
  due_date:                    string | null
  status:                      string
  priority:                    string
  created_at:                  string
  monthly_rental_contract_id:  string | null
}

export type RentalPropertyOption = {
  id:                 string
  title:              string
  public_code:        string | null
  location_label:     string | null
  monthly_rent_price: number | null
  expenses_amount:    number | null
  commercial_status:  string
}

export type RentalContactOption = {
  id:    string
  name:  string | null
  phone: string | null
  email: string | null
}

// ─── Dashboard stats ───────────────────────────────────────────────────────────

export async function getMonthlyRentalDashboardStats(
  tenantId: string,
): Promise<MonthlyRentalStats> {
  const supabase = await createClient()

  const today    = new Date().toISOString().split('T')[0]!
  const in60Days = new Date(Date.now() + 60 * 86_400_000).toISOString().split('T')[0]!
  const in5Days  = new Date(Date.now() + 5  * 86_400_000).toISOString().split('T')[0]!

  const [active, draft, endingSoon, overdue, upcoming, expired] = await Promise.all([
    supabase
      .from('monthly_rental_contracts')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .eq('status', 'active')
      .is('deleted_at', null),

    supabase
      .from('monthly_rental_contracts')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .eq('status', 'draft')
      .is('deleted_at', null),

    supabase
      .from('monthly_rental_contracts')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .eq('status', 'active')
      .not('end_date', 'is', null)
      .lte('end_date', in60Days)
      .is('deleted_at', null),

    // Overdue: due_date < today AND status not paid/cancelled
    supabase
      .from('monthly_rental_charges')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .lt('due_date', today)
      .not('status', 'in', '("paid","cancelled")'),

    // Upcoming: due_date between today and today+5 AND status not paid/cancelled
    supabase
      .from('monthly_rental_charges')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .gte('due_date', today)
      .lte('due_date', in5Days)
      .not('status', 'in', '("paid","cancelled")'),

    // Expired-active: end_date < today AND still status=active
    supabase
      .from('monthly_rental_contracts')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .eq('status', 'active')
      .not('end_date', 'is', null)
      .lt('end_date', today)
      .is('deleted_at', null),
  ])

  return {
    activeContracts:        active.count    ?? 0,
    draftContracts:         draft.count     ?? 0,
    endingSoonContracts:    endingSoon.count ?? 0,
    overdueCharges:         overdue.count   ?? 0,
    upcomingCharges:        upcoming.count  ?? 0,
    expiredActiveContracts: expired.count   ?? 0,
  }
}

// ─── List contracts ────────────────────────────────────────────────────────────

export async function listMonthlyRentalContracts(
  tenantId: string,
  opts?: {
    status?: string
    search?: string
    limit?: number
  },
): Promise<MonthlyRentalContractWithDetails[]> {
  const supabase = await createClient()

  let query = supabase
    .from('monthly_rental_contracts')
    .select(`
      *,
      property:properties(id, title, public_code, location_label, commercial_status),
      contact:contacts(id, name, phone, email)
    `)
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .order('status', { ascending: true })
    .order('start_date', { ascending: false })
    .limit(opts?.limit ?? 200)

  if (opts?.status) {
    query = query.eq('status', opts.status)
  }

  const { data, error } = await query
  if (error) throw new Error(error.message)

  let rows = (data ?? []) as unknown as MonthlyRentalContractWithDetails[]

  if (opts?.search) {
    const q = opts.search.toLowerCase()
    rows = rows.filter(
      (r) =>
        r.property?.title?.toLowerCase().includes(q) ||
        r.contact?.name?.toLowerCase().includes(q)  ||
        r.contact?.phone?.includes(q),
    )
  }

  // Sort: active first, draft second, then others
  const ORDER: Record<string, number> = { active: 0, draft: 1, ended: 2, cancelled: 3 }
  rows.sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9))

  return rows
}

// ─── Get single contract ───────────────────────────────────────────────────────

export async function getMonthlyRentalContractById(
  tenantId:   string,
  contractId: string,
): Promise<MonthlyRentalContractDetail | null> {
  const supabase = await createClient()

  const { data: contract, error } = await supabase
    .from('monthly_rental_contracts')
    .select(`
      *,
      property:properties(id, title, public_code, location_label, commercial_status),
      contact:contacts(id, name, phone, email)
    `)
    .eq('tenant_id', tenantId)
    .eq('id', contractId)
    .is('deleted_at', null)
    .maybeSingle()

  if (error) throw new Error(error.message)
  if (!contract) return null

  const { data: charges } = await supabase
    .from('monthly_rental_charges')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('contract_id', contractId)
    .order('period_year',  { ascending: true })
    .order('period_month', { ascending: true })

  return {
    ...(contract as unknown as MonthlyRentalContractWithDetails),
    charges: charges ?? [],
  }
}

// ─── List charges for a contract ──────────────────────────────────────────────

export async function listMonthlyRentalCharges(
  tenantId:   string,
  contractId: string,
): Promise<MonthlyRentalChargeRow[]> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('monthly_rental_charges')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('contract_id', contractId)
    .order('period_year',  { ascending: true })
    .order('period_month', { ascending: true })

  if (error) throw new Error(error.message)
  return (data ?? []) as MonthlyRentalChargeRow[]
}

// ─── Get single charge ────────────────────────────────────────────────────────

export async function getMonthlyRentalChargeById(
  tenantId: string,
  chargeId: string,
): Promise<MonthlyRentalChargeRow | null> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('monthly_rental_charges')
    .select('*')
    .eq('id', chargeId)
    .eq('tenant_id', tenantId)
    .maybeSingle()

  if (error) throw new Error(error.message)
  return data as MonthlyRentalChargeRow | null
}

// ─── Debt summary ─────────────────────────────────────────────────────────────

export async function getMonthlyRentalDebtSummary(
  tenantId:   string,
  contractId: string,
): Promise<MonthlyRentalDebtSummary> {
  const supabase = await createClient()
  const today = new Date().toISOString().split('T')[0]!

  const { data: charges } = await supabase
    .from('monthly_rental_charges')
    .select('id, status, due_date, total_amount, amount_paid')
    .eq('tenant_id', tenantId)
    .eq('contract_id', contractId)
    .order('due_date', { ascending: true })

  const rows = (charges ?? []) as {
    id: string; status: string; due_date: string
    total_amount: number; amount_paid: number
  }[]

  let totalDebt    = 0
  let overdueDebt  = 0
  let pendingDebt  = 0
  let paidAmount   = 0
  let overdueCount = 0
  let pendingCount = 0
  let cancelledCount = 0
  let nextDueDate:   string | null = null
  let nextDueAmount: number | null = null

  for (const r of rows) {
    const saldo = r.total_amount - r.amount_paid
    const isVisuallyOverdue = r.due_date < today && r.status !== 'paid' && r.status !== 'cancelled'

    if (r.status === 'cancelled') {
      cancelledCount++
    } else if (r.status === 'paid') {
      paidAmount += r.amount_paid
    } else {
      // pending, overdue, partially_paid — all count as debt
      totalDebt += saldo
      if (isVisuallyOverdue) {
        overdueDebt  += saldo
        overdueCount++
      } else {
        pendingDebt  += saldo
        pendingCount++
        // Track next upcoming due date
        if (nextDueDate === null) {
          nextDueDate   = r.due_date
          nextDueAmount = saldo
        }
      }
    }
  }

  return {
    totalDebt, overdueDebt, pendingDebt, paidAmount,
    overdueCount, pendingCount, cancelledCount,
    nextDueDate, nextDueAmount,
  }
}

// ─── Property selector ────────────────────────────────────────────────────────

export async function listAvailableLongTermRentalProperties(
  tenantId:          string,
  includePropertyId?: string,
): Promise<RentalPropertyOption[]> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('properties')
    .select('id, title, public_code, location_label, monthly_rent_price, expenses_amount, commercial_status')
    .eq('tenant_id', tenantId)
    .eq('operation_type', 'long_term_rental')
    .is('deleted_at', null)
    .order('title', { ascending: true })

  if (error) throw new Error(error.message)

  const rows = (data ?? []) as RentalPropertyOption[]

  return rows.filter((p) => {
    // Always include the current property (edit scenarios where it's already rented)
    if (includePropertyId && p.id === includePropertyId) return true
    // For new contracts: only available properties
    return p.commercial_status === 'available'
  })
}

// ─── Contact selector ─────────────────────────────────────────────────────────

export async function listTenantContactsForRental(
  tenantId: string,
  search?:  string,
): Promise<RentalContactOption[]> {
  const supabase = await createClient()

  let query = supabase
    .from('contacts')
    .select('id, name, phone, email')
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .order('name', { ascending: true })
    .limit(300)

  if (search) {
    const q = `%${search}%`
    query = query.or(`name.ilike.${q},phone.ilike.${q},email.ilike.${q}`)
  }

  const { data, error } = await query
  if (error) throw new Error(error.message)
  return (data ?? []) as RentalContactOption[]
}

// ─── Count other active contracts for a property ───────────────────────────────

export async function countOtherActiveContracts(
  tenantId:          string,
  propertyId:        string,
  excludeContractId?: string,
): Promise<number> {
  const supabase = await createClient()

  let query = supabase
    .from('monthly_rental_contracts')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('property_id', propertyId)
    .eq('status', 'active')
    .is('deleted_at', null)

  if (excludeContractId) {
    query = query.neq('id', excludeContractId)
  }

  const { count } = await query
  return count ?? 0
}

// ─── List payments for a contract ─────────────────────────────────────────────

export async function listMonthlyRentalPayments(
  tenantId:   string,
  contractId: string,
): Promise<MonthlyRentalPaymentRow[]> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('monthly_rental_payments')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('contract_id', contractId)
    .order('paid_at',    { ascending: false })
    .order('created_at', { ascending: false })

  if (error) throw new Error(error.message)
  return (data ?? []) as MonthlyRentalPaymentRow[]
}

// ─── Alert lists ───────────────────────────────────────────────────────────────

type RawAlertCharge = {
  id: string; contract_id: string; due_date: string
  period_month: number; period_year: number
  total_amount: number; amount_paid: number; status: string
  contract: { property: { title: string } | null; contact: { name: string } | null } | null
}

type RawAlertContract = {
  id: string; end_date: string | null; status: string
  property: { title: string } | null
  contact:  { name: string }  | null
}

function mapAlertCharge(r: RawAlertCharge): MonthlyRentalAlertCharge {
  return {
    id:             r.id,
    contract_id:    r.contract_id,
    due_date:       r.due_date,
    period_month:   r.period_month,
    period_year:    r.period_year,
    total_amount:   r.total_amount,
    amount_paid:    r.amount_paid,
    status:         r.status,
    property_title: r.contract?.property?.title ?? null,
    contact_name:   r.contract?.contact?.name  ?? null,
  }
}

function mapAlertContract(r: RawAlertContract): MonthlyRentalAlertContract {
  return {
    id:             r.id,
    end_date:       r.end_date,
    status:         r.status,
    property_title: r.property?.title ?? null,
    contact_name:   r.contact?.name   ?? null,
  }
}

const CHARGE_ALERT_SELECT = `
  id, contract_id, due_date, period_month, period_year, total_amount, amount_paid, status,
  contract:monthly_rental_contracts!monthly_rental_charges_contract_id_fkey(
    property:properties(title),
    contact:contacts(name)
  )
`

const CONTRACT_ALERT_SELECT = `
  id, end_date, status,
  property:properties(title),
  contact:contacts(name)
`

export async function listMonthlyRentalOverdueCharges(
  tenantId: string,
  limit = 30,
): Promise<MonthlyRentalAlertCharge[]> {
  const supabase = await createClient()
  const today = new Date().toISOString().split('T')[0]!

  const { data, error } = await supabase
    .from('monthly_rental_charges')
    .select(CHARGE_ALERT_SELECT)
    .eq('tenant_id', tenantId)
    .lt('due_date', today)
    .not('status', 'in', '("paid","cancelled")')
    .order('due_date', { ascending: true })
    .limit(limit)

  if (error) throw new Error(error.message)
  return (data ?? []).map((r) => mapAlertCharge(r as unknown as RawAlertCharge))
}

export async function listMonthlyRentalUpcomingCharges(
  tenantId: string,
  limit = 30,
): Promise<MonthlyRentalAlertCharge[]> {
  const supabase = await createClient()
  const today   = new Date().toISOString().split('T')[0]!
  const in5Days = new Date(Date.now() + 5 * 86_400_000).toISOString().split('T')[0]!

  const { data, error } = await supabase
    .from('monthly_rental_charges')
    .select(CHARGE_ALERT_SELECT)
    .eq('tenant_id', tenantId)
    .gte('due_date', today)
    .lte('due_date', in5Days)
    .not('status', 'in', '("paid","cancelled")')
    .order('due_date', { ascending: true })
    .limit(limit)

  if (error) throw new Error(error.message)
  return (data ?? []).map((r) => mapAlertCharge(r as unknown as RawAlertCharge))
}

export async function listMonthlyRentalEndingContracts(
  tenantId: string,
  limit = 30,
): Promise<MonthlyRentalAlertContract[]> {
  const supabase = await createClient()
  const today    = new Date().toISOString().split('T')[0]!
  const in30Days = new Date(Date.now() + 30 * 86_400_000).toISOString().split('T')[0]!

  const { data, error } = await supabase
    .from('monthly_rental_contracts')
    .select(CONTRACT_ALERT_SELECT)
    .eq('tenant_id', tenantId)
    .eq('status', 'active')
    .not('end_date', 'is', null)
    .gte('end_date', today)
    .lte('end_date', in30Days)
    .is('deleted_at', null)
    .order('end_date', { ascending: true })
    .limit(limit)

  if (error) throw new Error(error.message)
  return (data ?? []).map((r) => mapAlertContract(r as unknown as RawAlertContract))
}

export async function listMonthlyRentalExpiredActiveContracts(
  tenantId: string,
  limit = 30,
): Promise<MonthlyRentalAlertContract[]> {
  const supabase = await createClient()
  const today = new Date().toISOString().split('T')[0]!

  const { data, error } = await supabase
    .from('monthly_rental_contracts')
    .select(CONTRACT_ALERT_SELECT)
    .eq('tenant_id', tenantId)
    .eq('status', 'active')
    .not('end_date', 'is', null)
    .lt('end_date', today)
    .is('deleted_at', null)
    .order('end_date', { ascending: true })
    .limit(limit)

  if (error) throw new Error(error.message)
  return (data ?? []).map((r) => mapAlertContract(r as unknown as RawAlertContract))
}

export async function listMonthlyRentalFollowUpTasks(
  tenantId:   string,
  contractId: string,
): Promise<MonthlyRentalFollowUpTask[]> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('tasks')
    .select('id, title, description, due_date, status, priority, created_at, monthly_rental_contract_id')
    .eq('tenant_id', tenantId)
    .eq('monthly_rental_contract_id', contractId)
    .order('created_at', { ascending: false })
    .limit(50)

  if (error) throw new Error(error.message)
  return (data ?? []) as MonthlyRentalFollowUpTask[]
}

// ─── Documents ────────────────────────────────────────────────────────────────

export type MonthlyRentalDocument = {
  id:              string
  name:            string
  document_type:   string
  file_url:        string
  mime_type:       string | null
  file_size_bytes: number | null
  notes:           string | null
  source:          string | null
  created_at:      string
}

export async function listMonthlyRentalDocuments(
  tenantId:   string,
  contractId: string,
): Promise<MonthlyRentalDocument[]> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('documents')
    .select('id, name, document_type, file_url, mime_type, file_size_bytes, notes, source, created_at')
    .eq('tenant_id', tenantId)
    .eq('monthly_rental_contract_id', contractId)
    .order('created_at', { ascending: false })

  if (error) throw new Error(error.message)
  return (data ?? []) as MonthlyRentalDocument[]
}
