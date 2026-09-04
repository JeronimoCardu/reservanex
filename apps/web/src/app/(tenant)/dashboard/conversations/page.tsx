import type { Metadata } from 'next'
import { MessageSquareIcon } from 'lucide-react'

export const metadata: Metadata = {
  title: 'Conversaciones — ReservaNex',
}

// The conversation list lives in the conversations/layout.tsx split-pane.
// This page renders the empty state shown in the right panel on desktop,
// and is hidden on mobile (the list takes the full screen there).
export default function ConversationsPage() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center px-6">
      <MessageSquareIcon className="h-10 w-10 text-muted-foreground/30" />
      <p className="text-sm font-medium">Seleccioná una conversación</p>
      <p className="text-xs text-muted-foreground">La conversación aparecerá aquí.</p>
    </div>
  )
}
