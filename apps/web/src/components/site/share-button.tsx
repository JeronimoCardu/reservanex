'use client'

import { useState } from 'react'
import { toast } from 'sonner'

interface ShareButtonProps {
  title: string
  url:   string
}

export function ShareButton({ title, url }: ShareButtonProps) {
  const [copied, setCopied] = useState(false)

  async function handleShare() {
    const shareUrl = url || window.location.href

    if (navigator.share) {
      try {
        await navigator.share({ title, url: shareUrl })
      } catch {
        // user cancelled — do nothing
      }
      return
    }

    // Fallback: copy to clipboard
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopied(true)
      toast.success('Enlace copiado al portapapeles')
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error('No se pudo copiar el enlace')
    }
  }

  return (
    <button
      type="button"
      onClick={handleShare}
      aria-label="Compartir propiedad"
      className="inline-flex items-center gap-1.5 rounded-full border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-600 shadow-sm transition-colors hover:border-zinc-400 hover:text-zinc-900"
    >
      {copied ? (
        <>
          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
          Copiado
        </>
      ) : (
        <>
          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
          </svg>
          Compartir
        </>
      )}
    </button>
  )
}
