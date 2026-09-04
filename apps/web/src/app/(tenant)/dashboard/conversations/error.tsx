'use client'

export default function ConversationsError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-sm font-medium text-foreground">No pudimos cargar las conversaciones.</p>
      <p className="text-xs text-muted-foreground max-w-xs">
        {error.digest ? `Referencia: ${error.digest}` : 'Revisá tu conexión e intentá de nuevo.'}
      </p>
      <button
        onClick={reset}
        className="mt-1 rounded-md bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90"
      >
        Reintentar
      </button>
    </div>
  )
}
