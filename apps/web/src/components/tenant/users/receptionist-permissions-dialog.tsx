'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { ShieldCheck } from 'lucide-react'
import type { TenantVertical } from '@orderflow/validators'
import type { TenantUserWithWorkspaceIds } from '@/lib/repositories/users.repository'
import {
  emptyPermissions,
  visiblePermissionFields,
  type ReceptionistPermissionKey,
} from '@/lib/dashboard/permission-fields'
import { updateReceptionistPermissionsAction } from '@/actions/users'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

// Las 8 claves siguen viajando SIEMPRE en el update, aunque alguna no se
// renderice: updateReceptionistPermissions() hace .update(permissions) con el
// objeto completo, así que un permiso oculto se reescribe con SU VALOR ACTUAL, no
// con false. El filtro es de presentación y no puede revocar nada.
type Permissions = Record<ReceptionistPermissionKey, boolean>

interface ReceptionistPermissionsDialogProps {
  user: TenantUserWithWorkspaceIds | null
  // Fase 3E-C3A1 — el rubro del tenant. Decide qué permisos se muestran.
  vertical: TenantVertical
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ReceptionistPermissionsDialog({
  user,
  vertical,
  open,
  onOpenChange,
}: ReceptionistPermissionsDialogProps) {
  const [isPending, startTransition] = useTransition()
  // Placeholder hasta que se sincronice con la fila del usuario. Se deriva de
  // PERMISSION_FIELDS en vez de escribirse a mano: el literal anterior tenía
  // can_confirm_reservations en true, copiando el viejo DEFAULT de la columna.
  const [perms, setPerms] = useState<Permissions>(emptyPermissions)

  // Sync local state when user changes
  const [syncedUserId, setSyncedUserId] = useState<string | null>(null)
  if (user && user.id !== syncedUserId) {
    setSyncedUserId(user.id)
    setPerms({
      can_assign_conversations: user.can_assign_conversations,
      can_access_settings: user.can_access_settings,
      can_create_properties: user.can_create_properties,
      can_confirm_reservations: user.can_confirm_reservations,
      can_manage_inquiries: user.can_manage_inquiries,
      can_manage_visits: user.can_manage_visits,
      can_manage_table_reservations: user.can_manage_table_reservations,
      can_manage_menu: user.can_manage_menu,
    })
  }

  if (!user) return null

  // Qué se muestra: los permisos del rubro, más los que estén fuera de rubro pero
  // CONCEDIDOS — para que el owner pueda apagarlos en vez de quedarse con un
  // permiso invisible.
  //
  // Se mide contra los valores GUARDADOS (user.*), no contra `perms`: si mirara el
  // estado en vivo, la fila se esfumaría en el mismo click en que se apaga y no
  // habría forma de volver a encenderla antes de guardar. Desaparece en el render
  // siguiente.
  const campos = visiblePermissionFields(vertical, {
    can_assign_conversations:      user.can_assign_conversations,
    can_access_settings:           user.can_access_settings,
    can_create_properties:         user.can_create_properties,
    can_confirm_reservations:      user.can_confirm_reservations,
    can_manage_inquiries:          user.can_manage_inquiries,
    can_manage_visits:             user.can_manage_visits,
    can_manage_table_reservations: user.can_manage_table_reservations,
    can_manage_menu:               user.can_manage_menu,
  })

  function toggle(key: keyof Permissions) {
    setPerms((p) => ({ ...p, [key]: !p[key] }))
  }

  function handleSave() {
    startTransition(async () => {
      const result = await updateReceptionistPermissionsAction(user!.id, perms)
      if (result.success) {
        toast.success(`Permisos de "${user!.name}" actualizados`)
        onOpenChange(false)
      } else {
        toast.error(result.error)
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-muted-foreground" />
            Permisos de {user.name}
          </DialogTitle>
          <DialogDescription>
            Configurá qué acciones puede realizar este recepcionista.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {campos.map(({ key, label, description }) => (
            <div key={key} className="flex items-start justify-between gap-4">
              <div className="space-y-0.5">
                <Label htmlFor={key} className="cursor-pointer text-sm font-medium leading-none">
                  {label}
                </Label>
                <p className="text-xs text-muted-foreground">{description}</p>
              </div>
              {/* Inline toggle — no external dependency needed */}
              <button
                id={key}
                role="switch"
                aria-checked={perms[key]}
                disabled={isPending}
                onClick={() => toggle(key)}
                className={cn(
                  'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
                  perms[key] ? 'bg-primary' : 'bg-input',
                )}
              >
                <span
                  className={cn(
                    'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg transition-transform',
                    perms[key] ? 'translate-x-4' : 'translate-x-0',
                  )}
                />
              </button>
            </div>
          ))}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancelar
          </Button>
          <Button onClick={handleSave} disabled={isPending}>
            {isPending ? 'Guardando...' : 'Guardar permisos'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
