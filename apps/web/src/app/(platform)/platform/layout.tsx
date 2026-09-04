import Link from 'next/link'
import { redirect } from 'next/navigation'
import { requirePlatformContext } from '@/lib/auth/require-platform-context'
import { LogoutButton } from '@/components/auth/logout-button'
import { cn } from '@/lib/utils'

export default async function PlatformShellLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requirePlatformContext()
  if (!ctx) redirect('/login')

  const sa       = ctx.isSuperAdmin
  const operator = ctx.isOperator

  const navItems = sa
    ? [
        { href: '/platform',                  label: 'Resumen'       },
        { href: '/platform/tenants',          label: 'Inmobiliarias' },
        { href: '/platform/sellers',          label: 'Sellers'       },
        { href: '/platform/pending',          label: 'Pendientes'    },
        { href: '/platform/admin/cleanup',    label: 'Cleanup'       },
      ]
    : operator
    ? [
        { href: '/platform/setup', label: 'Mis setups' },
      ]
    : [
        { href: '/platform',             label: 'Mis inmobiliarias'  },
        { href: '/platform/tenants/new', label: 'Nueva inmobiliaria' },
        { href: '/platform/metrics',     label: 'Métricas'           },
      ]

  return (
    <div className="flex min-h-screen flex-col bg-muted/30">
      {/* Top bar */}
      <header className="sticky top-0 z-10 flex h-12 items-center justify-between border-b bg-background px-4">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold tracking-tight text-foreground">
            ReservaNex
</span>
          <span className="hidden h-4 w-px bg-border sm:block" />
          <span className="hidden text-xs text-muted-foreground sm:block capitalize">
            {sa ? 'Super Admin' : operator ? 'Operator' : 'Seller'} · {ctx.email}
          </span>
        </div>
        <LogoutButton />
      </header>

      <div className="flex flex-1">
        {/* Sidebar */}
        <nav className="hidden w-48 shrink-0 border-r bg-background py-4 sm:block">
          <ul className="space-y-0.5 px-2">
            {navItems.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={cn(
                    'flex items-center rounded-md px-3 py-2 text-sm font-medium',
                    'text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
                  )}
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        {/* Main content */}
        <main className="flex-1 overflow-auto p-6">
          {children}
        </main>
      </div>
    </div>
  )
}
