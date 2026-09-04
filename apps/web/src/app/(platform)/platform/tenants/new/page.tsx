import type { Metadata } from 'next'
import { requirePlatformContext } from '@/lib/auth/require-platform-context'
import { CreateTenantForm } from './create-tenant-form'

export const metadata: Metadata = { title: 'Nueva inmobiliaria — ReservaNex' }

export default async function NewTenantPage() {
  await requirePlatformContext()

  return (
    <div className="max-w-lg space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Nueva inmobiliaria</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          El owner no recibe invitación hasta que el onboarding esté completado.
        </p>
      </div>
      <CreateTenantForm />
    </div>
  )
}
