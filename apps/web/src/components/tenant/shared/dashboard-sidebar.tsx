'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { SettingsIcon, BotIcon, LogOutIcon } from 'lucide-react'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@orderflow/supabase/browser'
import type { TenantRole } from '@orderflow/types'
import type { TenantVertical, FoodCapabilities } from '@orderflow/validators'
import { COMING_SOON, visibleNavItems, type NavBadges } from '@/lib/dashboard/nav-items'
import { cn } from '@/lib/utils'

interface DashboardSidebarProps {
  role:              TenantRole
  canAccessSettings: boolean
  // Fase 3E-C3A1 — el rubro decide qué módulos existen para este tenant.
  vertical:          TenantVertical
  capabilities?:     FoodCapabilities | null
  isSetupOperator?:  boolean
  // Atención humana V2 — contadores por badgeKey, calculados una vez en el
  // layout con el cliente del usuario (RLS). Un badge sólo se pinta si > 0.
  badges?:           NavBadges
}

export function DashboardSidebar({ role, canAccessSettings, vertical, capabilities, isSetupOperator = false, badges }: DashboardSidebarProps) {
  const pathname   = usePathname()
  const router     = useRouter()
  const [loggingOut, setLoggingOut] = useState(false)

  // Misma función que usa el mobile nav, y que lee el mismo mapa de rubros que
  // el guard de ruta server-side. Sin esto, escritorio y celular podían mostrar
  // listas distintas.
  const navItems = visibleNavItems({ role, vertical, capabilities, isSetupOperator })
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
          {navItems.map(({ label, href, icon: Icon, badgeKey }) => {
            const isActive = pathname.startsWith(href)
            const badge    = badgeKey ? (badges?.[badgeKey] ?? 0) : 0
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
                <span className="flex-1 truncate">{label}</span>
                {badge > 0 && (
                  <span
                    className={cn(
                      'ml-auto inline-flex min-w-[1.375rem] items-center justify-center rounded-full px-1.5 text-[11px] font-semibold tabular-nums',
                      isActive ? 'bg-primary-foreground/20 text-primary-foreground' : 'bg-amber-500 text-white',
                    )}
                    aria-label={`${badge} pendientes`}
                  >
                    {badge > 99 ? '99+' : badge}
                  </span>
                )}
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
