'use client'

import { BellIcon } from 'lucide-react'
import type { NotificationRow } from '@orderflow/types'
import { NotificationItem } from './notification-item'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'

interface NotificationBellProps {
  notifications: NotificationRow[]
  unreadCount:   number
}

export function NotificationBell({ notifications, unreadCount }: NotificationBellProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative">
          <BellIcon className="h-5 w-5" />
          {unreadCount > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="border-b px-4 py-3">
          <h3 className="font-semibold">Notificaciones</h3>
          {unreadCount > 0 && (
            <p className="text-xs text-muted-foreground">{unreadCount} sin leer</p>
          )}
        </div>
        <ScrollArea className="h-[360px]">
          {notifications.length === 0 ? (
            <p className="p-4 text-center text-sm text-muted-foreground">No hay notificaciones</p>
          ) : (
            <div className="p-1">
              {notifications.map((n) => (
                <NotificationItem key={n.id} notification={n} />
              ))}
            </div>
          )}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  )
}
