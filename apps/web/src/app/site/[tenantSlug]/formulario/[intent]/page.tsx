import { notFound } from 'next/navigation'
import { randomUUID } from 'node:crypto'
import {
  formIntentSchema,
  tenantVerticalSchema,
  isIntentAllowedForVertical,
  getFormDefinition,
} from '@orderflow/validators'
import { getPublicTenant } from '@/lib/repositories/public-site.repository'
import { DynamicForm } from '@/components/site/dynamic-form'

export const dynamic = 'force-dynamic'

// Fase 3A — /site/[tenantSlug]/formulario/[intent]
//
// Página pública y anónima. Resuelve el tenant desde el slug (nunca desde un
// id del cliente), valida que el intent exista Y corresponda al rubro del
// tenant, y renderiza el formulario dinámico.
//
// El contexto de publicación llega por ?ref=OF-XXXXXX (properties.public_code,
// que es lo que el sitio público ya emite en sus CTAs de WhatsApp). Se pasa
// tal cual al formulario; el servidor lo resuelve contra el tenant al guardar.
//
// Fase 3B agregará el envío por WhatsApp. Acá termina en un estado de éxito.

interface PageProps {
  params:       Promise<{ tenantSlug: string; intent: string }>
  searchParams: Promise<{ ref?: string }>
}

export async function generateMetadata({ params }: PageProps) {
  const { tenantSlug, intent } = await params
  const tenant = await getPublicTenant(tenantSlug)
  const parsedIntent = formIntentSchema.safeParse(intent)
  if (!tenant || !parsedIntent.success) return {}

  const definition = getFormDefinition({ intent: parsedIntent.data })
  return {
    title:       `${definition.title} · ${tenant.public_name ?? tenant.name}`,
    description: definition.description,
    // Un formulario con contexto de una publicación no aporta nada a un
    // buscador y no queremos que se indexe suelto.
    robots: { index: false, follow: false },
  }
}

export default async function FormPage({ params, searchParams }: PageProps) {
  const { tenantSlug, intent } = await params
  const { ref } = await searchParams

  const tenant = await getPublicTenant(tenantSlug)
  if (!tenant) notFound()

  // §21 J — un intent inexistente es 404, no un formulario vacío.
  const parsedIntent = formIntentSchema.safeParse(intent)
  if (!parsedIntent.success) notFound()

  // Y un intent que no corresponde al rubro tampoco existe para este tenant:
  // /formulario/table_reservation en una inmobiliaria es 404.
  const verticalParsed = tenantVerticalSchema.safeParse(tenant.vertical)
  const vertical = verticalParsed.success ? verticalParsed.data : 'real_estate'
  if (!isIntentAllowedForVertical(parsedIntent.data, vertical)) notFound()

  // Una clave de idempotencia por carga de página. Dos taps en "Enviar"
  // comparten clave (→ una sola submission); recargar la página da una nueva
  // (→ el visitante puede enviar una consulta genuinamente distinta).
  const idempotencyKey = randomUUID()

  return (
    <main className="mx-auto w-full max-w-lg px-4 py-8 sm:py-12">
      <DynamicForm
        tenantSlug={tenantSlug}
        intent={parsedIntent.data}
        publicationRef={ref ?? null}
        idempotencyKey={idempotencyKey}
      />
    </main>
  )
}
