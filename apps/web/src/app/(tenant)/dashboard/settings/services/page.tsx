import type { Metadata } from 'next'
import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { requireTenantContext } from '@/lib/auth/require-tenant-context'
import { ServicesSettingsForm } from './services-settings-form'
import { cn } from '@/lib/utils'

export const metadata: Metadata = { title: 'Servicios — Configuración — ReservaNex' }

// La pestaña sólo existe para gastronomía, así que la lista de tabs se arma
// según el rubro en vez de mostrar un link que para una inmobiliaria sería 404.
function tabsFor(vertical: string) {
  return [
    { href: '/dashboard/settings/business',     label: 'Negocio'                                     },
    { href: '/dashboard/settings/whatsapp',     label: 'WhatsApp'                                    },
    ...(vertical === 'food_service'
      ? [{ href: '/dashboard/settings/services', label: 'Servicios' }]
      : []),
    { href: '/dashboard/settings/payments',     label: 'Pagos'                                       },
    { href: '/dashboard/settings/bot',          label: 'Bot'                                         },
    { href: '/dashboard/settings/reservations', label: 'Reservas IA'                                 },
    { href: '/dashboard/settings/public-site',  label: 'Sitio público'                               },
  ]
}

export default async function ServicesSettingsPage() {
  const ctx = await requireTenantContext()

  // Owner solamente: qué modalidades ofrece el local es una decisión comercial,
  // del mismo orden que Pagos o Sitio público. can_access_settings no alcanza.
  if (ctx.role !== 'owner') redirect('/dashboard/attention')

  // Y sólo para gastronomía. Server-side, no por ocultar el tab.
  if (ctx.vertical !== 'food_service') notFound()

  const tabs = tabsFor(ctx.vertical)

  return (
    <div className="space-y-6">
      <nav className="flex flex-wrap gap-1 border-b">
        {tabs.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            className={cn(
              'rounded-t-md px-3 py-2 text-sm transition-colors',
              t.href === '/dashboard/settings/services'
                ? 'border-b-2 border-foreground font-medium text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      <div className="max-w-xl space-y-1">
        <h1 className="text-xl font-semibold">Servicios</h1>
        <p className="text-sm text-muted-foreground">
          Qué puede hacer un cliente desde tu sitio público. Podés cambiarlo cuando quieras.
        </p>
      </div>

      <ServicesSettingsForm initial={ctx.capabilities} />
    </div>
  )
}
