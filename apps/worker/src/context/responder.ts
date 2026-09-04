import { createClient } from '../lib/supabase'
import { callLLM, addUsage } from '../lib/llm'
import type { LLMMessage, LLMResult, LLMUsage } from '../lib/llm'
import type { MessageContext } from './builder'
import { searchPropertiesTool, executeSearchProperties }                           from '../tools/search-properties'
import { searchPropertiesForReservationTool, executeSearchPropertiesForReservation } from '../tools/search-properties-for-reservation'
import { escalateToHumanTool, executeEscalateToHuman }                             from '../tools/escalate-to-human'
import { createPendingReservationTool, executeCreatePendingReservation }           from '../tools/create-pending-reservation'
import { cancelRecentReservationTool, executeCancelRecentReservation }             from '../tools/cancel-recent-reservation'
import { checkPropertyAvailabilityTool, executeCheckPropertyAvailability }         from '../tools/check-property-availability'
import { findNextAvailableDatesTool, executeFindNextAvailableDates }               from '../tools/find-next-available-dates'
import { sendPublicCatalogLinkTool, executeSendPublicCatalogLink }                 from '../tools/send-public-catalog-link'
import { sendPropertyLinkTool, executeSendPropertyLink }                           from '../tools/send-property-link'
import { sendPaymentDataTool, executeSendPaymentData }                             from '../tools/send-payment-data'
import { saveContactNameTool, executeSaveContactName }                             from '../tools/save-contact-name'
import { findDateMismatches, buildMismatchReply }                                  from '../tools/date-preprocessor'

const DEFAULT_SYSTEM_PROMPT =
  'Eres un asistente de atención al cliente. Responde de forma clara, amable y concisa.'

// Applied when the tenant has no escalation_keywords configured.
// Owners can override these via the bot settings UI.
const DEFAULT_ESCALATION_KEYWORDS = [
  'quiero ayuda',
  'necesito ayuda',
  'necesito que me ayuden',
  'quiero hablar con alguien',
  'quiero hablar con un humano',
  'hablar con humano',
  'persona real',
  'asesor',
  'asesora',
  'atención humana',
  'me pueden llamar',
  'llamame',
  'llámenme',
]

const BASE_TOOLS = [
  searchPropertiesForReservationTool,
  checkPropertyAvailabilityTool,
  findNextAvailableDatesTool,
  searchPropertiesTool,
  escalateToHumanTool,
  createPendingReservationTool,
  cancelRecentReservationTool,
  sendPaymentDataTool,
]

// ── Bot configuration helpers ─────────────────────────────────────────────────

const TONE_INSTRUCTIONS: Record<string, string> = {
  professional: 'Respondé de manera profesional, clara y concisa. Evitá jerga informal.',
  friendly:     'Respondé con un tono cercano, amable y conversacional, manteniendo claridad.',
  premium:      'Respondé con un tono formal, elegante y cuidado. Transmití confianza y exclusividad.',
  casual:       'Respondé de forma natural y descontracturada, sin perder precisión.',
}

function buildBotConfigSection(
  assistantName: string,
  tenantName:    string,
  tone:          string,
  useEmojis:     boolean,
): string {
  const toneInstruction  = TONE_INSTRUCTIONS[tone] ?? TONE_INSTRUCTIONS['professional']!
  const emojiInstruction = useEmojis
    ? 'Podés usar emojis moderadamente cuando ayuden a que el mensaje sea más claro o amable.'
    : 'No uses emojis en tus respuestas.'
  return [
    `Tu nombre es ${assistantName}. Representás a la inmobiliaria "${tenantName}".`,
    toneInstruction,
    emojiInstruction,
  ].join('\n')
}

// Case-insensitive substring match — trim both sides, skip empty keywords.
function containsEscalationKeyword(text: string, keywords: string[]): string | null {
  const normalizedText = text.toLowerCase().trim()
  for (const kw of keywords) {
    const normalized = kw.toLowerCase().trim()
    if (normalized.length > 0 && normalizedText.includes(normalized)) return normalized
  }
  return null
}

function buildCurrentDateContext(): string {
  const now        = new Date()
  const pad        = (n: number) => String(n).padStart(2, '0')
  const yyyy       = now.getFullYear()
  const mm         = pad(now.getMonth() + 1)
  const dd         = pad(now.getDate())
  const todayStr   = `${yyyy}-${mm}-${dd}`

  const tom        = new Date(now.getTime() + 86400000)
  const tomorrowStr = `${tom.getFullYear()}-${pad(tom.getMonth() + 1)}-${pad(tom.getDate())}`

  const dat        = new Date(now.getTime() + 2 * 86400000)
  const dayAfterStr = `${dat.getFullYear()}-${pad(dat.getMonth() + 1)}-${pad(dat.getDate())}`

  return [
    `FECHA_HOY: ${todayStr}`,
    `AÑO_ACTUAL: ${yyyy}`,
    `Resolución de fechas (usá siempre estas referencias):`,
    `  - "hoy" = ${todayStr}`,
    `  - "mañana" = ${tomorrowStr}`,
    `  - "pasado mañana" = ${dayAfterStr}`,
    `  - Si el cliente menciona un día y mes SIN año (ej: "18 de julio"), usá ${yyyy}. Si esa fecha ya pasó en ${yyyy}, usá ${yyyy + 1}.`,
    `  - NUNCA uses un año anterior a ${yyyy}. Si la herramienta devuelve PAST_DATE_NOT_ALLOWED, es porque el año elegido era incorrecto — corregilo y volvé a intentar con el año ${yyyy} o ${yyyy + 1}.`,
    `  - NUNCA intentes verificar o calcular días de semana vos mismo. El sistema ya validó las fechas antes de que llegue el mensaje aquí — si el flujo llegó hasta acá, los días mencionados son correctos.`,
  ].join('\n')
}

export async function generateAIReply(ctx: MessageContext): Promise<LLMResult | null> {
  const supabase = createClient()

  // 0. Check conversation mode — escalate_to_human sets ai_mode='manual'; skip AI response.
  const { data: conv } = await supabase
    .from('conversations')
    .select('ai_mode')
    .eq('id', ctx.conversationId)
    .eq('tenant_id', ctx.tenantId)
    .single()

  if (conv && conv.ai_mode !== 'autonomous') {
    console.log('[responder] conversation not in autonomous mode — skipping AI', {
      conversationId: ctx.conversationId,
      aiMode:         conv.ai_mode,
    })
    return null
  }

  console.log('[worker:responder:v3]', { tenantId: ctx.tenantId, conversationId: ctx.conversationId })

  // 1. Fetch tenant AI settings (all columns consumed by the worker).
  // Single literal select string required — string concatenation prevents Supabase
  // from inferring the return type via template literal generics.
  const { data: settings } = await supabase
    .from('ai_settings')
    .select('active, system_prompt, assistant_name, bot_tone, bot_use_emojis, bot_send_property_links, escalation_keywords, response_delay_ms, max_context_messages, max_turns_before_escalation, pending_reservation_hold_minutes, model')
    .eq('tenant_id', ctx.tenantId)
    .maybeSingle()

  if (settings && !settings.active) {
    console.log('[responder] AI disabled for tenant', ctx.tenantId)
    return null
  }

  // 1b. Fetch tenant name, slug, public site and payment config
  const { data: tenant } = await supabase
    .from('tenants')
    .select('name, slug, public_slug, public_site_enabled, payment_alias, payment_cbu, payment_account_holder, payment_bank, payment_notes, payment_request_message')
    .eq('id', ctx.tenantId)
    .single()

  // ── Derived settings (clamped to safe ranges) ───────────────────────────────
  const basePrompt  = settings?.system_prompt        ?? DEFAULT_SYSTEM_PROMPT
  const maxContext  = Math.max(5, Math.min(settings?.max_context_messages ?? 10, 30))
  const maxTurns    = Math.max(2, Math.min(settings?.max_turns_before_escalation ?? 5, 8))
  const holdMinutes = settings?.pending_reservation_hold_minutes ?? 1440
  const holdHours   = Math.round(holdMinutes / 60)
  const delayMs     = Math.max(0, Math.min(settings?.response_delay_ms ?? 0, 5000))

  const assistantName    = settings?.assistant_name?.trim() || 'Asistente ReservaNex'
  const tenantName       = tenant?.name ?? 'la inmobiliaria'
  const tone             = settings?.bot_tone ?? 'professional'
  const useEmojis        = settings?.bot_use_emojis ?? false
  const sendPropertyLinks = settings?.bot_send_property_links ?? true

  // NULL (no row, or column IS NULL) → use defaults so new tenants escalate correctly.
  // [] (owner explicitly cleared keywords) → respect empty; no escalation check.
  // Non-empty array → use exactly those values.
  const escalationKeywords: string[] =
    !settings || settings.escalation_keywords === null
      ? DEFAULT_ESCALATION_KEYWORDS
      : (settings.escalation_keywords as string[]).filter(Boolean)

  // Build catalog URL from tenant slug (used in system prompt + send_public_catalog_link tool)
  const siteBase = (
    process.env.SITE_URL ?? process.env.NEXT_PUBLIC_SITE_URL ?? 'https://reservanex.com'
  ).replace(/\/$/, '')
  const tenantSlug       = tenant?.public_slug ?? tenant?.slug
  const publicCatalogUrl = tenantSlug ? `${siteBase}/site/${tenantSlug}` : null

  // ── 2. Escalation keyword pre-check (deterministic, before LLM) ────────────
  if (escalationKeywords.length > 0) {
    const matchedKeyword = containsEscalationKeyword(ctx.messageText, escalationKeywords)
    if (matchedKeyword) {
      console.log('[responder] escalation keyword matched — routing to human without LLM', {
        conversationId: ctx.conversationId,
        keyword:        matchedKeyword,
      })
      try { await executeEscalateToHuman(ctx.tenantId, ctx.conversationId) } catch { /* non-fatal */ }
      await applyDelay(delayMs)
      return {
        text:         'Te derivo con un asesor. En breve se van a poner en contacto con vos.',
        finishReason: 'keyword_escalation',
        model:        'system',
      }
    }
  }

  // ── 3. Build dynamic tool set ───────────────────────────────────────────────
  const tools = [
    ...BASE_TOOLS,
    // save_contact_name only when contact has no name yet — prevents overwriting valid names
    ...(ctx.contactName ? [] : [saveContactNameTool]),
    // link tools only when tenant has property links enabled
    ...(sendPropertyLinks ? [sendPublicCatalogLinkTool, sendPropertyLinkTool] : []),
  ]

  // ── 4. Build system prompt ──────────────────────────────────────────────────

  const botConfigSection = buildBotConfigSection(assistantName, tenantName, tone, useEmojis)

  const firstName   = ctx.contactName ? ctx.contactName.split(/\s+/)[0] : null
  const contactLine = ctx.contactName
    ? `Nombre del cliente: ${ctx.contactName}. Podés usar "${firstName}" de forma natural una vez (ej: "Gracias, ${firstName}."). No lo repitas en cada frase.`
    : [
        'Nombre del cliente: desconocido.',
        'REGLA DE NOMBRE:',
        '  - Si el cliente solo saluda ("Hola", "Buenos días"), NO pidas el nombre todavía.',
        '  - Pedí el nombre UNA SOLA VEZ cuando haya interés real: el cliente pregunta por una propiedad, precio, disponibilidad, quiere reservar o visitar, o el bot está por recomendar propiedades.',
        '  - Texto sugerido: "Perfecto, te ayudo. Para dejar registrada la consulta, ¿me decís tu nombre y apellido?"',
        '  - Cuando el cliente responda con su nombre (aunque sea sin "soy" o "me llamo", ej: solo "Juan Pérez"), tenés que llamar a save_contact_name en ese mismo turno antes de responder. NUNCA digas que el nombre quedó guardado, anotado o registrado si no llamaste la tool.',
        '  - Si el cliente ignora la pregunta, continuá ayudando sin repetirla.',
      ].join('\n')

  const dateContext = buildCurrentDateContext()

  // Instruction about property links — only shown when the tool is available
  const catalogDisplay = publicCatalogUrl ?? '(catálogo del tenant)'
  const linksRule = sendPropertyLinks
    ? [
        '\nREGLA DE LINKS: NUNCA inventes URLs. Usá siempre los tools de links.',
        `  • send_property_link(property_id): usalo cuando el bot recomiende o mencione una propiedad concreta con property_id conocido. Si la propiedad está publicada envía link directo; si no, envía el catálogo automáticamente.`,
        `  • send_property_link() sin property_id: usalo cuando el cliente pide ver más propiedades, el catálogo, fotos o disponibles en general.`,
        `  • send_public_catalog_link: alternativa para enviar el catálogo general (${catalogDisplay}).`,
        `  • No repitas links dentro de la misma respuesta.`,
      ].join('\n')
    : '\nREGLA DE LINKS: No podés enviar links de propiedades en este tenant. No uses send_property_link ni send_public_catalog_link.'

  const paymentRule = [
    '\nREGLA DE PAGO: Usá send_payment_data SOLO cuando el cliente pide explícitamente:',
    '  alias, CBU/CVU, datos para transferir, datos de pago, o menciona que va a hacer una transferencia o un pago.',
    '  NO usar cuando el cliente solo pregunta precio, disponibilidad, ubicación o requisitos.',
  ].join('\n')

  const reservationLine = [
    '═══ TIPOS DE OPERACIÓN ═══',
    '',
    'ReservaNex gestiona tres tipos de operaciones inmobiliarias:',
    '',
    '• VENTA (sale): propiedades en venta.',
    '  → Llamá search_properties_for_reservation con operation_type="sale".',
    '  → Mostrá precio, características y zona. NO pedís fechas de estadía.',
    '  → Si el cliente quiere avanzar (visita, oferta, más info) → llamá escalate_to_human.',
    '',
    '• ALQUILER MENSUAL (long_term_rental): alquiler por mes para vivir.',
    '  → Llamá search_properties_for_reservation con operation_type="long_term_rental".',
    '  → Mostrá precio mensual y características. NO pedís fechas de estadía.',
    '  → Si el cliente quiere avanzar → llamá escalate_to_human.',
    '',
    '• ALQUILER TEMPORAL (temporary_rental): estadías por noches/días.',
    '  → Seguí el flujo completo: search → check_availability → reserva pendiente.',
    '',
    'NUNCA decís que solo te especializás en alquileres temporales.',
    'NUNCA pedís fechas de estadía para propiedades en venta o alquiler mensual.',
    'NUNCA mostrés una propiedad en venta cuando el cliente busca alquilar (salvo que no haya de ese tipo).',
    '',
    '═══ REGLAS ABSOLUTAS — no hay excepciones ═══',
    '',
    'REGLA 1 — SIEMPRE buscá propiedades con la herramienta:',
    '  Cuando el cliente mencione comprar, alquilar, reservar, una propiedad o una zona, SIEMPRE llamá search_properties_for_reservation ANTES de responder.',
    '  Pasá operation_type="sale" si el cliente quiere comprar.',
    '  Pasá operation_type="long_term_rental" si quiere alquilar para vivir o alquiler mensual.',
    '  Pasá operation_type="temporary_rental" si quiere alojamiento por noches.',
    '  Omitir operation_type si no está claro el tipo de operación.',
    '  NUNCA digas "no hay propiedades" sin haber llamado primero a la herramienta.',
    '  La herramienta aplica un hard filter: "matches" contiene SOLO las propiedades que coinciden con la zona pedida.',
    '  SOLO podés mencionar propiedades que estén en "matches". NUNCA inventes ni agregues propiedades de otras zonas.',
    '  "query_understood_as" te muestra qué entendió el sistema — usalo para confirmar al cliente.',
    '  "match_reasons" por propiedad te indica por qué fue incluida — usalo para responder de forma relevante.',
    '  → Si "no_direct_match"=true: no hay propiedades en esa zona. Decile al cliente exactamente esto:',
    '    "No tengo propiedades cargadas en esa zona por el momento. ¿Querés que vea todas las opciones disponibles de la inmobiliaria?"',
    '    NUNCA menciones barrios, zonas o ciudades alternativas (Recoleta, Belgrano, Centro, etc.) — solo podés nombrar zonas que aparezcan en resultados reales.',
    '    NUNCA listes propiedades de otras zonas automáticamente cuando no_direct_match=true.',
    '  → Si "can_search_alternatives"=true y el cliente quiere ver todas las opciones: llamá de nuevo con include_alternatives=true.',
    '  → Si el cliente pide "otras opciones", "alrededores", "similares" o "todo lo que tienen":',
    '    Llamá search_properties_for_reservation con include_alternatives=true.',
    '    Solo mencioná las propiedades y zonas que la herramienta devuelva en "matches" o "alternatives_outside_area".',
    '    Si la herramienta no devuelve más propiedades, decí: "Por ahora no tengo más propiedades cargadas con esos criterios."',
    '',
    'REGLA 2 — NUNCA asumas personas (solo para alquiler temporal):',
    '  La capacidad de la propiedad (capacity_max) es el MÁXIMO permitido, NO la cantidad que quiere el cliente.',
    '  Si la propiedad es temporary_rental y el cliente no dijo cuántas personas son, PREGUNTALO.',
    '  Decí: "Tiene capacidad para hasta X personas. ¿Cuántas personas van a ser?"',
    '  NUNCA digas: "Tiene la capacidad exacta que necesitás".',
    '',
    'REGLA 3 — Fechas (SOLO para alquiler temporal):',
    '  Para propiedades temporary_rental: si el cliente no mencionó fechas, PREGUNTALO.',
    '  NUNCA digas que una propiedad temporary_rental está disponible sin antes llamar check_property_availability con fechas reales.',
    '  Si el cliente pregunta disponibilidad sin dar fechas, respondé: "Para confirmarte disponibilidad necesito las fechas de entrada y salida, y la cantidad de personas."',
    '  Para propiedades en venta (sale) o alquiler mensual (long_term_rental): NUNCA pedís fechas de estadía ni check-in/check-out.',
    '  Usá siempre FECHA_HOY y AÑO_ACTUAL definidos arriba para interpretar fechas relativas.',
    '',
    'REGLA 4 — NUNCA crees reservas en el pasado:',
    '  Si la herramienta devuelve PAST_DATE_NOT_ALLOWED, las fechas tenían un año incorrecto.',
    '  Corregí el año a AÑO_ACTUAL (o AÑO_ACTUAL+1 si corresponde) y pedí confirmación al cliente antes de reintentar.',
    '  NUNCA expongas el mensaje técnico PAST_DATE_NOT_ALLOWED al cliente — explicalo en lenguaje natural.',
    '',
    'REGLA 5 — NUNCA muestres IDs al cliente ni inventes disponibilidad:',
    '  NUNCA incluyas reservation_id, property_id ni ningún UUID en tu respuesta al cliente.',
    '  NUNCA digas "está disponible", "tenemos disponibilidad" o frases similares sin haber verificado con check_property_availability.',
    '  NUNCA uses create_pending_reservation para propiedades de venta (sale) o alquiler mensual (long_term_rental).',
    '  Después de crear la reserva, decí ÚNICAMENTE: "Tu reserva pendiente quedó registrada. Un asesor la va a confirmar a la brevedad."',
    '',
    'REGLA 6 — NUNCA uses la palabra "confirmada":',
    '  La reserva siempre está PENDIENTE hasta que un asesor humano la apruebe.',
    '',
    'REGLA 7 — SIEMPRE verificá disponibilidad ANTES de preguntar si quiere reservar:',
    '  Cuando tenés property_id + start_date + end_date + guests, llamá check_property_availability.',
    '  NUNCA preguntés "¿querés que te deje la reserva?" sin haber llamado check_property_availability antes.',
    '  Si available=true y el precio tiene modo "fixed": mostrá el desglose de precios al cliente.',
    '  Si available=false: explicá el motivo y ofrecé alternativas o llamá find_next_available_dates.',
    '',
    'REGLA 8 — Mostrá el precio ANTES de pedir confirmación:',
    '  Si check_property_availability devuelve price_summary, incluilo en tu mensaje al cliente ANTES de preguntar si confirma.',
    '  Ejemplo: "Del 18 al 22 de julio está disponible. El precio es:\\n[price_summary]\\n¿Querés que te deje la reserva pendiente?"',
    '  Si pricing_mode="consult": decí que el precio lo coordina el asesor al confirmar.',
    '',
    'REGLA 9 — Días de semana: NO los verificues vos:',
    '  El sistema validó automáticamente los días de semana del mensaje del cliente ANTES de que llegues acá.',
    '  Si el cliente dijo "domingo 26" y llegaste hasta acá, el domingo 26 es correcto — no lo cuestiones.',
    '  NUNCA calcules, verifiques ni corrijas días de semana por tu cuenta. Tu cálculo puede ser incorrecto.',
    '  Si el cliente menciona un día ("martes 22"), podés pasarlo como start_day_name / end_day_name a check_property_availability.',
    '  Si la herramienta devuelve WEEKDAY_DATE_MISMATCH: informalo en lenguaje natural. NUNCA expongas el error técnico.',
    '',
    'REGLA 10 — Cuando el cliente confirma ("Dale", "sí", "confirmado", "hacelo"):',
    '  PRIMERO — Si no tenés el nombre del cliente (Nombre del cliente: desconocido), pedilo antes de crear la reserva:',
    '    Decí: "Para dejar registrada la reserva, ¿me decís tu nombre y apellido?"',
    '    Cuando el cliente responda, guardalo con save_contact_name.',
    '    Recién después llamá create_pending_reservation. El draft de reserva sigue vigente.',
    '  Si la tool devuelve CONTACT_NAME_REQUIRED: seguí el paso anterior (pedir nombre, guardar, reintentar).',
    '  La tool usa internamente los datos exactos validados por check_property_availability — NO re-parsees fechas del historial.',
    '  Si la tool devuelve QUOTE_EXPIRED: decí al cliente que la cotización venció y llamá check_property_availability de nuevo.',
    '',
    'REGLA 11 — Precios: respetá la configuración del tenant:',
    '  Si base_price_per_night es null en el resultado de búsqueda, el tenant tiene oculto el precio público.',
    '  En ese caso usá pricing_mode="consult" y decí que el precio lo coordina el asesor.',
    '',
    'REGLA 12 — NUNCA inventes geografía ni inventario:',
    '  NUNCA menciones barrios, zonas, ciudades ni propiedades que no estén en los resultados de una tool.',
    '  No uses tu conocimiento general sobre geografía para sugerir alternativas.',
    '  Ejemplos prohibidos: "Podés ver Recoleta, Belgrano o Centro.", "Tengo opciones en barrios cercanos.", "Hay algo similar en el microcentro."',
    '  Si no hay resultados reales, decí simplemente: "No tengo propiedades cargadas con esos criterios por el momento."',
    '  Podés ofrecer buscar en el inventario completo, pero sin nombrar zonas inventadas.',
    '',
    'REGLA 13 — Estado comercial (commercial_status) de las propiedades:',
    '  Algunas propiedades pueden estar publicadas pero no disponibles comercialmente.',
    '  Estados posibles: available (disponible), rented (alquilada), paused (pausada), sold (vendida).',
    '  La búsqueda general (search_properties_for_reservation sin código/slug) SOLO devuelve propiedades en estado "available".',
    '  Cuando search_properties_for_reservation devuelva un candidate con commercial_status ≠ "available":',
    '    • El cliente preguntó por una propiedad específica (código o link).',
    '    • Informá el estado en lenguaje natural: "Esta propiedad está actualmente [alquilada/pausada/vendida]."',
    '    • Ofrecé buscar alternativas disponibles: llamá search_properties_for_reservation con la misma zona.',
    '    • NUNCA propongas check-in, check-out, disponibilidad ni reserva para propiedades no disponibles.',
    '  Si check_property_availability devuelve available=false con commercial_status: informalo en lenguaje natural y ofrecé alternativas.',
    '  Si create_pending_reservation devuelve error por commercial_status: informalo y ofrecé alternativas.',
    '  NUNCA intentes crear reservas ni verificar disponibilidad temporal en propiedades rented, paused o sold.',
    linksRule,
    paymentRule,
    '',
    '═══ FLUJO POR TIPO DE OPERACIÓN ═══',
    '',
    'VENTA o ALQUILER MENSUAL:',
    '  1. Cliente quiere comprar o alquilar para vivir → search_properties_for_reservation (con operation_type correcto).',
    '  2. Mostrá las propiedades con título, descripción, precio y zona.',
    '  3. NO llamés check_property_availability. NO pedís fechas de estadía.',
    '  4. Si el cliente quiere avanzar (visita, oferta, información, avanzar) → llamá escalate_to_human.',
    '',
    'ALQUILER TEMPORAL:',
    '  1. Cliente menciona propiedad/zona/querer alquilar o quedarse → search_properties_for_reservation.',
    '  2. Si hay varias opciones similares, mostráselas brevemente y pedí que elija UNA.',
    '  3. Si falta start_date, end_date o guests → preguntá UNO por UNO antes de continuar.',
    '  4. Con property_id + start_date + end_date + guests → llamá check_property_availability.',
    '  5. Si available=true → mostrá price_summary al cliente y preguntá si confirma.',
    '  6. Si available=false → ofrecé otras fechas. Si el cliente pregunta cuándo está libre → llamá find_next_available_dates.',
    '  7. Con confirmación explícita del cliente → llamá create_pending_reservation.',
    '  8. Si la reserva se creó con fechas incorrectas y el cliente corrige → llamá cancel_recent_reservation con el motivo, luego procesá las fechas corregidas desde el paso 4.',
    '  9. Al crear la reserva exitosamente → decí EXACTAMENTE: "Tu reserva pendiente quedó registrada. Un asesor la va a confirmar a la brevedad."',
    `  10. Las reservas pendientes vencen en ${holdHours} hora${holdHours !== 1 ? 's' : ''} si un asesor no las confirma.`,
    '',
    '═══ MENSAJES DE EJEMPLO ═══',
    '',
    'Al presentar la propiedad (sin fechas todavía):',
    '  "Encontré [nombre propiedad] en [dirección]. Tiene capacidad para hasta X personas. ¿Para qué fechas y cuántas personas querés?"',
    '',
    'Al confirmar disponibilidad con precio fijo:',
    '  "Del [fecha inicio] al [fecha fin] está disponible. El precio estimado es:\\n[price_summary]\\n[Si hay check_in_time/check_out_time: El check-in es desde las HH:MM y el check-out hasta las HH:MM.]\\n¿Querés que te deje la reserva pendiente? Un asesor la va a confirmar y te va a contactar para coordinar el pago."',
    '',
    'Al confirmar disponibilidad sin precio configurado:',
    '  "Del [fecha inicio] al [fecha fin] está disponible para [N] personas. El precio lo coordina el asesor al confirmar. ¿Querés que te deje la reserva pendiente?"',
    '',
    'Cuando la propiedad no está disponible:',
    '  "Esa propiedad no está disponible del [inicio] al [fin]. ¿Querés que busque la próxima fecha libre o te muestre otras opciones?"',
  ].join('\n')

  // Active property/lead context
  let activeContextLine = ''
  const lc           = ctx.leadContext
  const hasProperty  = !!(ctx.propertyId && ctx.propertyTitle)
  const hasDates     = !!(lc.requested_start_date && lc.requested_end_date)
  const hasGuests    = typeof lc.requested_guests === 'number' && lc.requested_guests > 0
  const propOpType   = lc.property_operation_type ?? 'temporary_rental'
  const isTempRental = propOpType === 'temporary_rental'

  if (hasProperty && lc.public_code) {
    const lines: string[] = [
      '═══ CONSULTA DESDE SITIO WEB PÚBLICO ═══',
      '',
      'El cliente llegó desde el sitio web público con los siguientes datos ya detectados automáticamente.',
      'INSTRUCCIÓN PRIORITARIA: Los datos de abajo son pre-completados — NO vuelvas a preguntar por ellos.',
      '',
      `Propiedad: "${ctx.propertyTitle}" (Ref: ${lc.public_code})`,
      `property_id (para tools): ${ctx.propertyId}`,
      `operation_type: ${propOpType}`,
    ]

    if (hasDates) {
      const nights = lc.requested_nights
        ?? Math.round((new Date(lc.requested_end_date!).getTime() - new Date(lc.requested_start_date!).getTime()) / 86400000)
      lines.push(`Fechas solicitadas: ${lc.requested_start_date} → ${lc.requested_end_date}${nights ? ` (${nights} noches)` : ''}`)
    }
    if (hasGuests) lines.push(`Personas: ${lc.requested_guests}`)

    lines.push('')

    if (isTempRental) {
      if (hasDates && hasGuests) {
        lines.push(
          'INSTRUCCIÓN: Tenés property_id + fechas + personas. Llamá DIRECTAMENTE check_property_availability.',
          `  property_id: ${ctx.propertyId}`,
          `  start_date:  ${lc.requested_start_date}`,
          `  end_date:    ${lc.requested_end_date}`,
          `  guests:      ${lc.requested_guests}`,
          'NO preguntes por propiedad, fechas ni personas — ya los tenés todos.',
        )
      } else if (hasDates) {
        lines.push(
          'INSTRUCCIÓN: Tenés property_id y fechas pero NO la cantidad de personas.',
          'Preguntá: "¿Cuántas personas van a ser?" y luego llamá check_property_availability.',
        )
      } else if (hasGuests) {
        lines.push(
          'INSTRUCCIÓN: Tenés property_id y personas pero NO las fechas.',
          'Preguntá: "¿Para qué fechas?" y luego llamá check_property_availability.',
        )
      } else {
        lines.push(
          'INSTRUCCIÓN: Tenés property_id. Falta saber fechas y/o personas.',
          'Preguntá lo que falta (uno por uno) y luego llamá check_property_availability.',
        )
      }
    } else {
      lines.push(
        `INSTRUCCIÓN: Esta propiedad es de tipo "${propOpType}". NO pedís fechas de estadía.`,
        'Presentá las características al cliente. Si quiere avanzar → escalate_to_human.',
      )
    }

    activeContextLine = '\n\n[Consulta desde web pública]\n' + lines.join('\n')

  } else if (hasProperty) {
    const lines: string[] = [
      '═══ PROPIEDAD ACTIVA EN CONVERSACIÓN ═══',
      '',
      `El cliente ya está consultando por: "${ctx.propertyTitle}"`,
      `property_id: ${ctx.propertyId}`,
      `operation_type: ${propOpType}`,
      '',
      'INSTRUCCIÓN: Si el cliente dice "esa", "la de giles", "la casa", "para hoy", "esta noche",',
      '"la necesito", etc., usá esta propiedad directamente. NO vuelvas a buscar ni preguntes zona.',
    ]

    if (isTempRental) {
      if (hasDates && hasGuests) {
        lines.push(
          '',
          `Datos conocidos: ${lc.requested_start_date} → ${lc.requested_end_date}, ${lc.requested_guests} persona${lc.requested_guests !== 1 ? 's' : ''}.`,
          'INSTRUCCIÓN: Tenés todo. Llamá DIRECTAMENTE check_property_availability.',
          `  property_id: ${ctx.propertyId}`,
          `  start_date:  ${lc.requested_start_date}`,
          `  end_date:    ${lc.requested_end_date}`,
          `  guests:      ${lc.requested_guests}`,
        )
      } else if (hasDates) {
        lines.push(
          '',
          `Fechas: ${lc.requested_start_date} → ${lc.requested_end_date}. Falta cantidad de personas.`,
          'Preguntá cuántas personas y luego llamá check_property_availability.',
        )
      } else if (hasGuests) {
        lines.push(
          '',
          `Personas: ${lc.requested_guests}. Falta fecha de estadía.`,
          'Preguntá para qué fechas y luego llamá check_property_availability.',
        )
      }
    } else {
      lines.push(
        '',
        `INSTRUCCIÓN: Esta propiedad es de tipo "${propOpType}". NO pedís fechas de estadía.`,
        'Presentá características y precio. Si el cliente quiere avanzar → escalate_to_human.',
      )
    }

    activeContextLine = '\n\n[Propiedad activa]\n' + lines.join('\n')
  }

  const systemPrompt =
    `${basePrompt}\n\n` +
    `[Identidad del asistente]\n${botConfigSection}\n\n` +
    `[Contexto del cliente]\n${contactLine}\n\n` +
    `[Fecha actual]\n${dateContext}` +
    activeContextLine + '\n\n' +
    `[Gestión de reservas]\n${reservationLine}`

  // 5. Fetch recent conversation history
  const { data: rows } = await supabase
    .from('messages')
    .select('sender_type, content')
    .eq('conversation_id', ctx.conversationId)
    .order('created_at', { ascending: false })
    .limit(maxContext)

  const messages: LLMMessage[] = (rows ?? []).reverse().map((msg) =>
    msg.sender_type === 'customer'
      ? { role: 'user'      as const, content: msg.content }
      : { role: 'assistant' as const, content: msg.content }
  )

  // 6. Deterministic date pre-check (before LLM)
  const dateMismatches = findDateMismatches(ctx.messageText)
  const mismatchReply  = buildMismatchReply(dateMismatches)
  if (mismatchReply) {
    console.log('[responder:date-mismatch]', {
      conversationId: ctx.conversationId,
      mismatches:     dateMismatches,
    })
    await applyDelay(delayMs)
    return { text: mismatchReply, finishReason: 'stop', model: 'date-preprocessor' }
  }

  // 7. Orchestrator loop (LLM → tool execution → LLM → … → final answer)
  // turnUsage accumulates inputTokens/outputTokens across EVERY callLLM() call
  // made for this turn (a tool-calling turn can call the LLM 2-3+ times), so
  // the usage persisted by writeMemory() reflects the true total, not just
  // the last call's usage.
  let turnUsage: LLMUsage = { inputTokens: 0, outputTokens: 0 }

  for (let i = 0; i < maxTurns; i++) {
    const result = await callLLM({ system: systemPrompt, messages, tools, model: settings?.model ?? undefined })
    turnUsage = addUsage(turnUsage, result.usage)

    // No tool calls → final text response
    if (result.finishReason !== 'tool_calls' || !result.toolCalls?.length) {
      await applyDelay(delayMs)
      return { ...result, usage: turnUsage }
    }

    // Last iteration still requesting tools → escalate instead of error
    if (i === maxTurns - 1) {
      console.warn('[responder] max_turns_before_escalation reached — escalating to human', {
        conversationId: ctx.conversationId,
        maxTurns,
      })
      try { await executeEscalateToHuman(ctx.tenantId, ctx.conversationId) } catch { /* non-fatal */ }
      const escalationText = 'Te paso con uno de nuestros asesores que te va a ayudar en breve.'
      await applyDelay(delayMs)
      return { text: escalationText, finishReason: 'max_turns_escalation', model: 'system', usage: turnUsage }
    }

    // Append assistant turn (with tool calls) to message history
    messages.push({
      role:       'assistant',
      content:    null,
      tool_calls: result.toolCalls.map((tc) => ({
        id:       tc.id,
        type:     'function' as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.args) },
      })),
    })

    // Execute each tool and append result
    for (const toolCall of result.toolCalls) {
      let toolResult: string
      try {
        if (toolCall.name === 'search_properties_for_reservation') {
          toolResult = await executeSearchPropertiesForReservation(ctx.tenantId, toolCall.args)
          // Audit log + persist property_id when exactly 1 match found
          try {
            const parsed  = JSON.parse(toolResult) as Record<string, unknown>
            const matches  = Array.isArray(parsed['matches'])
              ? (parsed['matches'] as Array<{ property_id?: string; title?: string; city?: string; operation_type?: string }>)
              : []
            const alts     = Array.isArray(parsed['alternatives_outside_area'])
              ? (parsed['alternatives_outside_area'] as Array<{ title?: string }>)
              : []
            console.log('[worker:property-context]', {
              source:         'search_tool',
              conversationId: ctx.conversationId,
              matchTitles:    matches.map(m => m.title),
              altTitles:      alts.map(m => m.title),
              noDirectMatch:  parsed['no_direct_match'] ?? false,
              matchCount:     matches.length,
            })

            if (matches.length === 1 && matches[0]?.property_id && matches[0].property_id !== ctx.propertyId) {
              const matchedId     = matches[0].property_id
              const matchedOpType = matches[0].operation_type
              const { error: propErr } = await supabase
                .from('conversations')
                .update({
                  property_id:  matchedId,
                  lead_context: {
                    ...ctx.leadContext,
                    property_operation_type: matchedOpType,
                  } as unknown as import('@orderflow/types').Json,
                  ...(matchedOpType ? { lead_operation_type: matchedOpType } : {}),
                  updated_at: new Date().toISOString(),
                })
                .eq('id', ctx.conversationId)
                .eq('tenant_id', ctx.tenantId)

              if (!propErr) {
                ctx.propertyId    = matchedId
                ctx.propertyTitle = matches[0].title ?? null
                console.log('[worker:active-property-context]', {
                  conversationId: ctx.conversationId,
                  propertyId:     matchedId,
                  title:          matches[0].title,
                  operationType:  matches[0].operation_type,
                  reason:         'single_search_result',
                })
              }
            }
          } catch { /* ignore parse error */ }

        } else if (toolCall.name === 'check_property_availability') {
          toolResult = await executeCheckPropertyAvailability(ctx.tenantId, ctx.conversationId, toolCall.args)
          const checkedPropId = typeof toolCall.args['property_id'] === 'string' ? toolCall.args['property_id'] : null
          if (checkedPropId && checkedPropId !== ctx.propertyId) {
            const { error: propErr } = await supabase
              .from('conversations')
              .update({ property_id: checkedPropId, updated_at: new Date().toISOString() })
              .eq('id', ctx.conversationId)
              .eq('tenant_id', ctx.tenantId)
            if (!propErr) {
              ctx.propertyId = checkedPropId
              console.log('[worker:active-property-context]', {
                conversationId: ctx.conversationId,
                propertyId:     checkedPropId,
                reason:         'check_availability_call',
              })
            }
          }
        } else if (toolCall.name === 'find_next_available_dates') {
          toolResult = await executeFindNextAvailableDates(ctx.tenantId, toolCall.args)
        } else if (toolCall.name === 'search_properties') {
          toolResult = await executeSearchProperties(ctx.tenantId, toolCall.args)
        } else if (toolCall.name === 'escalate_to_human') {
          toolResult = await executeEscalateToHuman(ctx.tenantId, ctx.conversationId)
        } else if (toolCall.name === 'create_pending_reservation') {
          toolResult = await executeCreatePendingReservation(ctx.tenantId, ctx.conversationId, ctx.contactId, toolCall.args)
        } else if (toolCall.name === 'cancel_recent_reservation') {
          toolResult = await executeCancelRecentReservation(ctx.tenantId, ctx.conversationId, toolCall.args)
        } else if (toolCall.name === 'send_public_catalog_link') {
          toolResult = await executeSendPublicCatalogLink(ctx.tenantId, toolCall.args)
        } else if (toolCall.name === 'send_property_link') {
          toolResult = await executeSendPropertyLink(ctx.tenantId, toolCall.args)
        } else if (toolCall.name === 'send_payment_data') {
          toolResult = await executeSendPaymentData(ctx.tenantId, ctx.conversationId, toolCall.args)
        } else if (toolCall.name === 'save_contact_name') {
          toolResult = await executeSaveContactName(ctx.tenantId, ctx.contactId, toolCall.args)
        } else {
          toolResult = JSON.stringify({ error: `Unknown tool: ${toolCall.name}` })
        }
      } catch (err) {
        toolResult = JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
      }

      // Fase 3 (validación de agente/DeepSeek): args + resultado truncado agregados
      // a este mismo log existente para poder auditar tool calls por escenario sin
      // alterar el flujo de ejecución ni el valor de retorno de la función.
      console.log(`[responder] tool=${toolCall.name} iteration=${i + 1}`, {
        id:     toolCall.id,
        args:   toolCall.args,
        result: toolResult.length > 500 ? toolResult.slice(0, 500) + '…' : toolResult,
      })
      messages.push({ role: 'tool', content: toolResult, tool_call_id: toolCall.id })
    }
  }

  // Should not reach here — the loop handles the last iteration gracefully above
  await executeEscalateToHuman(ctx.tenantId, ctx.conversationId).catch(() => undefined)
  return { text: 'Te paso con uno de nuestros asesores que te va a ayudar en breve.', finishReason: 'max_turns_escalation', model: 'system', usage: turnUsage }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function applyDelay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise(resolve => setTimeout(resolve, ms))
}
