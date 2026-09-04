'use client'

import { Badge } from '@/components/ui/badge'

const labels: Record<string, string> = {
  whatsapp: 'WhatsApp',
  website:  'Web',
  manual:   'Manual',
}

const variants: Record<string, 'default' | 'secondary' | 'outline'> = {
  whatsapp: 'default',
  website:  'secondary',
  manual:   'outline',
}

export function ContactSourceBadge({ source }: { source: string }) {
  return (
    <Badge variant={variants[source] ?? 'outline'}>
      {labels[source] ?? source}
    </Badge>
  )
}
