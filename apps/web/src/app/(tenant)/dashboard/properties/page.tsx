import type { Metadata } from 'next'
import { requireTenantContext } from '@/lib/auth/require-tenant-context'
import { listProperties } from '@/lib/repositories/properties.repository'
import { PropertyTable } from '@/components/tenant/properties/property-table'

export const metadata: Metadata = {
  title: 'Propiedades — ReservaNex',
}

export default async function PropertiesPage() {
  const ctx        = await requireTenantContext()
  const properties = await listProperties(ctx.tenantId)

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="border-b bg-background px-6 py-4">
        <h1 className="text-lg font-semibold">Propiedades</h1>
        <p className="text-xs text-muted-foreground">
          {properties.filter((p) => p.status !== 'archived').length} propiedad
          {properties.filter((p) => p.status !== 'archived').length !== 1 ? 'es' : ''}
        </p>
      </div>
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <PropertyTable
          properties={properties}
          currentRole={ctx.role}
          canCreateProperties={ctx.canCreateProperties}
        />
      </div>
    </div>
  )
}
