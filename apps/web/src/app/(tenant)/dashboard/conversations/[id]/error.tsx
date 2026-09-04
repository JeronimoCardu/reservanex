'use client'

import Link from 'next/link'

export default function ConversationDetailError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-sm font-medium text-foreground">No pudimos cargar esta conversación.</p>
      <p className="text-xs text-muted-foreground max-w-xs">
        {error.digest ? `Referencia: ${error.digest}` : 'Revisá tu conexión e intentá de nuevo.'}
      </p>
      <div className="mt-1 flex gap-2">
        <button
          onClick={reset}
          className="rounded-md bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90"
        >
          Reintentar
        </button>
        <Link
          href="/dashboard/conversations"
          className="rounded-md border px-4 py-1.5 text-xs font-medium hover:bg-muted"
        >
          Volver
        </Link>
      </div>
    </div>
  )
}
