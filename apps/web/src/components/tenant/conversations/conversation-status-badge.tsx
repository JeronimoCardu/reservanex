'use client'

import { Badge } from '@/components/ui/badge'
import type { ConversationStatus } from '@orderflow/types'

const config: Record<ConversationStatus, { label: string; variant: 'default' | 'secondary' | 'outline' | 'destructive' }> = {
  open:    { label: 'Abierta',   variant: 'default' },
  waiting: { label: 'Esperando', variant: 'secondary' },
  closed:  { label: 'Cerrada',   variant: 'outline' },
}

export function ConversationStatusBadge({ status }: { status: ConversationStatus }) {
  const { label, variant } = config[status] ?? { label: status, variant: 'outline' }
  return <Badge variant={variant}>{label}</Badge>
}
