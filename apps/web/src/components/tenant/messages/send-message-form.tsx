'use client'

import { useState, useRef, useTransition, useEffect } from 'react'
import { toast } from 'sonner'
import {
  SendIcon, LockIcon, SmileIcon, PaperclipIcon,
  XIcon, FileIcon, ImageIcon, CreditCardIcon, LinkIcon,
} from 'lucide-react'
import {
  sendMessageAction,
  sendImageMessageAction,
  sendDocumentMessageAction,
} from '@/actions/messages'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

// Voice recording is paused until browser audio conversion is supported.
// sendAudioMessageAction remains available on the backend for future use.

export interface OptimisticMediaParams {
  contentType:      'image' | 'audio' | 'document'
  caption?:         string
  localPreviewUrl?: string
  mimeType?:        string
  filename?:        string
}

type PaymentData = {
  payment_alias:           string | null
  payment_cbu:             string | null
  payment_account_holder:  string | null
  payment_bank:            string | null
  payment_notes:           string | null
  payment_request_message: string | null
}

type PublicLinkData = {
  siteEnabled:       boolean
  siteSlug:          string | null
  propertySlug:      string | null
  propertyPublished: boolean
}

interface SendMessageFormProps {
  conversationId:         string
  disabled?:              boolean
  onOptimisticSend?:      (text: string) => string
  onOptimisticMediaSend?: (params: OptimisticMediaParams) => string
  onSendConfirmed?:       (tempId: string, realId: string, mediaStoragePath?: string | null) => void
  onSendFailed?:          (tempId: string) => void
  paymentData?:           PaymentData | null
  publicLinkData?:        PublicLinkData | null
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// ─── Mini emoji picker ────────────────────────────────────────────────────────

const EMOJIS = [
  '😀', '😄', '😊', '🙌', '👍', '👌',
  '✅', '❤️', '🎉', '✨', '⭐', '🙏',
  '🏠', '🏡', '📍', '📅', '💬', '💵',
  '🔑', '📞', '💼', '📋', '✔️', '🤝',
]

function EmojiPicker({
  onSelect,
  onClose,
}: {
  onSelect: (emoji: string) => void
  onClose:  () => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handleDown)
    return () => document.removeEventListener('mousedown', handleDown)
  }, [onClose])

  return (
    <div
      ref={ref}
      className="absolute bottom-full left-0 z-50 mb-2 grid grid-cols-6 gap-0.5 rounded-xl border bg-popover p-2 shadow-lg"
    >
      {EMOJIS.map((emoji) => (
        <button
          key={emoji}
          type="button"
          onClick={() => onSelect(emoji)}
          className="rounded p-1.5 text-lg leading-none transition-colors hover:bg-accent"
          aria-label={emoji}
        >
          {emoji}
        </button>
      ))}
    </div>
  )
}

// ─── Attach menu ──────────────────────────────────────────────────────────────

function AttachMenu({
  onImage,
  onDoc,
  onClose,
}: {
  onImage: () => void
  onDoc:   () => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handleDown)
    return () => document.removeEventListener('mousedown', handleDown)
  }, [onClose])

  return (
    <div
      ref={ref}
      className="absolute bottom-full right-0 z-50 mb-2 overflow-hidden rounded-xl border bg-popover shadow-lg"
    >
      <button
        type="button"
        onClick={() => { onImage(); onClose() }}
        className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm hover:bg-accent"
      >
        <ImageIcon className="h-4 w-4 shrink-0 opacity-70" />
        Imagen
      </button>
      <button
        type="button"
        onClick={() => { onDoc(); onClose() }}
        className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm hover:bg-accent"
      >
        <FileIcon className="h-4 w-4 shrink-0 opacity-70" />
        Archivo
      </button>
    </div>
  )
}

// ─── Main form ────────────────────────────────────────────────────────────────

export function SendMessageForm({
  conversationId,
  disabled = false,
  onOptimisticSend,
  onOptimisticMediaSend,
  onSendConfirmed,
  onSendFailed,
  paymentData,
  publicLinkData,
}: SendMessageFormProps) {
  const [isPending, startTransition] = useTransition()
  const [text,            setText]           = useState('')
  const [imageFile,       setImageFile]      = useState<File | null>(null)
  const [docFile,         setDocFile]        = useState<File | null>(null)
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null)
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const [showAttachMenu,  setShowAttachMenu]  = useState(false)

  const savedTextRef  = useRef('')
  const imageInputRef = useRef<HTMLInputElement>(null)
  const docInputRef   = useRef<HTMLInputElement>(null)
  const textareaRef   = useRef<HTMLTextAreaElement>(null)

  // Create/revoke image preview URL
  useEffect(() => {
    if (!imageFile) { setImagePreviewUrl(null); return }
    const url = URL.createObjectURL(imageFile)
    setImagePreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [imageFile])

  // ── File helpers ────────────────────────────────────────────────────────────

  function clearImage() {
    setImageFile(null)
    if (imageInputRef.current) imageInputRef.current.value = ''
  }

  function clearDoc() {
    setDocFile(null)
    if (docInputRef.current) docInputRef.current.value = ''
  }

  function onImageSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 5 * 1024 * 1024) {
      toast.error('La imagen no puede superar 5 MB.')
      e.target.value = ''
      return
    }
    setImageFile(file)
  }

  function onDocSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 16 * 1024 * 1024) {
      toast.error('El archivo no puede superar 16 MB.')
      e.target.value = ''
      return
    }
    setDocFile(file)
  }

  // ── Emoji ───────────────────────────────────────────────────────────────────

  function insertEmoji(emoji: string) {
    const el = textareaRef.current
    setShowEmojiPicker(false)
    if (!el) { setText((prev) => prev + emoji); return }
    const start   = el.selectionStart ?? text.length
    const end     = el.selectionEnd   ?? text.length
    const newText = text.slice(0, start) + emoji + text.slice(end)
    setText(newText)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(start + emoji.length, start + emoji.length)
    })
  }

  // ── Quick actions ───────────────────────────────────────────────────────────

  function insertText(snippet: string) {
    setText((prev) => {
      const trimmed = prev.trim()
      return trimmed ? trimmed + '\n\n' + snippet : snippet
    })
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
    })
  }

  function handleInsertPayment() {
    if (!paymentData) return
    const { payment_alias, payment_cbu, payment_account_holder, payment_bank, payment_notes, payment_request_message } = paymentData
    const hasData = payment_alias || payment_cbu || payment_account_holder || payment_bank
    if (!hasData) {
      toast.error('Configurá los datos de pago en Configuración → Pagos.')
      return
    }
    const lines: string[] = []
    if (payment_request_message) lines.push(payment_request_message, '')
    if (payment_account_holder)  lines.push(`Titular: ${payment_account_holder}`)
    if (payment_bank)            lines.push(`Banco: ${payment_bank}`)
    if (payment_alias)           lines.push(`Alias: ${payment_alias}`)
    if (payment_cbu)             lines.push(`CBU/CVU: ${payment_cbu}`)
    if (payment_notes)           lines.push('', payment_notes)
    insertText(lines.join('\n').trim())
  }

  function handleInsertLink() {
    if (!publicLinkData?.siteEnabled || !publicLinkData?.siteSlug) {
      toast.error('El sitio público no está habilitado.')
      return
    }
    const base = window.location.origin
    const { siteSlug, propertySlug, propertyPublished } = publicLinkData
    const url = propertySlug && propertyPublished
      ? `${base}/site/${siteSlug}/properties/${propertySlug}`
      : `${base}/site/${siteSlug}/properties`
    insertText(url)
  }

  // ── Send handlers ───────────────────────────────────────────────────────────

  function handleSendText() {
    const content = text.trim()
    if (!content) return
    savedTextRef.current = content
    const tempId = onOptimisticSend?.(content)
    setText('')
    startTransition(async () => {
      const result = await sendMessageAction(conversationId, { content })
      if (!result.success) {
        toast.error(result.error)
        setText(savedTextRef.current)
        if (tempId) onSendFailed?.(tempId)
        return
      }
      if (tempId && result.data?.id) onSendConfirmed?.(tempId, result.data.id)
    })
  }

  function handleSendImage() {
    const file    = imageFile!
    const caption = text.trim() || undefined
    // Create a fresh blob URL for the optimistic preview. This is intentionally
    // separate from imagePreviewUrl so that clearImage() (which revokes imagePreviewUrl
    // via its useEffect cleanup) does not invalidate the URL the bubble is displaying.
    // ImageContent revokes this URL when localPreviewUrl transitions away (server took over).
    const optimisticBlob = URL.createObjectURL(file)
    const tempId  = onOptimisticMediaSend?.({
      contentType:     'image',
      caption,
      localPreviewUrl: optimisticBlob,
      mimeType:        file.type,
    })
    clearImage()
    setText('')
    startTransition(async () => {
      const fd = new FormData()
      fd.append('file', file)
      if (caption) fd.append('caption', caption)
      const result = await sendImageMessageAction(conversationId, fd)
      if (!result.success) {
        toast.error(result.error)
        URL.revokeObjectURL(optimisticBlob)
        if (tempId) onSendFailed?.(tempId)
        return
      }
      if (tempId && result.data?.id) onSendConfirmed?.(tempId, result.data.id, result.data.mediaStoragePath)
      // On success, optimisticBlob stays alive and is revoked by ImageContent when
      // localPreviewUrl is cleared from metadata by the realtime UPDATE.
    })
  }

  function handleSendDocument() {
    const file    = docFile!
    const caption = text.trim() || undefined
    const tempId  = onOptimisticMediaSend?.({
      contentType: 'document',
      caption,
      mimeType:    file.type,
      filename:    file.name,
    })
    clearDoc()
    setText('')
    startTransition(async () => {
      const fd = new FormData()
      fd.append('file', file)
      if (caption) fd.append('caption', caption)
      const result = await sendDocumentMessageAction(conversationId, fd)
      if (!result.success) {
        toast.error(result.error)
        if (tempId) onSendFailed?.(tempId)
        return
      }
      if (tempId && result.data?.id) onSendConfirmed?.(tempId, result.data.id, result.data.mediaStoragePath)
    })
  }

  function handleSubmit() {
    if (imageFile) handleSendImage()
    else if (docFile) handleSendDocument()
    else handleSendText()
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit() }
  }

  const hasAttachment = !!imageFile || !!docFile
  const canSend = !isPending && (text.trim().length > 0 || hasAttachment)

  // ── Disabled state ──────────────────────────────────────────────────────────

  if (disabled) {
    return (
      <div className="border-t bg-muted/30 px-4 py-4">
        <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <LockIcon className="h-3.5 w-3.5 shrink-0" />
          <span>
            Conversación cerrada.{' '}
            <span className="font-medium text-foreground">Reabrila</span>
            {' '}desde el botón superior para seguir escribiendo.
          </span>
        </div>
      </div>
    )
  }

  // ── Active state ────────────────────────────────────────────────────────────

  return (
    <div className="border-t bg-background p-3">
      {/* Preview strip — image or document attachment */}
      {(imageFile ?? docFile) && (
        <div className="mb-2 flex flex-wrap items-center gap-2">
          {imageFile && imagePreviewUrl && (
            <div className="relative inline-block">
              <img
                src={imagePreviewUrl}
                alt="Preview"
                className="h-20 w-auto rounded-lg object-cover"
              />
              <button
                type="button"
                onClick={clearImage}
                aria-label="Quitar imagen"
                className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-destructive text-destructive-foreground shadow-sm"
              >
                <XIcon className="h-3 w-3" />
              </button>
            </div>
          )}
          {docFile && (
            <div className="flex flex-1 items-center gap-2 rounded-lg border bg-muted/50 px-3 py-2">
              <FileIcon className="h-4 w-4 shrink-0 opacity-70" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium leading-tight">{docFile.name}</p>
                <p className="text-[10px] opacity-60">{formatFileSize(docFile.size)}</p>
              </div>
              <button
                type="button"
                onClick={clearDoc}
                aria-label="Quitar archivo"
                className="shrink-0 text-muted-foreground hover:text-foreground"
              >
                <XIcon className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>
      )}

      {/* Quick actions */}
      {(paymentData || (publicLinkData?.siteEnabled && publicLinkData?.siteSlug)) && (
        <div className="mb-2 flex items-center gap-1.5 flex-wrap">
          {paymentData && (
            <button
              type="button"
              onClick={handleInsertPayment}
              disabled={isPending}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
            >
              <CreditCardIcon className="h-3 w-3" />
              Datos de pago
            </button>
          )}
          {publicLinkData?.siteEnabled && publicLinkData?.siteSlug && (
            <button
              type="button"
              onClick={handleInsertLink}
              disabled={isPending}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
            >
              <LinkIcon className="h-3 w-3" />
              {publicLinkData.propertySlug && publicLinkData.propertyPublished ? 'Link propiedad' : 'Link web'}
            </button>
          )}
        </div>
      )}

      {/* Input row */}
      <div className="relative flex items-end gap-2">
        {showEmojiPicker && (
          <EmojiPicker
            onSelect={insertEmoji}
            onClose={() => setShowEmojiPicker(false)}
          />
        )}

        {/* Emoji button */}
        <button
          type="button"
          onClick={() => { setShowEmojiPicker((v) => !v); setShowAttachMenu(false) }}
          disabled={isPending}
          aria-label="Emojis"
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40',
            showEmojiPicker && 'bg-accent text-foreground',
          )}
        >
          <SmileIcon className="h-4 w-4" />
        </button>

        {/* Hidden file inputs */}
        <input
          ref={imageInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={onImageSelect}
        />
        <input
          ref={docInputRef}
          type="file"
          accept=".pdf,.doc,.docx,.xls,.xlsx,.txt,.csv"
          className="hidden"
          onChange={onDocSelect}
        />

        {/* Textarea — doubles as caption input when an attachment is selected */}
        <Textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={
            imageFile || docFile
              ? 'Agregar caption (opcional)…'
              : 'Escribí un mensaje…  (Enter: enviar · Shift+Enter: nueva línea)'
          }
          className="min-h-[44px] resize-none text-sm"
          disabled={isPending}
          onKeyDown={handleKeyDown}
        />

        {/* Attach button — opens Imagen / Archivo dropdown */}
        <div className="relative">
          {showAttachMenu && (
            <AttachMenu
              onImage={() => imageInputRef.current?.click()}
              onDoc={() => docInputRef.current?.click()}
              onClose={() => setShowAttachMenu(false)}
            />
          )}
          <button
            type="button"
            onClick={() => { setShowAttachMenu((v) => !v); setShowEmojiPicker(false) }}
            disabled={isPending}
            aria-label="Adjuntar"
            title="Adjuntar"
            className={cn(
              'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40',
              showAttachMenu && 'bg-accent text-foreground',
              hasAttachment  && 'text-primary',
            )}
          >
            <PaperclipIcon className="h-4 w-4" />
          </button>
        </div>

        {/* Send button — appears only when there's content */}
        {canSend && (
          <Button
            onClick={handleSubmit}
            disabled={!canSend}
            size="icon"
            className="h-10 w-10 shrink-0"
            title="Enviar"
          >
            <SendIcon className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  )
}
