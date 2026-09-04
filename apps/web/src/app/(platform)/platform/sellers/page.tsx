import type { Metadata } from 'next'
import Link from 'next/link'
import { requireSuperAdmin } from '@/lib/auth/require-platform-context'
import * as repo from '@/lib/repositories/platform.repository'
import { ToggleSellerButton } from './toggle-seller-button'
import { ResendSellerButton } from './resend-seller-button'

export const metadata: Metadata = { title: 'Sellers — ReservaNex' }

export default async function SellersPage() {
  await requireSuperAdmin()

  const [sellers, tenants] = await Promise.all([
    repo.listSellers(),
    repo.listAllTenants(),
  ])

  const tenantsBySeller = tenants.reduce<Record<string, { total: number; delivered: number; pending: number }>>((acc, t) => {
    const sid = t.assigned_seller_id
    if (!sid) return acc
    if (!acc[sid]) acc[sid] = { total: 0, delivered: 0, pending: 0 }
    acc[sid]!.total++
    if (t.onboarding_status === 'delivered')       acc[sid]!.delivered++
    if (t.onboarding_status === 'pending_review')   acc[sid]!.pending++
    return acc
  }, {})

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Sellers</h1>
          <p className="text-sm text-muted-foreground mt-0.5">{sellers.length} en total</p>
        </div>
        <Link
          href="/platform/sellers/new"
          className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          + Nuevo seller
        </Link>
      </div>

      {sellers.length === 0 ? (
        <div className="rounded-lg border bg-background py-12 text-center text-sm text-muted-foreground">
          No hay sellers todavía.{' '}
          <Link href="/platform/sellers/new" className="underline">Crear el primero.</Link>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-background">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40">
              <tr>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Nombre</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Email</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Total</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Entregadas</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Pendientes</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Estado</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Alta</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground"></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {sellers.map((s) => {
                const stats = tenantsBySeller[s.id] ?? { total: 0, delivered: 0, pending: 0 }
                return (
                  <tr key={s.id} className="hover:bg-muted/30">
                    <td className="px-4 py-3 font-medium">{s.name}</td>
                    <td className="px-4 py-3 text-muted-foreground">{s.email}</td>
                    <td className="px-4 py-3 tabular-nums">{stats.total}</td>
                    <td className="px-4 py-3 tabular-nums">{stats.delivered}</td>
                    <td className="px-4 py-3 tabular-nums">{stats.pending}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                        s.active
                          ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
                          : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'
                      }`}>
                        {s.active ? 'Activo' : 'Inactivo'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {new Date(s.created_at).toLocaleDateString('es-AR')}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {s.active && (
                          <ResendSellerButton sellerId={s.id} email={s.email} />
                        )}
                        <ToggleSellerButton sellerId={s.id} active={s.active} name={s.name} />
                      </div>
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
