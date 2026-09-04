import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { requireTenantContext } from '@/lib/auth/require-tenant-context'
import { getReservationSettingsAction } from '@/actions/ai-settings'
import { ReservationSettingsForm } from './reservation-settings-form'
import { cn } from '@/lib/utils'

export const metadata: Metadata = { title: 'Reservas — Configuración — ReservaNex' }

const TABS = [
  { href: '/dashboard/settings/business',     label: 'Negocio',       ownerOnly: false },
  { href: '/dashboard/settings/whatsapp',     label: 'WhatsApp',      ownerOnly: false },
  { href: '/dashboard/settings/payments',     label: 'Pagos',         ownerOnly: true  },
  { href: '/dashboard/settings/bot',          label: 'Bot',           ownerOnly: true  },
  { href: '/dashboard/settings/reservations', label: 'Reservas IA',   ownerOnly: true  },
  { href: '/dashboard/settings/public-site',  label: 'Sitio público', ownerOnly: true  },
]

export default async function ReservationSettingsPage() {
  const ctx = await requireTenantContext()

  if (ctx.role !== 'owner') redirect('/dashboard/conversations')

  const result = await getReservationSettingsAction()
  const settings = result.success ? result.data! : { hold_hours: 24 }

  return (
    <div className="flex flex-col overflow-hidden h-full">
      {/* Settings sub-nav */}
      <div className="border-b bg-background">
        <div className="flex gap-1 px-6 pt-4 overflow-x-auto">
          {TABS.filter(t => !t.ownerOnly || ctx.role === 'owner').map(t => (
            <Link
              key={t.href}
              href={t.href}
              className={cn(
                'px-3 py-1.5 text-sm font-medium rounded-t-sm transition-colors border-b-2 whitespace-nowrap',
                t.href === '/dashboard/settings/reservations'
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {t.label}
            </Link>
          ))}
        </div>
      </div>

      <div className="border-b bg-background px-6 py-4">
        <h1 className="text-lg font-semibold">Configuración de reservas por IA</h1>
        <p className="text-xs text-muted-foreground">
          Controlá cómo la IA gestiona reservas automáticas en las conversaciones.
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-6">
        <ReservationSettingsForm settings={settings} />
      </div>
    </div>
  )
}
