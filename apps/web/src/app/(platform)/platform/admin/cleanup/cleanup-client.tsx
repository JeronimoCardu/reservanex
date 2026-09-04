'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import {
  ChevronDownIcon,
  ChevronRightIcon,
  TrashIcon,
  BanIcon,
  RotateCcwIcon,
  EyeIcon,
} from 'lucide-react'
import type {
  CleanupOverview,
  CleanupTenantRow,
  CleanupSellerRow,
  TenantDeletionPreview,
} from '@/actions/platform-danger'
import {
  getTenantDeletionPreviewAction,
  deactivateSellerBySuperAdminAction,
  deactivateTenantBySuperAdminAction,
  hardDeleteTenantBySuperAdminAction,
  hardDeleteSellerBySuperAdminAction,
  resetQaDataExceptSuperAdminAction,
} from '@/actions/platform-danger'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'

// ── Overview Stats ─────────────────────────────────────────────────────────────

function OverviewStats({ overview }: { overview: CleanupOverview | null }) {
  if (!overview) return null
  const stats = [
    { label: 'Tenants',       value: overview.tenants },
    { label: 'Sellers',       value: overview.sellers },
    { label: 'Tenant Users',  value: overview.tenantUsers },
    { label: 'Contactos',     value: overview.contacts },
    { label: 'Conversaciones',value: overview.conversations },
    { label: 'Mensajes',      value: overview.messages },
    { label: 'Queue',         value: overview.messageQueue },
    { label: 'Propiedades',   value: overview.properties },
    { label: 'WA Accounts',   value: overview.whatsappAccts },
    { label: 'Audit Logs',    value: overview.auditLogs },
    { label: 'AI Usage',      value: overview.aiUsageLogs },
  ]
  return (
    <div>
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
        Estado global de datos
      </h2>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
        {stats.map((s) => (
          <div key={s.label} className="rounded-md border bg-background px-3 py-2 text-center">
            <div className="text-xl font-bold tabular-nums">{s.value}</div>
            <div className="text-xs text-muted-foreground">{s.label}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Reset QA Section ──────────────────────────────────────────────────────────

function ResetQaSection({ globalResetAllowed }: { globalResetAllowed: boolean }) {
  const [isPending, startTransition] = useTransition()
  const [confirm, setConfirm] = useState('')
  const [expanded, setExpanded] = useState(false)

  function handleReset() {
    startTransition(async () => {
      const res = await resetQaDataExceptSuperAdminAction(confirm)
      if (res.success) {
        const summary =
          `${res.data?.tenantsDeleted ?? 0} tenants eliminados (DB), ` +
          `${res.data?.sellersDeleted ?? 0} sellers eliminados, ` +
          `${res.data?.tenantAuthUsersDeleted ?? 0} usuarios auth de tenants eliminados, ` +
          `${res.data?.storageObjectsDeleted ?? 0} archivos de storage eliminados.`
        // 'warning' is set whenever storage cleanup left files behind — DB/Auth
        // are genuinely done, but never say "reset completo" in that case.
        if ('warning' in res && res.warning) {
          toast.warning(`Reset con advertencias. ${summary}`, { description: res.warning, duration: 12000 })
        } else {
          toast.success(`Reset completo. ${summary}`)
        }
        setConfirm('')
        setExpanded(false)
      } else {
        toast.error(res.error)
      }
    })
  }

  return (
    <div className="rounded-lg border border-red-300 bg-red-50/50 p-4 dark:border-red-800 dark:bg-red-950/20">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-semibold text-red-700 dark:text-red-400">
            Reset global de QA
          </h2>
          <p className="mt-1 text-sm text-red-600/80 dark:text-red-500/80">
            Elimina todos los tenants, sellers y sus datos. No borra al Super Admin actual.
          </p>
          {!globalResetAllowed && (
            <p className="mt-1 text-sm font-medium text-amber-700 dark:text-amber-500">
              Reset global deshabilitado por configuración (requiere ALLOW_GLOBAL_TENANT_RESET=true en el servidor).
            </p>
          )}
        </div>
        <Button
          variant="destructive"
          size="sm"
          onClick={() => setExpanded((v) => !v)}
          disabled={isPending || !globalResetAllowed}
        >
          <RotateCcwIcon className="h-4 w-4 mr-1.5" />
          RESET RESERVANEX
        </Button>
      </div>

      {expanded && (
        <div className="mt-4 space-y-3 border-t border-red-200 pt-4 dark:border-red-800">
          <p className="text-sm font-medium text-red-700 dark:text-red-400">
            Escribí exactamente <code className="rounded bg-red-100 px-1 dark:bg-red-950">RESET RESERVANEX</code> para confirmar:
          </p>
          <div className="flex gap-2">
            <Input
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="RESET RESERVANEX"
              disabled={isPending}
              className="max-w-xs font-mono"
            />
            <Button
              variant="destructive"
              onClick={handleReset}
              disabled={isPending || confirm !== 'RESET RESERVANEX' || !globalResetAllowed}
            >
              {isPending ? 'Borrando…' : 'Confirmar reset'}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Tenant Preview Modal ──────────────────────────────────────────────────────

function TenantPreview({ preview }: { preview: TenantDeletionPreview }) {
  const entries = Object.entries(preview.counts).filter(([, v]) => v > 0)
  return (
    <div className="mt-3 rounded-md border bg-background p-3 text-sm">
      <div className="mb-2 font-medium">
        Preview: <span className="text-foreground">{preview.name}</span>
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-0.5 text-muted-foreground sm:grid-cols-3">
        {entries.length === 0 ? (
          <span className="col-span-3 text-xs">Tenant vacío — no hay datos asociados.</span>
        ) : (
          entries.map(([key, val]) => (
            <div key={key} className="flex justify-between gap-2">
              <span className="text-xs">{key.replace(/_/g, ' ')}</span>
              <span className="tabular-nums text-foreground font-medium">{val}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

// ── Tenant Row ────────────────────────────────────────────────────────────────

function TenantRow({ tenant }: { tenant: CleanupTenantRow }) {
  const [isPending, startTransition] = useTransition()
  const [expanded, setExpanded] = useState(false)
  const [preview, setPreview] = useState<TenantDeletionPreview | null>(null)
  const [loadingPreview, setLoadingPreview] = useState(false)

  // Hard delete state
  const [showDelete, setShowDelete] = useState(false)
  const [confirmInput, setConfirmInput] = useState('')
  const [deleteAuth, setDeleteAuth] = useState(true)
  const [deleteStorage, setDeleteStorage] = useState(false)

  // Soft deactivate state
  const [showDeactivate, setShowDeactivate] = useState(false)
  const [deactivateConfirm, setDeactivateConfirm] = useState('')

  const isDeleted = !!tenant.deleted_at

  async function loadPreview() {
    setLoadingPreview(true)
    const res = await getTenantDeletionPreviewAction(tenant.id)
    setLoadingPreview(false)
    if (res.success) setPreview(res.data ?? null)
    else toast.error(res.error)
  }

  function handleDeactivate() {
    startTransition(async () => {
      const res = await deactivateTenantBySuperAdminAction(tenant.id, deactivateConfirm)
      if (res.success) {
        toast.success(`Tenant "${tenant.name}" desactivado.`)
        setShowDeactivate(false)
        setDeactivateConfirm('')
      } else {
        toast.error(res.error)
      }
    })
  }

  function handleHardDelete() {
    startTransition(async () => {
      const res = await hardDeleteTenantBySuperAdminAction({
        tenantId:             tenant.id,
        confirmName:          confirmInput,
        deleteAuthUsers:      deleteAuth,
        deleteStorageObjects: deleteStorage,
      })
      if (res.success) {
        toast.success(`Tenant "${tenant.name}" eliminado permanentemente.`)
        if (res.warning) toast.warning(res.warning)
        setShowDelete(false)
        setConfirmInput('')
      } else {
        toast.error(res.error)
      }
    })
  }

  return (
    <div className={`rounded-md border bg-background ${isDeleted ? 'opacity-60' : ''}`}>
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <button
          className="flex items-center gap-2 text-left hover:opacity-70 transition-opacity"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? (
            <ChevronDownIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRightIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <div>
            <div className="text-sm font-medium leading-tight">{tenant.name}</div>
            <div className="text-xs text-muted-foreground">{tenant.slug}</div>
          </div>
        </button>

        <div className="flex shrink-0 items-center gap-2">
          <Badge variant="outline" className="text-xs">
            {tenant.status}
          </Badge>
          {isDeleted && (
            <Badge className="bg-red-100 text-red-700 border-red-200 text-xs dark:bg-red-950 dark:text-red-400">
              eliminado
            </Badge>
          )}
        </div>
      </div>

      {expanded && (
        <div className="border-t px-4 pb-4 pt-3 space-y-3">
          {/* Preview */}
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={loadPreview}
              disabled={loadingPreview || isPending}
            >
              <EyeIcon className="h-3.5 w-3.5 mr-1.5" />
              {loadingPreview ? 'Cargando…' : 'Ver preview'}
            </Button>
          </div>

          {preview && <TenantPreview preview={preview} />}

          {/* Soft deactivate */}
          {!isDeleted && (
            <div className="space-y-2">
              <Button
                variant="outline"
                size="sm"
                className="text-yellow-700 border-yellow-300 hover:bg-yellow-50 dark:text-yellow-400 dark:border-yellow-800"
                onClick={() => { setShowDeactivate((v) => !v); setShowDelete(false) }}
                disabled={isPending}
              >
                <BanIcon className="h-3.5 w-3.5 mr-1.5" />
                Desactivar (soft)
              </Button>

              {showDeactivate && (
                <div className="flex gap-2 items-center">
                  <Input
                    placeholder={`Escribí "${tenant.name}" para confirmar`}
                    value={deactivateConfirm}
                    onChange={(e) => setDeactivateConfirm(e.target.value)}
                    disabled={isPending}
                    className="max-w-xs text-sm"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-yellow-700 border-yellow-300 dark:text-yellow-400 dark:border-yellow-800"
                    disabled={
                      isPending ||
                      (deactivateConfirm !== tenant.name && deactivateConfirm !== tenant.slug)
                    }
                    onClick={handleDeactivate}
                  >
                    {isPending ? 'Guardando…' : 'Confirmar'}
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* Hard delete */}
          <div className="space-y-2">
            <Button
              variant="destructive"
              size="sm"
              onClick={() => { setShowDelete((v) => !v); setShowDeactivate(false) }}
              disabled={isPending}
            >
              <TrashIcon className="h-3.5 w-3.5 mr-1.5" />
              Eliminar permanentemente
            </Button>

            {showDelete && (
              <div className="rounded-md border border-red-200 bg-red-50/50 p-3 space-y-3 dark:border-red-800 dark:bg-red-950/20">
                <p className="text-xs font-medium text-red-700 dark:text-red-400">
                  Escribí el nombre o slug exacto para confirmar la eliminación permanente:
                </p>
                <Input
                  placeholder={tenant.name}
                  value={confirmInput}
                  onChange={(e) => setConfirmInput(e.target.value)}
                  disabled={isPending}
                  className="max-w-xs text-sm font-mono"
                />
                <div className="flex flex-col gap-1.5 text-xs text-muted-foreground">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={deleteAuth}
                      onChange={(e) => setDeleteAuth(e.target.checked)}
                      disabled={isPending}
                    />
                    Borrar cuentas de auth (tenant users)
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={deleteStorage}
                      onChange={(e) => setDeleteStorage(e.target.checked)}
                      disabled={isPending}
                    />
                    Borrar archivos de storage (imágenes)
                  </label>
                </div>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={
                    isPending ||
                    (confirmInput !== tenant.name && confirmInput !== tenant.slug)
                  }
                  onClick={handleHardDelete}
                >
                  {isPending ? 'Eliminando…' : 'Eliminar todo'}
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Seller Row ────────────────────────────────────────────────────────────────

function SellerRow({ seller }: { seller: CleanupSellerRow }) {
  const [isPending, startTransition] = useTransition()
  const [expanded, setExpanded] = useState(false)
  const [showDeactivate, setShowDeactivate] = useState(false)
  const [showDelete,     setShowDelete]     = useState(false)
  const [confirmInput,   setConfirmInput]   = useState('')

  function handleDeactivate() {
    startTransition(async () => {
      const res = await deactivateSellerBySuperAdminAction(seller.id, confirmInput)
      if (res.success) {
        toast.success(`Seller "${seller.name}" desactivado.`)
        setShowDeactivate(false)
        setConfirmInput('')
      } else {
        toast.error(res.error)
      }
    })
  }

  function handleHardDelete() {
    startTransition(async () => {
      const res = await hardDeleteSellerBySuperAdminAction(seller.id, confirmInput)
      if (res.success) {
        toast.success(`Seller "${seller.name}" eliminado.`)
        setShowDelete(false)
        setConfirmInput('')
      } else {
        toast.error(res.error)
      }
    })
  }

  return (
    <div className={`rounded-md border bg-background ${!seller.active ? 'opacity-60' : ''}`}>
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <button
          className="flex items-center gap-2 text-left hover:opacity-70 transition-opacity"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? (
            <ChevronDownIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRightIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <div>
            <div className="text-sm font-medium leading-tight">{seller.name}</div>
            <div className="text-xs text-muted-foreground">{seller.email}</div>
          </div>
        </button>

        {!seller.active && (
          <Badge className="bg-gray-100 text-gray-600 border-gray-200 text-xs dark:bg-gray-800 dark:text-gray-400 shrink-0">
            inactivo
          </Badge>
        )}
      </div>

      {expanded && (
        <div className="border-t px-4 pb-4 pt-3 space-y-2">
          {/* Soft deactivate */}
          {seller.active && (
            <div className="space-y-2">
              <Button
                variant="outline"
                size="sm"
                className="text-yellow-700 border-yellow-300 hover:bg-yellow-50 dark:text-yellow-400 dark:border-yellow-800"
                onClick={() => {
                  setShowDeactivate((v) => !v)
                  setShowDelete(false)
                  setConfirmInput('')
                }}
                disabled={isPending}
              >
                <BanIcon className="h-3.5 w-3.5 mr-1.5" />
                Desactivar (soft)
              </Button>

              {showDeactivate && (
                <div className="flex gap-2 items-center">
                  <Input
                    placeholder={`Email: ${seller.email}`}
                    value={confirmInput}
                    onChange={(e) => setConfirmInput(e.target.value)}
                    disabled={isPending}
                    className="max-w-xs text-sm"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-yellow-700 border-yellow-300 dark:text-yellow-400 dark:border-yellow-800"
                    disabled={isPending || confirmInput.toLowerCase() !== seller.email.toLowerCase()}
                    onClick={handleDeactivate}
                  >
                    {isPending ? 'Guardando…' : 'Confirmar'}
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* Hard delete */}
          <div className="space-y-2">
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                setShowDelete((v) => !v)
                setShowDeactivate(false)
                setConfirmInput('')
              }}
              disabled={isPending}
            >
              <TrashIcon className="h-3.5 w-3.5 mr-1.5" />
              Eliminar permanentemente
            </Button>

            {showDelete && (
              <div className="rounded-md border border-red-200 bg-red-50/50 p-3 space-y-3 dark:border-red-800 dark:bg-red-950/20">
                <p className="text-xs font-medium text-red-700 dark:text-red-400">
                  Escribí el email exacto para confirmar:
                </p>
                <div className="flex gap-2 items-center">
                  <Input
                    placeholder={seller.email}
                    value={confirmInput}
                    onChange={(e) => setConfirmInput(e.target.value)}
                    disabled={isPending}
                    className="max-w-xs text-sm font-mono"
                  />
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={
                      isPending ||
                      confirmInput.toLowerCase() !== seller.email.toLowerCase()
                    }
                    onClick={handleHardDelete}
                  >
                    {isPending ? 'Eliminando…' : 'Eliminar'}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Main Client Component ─────────────────────────────────────────────────────

interface CleanupClientProps {
  overview:           CleanupOverview | null
  tenants:            CleanupTenantRow[]
  sellers:            CleanupSellerRow[]
  globalResetAllowed: boolean
}

export function CleanupClient({ overview, tenants, sellers, globalResetAllowed }: CleanupClientProps) {
  return (
    <div className="space-y-8">
      <OverviewStats overview={overview} />

      <ResetQaSection globalResetAllowed={globalResetAllowed} />

      {/* Tenants */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Tenants ({tenants.length})
          </h2>
        </div>
        {tenants.length === 0 ? (
          <p className="text-sm text-muted-foreground">No hay tenants.</p>
        ) : (
          <div className="space-y-2">
            {tenants.map((t) => (
              <TenantRow key={t.id} tenant={t} />
            ))}
          </div>
        )}
      </section>

      {/* Sellers */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Sellers ({sellers.length})
        </h2>
        {sellers.length === 0 ? (
          <p className="text-sm text-muted-foreground">No hay sellers.</p>
        ) : (
          <div className="space-y-2">
            {sellers.map((s) => (
              <SellerRow key={s.id} seller={s} />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
