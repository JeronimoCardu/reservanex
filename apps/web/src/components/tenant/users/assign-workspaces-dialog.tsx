'use client'

import { useEffect, useState, useTransition } from 'react'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'
import type { WorkspaceRow } from '@orderflow/types'
import type { TenantUserWithWorkspaceIds } from '@/lib/repositories/users.repository'
import { assignWorkspacesAction } from '@/actions/users'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

interface AssignWorkspacesDialogProps {
  user: TenantUserWithWorkspaceIds | null
  workspaces: WorkspaceRow[]
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function AssignWorkspacesDialog({
  user,
  workspaces,
  open,
  onOpenChange,
}: AssignWorkspacesDialogProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [selectedIds, setSelectedIds] = useState<string[]>([])

  // [C2] Sync selection from user.workspaceIds whenever the dialog opens or the
  // target user changes. Cannot rely on onOpenChange(true) — Radix does not call
  // it when open is set externally by the parent.
  useEffect(() => {
    if (open && user) {
      setSelectedIds(user.workspaceIds)
    }
  }, [open, user])

  const activeWorkspaces = workspaces.filter((w) => w.active)

  if (!user) return null

  function handleOpenChange(nextOpen: boolean) {
    onOpenChange(nextOpen)
  }

  function toggle(id: string, checked: boolean) {
    setSelectedIds((prev) => (checked ? [...prev, id] : prev.filter((x) => x !== id)))
  }

  function handleSave() {
    startTransition(async () => {
      const result = await assignWorkspacesAction(user!.id, { workspaceIds: selectedIds })
      if (result.success) {
        toast.success('Workspaces asignados correctamente')
        onOpenChange(false)
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Asignar Workspaces</DialogTitle>
          <DialogDescription>
            Seleccioná los workspaces para &quot;{user.name}&quot;.
          </DialogDescription>
        </DialogHeader>

        {activeWorkspaces.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            No hay workspaces activos disponibles.
          </p>
        ) : (
          <div className="max-h-64 overflow-y-auto rounded-md border p-3 space-y-2">
            {activeWorkspaces.map((w) => (
              <label
                key={w.id}
                className="flex items-center gap-2 text-sm cursor-pointer select-none py-0.5"
              >
                <input
                  type="checkbox"
                  checked={selectedIds.includes(w.id)}
                  onChange={(e) => toggle(w.id, e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300"
                  disabled={isPending}
                />
                <span>{w.name}</span>
              </label>
            ))}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            Cancelar
          </Button>
          <Button onClick={handleSave} disabled={isPending || activeWorkspaces.length === 0}>
            {isPending ? 'Guardando...' : 'Guardar'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
