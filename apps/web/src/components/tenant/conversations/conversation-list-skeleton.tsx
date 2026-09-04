import { Skeleton } from '@/components/ui/skeleton'

function SkeletonRow() {
  return (
    <div className="flex items-start gap-3 border-l-4 border-transparent px-4 py-3">
      <Skeleton className="mt-0.5 h-9 w-9 shrink-0 rounded-full" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <Skeleton className="h-3.5 w-24 rounded" />
          <Skeleton className="h-3 w-10 rounded" />
        </div>
        <Skeleton className="h-3 w-48 rounded" />
        <Skeleton className="h-3 w-16 rounded" />
      </div>
    </div>
  )
}

export function ConversationListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="divide-y">
      {Array.from({ length: rows }).map((_, i) => (
        <SkeletonRow key={i} />
      ))}
    </div>
  )
}
