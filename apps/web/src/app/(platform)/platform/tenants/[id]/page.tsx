import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import {
  tenantKindFrom,
  tenantKindLabel,
  foodCapabilitiesFrom,
  type TenantKind,
} from '@orderflow/validators'
import { requirePlatformContext } from '@/lib/auth/require-platform-context'
import * as repo from '@/lib/repositories/platform.repository'
import { StatusBadge } from '@/components/platform/onboarding-badge'
import { TenantDetailActions } from './tenant-detail-actions'
import { getTenantSetupChecklistAction } from '@/actions/platform-tenant-setup'
import type { TenantSetupChecklist } from '@/lib/tenant-setup-status'
import { limitUsage } from '@/lib/tenant-limits'

export const metadata: Metadata = { title: 'Cliente — ReservaNex' }

// La ficha de un cliente, para los TRES tipos.
//
// Hasta el cierre multi-tipo esta pantalla asumía inmobiliaria en todo lo que
// no era genérico: el breadcrumb, el checklist exigiendo propiedades, la
// tarjeta de límites con "Agentes" y con `?? 4 / ?? 5` (que ahora, con los
// topes nullables, le inventaban un "0 / 5" a quien no tiene tope), y los
// planes de agentes ofrecidos a cualquiera.
//
// Lo que sigue siendo COMPARTIDO no cambia: owner prospecto, seller, setup
// operator, timeline, notas, y el checklist salvo su renglón de catálogo. Lo
// que era del rubro ahora lo decide el rubro: el par (vertical, client_type)
// traducido por tenantKindFrom, una sola vez, acá arriba.

export default async function TenantDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const ctx = await requirePlatformContext()

  const [tenant, sellers, operators, assignments, counts, checklistResult, propertyCount] = await Promise.all([
    repo.getTenantById(id),
    ctx.isSuperAdmin ? repo.listSellers()   : Promise.resolve([]),
    ctx.isSuperAdmin ? repo.listOperators() : Promise.resolve([]),
    ctx.isSuperAdmin ? repo.listSetupAssignmentsByTenant(id) : Promise.resolve([]),
    ctx.isSuperAdmin ? repo.getTenantUserCounts(id) : Promise.resolve({ owners: 0, receptionists: 0, total: 0 }),
    ctx.isSuperAdmin ? getTenantSetupChecklistAction(id) : Promise.resolve(null),
    ctx.isSuperAdmin ? repo.countActiveProperties(id) : Promise.resolve(0),
  ])

  const checklist: TenantSetupChecklist | null =
    (checklistResult && checklistResult.success ? checklistResult.data : null) ?? null

  if (!tenant) notFound()

  // Seller: can only see own tenants
  if (ctx.isSeller && tenant.assigned_seller_id !== ctx.userId) notFound()

  const kind: TenantKind = tenantKindFrom(tenant.vertical, tenant.client_type)
  const kindLabel        = tenantKindLabel(tenant.vertical, tenant.client_type)
  const caps             = foodCapabilitiesFrom(tenant)

  const canEdit     = ctx.isSuperAdmin || (ctx.isSeller && tenant.onboarding_status !== 'delivered')
  const canDeliver  = ctx.isSeller && tenant.onboarding_status === 'ready_to_deliver'
  const canInvite   = ctx.isSuperAdmin && !!tenant.primary_owner_email &&
                      ['ready_to_deliver', 'delivered'].includes(tenant.onboarding_status)

  const fmt = (d: string | null) =>
    d ? new Date(d).toLocaleString('es-AR', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' }) : '—'

  const planLabel   = tenant.plan_label
  const planCode    = tenant.plan_code
  const setupStatus = tenant.setup_status

  // NULL = sin límite, tal cual viene de la base. Ya no hay `?? 5`: ese
  // fallback leía "sin límite" como "cinco" y mostraba un tope que no existe.
  const usoUsuarios    = limitUsage(counts.total,         tenant.max_users)
  const usoOwners      = limitUsage(counts.owners,        tenant.max_owners)
  const usoEquipo      = limitUsage(counts.receptionists, tenant.max_receptionists)
  const usoPropiedades = limitUsage(propertyCount,        tenant.max_properties)

  const activeAssignment = assignments.find((a) => a.status === 'active')

  return (
    <div className="max-w-2xl space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Link href="/platform/tenants" className="text-xs text-muted-foreground hover:underline">
              ← Clientes
            </Link>
          </div>
          <h1 className="mt-1 text-xl font-semibold">{tenant.name}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {/* Qué tipo de cliente es, antes que cualquier estado. */}
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
              {kindLabel}
            </span>
            <StatusBadge status={tenant.onboarding_status} type="onboarding" />
            <StatusBadge status={tenant.status} type="tenant" />
            {/* setup_status es el ciclo de vida de la ASIGNACIÓN A OPERATOR
                (not_started → assigned → in_progress → completed): sólo lo
                escriben assignSetupOperatorAction y completeSetupAssignmentAction,
                y ninguna lógica lo lee. Ese subflujo no existe para gastronomía,
                así que "Setup sin iniciar" ahí no describe nada — la columna
                queda en la base por esquema, pero no se expone como estado del
                producto. Distinto de onboarding_status, que sí es el onboarding
                real de los tres tipos. */}
            {setupStatus && kind !== 'food_business' && <SetupStatusBadge status={setupStatus} />}
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

        {/* Owner prospect — es un PROSPECTO: un mail anotado. El owner activo
            es otra cosa, y lo dice el checklist. */}
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

        {/* Servicios — sólo gastronomía, informativo. El owner los edita desde
            /dashboard/settings/services; plataforma sólo necesita verlos. */}
        {kind === 'food_business' && (
          <InfoCard title="Servicios">
            <InfoRow label="Delivery"        value={caps.delivery          ? 'Sí' : 'No'} />
            <InfoRow label="Retiro"          value={caps.takeaway          ? 'Sí' : 'No'} />
            <InfoRow label="Reserva de mesa" value={caps.tableReservations ? 'Sí' : 'No'} />
            {!caps.delivery && !caps.takeaway && (
              <p className="pt-1 text-xs text-muted-foreground">
                Sin pedidos: el sitio funciona como carta digital con consultas.
              </p>
            )}
          </InfoCard>
        )}

        {/* Plan y límites (SA only) — lo que se muestra depende de si HAY
            tope. Sin tope no se inventa uno ni se dibuja "/∞": el número solo. */}
        {ctx.isSuperAdmin && (
          <InfoCard title={kind === 'agency' ? 'Plan y usuarios' : 'Plan y límites'}>
            {kind === 'agency' && (
              <InfoRow label="Plan" value={planLabel ?? planCode ?? '—'} />
            )}
            {kind === 'private_owner' && (
              <InfoRow label="Plan" value="Particular" />
            )}

            {/* Propiedades: sólo cuando hay tope. Una agency no tiene y un
                gastronómico no tiene propiedades. */}
            {usoPropiedades && (
              <InfoRow
                label="Propiedades"
                value={`${usoPropiedades.used} de ${usoPropiedades.max}`}
                tone={usoPropiedades.reached ? 'warn' : undefined}
              />
            )}

            <InfoRow
              label="Owner"
              value={usoOwners ? `${usoOwners.used} de ${usoOwners.max}` : String(counts.owners)}
              tone={usoOwners?.reached ? 'warn' : undefined}
            />
            {/* "Agentes" es vocabulario inmobiliario. Gastronomía tiene equipo. */}
            <InfoRow
              label={kind === 'food_business' ? 'Equipo' : 'Agentes'}
              value={usoEquipo ? `${usoEquipo.used} de ${usoEquipo.max}` : String(counts.receptionists)}
              tone={usoEquipo?.reached ? 'warn' : undefined}
            />
            <InfoRow
              label="Usuarios"
              value={usoUsuarios ? `${usoUsuarios.used} de ${usoUsuarios.max}` : String(counts.total)}
              tone={usoUsuarios?.reached ? 'warn' : undefined}
            />

            {kind !== 'private_owner' && (
              <p className="pt-1 text-xs text-muted-foreground">Sin límite de usuarios.</p>
            )}
          </InfoCard>
        )}

        {/* Setup operator (SA only) — SÓLO inmobiliario. El setup por operator
            está diseñado para real_estate: impersona con canCreateProperties y
            sin canManageMenu, y los módulos gastronómicos están setupBlocked.
            Para un restaurante la tarjeta diría "Sin operator asignado" para
            siempre, sobre algo que no existe en su flujo. No se reemplaza por
            "No aplica": no se dibuja. */}
        {ctx.isSuperAdmin && kind !== 'food_business' && (
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
        kind={kind}
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
  // El renglón de catálogo trae su propio título desde el checklist: la ficha
  // no sabe si son propiedades o productos, y no tiene por qué.
  const items: { label: string; item: { ok: boolean; label: string }; link?: { href: string; text: string } }[] = [
    { label: 'Tenant',                item: checklist.tenant },
    { label: 'Owner',                 item: checklist.owner },
    { label: 'IA',                    item: checklist.ai },
    { label: 'WhatsApp',              item: checklist.whatsapp,   link: { href: `/platform/tenants/${tenantId}/whatsapp`, text: 'Configurar →' } },
    { label: 'Android',               item: checklist.android,    link: { href: `/platform/tenants/${tenantId}/whatsapp`, text: 'Ver estado →' } },
    { label: checklist.catalogTitle,  item: checklist.catalog },
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
      {checklist.state === 'no_catalog' && (
        <p className="text-xs text-muted-foreground">{checklist.catalogHint}</p>
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

function InfoRow({ label, value, tone }: { label: string; value: string; tone?: 'warn' }) {
  return (
    <div className="flex justify-between gap-2 text-sm">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className={tone === 'warn' ? 'text-right font-medium text-amber-700 dark:text-amber-400' : 'text-right'}>
        {value}
      </span>
    </div>
  )
}
