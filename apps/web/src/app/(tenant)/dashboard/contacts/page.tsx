import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { requireTenantContext } from '@/lib/auth/require-tenant-context'
import { listContacts } from '@/lib/repositories/contacts.repository'
import { ContactTable } from '@/components/tenant/contacts/contact-table'

export const metadata: Metadata = {
  title: 'Contactos — ReservaNex',
}

export default async function ContactsPage() {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') redirect('/dashboard')

  const contacts = await listContacts(ctx.tenantId)

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="border-b bg-background px-6 py-4">
        <h1 className="text-lg font-semibold">Contactos</h1>
        <p className="text-xs text-muted-foreground">
          {contacts.length} contacto{contacts.length !== 1 ? 's' : ''}
        </p>
      </div>
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <ContactTable contacts={contacts} currentRole={ctx.role} />
      </div>
    </div>
  )
}
