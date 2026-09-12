'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  MessageSquareIcon,
  Users2Icon,
  Building2Icon,
  CheckSquareIcon,
  UsersIcon,
  CalendarIcon,
  BarChart3Icon,
  SettingsIcon,
  BotIcon,
  LogOutIcon,
  KeyRoundIcon,
  InboxIcon,
  CalendarClockIcon,
} from 'lucide-react'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@orderflow/supabase/browser'
import type { TenantRole } from '@orderflow/types'
import { cn } from '@/lib/utils'

const ALL_NAV_ITEMS = [
  { label: 'Conversaciones',       href: '/dashboard/conversations',    icon: MessageSquareIcon, ownerOnly: false, setupBlocked: true  },
  { label: 'Solicitudes',          href: '/dashboard/requests',         icon: InboxIcon,         ownerOnly: false, setupBlocked: true  },
  { label: 'Contactos',            href: '/dashboard/contacts',         icon: Users2Icon,        ownerOnly: false, setupBlocked: true  },
  { label: 'Propiedades',          href: '/dashboard/properties',       icon: Building2Icon,     ownerOnly: false, setupBlocked: false },
  { label: 'Reservas',             href: '/dashboard/reservations',     icon: CalendarIcon,      ownerOnly: false, setupBlocked: true  },
  { label: 'Visitas',              href: '/dashboard/visits',           icon: CalendarClockIcon, ownerOnly: false, setupBlocked: true  },
  { label: 'Alquileres mensuales', href: '/dashboard/monthly-rentals',  icon: KeyRoundIcon,      ownerOnly: false, setupBlocked: true  },
  { label: 'Tareas',               href: '/dashboard/tasks',            icon: CheckSquareIcon,   ownerOnly: false, setupBlocked: true  },
  { label: 'Usuarios',             href: '/dashboard/users',            icon: UsersIcon,         ownerOnly: true,  setupBlocked: false },
] as const satisfies readonly { label: string; href: string; icon: React.ElementType; ownerOnly: boolean; setupBlocked: boolean }[]

const COMING_SOON = [
  { label: 'Métricas', icon: BarChart3Icon },
] as const satisfies readonly { label: string; icon: React.ElementType }[]

interface DashboardSidebarProps {
  role:              TenantRole
  canAccessSettings: boolean
  isSetupOperator?:  boolean
}

export function DashboardSidebar({ role, canAccessSettings, isSetupOperator = false }: DashboardSidebarProps) {
  const pathname   = usePathname()
  const router     = useRouter()
  const [loggingOut, setLoggingOut] = useState(false)

  const navItems = ALL_NAV_ITEMS.filter((item) => {
    if (isSetupOperator && item.setupBlocked) return false
    if (item.ownerOnly && role !== 'owner') return false
    return true
  })
  const showSettings = isSetupOperator || role === 'owner' || canAccessSettings

  async function handleLogout() {
    setLoggingOut(true)
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  return (
    <aside className="hidden h-full w-56 shrink-0 flex-col border-r bg-background lg:flex">
      {/* Logo */}
      <div className="flex h-14 items-center gap-2.5 border-b px-4">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary">
          <BotIcon className="h-4 w-4 text-primary-foreground" />
        </div>
        <span className="text-sm font-semibold tracking-tight">ReservaNex</span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-2 py-2">
        <div className="space-y-0.5">
          {navItems.map(({ label, href, icon: Icon }) => {
            const isActive = pathname.startsWith(href)
            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {label}
              </Link>
            )
          })}
        </div>

        {/* Coming soon — hidden in setup mode to keep UI clean */}
        {!isSetupOperator && (
          <div className="mt-5">
            <p className="mb-1 px-3 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/35">
              Próximamente
            </p>
            <div className="space-y-0.5">
              {COMING_SOON.map(({ label, icon: Icon }) => (
                <div
                  key={label}
                  className="flex cursor-not-allowed items-center gap-2.5 rounded-md px-3 py-2 text-sm text-muted-foreground/35 select-none"
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {label}
                </div>
              ))}
            </div>
          </div>
        )}
      </nav>

      {/* Footer: settings + logout */}
      <div className="border-t px-2 py-2 space-y-0.5">
        {showSettings && (
          <Link
            href="/dashboard/settings/whatsapp"
            className={cn(
              'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors',
              pathname.startsWith('/dashboard/settings')
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            <SettingsIcon className="h-4 w-4 shrink-0" />
            Configuración
          </Link>
        )}

        <button
          onClick={handleLogout}
          disabled={loggingOut}
          className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
        >
          <LogOutIcon className="h-4 w-4 shrink-0" />
          {loggingOut ? 'Saliendo…' : 'Cerrar sesión'}
        </button>
      </div>
    </aside>
  )
}
