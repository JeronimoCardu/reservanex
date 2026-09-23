import Link from 'next/link'
import type { ConversationRow } from '@orderflow/types'
import { HeadsetIcon, MessageCircleIcon } from 'lucide-react'
import { ClientTimeAgo } from '@/components/tenant/shared/client-time-ago'
import { buildContactWhatsAppHref } from '@/lib/human-attention/contact-whatsapp-href'
import { channelLabel } from '@/lib/human-attention/semantics'
import { cn } from '@/lib/utils'

// ════════════════════════════════════════════════════════════════════════════
// Atención humana V2 — reemplaza a ConversationList en la ficha del contacto.
//
// La surface /dashboard/conversations ya no existe, así que acá no hay nada a
// dónde "entrar": cada conversación es una línea de estado (canal, IA, último
// mensaje, cuándo) y las dos salidas reales son WhatsApp y, si el cliente está
// esperando una persona, la bandeja de Atención humana. Sin historial, sin
// input: ReservaNex no es un inbox.
// ════════════════════════════════════════════════════════════════════════════

const aiModeBadge: Record<string, { label: string; className: string }> = {
  autonomous: { label: 'IA activa',   className: 'bg-green-50 text-green-700 border-green-200 dark:bg-green-950 dark:text-green-400 dark:border-green-900'  },
  manual:     { label: 'IA en pausa', className: 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700' },
  assisted:   { label: 'IA en pausa', className: 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700' },
}

const senderPrefix: Record<string, string> = {
  customer: 'Cliente',
  ai:       'Asistente',
  human:    'Agente',
}

interface ContactConversationsProps {
  conversations: ConversationRow[]
  contactPhone:  string | null
}

export function ContactConversations({ conversations, contactPhone }: ContactConversationsProps) {
  const waHref = buildContactWhatsAppHref(contactPhone)

  return (
    <div className="space-y-3">
      {waHref && (
        <a
          href={waHref}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted"
        >
          <MessageCircleIcon className="h-4 w-4" />
          Abrir WhatsApp
        </a>
      )}

      <ul className="divide-y rounded-lg border">
        {conversations.map((conv) => {
          const mode     = conv.ai_mode ? aiModeBadge[conv.ai_mode] : undefined
          const pending  = conv.human_attention_pending === true
          const preview  = conv.last_message_content
            ? `${senderPrefix[conv.last_message_sender_type ?? ''] ?? 'Mensaje'}: ${conv.last_message_content.slice(0, 120)}`
            : null

          return (
            <li key={conv.id} className={cn('px-4 py-3', conv.status === 'closed' && 'opacity-60')}>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-medium text-foreground">{channelLabel(conv.channel)}</span>
                <span className="text-muted-foreground">·</span>
                <span className="text-muted-foreground">{conv.status === 'closed' ? 'Cerrada' : 'Abierta'}</span>
                {mode && (
                  <span className={cn('rounded-full border px-2 py-0.5 text-[11px] font-medium', mode.className)}>
                    {mode.label}
                  </span>
                )}
                {pending && (
                  <Link
                    href="/dashboard/attention"
                    className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800 hover:bg-amber-100 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300"
                  >
                    <HeadsetIcon className="h-3 w-3" /> Esperando una persona
                  </Link>
                )}
                {conv.last_message_at && (
                  <ClientTimeAgo date={conv.last_message_at} className="ml-auto text-muted-foreground" />
                )}
              </div>
              {preview && (
                <p className="mt-1.5 truncate text-sm text-muted-foreground">{preview}</p>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
