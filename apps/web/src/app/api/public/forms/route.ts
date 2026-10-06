import { NextResponse, type NextRequest } from 'next/server'
import {
  createSubmissionRequestSchema,
  validateSubmissionPayload,
  isIntentAllowedForVertical,
  foodCapabilitiesFrom,
  canAcceptFoodOrders,
  isFulfillmentEnabled,
  tenantVerticalSchema,
  foodOrderResolvedPayloadSchema,
  type FoodOrderInput,
} from '@orderflow/validators'
import { getPublicTenant } from '@/lib/repositories/public-site.repository'
import {
  createSubmission,
  findSubmissionByIdempotencyKey,
  resolvePublicationContext,
} from '@/lib/forms/submissions.repository'
import { resolveFoodOrderCart, buildResolvedFoodOrderPayload } from '@/lib/forms/food-order-cart'
import { MAX_PUBLIC_POST_BODY_BYTES, readPublicJsonBody } from '@/lib/http/public-post-guard'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Fase 3A — POST /api/public/forms
//
// Endpoint PÚBLICO y anónimo: lo llama el formulario dinámico del sitio del
// tenant. Sigue el patrón ya establecido por /api/contact y
// /api/public/availability (ver la auditoría de Fase 3A).
//
// Reglas de seguridad que NO se negocian acá:
//  · el tenant se resuelve SIEMPRE server-side desde el slug público; un
//    tenant_id enviado por el browser sería confiar en el cliente para el
//    aislamiento multi-tenant;
//  · la validación del payload es server-side por intent — la del browser es
//    solo UX;
//  · la respuesta jamás devuelve ids internos, tenant_id ni el payload: solo
//    la referencia pública que el visitante necesita ver.
// Tope de body: MAX_PUBLIC_POST_BODY_BYTES (32 KiB en bytes UTF-8, ver
// lib/http/public-post-guard.ts). El tope de 25 líneas lo impone el schema, así
// que el pedido legítimo más grande (25 líneas con 300 caracteres de aclaración
// cada una, 1000 de observaciones y nombre y dirección al máximo) entra aunque
// cada carácter ocupe 3 bytes; route.test.ts lo mide en vez de suponerlo.
// Pasarse de 25 líneas es 422 por schema, no 413 por bytes: el mensaje tiene que
// decir cuál es la regla del producto, no cuánto pesó el request.

export async function POST(req: NextRequest) {
  try {
    // Content-Type, Sec-Fetch-Site y tamaño: todo antes de parsear y antes de
    // tocar la base. Ver lib/http/public-post-guard.ts.
    const guarded = await readPublicJsonBody(req, MAX_PUBLIC_POST_BODY_BYTES)
    if (!guarded.ok) {
      return NextResponse.json({ ok: false, reason: guarded.reason }, { status: guarded.status })
    }

    let body: unknown
    try {
      body = JSON.parse(guarded.raw)
    } catch {
      return NextResponse.json({ ok: false, reason: 'invalid_json' }, { status: 400 })
    }

    const parsed = createSubmissionRequestSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ ok: false, reason: 'invalid_request' }, { status: 422 })
    }
    const request = parsed.data

    // Resolución del tenant sin sesión. getPublicTenant ya exige public_slug,
    // no borrado, status trial/active y public_site_enabled.
    const tenant = await getPublicTenant(request.tenant_slug)
    if (!tenant) {
      return NextResponse.json({ ok: false, reason: 'not_found' }, { status: 404 })
    }

    // El intent tiene que corresponder al rubro del tenant: una inmobiliaria
    // no recibe reservas de mesa, ni un restaurante consultas de alquiler.
    // Sin esto, cualquiera podría postear un intent arbitrario a cualquier
    // tenant y ensuciarle los datos.
    const verticalParsed = tenantVerticalSchema.safeParse(tenant.vertical)
    const vertical = verticalParsed.success ? verticalParsed.data : 'real_estate'

    if (!isIntentAllowedForVertical(request.intent, vertical)) {
      return NextResponse.json({ ok: false, reason: 'intent_not_available' }, { status: 422 })
    }

    // ── Capacidades del local (food_service) ─────────────────────────────
    //
    // El browser NO es autoridad. Que la carta no muestre el carrito o esconda
    // el CTA de reservas es cortesía; lo que impide que entre una operación
    // deshabilitada es esto. Un POST armado a mano, un formulario viejo abierto
    // en otra pestaña o un bookmark llegan igual hasta acá.
    //
    // Se rechaza con el mismo 'intent_not_available' que el guard de vertical
    // de arriba: desde afuera son el mismo hecho —ese trámite no está
    // disponible en este tenant— y distinguirlos sólo le contaría a quien
    // sondea cómo está configurado el local.
    const caps = foodCapabilitiesFrom(tenant)

    if (request.intent === 'table_reservation' && !caps.tableReservations) {
      return NextResponse.json({ ok: false, reason: 'intent_not_available' }, { status: 422 })
    }

    if (request.intent === 'food_order' && !canAcceptFoodOrders(caps)) {
      return NextResponse.json({ ok: false, reason: 'intent_not_available' }, { status: 422 })
    }

    // general_inquiry no se toca: no tiene capability propia y sigue siendo la
    // vía de contacto aunque el local no tome pedidos ni reservas.

    // Validación real del payload, por intent. Devolvemos los errores por
    // campo para que el formulario pueda mostrarlos donde corresponde.
    const validation = validateSubmissionPayload(request.intent, request.payload)
    if (!validation.ok) {
      return NextResponse.json(
        { ok: false, reason: 'invalid_fields', errors: validation.errors },
        { status: 422 },
      )
    }

    // ── food_order: resolución canónica del carrito (Fase 3E-C3B1) ───────
    //
    // El resto de los intents no pasa por acá: su payload validado ES el que se
    // guarda. Para un pedido hay un paso más, porque lo que el browser mandó
    // (item_id + cantidad + expectativa de precio) no es lo que se persiste
    // (nombre, precio unitario, total de línea, moneda y subtotal, todo leído
    // del catálogo).
    let payloadFinal: Record<string, unknown> = validation.data

    if (request.intent === 'food_order') {
      const input = validation.data as unknown as FoodOrderInput

      // Y el fulfillment CONCRETO tiene que estar habilitado, no sólo alguno.
      // Un local que hace retiro pero no delivery no puede recibir un pedido
      // con envío porque alguien cambió el <select> en el inspector.
      if (!isFulfillmentEnabled(caps, input.fulfillment)) {
        return NextResponse.json(
          {
            ok: false,
            reason: 'invalid_fields',
            errors: { fulfillment: 'Esa forma de entrega no está disponible.' },
          },
          { status: 422 },
        )
      }

      // §9 — EL REINTENTO GANA SOBRE EL CATÁLOGO.
      //
      // Si esta clave de idempotencia ya creó una submission, se devuelve esa y
      // se termina acá, SIN mirar precios. El caso concreto: el cliente manda el
      // pedido, el dueño sube el precio cinco minutos después, y el browser
      // reintenta exactamente la misma request. Sin este short-circuit
      // responderíamos price_changed por un pedido que ya existe y ya está
      // confirmado a otro precio.
      //
      // createSubmission vuelve a chequear lo mismo (y el UNIQUE lo garantiza
      // ante concurrencia): esto es un adelanto del mismo chequeo, no otro.
      const yaCreada = await findSubmissionByIdempotencyKey(tenant.id, request.idempotency_key)
      if (yaCreada) {
        console.log('[forms] submission created', {
          tenantId:     tenant.id,
          intent:       request.intent,
          source:       request.source,
          reference:    yaCreada.reference,
          deduplicated: true,
        })
        // deduplicated: true va en el CUERPO, no solo en el status. El cliente
        // necesita el dato y deducirlo de un 200-vs-201 es un contrato implícito.
        return NextResponse.json(
          { ok: true, reference: yaCreada.reference, deduplicated: true },
          { status: 200 },
        )
      }

      const resolution = await resolveFoodOrderCart(tenant.id, input.items)

      if (!resolution.ok) {
        const f = resolution.failure

        if (f.code === 'price_changed') {
          // 409: no se crea nada. El browser actualiza TODAS las líneas de cada
          // item_id listado y obliga a revisar antes de reenviar.
          return NextResponse.json({
            ok:      false,
            code:    'price_changed',
            message: 'Algunos precios cambiaron. Revisá el carrito antes de continuar.',
            changes: f.changes,
          }, { status: 409 })
        }

        if (f.code === 'cart_changed') {
          // 409: tampoco se crea un pedido parcial ni se quitan líneas en
          // silencio. El motivo es uno solo a propósito (ver food-order-cart).
          return NextResponse.json({
            ok:      false,
            code:    'cart_changed',
            message: 'Algunos productos ya no están disponibles. Revisá el carrito.',
            items:   f.items,
          }, { status: 409 })
        }

        if (f.code === 'amount_too_large') {
          return NextResponse.json({
            ok:     false,
            reason: 'invalid_fields',
            errors: { _form: 'El total del pedido es demasiado grande.' },
          }, { status: 422 })
        }

        return NextResponse.json({ ok: false, reason: 'could_not_save' }, { status: 500 })
      }

      // El payload que se guarda lo arma el servidor campo por campo. El schema
      // resuelto es .strict(), así que si algo del browser se colara por una
      // ruta nueva, esto falla acá y no llega a la base.
      const armado = buildResolvedFoodOrderPayload(input, resolution.cart)
      const resuelto = foodOrderResolvedPayloadSchema.safeParse(armado)

      if (!resuelto.success) {
        console.error('[forms] el payload resuelto no valida', {
          tenantId: tenant.id,
          issues:   resuelto.error.issues.map((i) => i.path.join('.') || '_form'),
        })
        return NextResponse.json({ ok: false, reason: 'could_not_save' }, { status: 500 })
      }

      payloadFinal = resuelto.data as unknown as Record<string, unknown>
    }

    const context = await resolvePublicationContext(tenant.id, request.publication_ref)

    const result = await createSubmission({
      tenantId:       tenant.id,
      intent:         request.intent,
      source:         request.source,
      payload:        payloadFinal,
      idempotencyKey: request.idempotency_key,
      publicationRef: context.publicationRef,
      entityType:     context.entityType,
      entityId:       context.entityId,
    })

    if (!result.ok) {
      return NextResponse.json({ ok: false, reason: 'could_not_save' }, { status: 500 })
    }

    console.log('[forms] submission created', {
      tenantId:     tenant.id,
      intent:       request.intent,
      source:       request.source,
      reference:    result.submission.reference,
      deduplicated: result.deduplicated,
    })

    // Solo la referencia pública y si fue un reintento. Nada de id interno,
    // tenant_id ni payload. La forma está fijada por createSubmissionResponseSchema.
    return NextResponse.json(
      {
        ok:           true,
        reference:    result.submission.reference,
        deduplicated: result.deduplicated,
      },
      { status: result.deduplicated ? 200 : 201 },
    )
  } catch (err) {
    console.error('[forms] fatal error:', err instanceof Error ? err.message : String(err))
    return NextResponse.json({ ok: false, reason: 'server_error' }, { status: 500 })
  }
}
