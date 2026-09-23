'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { CheckIcon, HeadsetIcon, MessageCircleIcon, PhoneIcon } from 'lucide-react'
import { markHumanAttentionAttendedAction } from '@/actions/conversations'
import type { HumanAttentionRow } from '@/lib/repositories/conversations.repository'
import { buildContactWhatsAppHref } from '@/lib/human-attention/contact-whatsapp-href'
import { channelLabel, humanAttentionReasonLabel } from '@/lib/human-attention/semantics'
import { ClientTimeAgo } from '@/components/tenant/shared/client-time-ago'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

// ════════════════════════════════════════════════════════════════════════════
// Una card por cliente, mobile-first. Dos acciones y nada más:
//
//   Abrir WhatsApp        → wa.me del contacto (la atención pasa ahí)
//   Marcar como atendido  → cierra el ciclo y la IA retoma
//
// Sin burbujas, sin historial, sin input. El "último mensaje" es el snapshot
// que ya vive en la fila (last_message_*), no una lectura de messages.
// ════════════════════════════════════════════════════════════════════════════

interface AttentionListProps {
  items:         HumanAttentionRow[]
  currentUserId: string
}

export function AttentionList({ items, currentUserId }: AttentionListProps) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [busyId, setBusyId]        = useState<string | null>(null)
  // Optimista: la card desaparece al confirmar; si la acción falla, vuelve.
  const [hidden, setHidden]        = useState<Set<string>>(() => new Set())

  const visible = items.filter((i) => !hidden.has(i.id))

  function markAttended(id: string) {
    setBusyId(id)
    startTransition(async () => {
      const res = await markHumanAttentionAttendedAction(id)
      setBusyId(null)
      if (res.success) {
        setHidden((prev) => new Set(prev).add(id))
        toast.success('Marcado como atendido. El asistente vuelve a responder a este cliente.')
        router.refresh()
        return
      }
      toast.error(res.error ?? 'No se pudo marcar como atendido.')
      router.refresh()
    })
  }

  if (visible.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6 py-20 text-center">
        <HeadsetIcon className="mb-3 h-10 w-10 text-muted-foreground/30" />
        <p className="text-sm font-medium text-foreground">No hay clientes esperando atención humana.</p>
        <p className="mt-1.5 max-w-[280px] text-xs leading-relaxed text-muted-foreground">
          Cuando un cliente pida hablar con una persona, o el asistente derive la conversación, aparece acá.
        </p>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <ul className="mx-auto flex max-w-2xl flex-col gap-3 px-4 py-4 sm:px-6">
        {visible.map((item) => {
          const name    = item.contact?.name?.trim() || null
          const phone   = item.contact?.phone ?? null
          const title   = name ?? phone ?? 'Contacto'
          const waHref  = buildContactWhatsAppHref(phone)
          const since   = item.human_attention_requested_at ?? item.last_message_at
          const isMine  = item.assigned_user_id === currentUserId
          const busy    = pending && busyId === item.id
          const lastMsg = item.last_message_content?.trim() || null
          const lastBy  = item.last_message_sender_type

          return (
            <li
              key={item.id}
              className="rounded-xl border border-amber-200/70 bg-card p-4 shadow-sm dark:border-amber-900/50"
            >
              {/* Cabecera: quién + desde cuándo */}
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-base font-semibold leading-tight">{title}</p>
                  {name && phone && (
                    <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                      <PhoneIcon className="h-3 w-3" /> {phone}
                    </p>
                  )}
                </div>
                <div className="shrink-0 text-right text-xs text-muted-foreground">
                  {since ? (
                    <>
                      <span className="block">Esperando</span>
                      <ClientTimeAgo date={since} className="font-medium text-foreground" />
                    </>
                  ) : (
                    <span>Pendiente</span>
                  )}
                </div>
              </div>

              {/* Motivo */}
              <p className="mt-3 text-sm font-medium text-amber-800 dark:text-amber-300">
                {humanAttentionReasonLabel(item.ai_handoff_reason)}
              </p>

              {/* Último mensaje (snapshot) */}
              {lastMsg && (
                <blockquote className="mt-2 rounded-lg bg-muted/60 px-3 py-2 text-sm text-foreground/90">
                  <span className="mr-1 text-xs uppercase tracking-wide text-muted-foreground">
                    {lastBy === 'customer' ? 'Cliente' : lastBy === 'ai' ? 'Asistente' : 'Agente'}
                  </span>
                  «{lastMsg.length > 160 ? `${lastMsg.slice(0, 160)}…` : lastMsg}»
                </blockquote>
              )}

              {/* Estado informativo */}
              <p className="mt-2 text-xs text-muted-foreground">
                {channelLabel(item.channel)}
                {' · '}
                {item.ai_mode === 'autonomous'
                  ? 'El asistente volvió a responder, pero nadie marcó esta atención como atendida.'
                  : 'El asistente está en pausa para este cliente.'}
                {isMine && ' · Asignado a vos'}
              </p>

              {/* Acciones */}
              <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                {waHref ? (
                  <Button asChild className="w-full sm:w-auto" variant="default">
                    <a href={waHref} target="_blank" rel="noopener noreferrer">
                      <MessageCircleIcon className="h-4 w-4" />
                      Abrir WhatsApp
                    </a>
                  </Button>
                ) : (
                  <Button className="w-full sm:w-auto" variant="default" disabled title="Este contacto no tiene un teléfono válido">
                    <MessageCircleIcon className="h-4 w-4" />
                    Sin teléfono
                  </Button>
                )}
                <Button
                  variant="outline"
                  className={cn('w-full sm:w-auto', busy && 'opacity-70')}
                  disabled={busy}
                  onClick={() => markAttended(item.id)}
                >
                  <CheckIcon className="h-4 w-4" />
                  {busy ? 'Marcando…' : 'Marcar como atendido'}
                </Button>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
