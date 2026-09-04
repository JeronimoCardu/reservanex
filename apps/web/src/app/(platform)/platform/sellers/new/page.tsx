import type { Metadata } from 'next'
import Link from 'next/link'
import { requireSuperAdmin } from '@/lib/auth/require-platform-context'
import { CreateSellerForm } from './create-seller-form'

export const metadata: Metadata = { title: 'Nuevo seller — ReservaNex' }

export default async function NewSellerPage() {
  await requireSuperAdmin()

  return (
    <div className="max-w-md space-y-5">
      <div>
        <Link href="/platform/sellers" className="text-xs text-muted-foreground hover:underline">
          ← Sellers
        </Link>
        <h1 className="mt-1 text-xl font-semibold">Nuevo seller</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Se envía una invitación por email al seller para que active su cuenta.
        </p>
      </div>

      <CreateSellerForm />
    </div>
  )
}
