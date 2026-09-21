import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { requirePlatformContext } from '@/lib/auth/require-platform-context'
import { CreateTenantForm } from './create-tenant-form'

export const metadata: Metadata = { title: 'Nuevo cliente — ReservaNex' }

export default async function NewTenantPage() {
  const ctx = await requirePlatformContext()

  // Guard server-side, no sólo la acción.
  //
  // Antes esta página sólo pedía "ser alguien de plataforma", así que un
  // operator que escribía la URL veía el formulario entero, lo completaba y
  // recién al enviar descubría que no tenía permiso. La autorización real
  // siempre estuvo en createPlatformTenantAction —nunca hubo un agujero— pero
  // ofrecer una pantalla que no se puede usar es un defecto igual.
  //
  // 404 y no un mensaje de error: para un operator esta ruta no existe, que es
  // el mismo patrón que usa requireRouteVertical con los módulos que no
  // corresponden a un rubro.
  if (ctx.isOperator) notFound()

  return (
    <div className="max-w-lg space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Nuevo cliente</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          El owner no recibe invitación hasta que el onboarding esté completado.
        </p>
      </div>
      <CreateTenantForm />
    </div>
  )
}
