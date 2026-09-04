'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { XCircleIcon, RotateCcwIcon, AlertTriangleIcon } from 'lucide-react'
import { closeConversationAction, reopenConversationAction } from '@/actions/conversations'
import type { ConversationRow } from '@orderflow/types'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'

export function CloseConversationDialog({
  conversation,
}: {
  conversation: ConversationRow
}) {
  const [open, setOpen]                    = useState(false)
  const [isPending, startTransition]       = useTransition()
  const [pendingAction, setPendingAction]  = useState<'keep' | 'reactivate' | null>(null)

  const isClosed = conversation.status === 'closed'
  const isManual = conversation.ai_mode === 'manual'

  function handleReopen() {
    startTransition(async () => {
      const result = await reopenConversationAction(conversation.id)
      if (result.success) {
        toast.success('Conversación reabierta')
        // ConversationDetailLayout and RealtimeConversationList subscribe to
        // conversations UPDATE — they will reflect the new status via Realtime.
      } else {
        toast.error(result.error)
      }
    })
  }

  function handleClose(reactivateAi: boolean) {
    setPendingAction(reactivateAi ? 'reactivate' : 'keep')
    startTransition(async () => {
      const result = await closeConversationAction(conversation.id, { reactivateAi })
      setPendingAction(null)
      if (result.success) {
        toast.success(
          reactivateAi
            ? 'Conversación cerrada. La IA está activada para cuando el cliente vuelva.'
            : 'Conversación cerrada.',
        )
        setOpen(false)
      } else {
        toast.error(result.error ?? 'Error al cerrar la conversación.')
      }
    })
  }

  // Reopen: simple button, no dialog needed
  if (isClosed) {
    return (
      <Button variant="outline" size="sm" disabled={isPending} onClick={handleReopen}>
        <RotateCcwIcon className="mr-2 h-4 w-4" />
        {isPending ? 'Reabriendo...' : 'Reabrir'}
      </Button>
    )
  }

  return (
    <AlertDialog open={open} onOpenChange={(o) => !isPending && setOpen(o)}>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm">
          <XCircleIcon className="mr-2 h-4 w-4" />
          Cerrar
        </Button>
      </AlertDialogTrigger>

      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Cerrar conversación</AlertDialogTitle>
          <AlertDialogDescription>
            {isManual
              ? 'Revisá el modo de atención antes de cerrar.'
              : 'La conversación pasará a estado cerrado. Ya no se podrán enviar mensajes hasta reabrirla.'}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {/* Warning block — only shown when ai_mode is 'manual' */}
        {isManual && (
          <div className="flex gap-2.5 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-300">
            <AlertTriangleIcon className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              Esta conversación está en modo{' '}
              <span className="font-semibold">Humano</span>. Si la cerrás así, cuando el
              cliente vuelva a escribir se reabrirá en modo Humano y la IA no responderá
              automáticamente.
            </p>
          </div>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancelar</AlertDialogCancel>

          {isManual ? (
            <>
              {/* Secondary: keep manual mode — explicit downgrade choice */}
              <Button
                variant="outline"
                disabled={isPending}
                onClick={() => handleClose(false)}
              >
                {isPending && pendingAction === 'keep'
                  ? 'Cerrando...'
                  : 'Cerrar en modo Humano'}
              </Button>

              {/* Primary recommended: reactivate IA before closing */}
              <Button
                disabled={isPending}
                onClick={() => handleClose(true)}
              >
                {isPending && pendingAction === 'reactivate'
                  ? 'Cerrando...'
                  : 'Cerrar y activar IA'}
              </Button>
            </>
          ) : (
            <Button disabled={isPending} onClick={() => handleClose(false)}>
              {isPending ? 'Cerrando...' : 'Cerrar'}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
