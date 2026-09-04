'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { ShieldCheck } from 'lucide-react'
import type { TenantUserWithWorkspaceIds } from '@/lib/repositories/users.repository'
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

type Permissions = {
  can_assign_conversations: boolean
  can_access_settings: boolean
  can_create_properties: boolean
  can_confirm_reservations: boolean
}

const PERMISSION_FIELDS: { key: keyof Permissions; label: string; description: string }[] = [
  {
    key: 'can_assign_conversations',
    label: 'Asignar conversaciones',
    description: 'Puede auto-asignarse y liberar conversaciones',
  },
  {
    key: 'can_access_settings',
    label: 'Acceder a Configuración',
    description: 'Puede ver y editar la configuración del tenant',
  },
  {
    key: 'can_create_properties',
    label: 'Crear propiedades',
    description: 'Puede crear y editar propiedades',
  },
  {
    key: 'can_confirm_reservations',
    label: 'Confirmar reservas',
    description: 'Puede confirmar y gestionar reservas',
  },
]

interface ReceptionistPermissionsDialogProps {
  user: TenantUserWithWorkspaceIds | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ReceptionistPermissionsDialog({
  user,
  open,
  onOpenChange,
}: ReceptionistPermissionsDialogProps) {
  const [isPending, startTransition] = useTransition()
  const [perms, setPerms] = useState<Permissions>({
    can_assign_conversations: false,
    can_access_settings: false,
    can_create_properties: false,
    can_confirm_reservations: true,
  })

  // Sync local state when user changes
  const [syncedUserId, setSyncedUserId] = useState<string | null>(null)
  if (user && user.id !== syncedUserId) {
    setSyncedUserId(user.id)
    setPerms({
      can_assign_conversations: user.can_assign_conversations,
      can_access_settings: user.can_access_settings,
      can_create_properties: user.can_create_properties,
      can_confirm_reservations: user.can_confirm_reservations,
    })
  }

  if (!user) return null

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
          {PERMISSION_FIELDS.map(({ key, label, description }) => (
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
