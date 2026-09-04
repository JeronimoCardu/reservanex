'use client'

import { useEffect, useRef } from 'react'
import type { MessageRow } from '@orderflow/types'
import type { ConversationProofInfo } from '@/actions/documents'
import type { OutboundTrackingInfo } from '@/lib/outbound-status'
import { MessageBubble } from './message-bubble'

type SenderInfo = { name: string; role: string }

interface MessageListProps {
  messages:             MessageRow[]
  currentUserId:        string
  contact?:             { name: string | null; phone: string | null } | null
  senderMap?:           Map<string, SenderInfo>
  savedProofMap?:       Map<string, ConversationProofInfo>
  outboundTrackingMap?: Map<string, OutboundTrackingInfo>
}

export function MessageList({ messages, currentUserId, contact, senderMap, savedProofMap, outboundTrackingMap }: MessageListProps) {
  const containerRef  = useRef<HTMLDivElement>(null)
  const bottomRef     = useRef<HTMLDivElement>(null)
  const isFirstRender = useRef(true)

  useEffect(() => {
    const bottom = bottomRef.current
    if (!bottom) return

    if (isFirstRender.current) {
      isFirstRender.current = false
      // Instant jump on initial load — no visible scroll animation.
      bottom.scrollIntoView({ behavior: 'instant' })
      return
    }

    // Check if the last message is the user's own (optimistic send or confirmed send).
    // Always scroll for own messages; for others scroll only when near the bottom.
    const lastMsg  = messages[messages.length - 1]
    const lastIsMe = lastMsg?.sender_type === 'human' && lastMsg?.sender_id === currentUserId

    if (lastIsMe) {
      bottom.scrollIntoView({ behavior: 'smooth' })
      return
    }

    const container = containerRef.current
    if (container) {
      const distFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight
      if (distFromBottom < 200) {
        bottom.scrollIntoView({ behavior: 'smooth' })
      }
    }
  }, [messages.length, currentUserId])

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        No hay mensajes todavía
      </div>
    )
  }

  return (
    <div ref={containerRef} className="flex flex-1 flex-col gap-2 overflow-y-auto p-4">
      {messages.map((msg) => (
        <MessageBubble
          key={msg.id}
          message={msg}
          currentUserId={currentUserId}
          contact={contact}
          senderMap={senderMap}
          savedProofMap={savedProofMap}
          outboundTrackingMap={outboundTrackingMap}
        />
      ))}
      <div ref={bottomRef} />
    </div>
  )
}
