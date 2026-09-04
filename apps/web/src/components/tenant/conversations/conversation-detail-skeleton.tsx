import { Skeleton } from '@/components/ui/skeleton'

export function ConversationDetailSkeleton() {
  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b bg-background px-4 py-3">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <Skeleton className="h-8 w-8 rounded-md" />
            <div className="space-y-1.5">
              <Skeleton className="h-4 w-32 rounded" />
              <Skeleton className="h-3 w-20 rounded" />
            </div>
          </div>
          <div className="flex gap-2">
            <Skeleton className="h-8 w-20 rounded-md" />
            <Skeleton className="h-8 w-20 rounded-md" />
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Messages */}
        <div className="flex flex-1 flex-col gap-3 overflow-hidden p-4">
          <div className="flex flex-col gap-3 flex-1">
            <div className="flex items-end gap-2">
              <Skeleton className="h-16 w-48 rounded-2xl rounded-bl-sm" />
            </div>
            <div className="flex flex-col items-end gap-2">
              <Skeleton className="h-12 w-56 rounded-2xl rounded-br-sm" />
            </div>
            <div className="flex items-end gap-2">
              <Skeleton className="h-20 w-64 rounded-2xl rounded-bl-sm" />
            </div>
            <div className="flex flex-col items-end gap-2">
              <Skeleton className="h-14 w-40 rounded-2xl rounded-br-sm" />
            </div>
            <div className="flex items-end gap-2">
              <Skeleton className="h-10 w-36 rounded-2xl rounded-bl-sm" />
            </div>
          </div>
          {/* Input area */}
          <div className="border-t pt-3">
            <Skeleton className="h-16 w-full rounded-md" />
          </div>
        </div>

        {/* Sidebar */}
        <div className="hidden w-80 border-l p-3 lg:flex lg:flex-col gap-3">
          <Skeleton className="h-8 w-full rounded-md" />
          <Skeleton className="h-24 w-full rounded-md" />
          <Skeleton className="h-24 w-full rounded-md" />
        </div>
      </div>
    </div>
  )
}
