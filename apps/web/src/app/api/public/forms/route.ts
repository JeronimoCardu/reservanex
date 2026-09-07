import { NextResponse, type NextRequest } from 'next/server'
import {
  createSubmissionRequestSchema,
  validateSubmissionPayload,
  isIntentAllowedForVertical,
  tenantVerticalSchema,
} from '@orderflow/validators'
import { getPublicTenant } from '@/lib/repositories/public-site.repository'
import { createSubmission, resolvePublicationContext } from '@/lib/forms/submissions.repository'

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
const MAX_BODY_BYTES = 20_000

export async function POST(req: NextRequest) {
  try {
    const raw = await req.text()
    if (raw.length > MAX_BODY_BYTES) {
      return NextResponse.json({ ok: false, reason: 'payload_too_large' }, { status: 413 })
    }

    let body: unknown
    try {
      body = JSON.parse(raw)
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

    // Validación real del payload, por intent. Devolvemos los errores por
    // campo para que el formulario pueda mostrarlos donde corresponde.
    const validation = validateSubmissionPayload(request.intent, request.payload)
    if (!validation.ok) {
      return NextResponse.json(
        { ok: false, reason: 'invalid_fields', errors: validation.errors },
        { status: 422 },
      )
    }

    const context = await resolvePublicationContext(tenant.id, request.publication_ref)

    const result = await createSubmission({
      tenantId:       tenant.id,
      intent:         request.intent,
      source:         request.source,
      payload:        validation.data,
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

    // Solo la referencia pública. Nada de id interno, tenant_id ni payload.
    return NextResponse.json(
      { ok: true, reference: result.submission.reference },
      { status: result.deduplicated ? 200 : 201 },
    )
  } catch (err) {
    console.error('[forms] fatal error:', err instanceof Error ? err.message : String(err))
    return NextResponse.json({ ok: false, reason: 'server_error' }, { status: 500 })
  }
}
