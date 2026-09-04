'use client'

import { AlertCircleIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'

export default function ReservationsError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <AlertCircleIcon className="h-10 w-10 text-destructive/50" />
      <p className="text-sm font-medium">No se pudieron cargar las reservas</p>
      <p className="max-w-xs text-xs text-muted-foreground">{error.digest ?? 'Intentá de nuevo o recargá la página.'}</p>
      <Button variant="outline" size="sm" onClick={reset}>
        Reintentar
      </Button>
    </div>
  )
}
