import { redirect } from 'next/navigation'
import type { TenantVertical } from '@orderflow/validators'
import { requireTenantContext } from './require-tenant-context'
import type { AccessMode } from './require-tenant-context'

export type OwnerContext = {
  userId:     string
  tenantId:   string
  accessMode: AccessMode
  // Fase 3E-C3A1 — el rubro del tenant, para no ofrecerle al owner permisos de
  // módulos que no existen para él.
  //
  // SIN roundtrip adicional: requireTenantContext() ya lo resolvió, y a su vez lo
  // sacó de la query de checkTenantAccess() que corre en todos los caminos. Acá
  // solo se deja de descartar. Este archivo no habla con la base.
  vertical:   TenantVertical
}

export async function requireOwner(): Promise<OwnerContext> {
  const ctx = await requireTenantContext()

  if (ctx.role !== 'owner') redirect('/dashboard')

  return {
    userId:     ctx.userId,
    tenantId:   ctx.tenantId,
    accessMode: ctx.accessMode,
    vertical:   ctx.vertical,
  }
}
