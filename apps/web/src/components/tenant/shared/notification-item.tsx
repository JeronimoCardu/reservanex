'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { markNotificationReadAction } from '@/actions/notifications'
import type { NotificationRow } from '@orderflow/types'
import { ClientTimeAgo } from './client-time-ago'
import { cn } from '@/lib/utils'

interface NotificationItemProps {
  notification: NotificationRow
}

export function NotificationItem({ notification }: NotificationItemProps) {
  const [isPending, startTransition] = useTransition()
  const router = useRouter()

  const isUnread = notification.read_at === null

  // Notifications store content in payload JSON (no dedicated title/body columns)
  const payload = notification.payload as { title?: string; body?: string } | null
  const title   = payload?.title ?? notification.type
  const body    = payload?.body

  function handleClick() {
    if (!isUnread || isPending) return
    startTransition(async () => {
      const result = await markNotificationReadAction(notification.id)
      if (!result.success) toast.error(result.error)
      else router.refresh()
    })
  }

  return (
    <div
      role="button"
      tabIndex={isUnread ? 0 : -1}
      onClick={handleClick}
      onKeyDown={(e) => e.key === 'Enter' && handleClick()}
      className={cn(
        'flex cursor-default items-start gap-3 rounded-md px-3 py-2 text-sm',
        isUnread && 'cursor-pointer bg-primary/5 hover:bg-primary/10',
        isPending && 'opacity-60',
      )}
    >
      {isUnread && (
        <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" aria-hidden />
      )}
      <div className={cn('flex-1', !isUnread && 'ml-5')}>
        <p className={cn(isUnread ? 'font-medium' : 'text-muted-foreground')}>
          {title}
        </p>
        {body && (
          <p className="text-xs text-muted-foreground line-clamp-2">{body}</p>
        )}
        <ClientTimeAgo date={notification.created_at} className="mt-0.5 block text-xs text-muted-foreground" />
      </div>
    </div>
  )
}
