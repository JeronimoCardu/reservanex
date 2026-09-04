import type { Metadata } from 'next'
import { redirect }      from 'next/navigation'
import Link              from 'next/link'
import { requireTenantContext }  from '@/lib/auth/require-tenant-context'
import { getBotSettingsAction }  from '@/actions/tenant-settings'
import { BotSettingsForm }       from './bot-settings-form'
import { cn }                    from '@/lib/utils'

export const metadata: Metadata = { title: 'Bot — Configuración — ReservaNex' }

const TABS = [
  { href: '/dashboard/settings/business',     label: 'Negocio',       ownerOnly: false },
  { href: '/dashboard/settings/whatsapp',     label: 'WhatsApp',      ownerOnly: false },
  { href: '/dashboard/settings/payments',     label: 'Pagos',         ownerOnly: true  },
  { href: '/dashboard/settings/bot',          label: 'Bot',           ownerOnly: true  },
  { href: '/dashboard/settings/reservations', label: 'Reservas IA',   ownerOnly: true  },
  { href: '/dashboard/settings/public-site',  label: 'Sitio público', ownerOnly: true  },
]

export default async function BotSettingsPage() {
  const ctx = await requireTenantContext()
  if (ctx.role !== 'owner') redirect('/dashboard/conversations')

  const result   = await getBotSettingsAction()
  const settings = result.success ? result.data! : null

  return (
    <div className="flex flex-col overflow-hidden h-full">
      <div className="border-b bg-background">
        <div className="flex gap-1 px-6 pt-4 overflow-x-auto">
          {TABS.filter(t => !t.ownerOnly || ctx.role === 'owner').map(t => (
            <Link
              key={t.href}
              href={t.href}
              className={cn(
                'px-3 py-1.5 text-sm font-medium rounded-t-sm transition-colors border-b-2 whitespace-nowrap',
                t.href === '/dashboard/settings/bot'
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
        <h1 className="text-lg font-semibold">Bot</h1>
        <p className="text-xs text-muted-foreground">
          Configurá la personalidad y comportamiento del asistente de IA.
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-6">
        {settings ? (
          <BotSettingsForm settings={settings} />
        ) : (
          <p className="text-sm text-muted-foreground">No se pudo cargar la configuración del bot.</p>
        )}
      </div>
    </div>
  )
}
