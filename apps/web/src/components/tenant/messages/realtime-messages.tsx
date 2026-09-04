'use client'

import { useEffect, useState, useMemo, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { MessageRow, TenantUserRow } from '@orderflow/types'
import { createClient } from '@orderflow/supabase/browser'
import { getConversationPaymentProofsAction, type ConversationProofInfo } from '@/actions/documents'
import type { OutboundTrackingInfo } from '@/lib/outbound-status'
import { MessageList } from './message-list'

interface RealtimeMessagesProps {
  messages:            MessageRow[]
  setMessages:         React.Dispatch<React.SetStateAction<MessageRow[]>>
  conversationId:      string
  currentUserId:       string
  contact?:            { name: string | null; phone: string | null } | null
  tenantUsers?:        TenantUserRow[]
  outboundTrackingMap?: Map<string, OutboundTrackingInfo>
}

export function RealtimeMessages({
  messages,
  setMessages,
  conversationId,
  currentUserId,
  contact,
  tenantUsers,
  outboundTrackingMap,
}: RealtimeMessagesProps) {
  const router = useRouter()
  const [, startTransition] = useTransition()

  const [savedProofMap, setSavedProofMap] = useState<Map<string, ConversationProofInfo>>(new Map())

  const senderMap = useMemo(() => {
    const map = new Map<string, { name: string; role: string }>()
    for (const u of tenantUsers ?? []) {
      map.set(u.id, { name: u.name, role: u.role })
    }
    return map
  }, [tenantUsers])

  // Load payment proof info for this conversation so previously-saved comprobantes
  // render as "Comprobante guardado" without a page refresh.
  useEffect(() => {
    getConversationPaymentProofsAction(conversationId).then((res) => {
      if (res.success && res.data && res.data.length > 0) {
        const map = new Map<string, ConversationProofInfo>()
        for (const info of res.data) {
          map.set(info.storagePath, info)
        }
        setSavedProofMap(map)
      }
    })
  }, [conversationId])

  useEffect(() => {
    const supabase = createClient()
    const DEV = process.env.NODE_ENV === 'development'

    const instanceId = Math.random().toString(36).slice(2, 7)

    if (DEV) {
      console.log('[realtime:messages] MOUNT', { instanceId, conversationId })
    }

    let destroyed    = false
    let retryCount   = 0
    let retryTimer:     ReturnType<typeof setTimeout> | null = null
    let currentChannel: ReturnType<typeof supabase.channel> | null = null

    function createAndSubscribe(): void {
      const ch = supabase
        .channel(`messages:conv:${conversationId}`)

        // ── INSERT ─────────────────────────────────────────────────────────────
        .on(
          'postgres_changes',
          {
            event:  'INSERT',
            schema: 'public',
            table:  'messages',
            filter: `conversation_id=eq.${conversationId}`,
          },
          (payload) => {
            const incoming = payload.new as MessageRow
            if (DEV) {
              console.log('[realtime:messages] INSERT received', {
                instanceId,
                id:     incoming.id,
                sender: incoming.sender_type,
              })
            }
            setMessages((prev) => {
              // Standard dedup — message already in state (e.g. confirmed via onSendConfirmed)
              if (prev.some((m) => m.id === incoming.id)) {
                if (DEV) console.log('[realtime:messages] ignored duplicate', incoming.id)
                return prev
              }
              // Reconcile any matching optimistic message (temp_ prefix, same sender+content+time)
              const incAt    = new Date(incoming.created_at).getTime()
              const matchIdx = prev.findIndex(
                (m) =>
                  m.id.startsWith('temp_') &&
                  m.sender_id === incoming.sender_id &&
                  m.content  === incoming.content &&
                  Math.abs(new Date(m.created_at).getTime() - incAt) < 30_000,
              )
              if (matchIdx >= 0) {
                const next = [...prev]
                // Preserve localPreviewUrl from the optimistic message so the
                // audio/image player stays visible while the upload is in progress.
                const optimisticMeta = (prev[matchIdx]!.metadata as Record<string, unknown> | null) ?? {}
                const localPreviewUrl = optimisticMeta['localPreviewUrl'] as string | undefined
                next[matchIdx] = localPreviewUrl
                  ? {
                      ...incoming,
                      metadata: {
                        ...(incoming.metadata as object | null ?? {}),
                        localPreviewUrl,
                      } as never,
                    }
                  : incoming
                return next
              }
              return [...prev, incoming]
            })
          },
        )

        // ── UPDATE ─────────────────────────────────────────────────────────────
        .on(
          'postgres_changes',
          {
            event:  'UPDATE',
            schema: 'public',
            table:  'messages',
            filter: `conversation_id=eq.${conversationId}`,
          },
          (payload) => {
            const updated = payload.new as MessageRow
            if (DEV) {
              console.log('[realtime:messages] UPDATE received', { instanceId, id: updated.id })
            }
            setMessages((prev) =>
              prev.map((m) => {
                if (m.id !== updated.id) return m
                // If the DB row already has media_storage_path, use it directly —
                // no need for a local preview URL anymore.
                if (updated.media_storage_path) return updated
                // Otherwise preserve localPreviewUrl from the in-memory message so
                // the image/audio player stays visible while the upload is in progress.
                const existingMeta    = (m.metadata as Record<string, unknown> | null) ?? {}
                const localPreviewUrl = existingMeta['localPreviewUrl'] as string | undefined
                if (!localPreviewUrl) return updated
                const updatedMeta = (updated.metadata as Record<string, unknown> | null) ?? {}
                return {
                  ...updated,
                  metadata: { ...updatedMeta, localPreviewUrl } as never,
                }
              }),
            )
          },
        )

        // ── DELETE ─────────────────────────────────────────────────────────────
        .on(
          'postgres_changes',
          {
            event:  'DELETE',
            schema: 'public',
            table:  'messages',
            filter: `conversation_id=eq.${conversationId}`,
          },
          (payload) => {
            const deleted = payload.old as { id: string }
            if (DEV) {
              console.log('[realtime:messages] DELETE received', { instanceId, id: deleted.id })
            }
            setMessages((prev) => prev.filter((m) => m.id !== deleted.id))
          },
        )

        .subscribe((status) => {
          if (DEV) {
            console.log('[realtime:messages] channel status:', status, {
              instanceId,
              conversationId,
              retryCount,
            })
          }

          // On reconnect, refresh to recover any missed INSERTs.
          // The parent's sync-key merge effect will reconcile the server snapshot
          // with any locally-held messages to avoid a flash of missing content.
          if (status === 'SUBSCRIBED' && retryCount > 0) {
            if (DEV) {
              console.log('[realtime:messages] reconnected — refreshing to recover missed events', {
                instanceId,
                retryCount,
              })
            }
            startTransition(() => router.refresh())
          }

          if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            if (destroyed) return

            const delay = Math.min(1_000 * 2 ** retryCount, 30_000)

            if (DEV) {
              console.warn('[realtime:messages] channel failed, retrying in', delay, 'ms', {
                status,
                retryCount,
                instanceId,
              })
            }

            void supabase.removeChannel(ch)
            currentChannel = null

            if (retryTimer) clearTimeout(retryTimer)
            retryCount++
            retryTimer = setTimeout(() => {
              retryTimer = null
              if (!destroyed) createAndSubscribe()
            }, delay)
          }
        })

      currentChannel = ch
    }

    createAndSubscribe()

    return () => {
      if (DEV) console.log('[realtime:messages] CLEANUP', { instanceId, conversationId })
      destroyed = true
      if (retryTimer) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
      if (currentChannel) {
        void supabase.removeChannel(currentChannel)
        currentChannel = null
      }
    }
  }, [conversationId, router, startTransition, setMessages])

  return (
    <MessageList
      messages={messages}
      currentUserId={currentUserId}
      contact={contact}
      senderMap={senderMap}
      savedProofMap={savedProofMap}
      outboundTrackingMap={outboundTrackingMap}
    />
  )
}
