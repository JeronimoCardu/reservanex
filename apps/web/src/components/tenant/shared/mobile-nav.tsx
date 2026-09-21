'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { MenuIcon, XIcon, BotIcon, LogOutIcon, SettingsIcon } from 'lucide-react'
import { createClient } from '@orderflow/supabase/browser'
import type { TenantRole } from '@orderflow/types'
import type { TenantVertical, FoodCapabilities } from '@orderflow/validators'
import { COMING_SOON, visibleNavItems } from '@/lib/dashboard/nav-items'
import { cn } from '@/lib/utils'

interface MobileNavProps {
  role:              TenantRole
  canAccessSettings: boolean
  // Fase 3E-C3A1 — ídem sidebar: la misma regla, no una copia de la regla.
  vertical:          TenantVertical
  capabilities?:     FoodCapabilities | null
  isSetupOperator?:  boolean
}

export function MobileNav({ role, canAccessSettings, vertical, capabilities, isSetupOperator = false }: MobileNavProps) {
  const pathname = usePathname()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)

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
    <>
      {/* Mobile top bar — hidden on lg+ (the desktop sidebar takes over) */}
      <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-background px-4 lg:hidden">
        <button
          onClick={() => setOpen(true)}
          className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Abrir menú"
        >
          <MenuIcon className="h-5 w-5" />
        </button>
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary">
            <BotIcon className="h-4 w-4 text-primary-foreground" />
          </div>
          <span className="text-sm font-semibold tracking-tight">ReservaNex</span>
        </div>
      </header>

      {/* Overlay + slide-in panel */}
      {open && (
        <>
          <div
            className="fixed inset-0 z-40 bg-background/80 backdrop-blur-sm"
            onClick={() => setOpen(false)}
          />
          <div className="fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r bg-background shadow-xl">
            {/* Panel header */}
            <div className="flex h-14 items-center justify-between border-b px-4">
              <div className="flex items-center gap-2">
                <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary">
                  <BotIcon className="h-4 w-4 text-primary-foreground" />
                </div>
                <span className="text-sm font-semibold tracking-tight">ReservaNex</span>
              </div>
              <button
                onClick={() => setOpen(false)}
                className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
                aria-label="Cerrar menú"
              >
                <XIcon className="h-4 w-4" />
              </button>
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
                      onClick={() => setOpen(false)}
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

            {/* Footer */}
            <div className="border-t px-2 py-2 space-y-0.5">
              {showSettings && (
                <Link
                  href="/dashboard/settings/whatsapp"
                  onClick={() => setOpen(false)}
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
          </div>
        </>
      )}
    </>
  )
}
