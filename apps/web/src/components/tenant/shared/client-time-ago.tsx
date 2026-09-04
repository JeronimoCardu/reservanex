'use client'

import { useState, useEffect } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { es } from 'date-fns/locale'

interface ClientTimeAgoProps {
  date:      Date | string
  className?: string
}

export function ClientTimeAgo({ date, className }: ClientTimeAgoProps) {
  const ts = typeof date === 'string' ? new Date(date).getTime() : date.getTime()

  // null until after mount — prevents SSR/client mismatch on relative strings
  const [relative, setRelative] = useState<string | null>(null)

  useEffect(() => {
    const d = new Date(ts)
    function compute() {
      const now = new Date()
      // Clamp dates that are slightly in the future (clock drift) so we
      // never produce "en menos de un minuto" — always use past form.
      const target = d > now ? now : d
      setRelative(formatDistanceToNow(target, { addSuffix: true, locale: es }))
    }
    compute()
    const id = setInterval(compute, 60_000)
    return () => clearInterval(id)
  }, [ts])

  // Pre-mount fallback: UTC HH:MM slice from ISO string — always identical
  // on server and client, so React hydrates without mismatch.
  const iso = new Date(ts).toISOString()

  return (
    <time dateTime={iso} className={className}>
      {relative ?? iso.slice(11, 16)}
    </time>
  )
}
