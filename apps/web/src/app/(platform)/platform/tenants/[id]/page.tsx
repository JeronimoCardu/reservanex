import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { requirePlatformContext } from '@/lib/auth/require-platform-context'
import * as repo from '@/lib/repositories/platform.repository'
import { StatusBadge } from '@/components/platform/onboarding-badge'
import { TenantDetailActions } from './tenant-detail-actions'
import { getTenantSetupChecklistAction } from '@/actions/platform-tenant-setup'
import type { TenantSetupChecklist } from '@/lib/tenant-setup-status'

export const metadata: Metadata = { title: 'Inmobiliaria — ReservaNex' }

export default async function TenantDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const ctx = await requirePlatformContext()

  const [tenant, sellers, operators, assignments, counts, checklistResult] = await Promise.all([
    repo.getTenantById(id),
    ctx.isSuperAdmin ? repo.listSellers()   : Promise.resolve([]),
    ctx.isSuperAdmin ? repo.listOperators() : Promise.resolve([]),
    ctx.isSuperAdmin ? repo.listSetupAssignmentsByTenant(id) : Promise.resolve([]),
    ctx.isSuperAdmin ? repo.getTenantUserCounts(id) : Promise.resolve({ owners: 0, receptionists: 0, total: 0 }),
    ctx.isSuperAdmin ? getTenantSetupChecklistAction(id) : Promise.resolve(null),
  ])

  const checklist: TenantSetupChecklist | null =
    (checklistResult && checklistResult.success ? checklistResult.data : null) ?? null

  if (!tenant) notFound()

  // Seller: can only see own tenants
  if (ctx.isSeller && tenant.assigned_seller_id !== ctx.userId) notFound()

  const canEdit     = ctx.isSuperAdmin || (ctx.isSeller && tenant.onboarding_status !== 'delivered')
  const canDeliver  = ctx.isSeller && tenant.onboarding_status === 'ready_to_deliver'
  const canInvite   = ctx.isSuperAdmin && !!tenant.primary_owner_email &&
                      ['ready_to_deliver', 'delivered'].includes(tenant.onboarding_status)

  const fmt = (d: string | null) =>
    d ? new Date(d).toLocaleString('es-AR', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' }) : '—'

  const planLabel      = (tenant as Record<string, unknown>).plan_label as string | null
  const planCode       = (tenant as Record<string, unknown>).plan_code  as string | null
  const setupStatus    = (tenant as Record<string, unknown>).setup_status as string | null
  const maxOwners      = (tenant as Record<string, unknown>).max_owners      as number | null ?? 1
  const maxReception   = (tenant as Record<string, unknown>).max_receptionists as number | null ?? 4
  const maxTotal       = (tenant as Record<string, unknown>).max_users       as number | null ?? 5

  const activeAssignment = assignments.find((a) => a.status === 'active')

  return (
    <div className="max-w-2xl space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Link href="/platform/tenants" className="text-xs text-muted-foreground hover:underline">
              ← Inmobiliarias
            </Link>
          </div>
          <h1 className="mt-1 text-xl font-semibold">{tenant.name}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <StatusBadge status={tenant.onboarding_status} type="onboarding" />
            <StatusBadge status={tenant.status} type="tenant" />
            {setupStatus && <SetupStatusBadge status={setupStatus} />}
            {checklist && <TenantReadinessBadge label={checklist.stateLabel} ready={checklist.state === 'ready'} />}
            {tenant.owner_invited_at && (
              <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
                Owner invitado
              </span>
            )}
          </div>
          {ctx.isSuperAdmin && (
            <div className="mt-2">
              <Link
                href={`/platform/tenants/${id}/whatsapp`}
                className="text-xs text-blue-600 hover:underline dark:text-blue-400"
              >
                ⚙ Configuración WhatsApp →
              </Link>
            </div>
          )}
        </div>
      </div>

      {/* Checklist de puesta en marcha (SA only) — Fase 8 §2/§9. Distinct from
          the operator-assignment SetupStatusBadge above: this answers "is
          the tenant itself ready for pilot?", not "did an operator finish
          their assigned task?". */}
      {ctx.isSuperAdmin && checklist && (
        <TenantReadinessChecklistCard tenantId={id} checklist={checklist} />
      )}

      {/* Info cards */}
      <div className="grid gap-4 sm:grid-cols-2">

        {/* Owner prospect */}
        <InfoCard title="Owner prospecto">
          <InfoRow label="Nombre" value={tenant.primary_owner_name ?? '—'} />
          <InfoRow label="Email"  value={tenant.primary_owner_email ?? '—'} />
          <InfoRow label="Tel"    value={tenant.primary_owner_phone ?? '—'} />
          {tenant.owner_invited_at && (
            <InfoRow label="Invitado el" value={fmt(tenant.owner_invited_at)} />
          )}
        </InfoCard>

        {/* Seller */}
        <InfoCard title="Seller asignado">
          <InfoRow
            label="Nombre"
            value={(tenant.seller as { name?: string } | null)?.name ?? 'Sin asignar'}
          />
          <InfoRow
            label="Email"
            value={(tenant.seller as { email?: string } | null)?.email ?? '—'}
          />
        </InfoCard>

        {/* Plan / limits (SA only) */}
        {ctx.isSuperAdmin && (
          <InfoCard title="Plan y límites">
            <InfoRow label="Plan"        value={planLabel ?? planCode ?? '—'} />
            <InfoRow label="Owners"      value={`${counts.owners} / ${maxOwners}`} />
            <InfoRow label="Agentes"     value={`${counts.receptionists} / ${maxReception}`} />
            <InfoRow label="Total"       value={`${counts.total} / ${maxTotal}`} />
          </InfoCard>
        )}

        {/* Setup operator (SA only) */}
        {ctx.isSuperAdmin && (
          <InfoCard title="Setup operator">
            {activeAssignment ? (
              <>
                <InfoRow label="Operator"   value={(activeAssignment.operator as { name?: string } | null)?.name ?? '—'} />
                <InfoRow label="Email"      value={(activeAssignment.operator as { email?: string } | null)?.email ?? '—'} />
                <InfoRow label="Asignado"   value={fmt(activeAssignment.assigned_at)} />
                <InfoRow label="Estado"     value={activeAssignment.status} />
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Sin operator asignado</p>
            )}
          </InfoCard>
        )}

        {/* Timeline */}
        <InfoCard title="Timeline">
          <InfoRow label="Creada"         value={fmt(tenant.created_at)}            />
          <InfoRow label="Iniciado"        value={fmt(tenant.onboarding_started_at)} />
          <InfoRow label="Aprobada"        value={fmt(tenant.approved_at)}           />
          <InfoRow label="Lista entregar"  value={fmt(tenant.ready_to_deliver_at)}   />
          <InfoRow label="Entregada"       value={fmt(tenant.delivered_at)}          />
          {tenant.rejected_at && (
            <InfoRow label="Rechazada"     value={fmt(tenant.rejected_at)}           />
          )}
        </InfoCard>

        {/* Notes */}
        {tenant.onboarding_notes && (
          <InfoCard title="Notas internas">
            <p className="text-sm text-muted-foreground whitespace-pre-wrap">{tenant.onboarding_notes}</p>
          </InfoCard>
        )}
      </div>

      {/* Actions panel */}
      <TenantDetailActions
        tenant={tenant}
        sellers={sellers}
        operators={operators}
        activeAssignmentId={activeAssignment?.id ?? null}
        isSuperAdmin={ctx.isSuperAdmin}
        canEdit={canEdit}
        canDeliver={canDeliver}
        canInvite={canInvite}
      />
    </div>
  )
}

function SetupStatusBadge({ status }: { status: string }) {
  const MAP: Record<string, { label: string; className: string }> = {
    not_started: { label: 'Setup sin iniciar',  className: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400' },
    assigned:    { label: 'Operator asignado',  className: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' },
    in_progress: { label: 'Setup en curso',     className: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' },
    completed:   { label: 'Setup completado',   className: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' },
    approved:    { label: 'Setup aprobado',     className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' },
    revoked:     { label: 'Setup revocado',     className: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' },
  }
  const cfg = MAP[status] ?? { label: status, className: 'bg-slate-100 text-slate-600' }
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${cfg.className}`}>
      {cfg.label}
    </span>
  )
}

function TenantReadinessBadge({ label, ready }: { label: string; ready: boolean }) {
  const className = ready
    ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
    : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${className}`}>{label}</span>
}

function TenantReadinessChecklistCard({ tenantId, checklist }: { tenantId: string; checklist: TenantSetupChecklist }) {
  const items: { label: string; item: { ok: boolean; label: string }; link?: { href: string; text: string } }[] = [
    { label: 'Tenant',      item: checklist.tenant },
    { label: 'Owner',       item: checklist.owner },
    { label: 'IA',          item: checklist.ai },
    { label: 'WhatsApp',    item: checklist.whatsapp,   link: { href: `/platform/tenants/${tenantId}/whatsapp`, text: 'Configurar →' } },
    { label: 'Android',     item: checklist.android,    link: { href: `/platform/tenants/${tenantId}/whatsapp`, text: 'Ver estado →' } },
    { label: 'Propiedades', item: checklist.properties },
  ]

  return (
    <div className="rounded-lg border bg-background p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Checklist de puesta en marcha</h3>
        <TenantReadinessBadge label={checklist.stateLabel} ready={checklist.state === 'ready'} />
      </div>
      <ul className="space-y-1.5">
        {items.map(({ label, item, link }) => (
          <li key={label} className="flex items-center justify-between gap-2 text-sm">
            <span className="flex items-center gap-2">
              <span className={item.ok ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-400'}>
                {item.ok ? '✓' : '✗'}
              </span>
              <span className="text-muted-foreground">{label}</span>
              <span>{item.label}</span>
            </span>
            {!item.ok && link && (
              <Link href={link.href} className="shrink-0 text-xs text-blue-600 hover:underline dark:text-blue-400">
                {link.text}
              </Link>
            )}
          </li>
        ))}
      </ul>
      {checklist.state !== 'ready' && !checklist.owner.ok && (
        <p className="text-xs text-muted-foreground">Owner: invitalo desde la sección &quot;Invitar al Tenant Owner&quot; más abajo.</p>
      )}
      {checklist.state === 'no_properties' && (
        <p className="text-xs text-muted-foreground">Propiedades: las carga el owner desde su panel una vez que inició sesión.</p>
      )}
    </div>
  )
}

function InfoCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-background p-4 space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
      {children}
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2 text-sm">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  )
}
