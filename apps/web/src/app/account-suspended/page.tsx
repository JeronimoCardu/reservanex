import type { Metadata } from 'next'
import { requireTenantUser } from '@/lib/auth/require-tenant-context'
import { LogoutButton } from '@/components/auth/logout-button'

export const metadata: Metadata = { title: 'Cuenta suspendida — ReservaNex' }

export default async function AccountSuspendedPage() {
  // Confirms the visitor is a legitimate tenant user.
  // Intentionally does NOT check tenant.status to avoid a redirect loop.
  await requireTenantUser()

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="max-w-sm w-full space-y-6 text-center">
        <div className="space-y-2">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-destructive/10">
            <svg
              className="h-7 w-7 text-destructive"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"
              />
            </svg>
          </div>
          <h1 className="text-xl font-semibold">Cuenta no disponible</h1>
          <p className="text-sm text-muted-foreground">
            La cuenta de esta inmobiliaria está suspendida o cancelada.
            Contactá al administrador de ReservaNex para más información.
          </p>
        </div>

        <div className="rounded-lg border bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
          Si creés que esto es un error, contactá a soporte.
        </div>

        <LogoutButton />
      </div>
    </div>
  )
}
