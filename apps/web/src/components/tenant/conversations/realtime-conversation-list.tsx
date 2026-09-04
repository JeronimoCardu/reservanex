'use client'

import { useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@orderflow/supabase/browser'
import type { ConversationRow, TenantUserRow } from '@orderflow/types'
import { ConversationList } from './conversation-list'

type ConversationWithContact = ConversationRow & {
  contact?: { name: string | null; phone: string | null } | null
}

// Sort key: most-recent message timestamp from the scalar snapshot column,
// falling back to updated_at. Using last_message_at ensures conversations
// rise immediately when the conversations UPDATE event arrives from the trigger.
function getActivityAt(conv: ConversationWithContact): number {
  return conv.last_message_at
    ? new Date(conv.last_message_at).getTime()
    : new Date(conv.updated_at).getTime()
}

function sortByActivity(convs: ConversationWithContact[]): ConversationWithContact[] {
  return [...convs].sort((a, b) => getActivityAt(b) - getActivityAt(a))
}

interface RealtimeConversationListProps {
  // ALL conversations for this tenant (unfiltered) — filtering by status/search/assign
  // happens here so Realtime updates are not missed for conversations that are
  // temporarily excluded by the parent filter state.
  conversations:    ConversationWithContact[]
  tenantId:         string
  // Filters owned by the split-pane parent — applied locally after Realtime merges
  statusFilter:     'all' | 'open' | 'closed'
  assignFilter:     'all' | 'unassigned' | 'mine' | 'assigned'
  search:           string
  operationFilter:  'all' | 'sale' | 'long_term_rental' | 'temporary_rental' | 'unknown'
  leadStatusFilter: 'all' | 'new' | 'contacted' | 'interested' | 'visit_scheduled' | 'discarded' | 'converted' | 'closed'
  currentUserId:    string
  tenantUsers:      TenantUserRow[]
  // Operational badges — loaded once per page, refreshed on router.refresh()
  failedReceiptConvIds?:  Set<string>
  pendingPaymentConvIds?: Set<string>
}

export function RealtimeConversationList({
  conversations: initialConversations,
  tenantId,
  statusFilter,
  assignFilter,
  search,
  operationFilter,
  leadStatusFilter,
  currentUserId,
  tenantUsers,
  failedReceiptConvIds,
  pendingPaymentConvIds,
}: RealtimeConversationListProps) {
  const router = useRouter()
  const [, startTransition] = useTransition()

  // ALL conversations in local state (unfiltered).
  // Realtime events always operate on the full set so updates to
  // any conversation are never silently dropped by a status/search filter.
  const [allConversations, setAllConversations] = useState<ConversationWithContact[]>(
    () => sortByActivity(initialConversations),
  )

  // Per-conversation needs_human_attention overrides set by optimistic updates.
  // Cleared when the authoritative conversations UPDATE arrives from the DB.
  // Guards against router.refresh() returning a snapshot that races the DB trigger.
  const attentionOverrides = useRef<Map<string, boolean>>(new Map())

  // Debounced router.refresh() shared across all event handlers.
  const refreshDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Stable sync key — changes only when the server snapshot meaningfully changes
  // (conversation added/removed, or updated_at changed after a confirmed DB write).
  const syncKey = useMemo(
    () => initialConversations.map((c) => `${c.id}:${c.updated_at}`).join(','),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [initialConversations],
  )

  // MERGE — do NOT blindly replace. Preserve local contact enrichment and any
  // pending attention override so the badge survives a router.refresh() that
  // races the DB trigger.
  useEffect(() => {
    setAllConversations((localState) => {
      const localMap = new Map(localState.map((c) => [c.id, c]))
      const merged = initialConversations.map((serverConv) => {
        const local             = localMap.get(serverConv.id)
        const attentionOverride = attentionOverrides.current.get(serverConv.id)

        const base: ConversationWithContact = local
          ? {
              ...serverConv,
              contact: local.contact ?? serverConv.contact,
            }
          : serverConv

        return attentionOverride !== undefined
          ? { ...base, needs_human_attention: attentionOverride }
          : base
      })
      return sortByActivity(merged)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncKey])

  // Apply status + assignment + search filters on the live state
  const conversations = useMemo(() => {
    let result = allConversations
    if (statusFilter !== 'all') {
      result = result.filter((c) => c.status === statusFilter)
    }
    if (assignFilter !== 'all') {
      if (assignFilter === 'unassigned') {
        result = result.filter((c) => c.assigned_user_id === null)
      } else if (assignFilter === 'mine') {
        result = result.filter((c) => c.assigned_user_id === currentUserId)
      } else if (assignFilter === 'assigned') {
        result = result.filter((c) => c.assigned_user_id !== null)
      }
    }
    if (search) {
      const lower = search.toLowerCase()
      result = result.filter(
        (c) =>
          c.contact?.name?.toLowerCase().includes(lower) ||
          c.contact?.phone?.toLowerCase().includes(lower),
      )
    }
    if (operationFilter !== 'all') {
      result = result.filter((c) => (c.lead_operation_type ?? 'unknown') === operationFilter)
    }
    if (leadStatusFilter !== 'all') {
      result = result.filter((c) => (c.lead_status ?? 'new') === leadStatusFilter)
    }
    return result
  }, [allConversations, statusFilter, assignFilter, search, currentUserId, operationFilter, leadStatusFilter])

  useEffect(() => {
    const supabase = createClient()
    const DEV = process.env.NODE_ENV === 'development'

    // Random ID per effect run — in DEV, two simultaneous IDs means duplicate mounts
    // (e.g. React Strict Mode double-invoke, or ConversationSplitPane remounting).
    const instanceId = Math.random().toString(36).slice(2, 7)

    if (DEV) {
      console.log('[realtime:list] MOUNT', {
        instanceId,
        tenantId,
        initialCount: initialConversations.length,
      })
    }

    // Retry state — local to this effect instance, never shared across remounts
    let destroyed    = false
    let retryCount   = 0
    let retryTimer:     ReturnType<typeof setTimeout> | null = null
    let currentChannel: ReturnType<typeof supabase.channel> | null = null
    // DEV-only raw debug channel — separate from main so we can isolate whether
    // events arrive at all (no filters, no guards, just raw payloads).
    let debugChannel: ReturnType<typeof supabase.channel> | null = null

    // Deduplicated debounced refresh — avoids hammering on rapid event bursts
    function scheduleRefresh(): void {
      if (refreshDebounceRef.current) clearTimeout(refreshDebounceRef.current)
      refreshDebounceRef.current = setTimeout(() => {
        refreshDebounceRef.current = null
        startTransition(() => router.refresh())
      }, 300)
    }

    // ── WHY NO SERVER-SIDE COLUMN FILTER ─────────────────────────────────────
    // Supabase Realtime postgres_changes column filters require the column to be
    // in the table's REPLICA IDENTITY for UPDATE/DELETE events. We rely on:
    //   1. Row Level Security  — only rows the authenticated user can SELECT are
    //      delivered by Supabase Realtime.
    //   2. JS tenant_id guard  — defence-in-depth in each handler below.
    // ─────────────────────────────────────────────────────────────────────────

    function createAndSubscribe(): void {
      // ── PARTE D: auth session check (first attempt only) ─────────────────────
      if (DEV && retryCount === 0) {
        void supabase.auth.getSession().then(({ data: { session } }) => {
          console.log('[realtime:list] session', {
            instanceId,
            hasSession:  !!session,
            userId:      session?.user?.id,
            expiresAt:   session?.expires_at
              ? new Date(session.expires_at * 1000).toISOString()
              : null,
            tenantClaim: (session?.user?.app_metadata as Record<string, unknown> | undefined)
              ?.tenant_id ?? '⚠ MISSING',
          })
        })

        // ── PARTE C: minimal raw debug channel ──────────────────────────────────
        // Subscribes to ALL conversations + messages events with no guards.
        // Compare with main channel status to isolate connection vs. code issues:
        //   • debug SUBSCRIBED, main SUBSCRIBED, no [debug:raw] events
        //     → events not reaching server (trigger issue or wrong project)
        //   • debug SUBSCRIBED, [debug:raw] fires, main SUBSCRIBED but no UI update
        //     → filter/guard logic bug in this file
        //   • neither channel reaches SUBSCRIBED
        //     → auth/connectivity issue (check session above)
        debugChannel = supabase
          .channel(`dbg:${instanceId}`)
          .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'conversations' },
            (payload) => {
              const n = payload.new as Record<string, unknown>
              console.log('[debug:raw] conversations', payload.eventType, {
                id:                   n?.id ?? (payload.old as Record<string, unknown>)?.id,
                last_message_content: n?.last_message_content,   // KEY: null = Case A
                last_message_at:      n?.last_message_at,
                tenant_id:            n?.tenant_id,
                matchesTenant:        n?.tenant_id === tenantId,
              })
            },
          )
          .on(
            'postgres_changes',
            { event: 'INSERT', schema: 'public', table: 'messages' },
            (payload) => {
              console.log('[debug:raw] messages INSERT', {
                id:     (payload.new as Record<string, unknown>)?.id,
                conv:   (payload.new as Record<string, unknown>)?.conversation_id,
                tenant: (payload.new as Record<string, unknown>)?.tenant_id,
                matchesTenant: (payload.new as Record<string, unknown>)?.tenant_id === tenantId,
              })
            },
          )
          .subscribe((s) => console.log('[debug:raw] channel status', s, { instanceId }))
      }

      const ch = supabase
        .channel(`conv-list:${tenantId}`)

        // ── messages INSERT ───────────────────────────────────────────────────
        // Updates badge AND preview snapshot immediately (PARTE D fallback).
        //
        // Why optimistic preview here AND in conversations UPDATE:
        //   The DB trigger sets last_message_* and Realtime delivers it via
        //   conversations UPDATE. But depending on payload delivery timing or
        //   Supabase version, payload.new may arrive without all text columns.
        //   Updating preview here from the messages payload gives instant visual
        //   feedback; conversations UPDATE reconciles with the authoritative value.
        //
        // Badge logic (mirrors DB trigger in 20260709000001):
        //   customer in manual/assisted → needs_human_attention = true
        //   human reply                 → needs_human_attention = false
        //   ai message                  → preserve existing value (no change)
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'messages' },
          (payload) => {
            const msg = payload.new as {
              id:              string
              conversation_id: string
              tenant_id:       string
              content:         string
              content_type:    string
              sender_type:     string
              created_at:      string
            }

            if (DEV) {
              console.log('[realtime:list] messages INSERT', {
                instanceId,
                id:          msg.id,
                conv:        msg.conversation_id,
                sender:      msg.sender_type,
                content:     msg.content?.slice(0, 40),
                tenantMatch: msg.tenant_id === tenantId,
              })
            }

            if (msg.tenant_id !== tenantId) return

            setAllConversations((prev) => {
              const idx = prev.findIndex((c) => c.id === msg.conversation_id)
              if (idx === -1) {
                // Conversation not in local state — server round-trip needed
                if (DEV) {
                  console.log('[realtime:list] messages INSERT — conv not in state, scheduling refresh:', msg.conversation_id)
                }
                scheduleRefresh()
                return prev
              }

              const existing        = prev[idx]!
              const isCustomerMsg   = msg.sender_type === 'customer'
              const isHumanMsg      = msg.sender_type === 'human'
              const isNotAutonomous = existing.ai_mode !== 'autonomous'

              const newAttention: boolean = isHumanMsg
                ? false
                : existing.needs_human_attention || (isCustomerMsg && isNotAutonomous)

              // Track override so syncKey merge doesn't overwrite it before
              // the conversations UPDATE arrives to confirm.
              if (isHumanMsg || (isCustomerMsg && isNotAutonomous)) {
                attentionOverrides.current.set(msg.conversation_id, newAttention)
              }

              const updated: ConversationWithContact = {
                ...existing,
                // Optimistic preview from the message payload — resolved immediately
                // without waiting for conversations UPDATE.
                last_message_id:           msg.id,
                last_message_content:      msg.content,
                last_message_sender_type:  msg.sender_type,
                last_message_content_type: msg.content_type,
                last_message_at:           msg.created_at,
                needs_human_attention:     newAttention,
              }

              if (DEV) {
                console.log('[realtime:list] messages INSERT → preview+badge updated', {
                  instanceId,
                  sender:                msg.sender_type,
                  content:               msg.content?.slice(0, 40),
                  needs_human_attention: updated.needs_human_attention,
                  convId:                msg.conversation_id,
                })
              }

              return sortByActivity([updated, ...prev.filter((_, i) => i !== idx)])
            })
          },
        )

        // ── conversations UPDATE ──────────────────────────────────────────────
        // Receives the authoritative DB state after the trigger runs.
        // Since migration 20260710000005, this event now carries all five
        // last_message_* scalar columns (content, sender_type, content_type,
        // id, at), making it the sole source of truth for preview and ordering.
        // No stale-detection heuristics needed — the payload IS the latest state.
        .on(
          'postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'conversations' },
          (payload) => {
            const updated = payload.new as ConversationRow

            if (DEV) {
              console.log('[realtime:list] conversations UPDATE', {
                instanceId,
                id:                    updated.id,
                last_message_at:       updated.last_message_at,
                needs_human_attention: updated.needs_human_attention,
                ai_mode:               updated.ai_mode,
                status:                updated.status,
                tenantMatch:           updated.tenant_id === tenantId,
              })
              // PARTE A diagnostic: verify payload.new carries last_message_* content
              console.log('[realtime:list] conversations UPDATE payload preview', {
                instanceId,
                id:                       updated.id,
                last_message_content:     updated.last_message_content,
                last_message_sender_type: updated.last_message_sender_type,
                last_message_at:          updated.last_message_at,
                updated_at:               updated.updated_at,
              })
            }

            if (updated.tenant_id !== tenantId) return

            // DB has confirmed the authoritative value — clear the optimistic override
            attentionOverrides.current.delete(updated.id)

            setAllConversations((prev) => {
              if (!prev.some((c) => c.id === updated.id)) {
                if (DEV) {
                  console.log('[realtime:list] conversations UPDATE — conv not in state:', updated.id)
                }
                // A conversation not yet in state (reopened by worker) needs contact join.
                if (updated.status === 'open') scheduleRefresh()
                return prev
              }

              return sortByActivity(
                prev.map((c) => {
                  if (c.id !== updated.id) return c

                  const merged: ConversationWithContact = {
                    ...c,       // preserve local-only fields (contact, any optimistic preview)
                    ...updated, // authoritative DB scalars incl. last_message_* and badge
                    contact: c.contact, // never overwrite enriched join
                  }

                  if (DEV) {
                    console.log('[realtime:list] conversations UPDATE → state updated', {
                      instanceId,
                      id:                       merged.id,
                      last_message_content:     merged.last_message_content,
                      last_message_sender_type: merged.last_message_sender_type,
                      last_message_at:          merged.last_message_at,
                    })
                  }

                  return merged
                }),
              )
            })
          },
        )

        // ── conversations INSERT ──────────────────────────────────────────────
        // New conversation needs a server round-trip to fetch the contact join.
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'conversations' },
          (payload) => {
            const conv = payload.new as ConversationRow
            if (DEV) console.log('[realtime:list] conversations INSERT', { instanceId, id: conv.id })
            if (conv.tenant_id !== tenantId) return
            scheduleRefresh()
          },
        )

        .subscribe((status) => {
          if (DEV) {
            console.log('[realtime:list] channel status:', status, {
              instanceId,
              tenantId,
              retryCount,
            })
          }

          // After a successful reconnect, re-sync from the server to recover any
          // events that were missed during the error window.
          if (status === 'SUBSCRIBED' && retryCount > 0) {
            if (DEV) {
              console.log('[realtime:list] reconnected — scheduling refresh to recover missed events', {
                instanceId,
                retryCount,
              })
            }
            scheduleRefresh()
          }

          if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            if (destroyed) return

            // Exponential backoff: 1 s → 2 s → 4 s → … capped at 30 s
            const delay = Math.min(1_000 * 2 ** retryCount, 30_000)

            if (DEV) {
              console.warn('[realtime:list] channel failed, retrying in', delay, 'ms', {
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
      if (DEV) console.log('[realtime:list] CLEANUP', { instanceId, tenantId })
      destroyed = true
      if (retryTimer) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
      if (refreshDebounceRef.current) {
        clearTimeout(refreshDebounceRef.current)
        refreshDebounceRef.current = null
      }
      if (currentChannel) {
        void supabase.removeChannel(currentChannel)
        currentChannel = null
      }
      if (debugChannel) {
        void supabase.removeChannel(debugChannel)
        debugChannel = null
      }
    }
  // initialConversations.length is only used in a DEV mount log — intentionally excluded
  // to avoid tearing down the realtime channel on every server re-render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, router, startTransition])

  // PARTE A diagnostic: confirm what RealtimeConversationList hands to ConversationList
  if (process.env.NODE_ENV === 'development') {
    console.log('[realtime:list] render top previews', conversations.slice(0, 3).map((c) => ({
      id:                       c.id,
      last_message_content:     c.last_message_content,
      last_message_sender_type: c.last_message_sender_type,
      last_message_at:          c.last_message_at,
    })))
  }

  const isFiltered =
    statusFilter !== 'all' ||
    assignFilter !== 'all' ||
    !!search ||
    operationFilter !== 'all' ||
    leadStatusFilter !== 'all'

  return (
    <ConversationList
      conversations={conversations}
      currentUserId={currentUserId}
      tenantUsers={tenantUsers}
      failedReceiptConvIds={failedReceiptConvIds}
      pendingPaymentConvIds={pendingPaymentConvIds}
      isFiltered={isFiltered}
    />
  )
}
