'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { BotIcon, UserIcon, RefreshCwIcon } from 'lucide-react'
import { setAiModeAction, reactivateConversationAiAction } from '@/actions/conversations'
import type { ConversationRow, TenantRole } from '@orderflow/types'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

// MVP exposes only manual and autonomous.
// 'assisted' is a deprecated legacy DB enum value — any row with ai_mode='assisted'
// is displayed as 'manual' until the data migration (20260709000002) runs.
type ActiveMode = 'manual' | 'autonomous'

interface AiModeDisplayProps {
  conversation: ConversationRow
  currentRole:  TenantRole
}

export function AiModeDisplay({ conversation, currentRole }: AiModeDisplayProps) {
  const [isPending,    startTransition]    = useTransition()
  const [isReactivating, startReactivate] = useTransition()
  const [confirmOpen,  setConfirmOpen]    = useState(false)

  const rawMode     = conversation.ai_mode ?? 'manual'
  const currentMode: ActiveMode = rawMode === 'autonomous' ? 'autonomous' : 'manual'

  const count = conversation.ai_auto_replies_count ?? 0
  const limit = conversation.ai_auto_replies_limit ?? 10

  const handoffReason  = conversation.ai_handoff_reason ?? null
  const isAutoLimit    = handoffReason === 'auto_reply_limit'

  const canReactivate  = currentRole === 'owner' || currentRole === 'receptionist'

  function handleSetManual() {
    startTransition(async () => {
      const result = await setAiModeAction(conversation.id, { mode: 'manual' })
      if (!result.success) toast.error(result.error)
    })
  }

  function handleReactivate() {
    startReactivate(async () => {
      setConfirmOpen(false)
      const result = await reactivateConversationAiAction(conversation.id)
      if (result.success) {
        toast.success(result.warning ?? 'IA reactivada.')
      } else {
        toast.error(result.error)
      }
    })
  }

  if (currentMode === 'autonomous') {
    return (
      <div className="flex items-center gap-2 flex-wrap">
        {/* Badge: IA activa (clickable dropdown to switch to manual) */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              disabled={isPending}
              className="h-6 rounded-full border px-2.5 text-[11px] font-medium shadow-none bg-green-50 text-green-700 border-green-200 dark:bg-green-950/60 dark:text-green-400 dark:border-green-800"
            >
              <BotIcon className="h-3 w-3 mr-1" />
              {isPending ? '…' : 'IA activa'}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="z-50 w-52 bg-background text-foreground border shadow-md">
            <p className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
              Modo IA
            </p>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={handleSetManual}
              disabled={isPending}
              className="flex flex-col items-start gap-0"
            >
              <span className="font-medium">Tomar control</span>
              <span className="text-xs text-muted-foreground">Silenciar IA — el agente responde</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Counter */}
        <span className="text-[10px] text-muted-foreground tabular-nums">
          {count}/{limit} respuestas usadas
        </span>
      </div>
    )
  }

  // Manual mode
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {/* Badge: Control humano */}
      <span className="inline-flex items-center gap-1 h-6 rounded-full border border-slate-200 bg-slate-100 px-2.5 text-[11px] font-medium text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
        <UserIcon className="h-3 w-3" />
        Control humano
      </span>

      {/* Handoff reason */}
      {isAutoLimit && (
        <span className="text-[10px] text-amber-600 dark:text-amber-400">
          Límite de ciclo alcanzado
        </span>
      )}

      {/* Reactivate button — owner and receptionist only */}
      {canReactivate && (
        <>
          <Button
            variant="outline"
            size="sm"
            disabled={isReactivating}
            onClick={() => setConfirmOpen(true)}
            className="h-6 rounded-full border px-2.5 text-[11px] font-medium shadow-none border-blue-200 text-blue-700 bg-blue-50 hover:bg-blue-100 dark:border-blue-800 dark:text-blue-400 dark:bg-blue-950/40 dark:hover:bg-blue-950/60"
          >
            <RefreshCwIcon className="h-3 w-3 mr-1" />
            {isReactivating ? '…' : 'Reactivar IA'}
          </Button>

          <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>¿Reactivar la IA?</AlertDialogTitle>
                <AlertDialogDescription>
                  La IA volverá a responder automáticamente los próximos mensajes del cliente.
                  El contador se reiniciará a 0.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={isReactivating}>Cancelar</AlertDialogCancel>
                <AlertDialogAction onClick={handleReactivate} disabled={isReactivating}>
                  Reactivar IA
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}
    </div>
  )
}
