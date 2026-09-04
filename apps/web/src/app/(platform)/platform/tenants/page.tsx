import type { Metadata } from 'next'
import Link from 'next/link'
import { requirePlatformContext } from '@/lib/auth/require-platform-context'
import * as repo from '@/lib/repositories/platform.repository'
import { StatusBadge, isDelayed } from '@/components/platform/onboarding-badge'

export const metadata: Metadata = { title: 'Inmobiliarias — ReservaNex' }

export default async function TenantsPage() {
  const ctx = await requirePlatformContext()

  const tenants = ctx.isSuperAdmin
    ? await repo.listAllTenants()
    : await repo.listSellerTenants(ctx.userId)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">
            {ctx.isSuperAdmin ? 'Todas las inmobiliarias' : 'Mis inmobiliarias'}
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">{tenants.length} en total</p>
        </div>
        <Link
          href="/platform/tenants/new"
          className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          + Nueva
        </Link>
      </div>

      {tenants.length === 0 ? (
        <div className="rounded-lg border bg-background py-12 text-center text-sm text-muted-foreground">
          No hay inmobiliarias todavía.{' '}
          <Link href="/platform/tenants/new" className="underline">
            Crear la primera.
          </Link>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-background">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40">
              <tr>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Nombre</th>
                {ctx.isSuperAdmin && (
                  <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Seller</th>
                )}
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Owner prospecto</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Onboarding</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Estado</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Creada</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground"></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {tenants.map((t) => {
                const delayed = isDelayed(t.created_at, t.onboarding_status)
                const ageHours = Math.floor((Date.now() - new Date(t.created_at).getTime()) / 36e5)
                return (
                  <tr key={t.id} className="hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{t.name}</span>
                        {delayed && (
                          <span className="rounded-full bg-yellow-100 px-1.5 py-0.5 text-xs font-medium text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300">
                            Demorado
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">{t.slug}</div>
                    </td>
                    {ctx.isSuperAdmin && (
                      <td className="px-4 py-3 text-muted-foreground">
                        {(t.seller as { name?: string } | null)?.name ?? <span className="italic">Sin asignar</span>}
                      </td>
                    )}
                    <td className="px-4 py-3">
                      {t.primary_owner_name
                        ? <div>
                            <div className="font-medium">{t.primary_owner_name}</div>
                            <div className="text-xs text-muted-foreground">{t.primary_owner_email}</div>
                          </div>
                        : <span className="text-muted-foreground italic text-xs">Sin datos</span>
                      }
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={t.onboarding_status} type="onboarding" />
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={t.status} type="tenant" />
                    </td>
                    <td className="px-4 py-3 text-muted-foreground text-xs">
                      <div>{new Date(t.created_at).toLocaleDateString('es-AR')}</div>
                      <div>{ageHours < 24 ? `Hace ${ageHours}h` : `Hace ${Math.floor(ageHours/24)}d`}</div>
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/platform/tenants/${t.id}`}
                        className="rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-muted"
                      >
                        Ver
                      </Link>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
