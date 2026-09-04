'use client'

import type { MessageRow } from '@orderflow/types'
import { format } from 'date-fns'
import { es } from 'date-fns/locale'
import { useEffect, useRef, useState, useTransition } from 'react'
import { toast } from 'sonner'
import { AlertCircleIcon, FileIcon, DownloadIcon, PlayIcon, PauseIcon, ArchiveIcon, CheckCircleIcon, ExternalLinkIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { retryMessageAction } from '@/actions/messages'
import { deriveOutboundDisplayStatus, OUTBOUND_DISPLAY_LABEL, type OutboundTrackingInfo } from '@/lib/outbound-status'
import {
  saveMessageMediaAsPaymentProofAction,
  listConversationReservationsAction,
  type ReservationOption,
  type ConversationProofInfo,
} from '@/actions/documents'
import {
  Dialog, DialogContent, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

type SenderInfo = { name: string; role: string }

function ImageContent({
  messageId,
  caption,
  localPreviewUrl,
  mediaStoragePath,
}: {
  messageId:        string
  caption:          string | null
  localPreviewUrl:  string | null
  mediaStoragePath: string | null
}) {
  // Track errors for each source independently so a blob failure doesn't block
  // the server image and vice-versa.
  const [blobError,   setBlobError]   = useState(false)
  const [serverError, setServerError] = useState(false)

  // Reset error states whenever the effective source identifiers change.
  // Critical: when localPreviewUrl transitions blob→null and media_storage_path is
  // now set, we must clear blobError so the server URL gets a clean attempt.
  useEffect(() => {
    setBlobError(false)
    setServerError(false)
  }, [messageId, localPreviewUrl, mediaStoragePath])

  // Revoke the blob URL when localPreviewUrl transitions away (server image confirmed).
  // We intentionally do NOT revoke on unmount — the same blob URL may be reused
  // by the re-keyed component that replaces temp_ with the real message ID.
  const blobRef = useRef<string | null>(null)
  useEffect(() => {
    const prev = blobRef.current
    blobRef.current = localPreviewUrl
    if (prev?.startsWith('blob:') && !localPreviewUrl) {
      URL.revokeObjectURL(prev)
    }
  }, [localPreviewUrl])

  // Source selection:
  //   1. Local blob URL — fast, no auth; used while upload is in progress.
  //   2. Server proxy  — permanent; used once media_storage_path is confirmed.
  //   If the preferred source errors, fall through to the next.
  const canUseLocal  = !!localPreviewUrl  && !blobError
  const canUseServer = !!mediaStoragePath && !serverError

  if (!canUseLocal && !canUseServer) {
    return (
      <p className="text-xs opacity-70">
        {blobError || serverError ? 'No se pudo cargar la imagen' : 'Procesando imagen…'}
      </p>
    )
  }

  const useLocal = canUseLocal
  const src      = useLocal ? localPreviewUrl! : `/api/media/${messageId}`

  return (
    <div>
      {useLocal ? (
        <img
          src={src}
          alt="Imagen"
          className="max-h-64 w-auto rounded-lg object-contain"
          onError={() => setBlobError(true)}
        />
      ) : (
        <a href={`/api/media/${messageId}`} target="_blank" rel="noopener noreferrer">
          <img
            src={src}
            alt="Imagen"
            className="max-h-64 w-auto rounded-lg object-contain"
            onError={() => setServerError(true)}
          />
        </a>
      )}
      {caption && <p className="mt-1 text-xs opacity-80">{caption}</p>}
    </div>
  )
}

function formatAudioTime(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return '--:--'
  const m = Math.floor(secs / 60)
  const s = Math.floor(secs % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function AudioMessageContent({
  messageId,
  mediaStoragePath,
  transcriptionStatus,
  content,
  localPreviewUrl,
  deliveryFailed,
}: {
  messageId:           string
  mediaStoragePath:    string | null
  transcriptionStatus: string | null
  content:             string
  localPreviewUrl:     string | null
  deliveryFailed:      boolean
}) {
  const audioRef = useRef<HTMLAudioElement>(null)

  // All initial states are deterministic — safe for SSR/hydration
  const [isPlaying,     setIsPlaying]     = useState(false)
  const [currentTime,   setCurrentTime]   = useState(0)
  const [duration,      setDuration]      = useState(0)
  const [hasError,      setHasError]      = useState(false)
  const [showTranscript, setShowTranscript] = useState(false)

  // Use local object-URL while upload is in progress; switch to proxy once storage path is set.
  const audioSrc        = (localPreviewUrl && !mediaStoragePath) ? localPreviewUrl : `/api/media/${messageId}`
  const hasAudioSource  = !!mediaStoragePath || !!localPreviewUrl

  const hasTranscription = transcriptionStatus === 'completed'
  const transcriptFailed = transcriptionStatus === 'failed' || transcriptionStatus === 'skipped'
  const isTranscribing   = !!mediaStoragePath && !transcriptionStatus

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0

  function togglePlay() {
    const el = audioRef.current
    if (!el) return
    if (isPlaying) {
      el.pause()
    } else {
      el.play().catch(() => setHasError(true))
    }
  }

  if (!hasAudioSource) {
    return (
      <p className="text-xs opacity-60">
        {deliveryFailed ? 'Audio no enviado' : 'Procesando audio…'}
      </p>
    )
  }

  return (
    <div className="w-full min-w-[220px] max-w-[300px] space-y-2">
      {/* Player row */}
      <div className="flex items-center gap-3">
        {/* Play / Pause button */}
        <button
          type="button"
          onClick={togglePlay}
          disabled={hasError}
          aria-label={isPlaying ? 'Pausar audio' : 'Reproducir audio'}
          className={cn(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors',
            hasError
              ? 'cursor-not-allowed opacity-40'
              : 'bg-black/10 hover:bg-black/[0.17] dark:bg-white/[0.12] dark:hover:bg-white/20',
          )}
        >
          {hasError ? (
            <AlertCircleIcon className="h-4 w-4" />
          ) : isPlaying ? (
            <PauseIcon className="h-4 w-4" />
          ) : (
            <PlayIcon className="h-4 w-4 ml-0.5" />
          )}
        </button>

        {/* Progress + time column */}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {/* Track: custom visual + invisible native range on top for seek */}
          <div className="relative h-1.5 w-full rounded-full bg-black/15 dark:bg-white/20">
            {/* Fill bar */}
            <div
              className="pointer-events-none absolute inset-y-0 left-0 rounded-full bg-black/50 dark:bg-white/60"
              style={{ width: `${progress}%` }}
            />
            {/* Thumb dot */}
            <div
              className="pointer-events-none absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/80 shadow-sm dark:bg-foreground/70"
              style={{ left: `${progress}%` }}
            />
            {/* Invisible range input — handles click/drag/keyboard seek natively */}
            <input
              type="range"
              min={0}
              max={duration > 0 ? duration : 0}
              step={0.01}
              value={Math.min(currentTime, duration || currentTime)}
              disabled={duration <= 0}
              aria-label="Progreso del audio"
              onChange={(e) => {
                const next = Number(e.target.value)
                const el   = audioRef.current
                if (el) el.currentTime = next
                setCurrentTime(next)
              }}
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-default"
            />
          </div>

          {/* Time display */}
          <div className="flex justify-between tabular-nums text-[10px] opacity-60">
            <span>{formatAudioTime(currentTime)}</span>
            <span>{duration > 0 ? formatAudioTime(duration) : '--:--'}</span>
          </div>
        </div>
      </div>

      {/* Audio element — hidden, no native controls */}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio
        ref={audioRef}
        src={audioSrc}
        preload="metadata"
        onLoadedMetadata={() => {
          const el = audioRef.current
          if (el && Number.isFinite(el.duration) && el.duration > 0) setDuration(el.duration)
        }}
        onDurationChange={() => {
          const el = audioRef.current
          if (el && Number.isFinite(el.duration) && el.duration > 0) setDuration(el.duration)
        }}
        onTimeUpdate={() => {
          const el = audioRef.current
          if (el) setCurrentTime(el.currentTime)
        }}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => {
          setIsPlaying(false)
          setCurrentTime(0)
          const el = audioRef.current
          if (el) el.currentTime = 0
        }}
        onError={() => setHasError(true)}
        className="hidden"
      />

      {/* Transcription section */}
      {isTranscribing && (
        <p className="text-[11px] opacity-50">Transcribiendo audio…</p>
      )}

      {hasTranscription && (
        <div>
          <button
            type="button"
            onClick={() => setShowTranscript((v) => !v)}
            className="flex items-center gap-1 text-[11px] opacity-60 transition-opacity hover:opacity-90"
          >
            <span className="text-[9px]">{showTranscript ? '▲' : '▼'}</span>
            <span>Transcripción</span>
          </button>
          {showTranscript && (
            <p className="mt-1.5 max-w-[280px] whitespace-pre-wrap break-words text-xs leading-relaxed opacity-80">
              {content}
            </p>
          )}
        </div>
      )}

      {transcriptFailed && (
        <p className="text-[11px] opacity-40">No se pudo transcribir automáticamente.</p>
      )}
    </div>
  )
}

// ─── Payment proof ───────────────────────────────────────────────────────────

// Formats a YYYY-MM-DD date string as DD/MM without creating a Date object,
// avoiding the UTC-midnight timezone shift that would show the previous day
// in Argentina (UTC-3) when using new Date('YYYY-MM-DD').
function formatDateOnly(dateStr: string): string {
  const [, month, day] = dateStr.slice(0, 10).split('-')
  return `${day}/${month}`
}

const RESERVATION_STATUS_LABELS: Record<string, string> = {
  pre_reserved: 'Pre-reserva',
  confirmed:    'Confirmada',
  cancelled:    'Cancelada',
  completed:    'Completada',
}

function SavePaymentProofModal({
  open,
  onClose,
  message,
  onSaved,
}: {
  open:    boolean
  onClose: () => void
  message: MessageRow
  onSaved: (info: ConversationProofInfo) => void
}) {
  const [reservations, setReservations] = useState<ReservationOption[]>([])
  const [selectedId,   setSelectedId]   = useState('')
  const [notes,        setNotes]        = useState('')
  const [isLoading,    setIsLoading]    = useState(false)
  const [isSaving,     setIsSaving]     = useState(false)
  const [error,        setError]        = useState<string | null>(null)

  // Reset form and load reservations each time the modal opens
  useEffect(() => {
    if (!open) return
    setSelectedId('')
    setNotes('')
    setError(null)
    setReservations([])
    setIsLoading(true)
    listConversationReservationsAction(message.conversation_id)
      .then((res) => {
        if (res.success) setReservations(res.data ?? [])
        else setError(res.error)
      })
      .finally(() => setIsLoading(false))
  }, [open, message.conversation_id])

  async function handleSave() {
    if (!selectedId) return
    setIsSaving(true)
    setError(null)
    const res = await saveMessageMediaAsPaymentProofAction({
      messageId:     message.id,
      reservationId: selectedId,
      notes:         notes.trim() || undefined,
    })
    setIsSaving(false)

    if (res.success && res.data) {
      onSaved({
        storagePath:   res.data.storagePath,
        documentId:    res.data.documentId,
        notes:         res.data.notes,
        reservationId: res.data.reservationId,
      })
      onClose()
    } else if (!res.success) {
      setError(res.error)
    }
  }

  const noReservations = !isLoading && reservations.length === 0

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Guardar comprobante</DialogTitle>
          <DialogDescription>
            Esto solo archiva el archivo para revisión. No confirma el pago ni cambia el estado de la reserva.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Reservation selector — required */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Reserva</label>
            {isLoading ? (
              <p className="text-sm text-muted-foreground">Cargando reservas…</p>
            ) : noReservations ? (
              <p className="text-sm text-muted-foreground">
                No hay reservas disponibles para asociar este comprobante.
              </p>
            ) : (
              <select
                value={selectedId}
                onChange={(e) => setSelectedId(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="">Seleccioná una reserva…</option>
                {reservations.map((r) => {
                  const start = formatDateOnly(r.start_date)
                  const end   = formatDateOnly(r.end_date)
                  const amt   = r.total_amount != null
                    ? ` · ${r.currency} ${r.total_amount.toLocaleString('es-AR')}`
                    : ''
                  const label = RESERVATION_STATUS_LABELS[r.status] ?? r.status
                  return (
                    <option key={r.id} value={r.id}>
                      {start} → {end}{amt} · {label}
                    </option>
                  )
                })}
              </select>
            )}
          </div>

          {/* Optional note */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">
              Nota{' '}
              <span className="font-normal text-muted-foreground">(opcional)</span>
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Ej: Seña recibida el 08/08/2026"
              maxLength={1000}
              rows={2}
              className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isSaving}>
            Cancelar
          </Button>
          <Button onClick={handleSave} disabled={isSaving || isLoading || !selectedId || noReservations}>
            {isSaving ? 'Guardando…' : 'Guardar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

function DocumentContent({
  messageId,
  filename,
  mimeType,
  caption,
}: {
  messageId: string
  filename:  string | null
  mimeType:  string | null
  caption:   string | null
}) {
  return (
    <div className="space-y-1">
      <a
        href={`/api/media/${messageId}?download=1`}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-2 no-underline"
      >
        <FileIcon className="h-5 w-5 shrink-0 opacity-70" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium leading-tight">{filename ?? 'Documento'}</p>
          {mimeType && <p className="text-[10px] opacity-60">{mimeType}</p>}
        </div>
        <DownloadIcon className="ml-1 h-4 w-4 shrink-0 opacity-70" />
      </a>
      {caption && <p className="mt-1 text-xs opacity-80">{caption}</p>}
    </div>
  )
}

// Outbound receipt card — PDF lives in reservation-docs, served via /api/documents.
function ReceiptDocumentCard({
  documentId,
  filename,
  name,
}: {
  documentId: string
  filename:   string | null
  name:       string
}) {
  const displayName = filename ?? name
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <FileIcon className="h-5 w-5 shrink-0 opacity-70" />
        <p className="truncate text-sm font-medium leading-tight">{displayName}</p>
      </div>
      <div className="flex gap-3">
        <a
          href={`/api/documents/${documentId}`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 text-[11px] opacity-80 underline underline-offset-2 hover:opacity-100"
        >
          <ExternalLinkIcon className="h-3 w-3" />
          Ver recibo
        </a>
        <a
          href={`/api/documents/${documentId}?download=1`}
          className="flex items-center gap-1 text-[11px] opacity-80 underline underline-offset-2 hover:opacity-100"
        >
          <DownloadIcon className="h-3 w-3" />
          Descargar
        </a>
      </div>
    </div>
  )
}

interface MessageBubbleProps {
  message:              MessageRow
  currentUserId:        string
  contact?:             { name: string | null; phone: string | null } | null
  senderMap?:           Map<string, SenderInfo>
  savedProofMap?:       Map<string, ConversationProofInfo>
  outboundTrackingMap?: Map<string, OutboundTrackingInfo>
}

function getSenderLabel(
  message:   MessageRow,
  contact:   MessageBubbleProps['contact'],
  senderMap: Map<string, SenderInfo> | undefined,
): string {
  switch (message.sender_type) {
    case 'customer':
      return contact?.name ?? contact?.phone ?? 'Cliente'
    case 'ai':
      return 'IA ReservaNex'
    case 'human': {
      const info = message.sender_id ? senderMap?.get(message.sender_id) : undefined
      if (info?.name) {
        const roleLabel = info.role === 'owner' ? 'Owner' : 'Agente'
        return `${info.name} · ${roleLabel}`
      }
      return 'Agente'
    }
    default:
      return message.sender_type
  }
}

export function MessageBubble({ message, currentUserId, contact, senderMap, savedProofMap, outboundTrackingMap }: MessageBubbleProps) {
  const isRight = message.sender_type === 'human' || message.sender_type === 'ai'
  const isMe    = message.sender_type === 'human' && message.sender_id === currentUserId
  const time    = format(new Date(message.created_at), 'HH:mm', { locale: es })

  // localProof: set immediately after saving in this session (for instant feedback).
  // serverProof: loaded on conversation open from DB (persists across page loads).
  const [localProof,    setLocalProof]    = useState<ConversationProofInfo | null>(null)
  const [showProofModal, setShowProofModal] = useState(false)

  const serverProof  = message.media_storage_path
    ? (savedProofMap?.get(message.media_storage_path) ?? null)
    : null
  const activeProof  = localProof ?? serverProof
  const isSavedProof = !!activeProof

  // Only customer inbound image/document with uploaded media can be saved as proof.
  // Exclude temp/optimistic messages (no real storage path or server record yet).
  const canSaveAsProof =
    message.sender_type === 'customer' &&
    !message.id.startsWith('temp_') &&
    (message.content_type === 'image' || message.content_type === 'document') &&
    !!message.media_storage_path

  const meta           = message.metadata as Record<string, unknown> | null
  const deliveryStatus = meta?.delivery_status as string | undefined
  const isSending      = isMe && deliveryStatus === 'sending'
  const isFailed       = isMe && deliveryStatus === 'failed' && !message.id.startsWith('temp_')
  // Retry is only possible for text messages — media requires re-selecting the file.
  const canRetry             = isFailed && message.content_type === 'text'

  // Fase 8 "outbound ACK" — honest device-execution status, derived from
  // messaging_outbox (never a WhatsApp delivery/read receipt). Applies to
  // outbound (human/ai) messages only, and never to a still-optimistic temp_
  // message (it has no messaging_outbox row yet, so the map lookup naturally
  // returns nothing for it). Independent of the metadata-driven isFailed/
  // isSending above — those track the app-layer send call, this tracks what
  // happened physically after the message was enqueued.
  const isOutbound            = message.sender_type === 'human' || message.sender_type === 'ai'
  const outboundDisplayStatus = isOutbound && !message.id.startsWith('temp_')
    ? deriveOutboundDisplayStatus(outboundTrackingMap?.get(message.id) ?? null)
    : null
  const filename             = typeof meta?.['filename']             === 'string' ? meta['filename']             : null
  const mimeType             = typeof meta?.['mime_type']            === 'string' ? meta['mime_type']            : null
  const caption              = typeof meta?.['caption']              === 'string' ? meta['caption']              : null
  const transcriptionStatus  = typeof meta?.['transcription_status'] === 'string' ? meta['transcription_status'] : null
  const documentId           = typeof meta?.['document_id']          === 'string' ? meta['document_id']          : null
  const localPreviewUrl      = typeof meta?.['localPreviewUrl']      === 'string' ? meta['localPreviewUrl']      : null

  const [isPending, startTransition] = useTransition()

  function handleRetry() {
    startTransition(async () => {
      const result = await retryMessageAction(message.id)
      if (!result.success) {
        toast.error(result.error ?? 'Error al reintentar el envío')
      } else {
        toast.success('Mensaje enviado correctamente')
      }
    })
  }

  const senderLabel = getSenderLabel(message, contact, senderMap)

  const bubbleClass =
    message.sender_type === 'customer'
      ? 'rounded-bl-sm bg-muted text-foreground'
      : message.sender_type === 'ai'
        ? 'rounded-br-sm bg-blue-100 text-blue-900 dark:bg-blue-900/30 dark:text-blue-100'
        : 'rounded-br-sm bg-primary text-primary-foreground'

  return (
    <div className={cn('flex flex-col gap-0.5', isRight ? 'items-end' : 'items-start')}>
      {/* Author label — above the bubble for clarity */}
      <span className="px-1 text-[11px] font-medium text-muted-foreground">
        {senderLabel}
      </span>

      <div className={cn('max-w-[78%] rounded-2xl px-4 py-2.5 text-sm', bubbleClass)}>
        {message.content_type === 'audio' ? (
          <AudioMessageContent
            messageId={message.id}
            mediaStoragePath={message.media_storage_path ?? null}
            transcriptionStatus={transcriptionStatus}
            content={message.content}
            localPreviewUrl={localPreviewUrl}
            deliveryFailed={isFailed}
          />
        ) : message.content_type === 'image' && (message.media_storage_path ?? localPreviewUrl) ? (
          <ImageContent
            messageId={message.id}
            caption={caption}
            localPreviewUrl={localPreviewUrl}
            mediaStoragePath={message.media_storage_path ?? null}
          />
        ) : message.content_type === 'document' ? (
          documentId ? (
            <ReceiptDocumentCard documentId={documentId} filename={filename} name={message.content} />
          ) : message.media_storage_path ? (
            <DocumentContent messageId={message.id} filename={filename} mimeType={mimeType} caption={caption} />
          ) : (
            <div className="flex items-center gap-2">
              <FileIcon className="h-4 w-4 shrink-0 opacity-60" />
              <p className="text-xs opacity-60">{filename ?? 'Procesando documento…'}</p>
            </div>
          )
        ) : (
          <p className="whitespace-pre-wrap break-words leading-relaxed">{message.content}</p>
        )}
        <p className="mt-1 text-right text-[10px] opacity-50">{time}</p>
      </div>

      {/* Sending — subtle indicator below the bubble */}
      {isSending && (
        <p className="px-1 text-[11px] text-muted-foreground/60">Enviando…</p>
      )}

      {/* Failed delivery */}
      {isFailed && (
        <div className="flex items-center gap-1.5 px-1">
          <AlertCircleIcon className="h-3 w-3 text-destructive" />
          <span className="text-[11px] font-medium text-destructive">No enviado</span>
          {canRetry && (
            <button
              onClick={handleRetry}
              disabled={isPending}
              className="text-[11px] text-destructive underline underline-offset-2 hover:opacity-70 disabled:opacity-40"
            >
              {isPending ? 'Reintentando…' : 'Reintentar'}
            </button>
          )}
        </div>
      )}

      {/* Outbound device-execution status — honest, never implies WhatsApp
          delivery/read. See deriveOutboundDisplayStatus for exact semantics. */}
      {outboundDisplayStatus && (
        <p
          className={cn(
            'px-1 text-[11px]',
            outboundDisplayStatus === 'device_executed' && 'text-emerald-600 dark:text-emerald-400',
            outboundDisplayStatus === 'unconfirmed'      && 'text-amber-600 dark:text-amber-400',
            outboundDisplayStatus === 'failed'            && 'text-destructive',
            (outboundDisplayStatus === 'queued' || outboundDisplayStatus === 'dispatched_to_device') && 'text-muted-foreground/60',
          )}
        >
          {outboundDisplayStatus === 'unconfirmed' ? '⚠ ' : ''}
          {OUTBOUND_DISPLAY_LABEL[outboundDisplayStatus]}
        </p>
      )}

      {/* Save as payment proof — customer media messages only */}
      {canSaveAsProof && (
        <div className="flex flex-col gap-0.5 px-1">
          {isSavedProof ? (
            <>
              <div className="flex items-center gap-2">
                <span className="flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400">
                  <CheckCircleIcon className="h-3 w-3" />
                  Comprobante guardado
                </span>
                <a
                  href={`/api/media/${message.id}${message.content_type === 'document' ? '?download=1' : ''}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-0.5 text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
                >
                  <ExternalLinkIcon className="h-2.5 w-2.5" />
                  Ver
                </a>
              </div>
              {activeProof?.notes && (
                <p className="max-w-[240px] truncate text-[11px] italic text-muted-foreground">
                  Nota: {activeProof.notes}
                </p>
              )}
            </>
          ) : (
            <button
              type="button"
              onClick={() => setShowProofModal(true)}
              className="flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            >
              <ArchiveIcon className="h-3 w-3" />
              Guardar como comprobante
            </button>
          )}
        </div>
      )}

      {canSaveAsProof && (
        <SavePaymentProofModal
          open={showProofModal}
          onClose={() => setShowProofModal(false)}
          message={message}
          onSaved={(info) => setLocalProof(info)}
        />
      )}
    </div>
  )
}
