'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { LinkIcon, CopyIcon } from 'lucide-react'
import type { PlatformUserRow } from '@orderflow/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  updateTenantBasicAction,
  updateTenantOnboardingStatusAction,
  updateTenantStatusAction,
  reassignTenantSellerAction,
  markTenantDeliveredAction,
  invitePrimaryTenantOwnerAction,
  updateTenantPlanAction,
  assignSetupOperatorAction,
  revokeSetupOperatorAction,
} from '@/actions/platform'
import type { TenantWithSeller } from '@/lib/repositories/platform.repository'
import { PLAN_OPTIONS } from '@/lib/plans'

const ONBOARDING_OPTIONS = [
  { value: 'pending_review',   label: 'Pendiente revisión' },
  { value: 'approved',         label: 'Aprobada'           },
  { value: 'meta_setup',       label: 'Config. Meta'       },
  { value: 'testing',          label: 'En pruebas'         },
  { value: 'ready_to_deliver', label: 'Lista para entregar'},
  { value: 'delivered',        label: 'Entregada'          },
  { value: 'rejected',         label: 'Rechazada'          },
]

const TENANT_STATUS_OPTIONS = [
  { value: 'trial',     label: 'Trial'     },
  { value: 'active',    label: 'Activo'    },
  { value: 'suspended', label: 'Suspendido'},
  { value: 'cancelled', label: 'Cancelado' },
]

type Props = {
  tenant:              TenantWithSeller
  sellers:             PlatformUserRow[]
  operators:           PlatformUserRow[]
  activeAssignmentId:  string | null
  isSuperAdmin:        boolean
  canEdit:             boolean
  canDeliver:          boolean
  canInvite:           boolean
}

// Explicit reveal-once dialog for the invite-link fallback — mirrors
// TokenRevealDialog in the AutoResponder form (same "show a secret once,
// require an explicit click to copy" pattern). Never auto-copies: the SA
// must click "Copiar enlace" themselves.
function InviteLinkFallbackDialog({
  link,
  onClose,
}: {
  link:    string | null
  onClose: () => void
}) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(link ?? '')
      setCopied(true)
      toast.success('Enlace copiado al portapapeles')
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error('No se pudo copiar — copialo manualmente.')
    }
  }

  return (
    <Dialog open={link !== null} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LinkIcon className="h-5 w-5" />
            No pudimos enviar el email
          </DialogTitle>
          <DialogDescription>
            Podés compartir este enlace de invitación manualmente. Es de un solo uso — dejá de funcionar en cuanto el owner lo abra.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md border bg-muted/40 p-3">
          <code className="block break-all font-mono text-sm">{link}</code>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button type="button" variant="outline" onClick={handleCopy}>
            <CopyIcon className="h-4 w-4 mr-1.5" />
            {copied ? 'Copiado ✓' : 'Copiar enlace'}
          </Button>
          <Button type="button" onClick={onClose}>
            Cerrar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function TenantDetailActions({ tenant, sellers, operators, activeAssignmentId, isSuperAdmin, canEdit, canDeliver, canInvite }: Props) {
  const router    = useRouter()
  const [isPending, startTransition] = useTransition()
  const [inviteLink, setInviteLink] = useState<string | null>(null)

  // Edit form state
  const [editForm, setEditForm] = useState({
    name:                tenant.name,
    primary_owner_name:  tenant.primary_owner_name  ?? '',
    primary_owner_email: tenant.primary_owner_email ?? '',
    primary_owner_phone: tenant.primary_owner_phone ?? '',
    onboarding_notes:    tenant.onboarding_notes    ?? '',
  })

  function run(fn: () => Promise<void>) {
    startTransition(async () => { await fn(); router.refresh() })
  }

  function handleSaveBasic(e: React.FormEvent) {
    e.preventDefault()
    run(async () => {
      const res = await updateTenantBasicAction(tenant.id, {
        name:                editForm.name               || undefined,
        primary_owner_name:  editForm.primary_owner_name  || null,
        primary_owner_email: editForm.primary_owner_email || null,
        primary_owner_phone: editForm.primary_owner_phone || null,
        onboarding_notes:    editForm.onboarding_notes    || null,
      })
      if (res.success) toast.success('Datos actualizados.')
      else             toast.error(res.error)
    })
  }

  return (
    <div className="space-y-4">

      {/* Edit basic data */}
      {canEdit && (
        <Section title="Editar datos">
          <form onSubmit={handleSaveBasic} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="name">Nombre</Label>
                <Input
                  id="name"
                  value={editForm.name}
                  onChange={(e) => setEditForm((p) => ({ ...p, name: e.target.value }))}
                  required
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="owner_name">Nombre owner</Label>
                <Input
                  id="owner_name"
                  value={editForm.primary_owner_name}
                  onChange={(e) => setEditForm((p) => ({ ...p, primary_owner_name: e.target.value }))}
                  placeholder="Nombre completo"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="owner_email">Email owner</Label>
                <Input
                  id="owner_email"
                  type="email"
                  value={editForm.primary_owner_email}
                  onChange={(e) => setEditForm((p) => ({ ...p, primary_owner_email: e.target.value }))}
                  placeholder="owner@ejemplo.com"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="owner_phone">Teléfono owner</Label>
                <Input
                  id="owner_phone"
                  value={editForm.primary_owner_phone}
                  onChange={(e) => setEditForm((p) => ({ ...p, primary_owner_phone: e.target.value }))}
                  placeholder="+54 9 ..."
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="notes">Notas internas</Label>
              <Textarea
                id="notes"
                value={editForm.onboarding_notes}
                onChange={(e) => setEditForm((p) => ({ ...p, onboarding_notes: e.target.value }))}
                rows={2}
              />
            </div>
            <Button type="submit" size="sm" disabled={isPending}>
              {isPending ? 'Guardando...' : 'Guardar cambios'}
            </Button>
          </form>
        </Section>
      )}

      {/* Seller: mark delivered */}
      {canDeliver && (
        <Section title="Entregar al cliente">
          <p className="text-sm text-muted-foreground mb-3">
            El onboarding está listo. Podés marcarla como entregada.
          </p>
          <Button
            size="sm"
            disabled={isPending}
            onClick={() => run(async () => {
              const res = await markTenantDeliveredAction(tenant.id)
              if (res.success) toast.success('Inmobiliaria marcada como entregada.')
              else             toast.error(res.error)
            })}
          >
            Marcar como entregada
          </Button>
        </Section>
      )}

      {/* SA: Invite owner */}
      {canInvite && (
        <Section title="Invitar al Tenant Owner">
          <p className="text-sm text-muted-foreground mb-3">
            Se enviará una invitación a <strong>{tenant.primary_owner_email}</strong>.
            {tenant.owner_invited_at && ' Ya fue invitado — podés reenviar.'}
          </p>
          <Button
            size="sm"
            disabled={isPending}
            onClick={() => run(async () => {
              const res = await invitePrimaryTenantOwnerAction(tenant.id)
              if (res.success) {
                const link = res.data?.inviteLink
                if (link) {
                  // Email delivery failed on Supabase's side — fall back to
                  // an explicit reveal-once dialog instead of asking the SA
                  // to run a local script or touch Supabase Dashboard. Never
                  // auto-copied: the SA must click "Copiar enlace".
                  setInviteLink(link)
                } else if ('warning' in res && res.warning) {
                  toast.warning(res.warning, { duration: 10000 })
                } else {
                  toast.success('Invitación enviada al owner.')
                }
              } else {
                toast.error(res.error)
              }
            })}
          >
            {tenant.owner_invited_at ? 'Reenviar invitación' : 'Enviar invitación'}
          </Button>
        </Section>
      )}

      {/* SA-only: Onboarding status */}
      {isSuperAdmin && (
        <Section title="Estado de onboarding">
          <div className="flex flex-wrap gap-2">
            {ONBOARDING_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                disabled={isPending || tenant.onboarding_status === opt.value}
                onClick={() => run(async () => {
                  const res = await updateTenantOnboardingStatusAction(tenant.id, opt.value)
                  if (res.success) toast.success(`Onboarding → ${opt.label}`)
                  else             toast.error(res.error)
                })}
                className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors
                  ${tenant.onboarding_status === opt.value
                    ? 'border-primary bg-primary text-primary-foreground cursor-default'
                    : 'hover:bg-muted disabled:opacity-40'
                  }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </Section>
      )}

      {/* SA-only: Tenant status */}
      {isSuperAdmin && (
        <Section title="Estado del tenant">
          <div className="flex flex-wrap gap-2">
            {TENANT_STATUS_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                disabled={isPending || tenant.status === opt.value}
                onClick={() => run(async () => {
                  const res = await updateTenantStatusAction(tenant.id, opt.value)
                  if (res.success) toast.success(`Estado → ${opt.label}`)
                  else             toast.error(res.error)
                })}
                className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors
                  ${tenant.status === opt.value
                    ? 'border-primary bg-primary text-primary-foreground cursor-default'
                    : 'hover:bg-muted disabled:opacity-40'
                  }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </Section>
      )}

      {/* SA-only: Reassign seller */}
      {isSuperAdmin && sellers.length > 0 && (
        <Section title="Reasignar seller">
          <div className="flex flex-wrap gap-2">
            {sellers.filter((s) => s.active).map((s) => (
              <button
                key={s.id}
                disabled={isPending || tenant.assigned_seller_id === s.id}
                onClick={() => run(async () => {
                  const res = await reassignTenantSellerAction(tenant.id, s.id)
                  if (res.success) toast.success(`Reasignado a ${s.name}`)
                  else             toast.error(res.error)
                })}
                className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors
                  ${tenant.assigned_seller_id === s.id
                    ? 'border-primary bg-primary text-primary-foreground cursor-default'
                    : 'hover:bg-muted disabled:opacity-40'
                  }`}
              >
                {s.name}
              </button>
            ))}
          </div>
        </Section>
      )}

      {/* SA-only: Plan */}
      {isSuperAdmin && (
        <Section title="Plan comercial">
          <p className="text-xs text-muted-foreground mb-2">
            Cambiar plan actualiza los límites de owners, agentes y usuarios totales.
            El downgrade se bloquea si el tenant ya excede los nuevos límites.
          </p>
          <div className="flex flex-wrap gap-2">
            {PLAN_OPTIONS.map((opt) => {
              const currentCode = (tenant as Record<string, unknown>).plan_code as string | null
              const isActive    = currentCode === opt.code
              return (
                <button
                  key={opt.code}
                  disabled={isPending || isActive}
                  onClick={() => run(async () => {
                    const res = await updateTenantPlanAction(tenant.id, { plan_code: opt.code })
                    if (res.success) toast.success(`Plan actualizado → ${opt.label}`)
                    else             toast.error(res.error)
                  })}
                  className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors
                    ${isActive
                      ? 'border-primary bg-primary text-primary-foreground cursor-default'
                      : 'hover:bg-muted disabled:opacity-40'
                    }`}
                >
                  {opt.label}
                </button>
              )
            })}
          </div>
        </Section>
      )}

      {/* SA-only: Assign setup operator */}
      {isSuperAdmin && operators.length > 0 && (
        <Section title="Setup operator">
          {activeAssignmentId ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-muted-foreground">Hay un operator activo asignado a este tenant.</p>
              <button
                disabled={isPending}
                onClick={() => run(async () => {
                  const res = await revokeSetupOperatorAction(activeAssignmentId)
                  if (res.success) toast.success('Assignment revocado.')
                  else             toast.error(res.error)
                })}
                className="w-fit rounded-md border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-40 dark:border-red-800 dark:bg-red-950/30 dark:text-red-400"
              >
                Revocar assignment
              </button>
            </div>
          ) : (
            <>
              <p className="text-xs text-muted-foreground mb-2">Asignar un operator interno para configurar el CRM.</p>
              <div className="flex flex-wrap gap-2">
                {operators.map((op) => (
                  <button
                    key={op.id}
                    disabled={isPending}
                    onClick={() => run(async () => {
                      const res = await assignSetupOperatorAction(tenant.id, op.id)
                      if (res.success) toast.success(`Operator ${op.name} asignado.`)
                      else             toast.error(res.error)
                    })}
                    className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-40"
                  >
                    {op.name}
                  </button>
                ))}
              </div>
            </>
          )}
        </Section>
      )}

      <InviteLinkFallbackDialog link={inviteLink} onClose={() => setInviteLink(null)} />
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-background p-4 space-y-3">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </div>
  )
}
