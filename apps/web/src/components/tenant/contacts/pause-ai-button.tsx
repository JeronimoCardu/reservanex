'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { LoaderIcon, PauseCircleIcon } from 'lucide-react'
import { pauseConversationAiAction } from '@/actions/conversations'

// MVP P0-B — "Pausar IA": la persona toma la conversación para responder desde
// WhatsApp Business sin que la IA conteste encima. No manda nada al cliente.
// Se vuelve a la IA con "Marcar como atendido" en Atención humana.
export function PauseAiButton({ conversationId }: { conversationId: string }) {
  const [isPending, startTransition] = useTransition()
  const router = useRouter()

  function pause() {
    startTransition(async () => {
      const r = await pauseConversationAiAction(conversationId)
      if (!r.success) { toast.error(r.error); return }
      toast.success(
        r.data?.alreadyPaused
          ? 'Esta conversación ya la estaba atendiendo una persona.'
          : 'IA en pausa. Atendé por WhatsApp y, cuando termines, marcala como atendida en Atención humana.',
      )
      router.refresh()
    })
  }

  return (
    <button
      type="button"
      onClick={pause}
      disabled={isPending}
      title="La IA deja de responder esta conversación hasta que la marques como atendida."
      className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium text-foreground hover:bg-muted disabled:opacity-50"
    >
      {isPending ? <LoaderIcon className="h-3 w-3 animate-spin" /> : <PauseCircleIcon className="h-3 w-3" />}
      Pausar IA
    </button>
  )
}
