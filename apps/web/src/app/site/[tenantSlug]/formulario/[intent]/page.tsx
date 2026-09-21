import { notFound, redirect } from 'next/navigation'
import { randomUUID } from 'node:crypto'
import {
  formIntentSchema,
  tenantVerticalSchema,
  isIntentAllowedForVertical,
  getFormDefinition,
  foodCapabilitiesFrom,
} from '@orderflow/validators'
import {
  getPublicTenant,
  getTenantAutoResponderWhatsApp,
} from '@/lib/repositories/public-site.repository'
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

  // Un pedido NO se arma en este formulario genérico (cierre food_service).
  //
  // food_order es el único intent cuyo payload no lo escribe el visitante campo
  // por campo: las líneas salen del carrito, con los precios que congeló el
  // servidor. DynamicForm no tiene forma de producir `items`, así que esta
  // página renderizaba un formulario que fallaba con 422 SIEMPRE, y el error
  // caía bajo la clave `items` —que no es un campo dibujado— dejando al
  // visitante con "Revisá los campos marcados" y nada marcado.
  //
  // No es 404: la URL existe y el tenant también. Lo que no existe es este
  // camino hacia un pedido. El único flujo soportado es carta → carrito →
  // checkout, así que un favorito viejo termina en la carta y puede seguir.
  //
  // Redirect temporal, no permanente: un 308 se le queda cacheado al navegador
  // para siempre y volverlo atrás —si algún día food_order tiene página propia—
  // sería imposible sin cambiar la URL.
  //
  // Va DESPUÉS del guard de vertical a propósito: /formulario/food_order en una
  // inmobiliaria sigue siendo 404, no un redirect a una carta que no tiene.
  if (parsedIntent.data === 'food_order') redirect(`/site/${tenantSlug}`)

  // Las capacidades del local también cierran rutas, no sólo esconden botones.
  //
  // table_reservation es 404 —no un redirect— cuando el local no toma
  // reservas: a diferencia de food_order, acá no hay a dónde mandar a la
  // persona que sirva para lo mismo. Es el patrón de fallar cerrado que ya usa
  // el guard de vertical dos líneas más arriba.
  //
  // Apagar la capacidad NO borra reservas históricas ni altera su ciclo de
  // vida: sólo impide que entren nuevas.
  const caps = foodCapabilitiesFrom(tenant)
  if (parsedIntent.data === 'table_reservation' && !caps.tableReservations) notFound()

  // general_inquiry no tiene capacidad propia y queda siempre disponible.

  // Una clave de idempotencia por carga de página. Dos taps en "Enviar"
  // comparten clave (→ una sola submission); recargar la página da una nueva
  // (→ el visitante puede enviar una consulta genuinamente distinta).
  const idempotencyKey = randomUUID()

  // Fase 3B — el WhatsApp al que sigue la conversación después de enviar.
  // Se resuelve acá, en el servidor, y NUNCA se inventa: si el tenant no tiene
  // una cuenta AutoResponder activa esto es null y el formulario muestra un
  // estado controlado en lugar de un link roto (§2).
  const whatsappNumber = await getTenantAutoResponderWhatsApp(tenant.id)

  return (
    <main className="mx-auto w-full max-w-lg px-4 py-8 sm:py-12">
      <DynamicForm
        tenantSlug={tenantSlug}
        intent={parsedIntent.data}
        publicationRef={ref ?? null}
        idempotencyKey={idempotencyKey}
        whatsappNumber={whatsappNumber}
      />
    </main>
  )
}
