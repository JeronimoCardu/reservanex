'use client'

import { useTransition, useState } from 'react'
import { toast } from 'sonner'
import { UserCheckIcon } from 'lucide-react'
import { assignConversationAction } from '@/actions/conversations'
import type { ConversationRow, TenantUserRow, TenantRole } from '@orderflow/types'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

interface AssignConversationDialogProps {
  conversation:           ConversationRow
  tenantUsers:            TenantUserRow[]
  currentRole:            TenantRole
  currentUserId:          string
  canAssignConversations: boolean
}

export function AssignConversationDialog({
  conversation,
  tenantUsers,
  currentRole,
  currentUserId,
  canAssignConversations,
}: AssignConversationDialogProps) {
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<string>(conversation.assigned_user_id ?? '_none')
  const [isPending, startTransition] = useTransition()

  const isUnassigned = conversation.assigned_user_id === null
  const isMine       = conversation.assigned_user_id === currentUserId

  // Receptionist: ocultar si no tiene permiso o si la conversación es de otro
  if (currentRole === 'receptionist') {
    if (!canAssignConversations) return null
    if (!isUnassigned && !isMine) return null
  }

  function handleSave() {
    const userId = selected === '_none' ? null : selected
    startTransition(async () => {
      const result = await assignConversationAction(conversation.id, userId)
      if (result.success) {
        toast.success('Conversación reasignada')
        setOpen(false)
        // Realtime conversations UPDATE will reflect the new assigned_user_id
      } else {
        toast.error(result.error)
      }
    })
  }

  // Receptionist: botón simple "Tomar" o "Liberar"
  if (currentRole === 'receptionist') {
    if (isUnassigned) {
      return (
        <Button
          size="sm"
          variant="outline"
          disabled={isPending}
          onClick={() => {
            startTransition(async () => {
              const result = await assignConversationAction(conversation.id, currentUserId)
              if (result.success) {
                toast.success('Conversación tomada')
                // Realtime will deliver the conversation UPDATE
              } else {
                toast.error(result.error)
              }
            })
          }}
        >
          {isPending ? 'Tomando...' : 'Tomar'}
        </Button>
      )
    }
    if (isMine) {
      return (
        <Button
          size="sm"
          variant="ghost"
          disabled={isPending}
          onClick={() => {
            startTransition(async () => {
              const result = await assignConversationAction(conversation.id, null)
              if (result.success) {
                toast.success('Te desasignaste de la conversación')
                // Realtime will deliver the conversation UPDATE
              } else {
                toast.error(result.error)
              }
            })
          }}
        >
          {isPending ? 'Liberando...' : 'Liberar'}
        </Button>
      )
    }
    return null
  }

  // Owner: dialog completo con select
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          <UserCheckIcon className="mr-2 h-4 w-4" />
          Asignar
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Asignar conversación</DialogTitle>
        </DialogHeader>
        <Select value={selected} onValueChange={setSelected}>
          <SelectTrigger>
            <SelectValue placeholder="Seleccioná un agente" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="_none">Sin asignar</SelectItem>
            {tenantUsers.map((u) => (
              <SelectItem key={u.id} value={u.id}>
                {u.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setOpen(false)} disabled={isPending}>
            Cancelar
          </Button>
          <Button onClick={handleSave} disabled={isPending}>
            {isPending ? 'Guardando...' : 'Guardar'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
