import { ConversationListSkeleton } from '@/components/tenant/conversations/conversation-list-skeleton'

// This wraps the page slot (right panel) while conversations/layout.tsx is streaming.
// The sidebar is rendered by the layout, so we only need to cover the right panel here.
export default function ConversationsLoading() {
  return (
    <div className="flex h-full overflow-hidden">
      {/* Left panel skeleton */}
      <div className="hidden shrink-0 flex-col border-r bg-background lg:flex lg:w-80">
        <div className="border-b px-4 py-3 space-y-2.5">
          <div className="flex items-center justify-between">
            <div className="h-4 w-32 animate-pulse rounded bg-muted" />
            <div className="h-3 w-6 animate-pulse rounded bg-muted" />
          </div>
          <div className="h-8 animate-pulse rounded-md bg-muted" />
          <div className="flex gap-1">
            <div className="h-6 w-14 animate-pulse rounded-md bg-muted" />
            <div className="h-6 w-18 animate-pulse rounded-md bg-muted" />
            <div className="h-6 w-16 animate-pulse rounded-md bg-muted" />
          </div>
        </div>
        <ConversationListSkeleton rows={7} />
      </div>
      {/* Right panel: empty state placeholder */}
      <main className="flex min-w-0 flex-1 flex-col items-center justify-center">
        <div className="h-10 w-10 animate-pulse rounded-full bg-muted/40" />
      </main>
    </div>
  )
}
