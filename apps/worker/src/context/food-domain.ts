// ════════════════════════════════════════════════════════════════════════════
// Dominio gastronómico para el responder de WhatsApp.
//
// Hasta acá el responder representaba SIEMPRE a "la inmobiliaria": identidad,
// reglas, tools y dominio eran inmobiliarios sin mirar tenants.vertical. Con
// eso, a "¿hacen delivery?" el modelo contestaba —correctamente según su
// prompt— que "en este canal gestionamos exclusivamente consultas sobre
// propiedades" y que "no ofrecemos delivery". Para un restaurante con
// delivery_enabled = true.
//
// Este módulo es puro y sin dependencias del workspace (el worker no tiene
// deps de runtime de otros paquetes): recibe la fila del tenant y devuelve el
// bloque de prompt que describe QUÉ ofrece este local, derivado de sus
// capacidades reales. Las capacidades son la autoridad — el modelo no decide
// si hay delivery, lo lee.
// ════════════════════════════════════════════════════════════════════════════

export interface FoodCapabilities {
  delivery:          boolean
  takeaway:          boolean
  tableReservations: boolean
}

/**
 * Copia standalone de foodCapabilitiesFrom() de packages/validators: el
 * worker no importa workspace packages en runtime. Misma regla: un tenant
 * que no es food_service tiene las tres en false.
 */
export function foodCapabilitiesFromTenant(row: {
  vertical?: string | null
  delivery_enabled?: boolean | null
  takeaway_enabled?: boolean | null
  table_reservations_enabled?: boolean | null
}): FoodCapabilities {
  if (row.vertical !== 'food_service') {
    return { delivery: false, takeaway: false, tableReservations: false }
  }
  return {
    delivery:          row.delivery_enabled           !== false,
    takeaway:          row.takeaway_enabled           !== false,
    tableReservations: row.table_reservations_enabled !== false,
  }
}

export function isFoodService(row: { vertical?: string | null }): boolean {
  return row.vertical === 'food_service'
}

/** Cómo se presenta el asistente según el rubro. */
export function identityLine(assistantName: string, tenantName: string, food: boolean): string {
  return food
    ? `Tu nombre es ${assistantName}. Atendés el WhatsApp del negocio gastronómico "${tenantName}".`
    : `Tu nombre es ${assistantName}. Representás a la inmobiliaria "${tenantName}".`
}

/**
 * El bloque de dominio para un local gastronómico, construido desde sus
 * capacidades. Lo que el local NO ofrece se dice explícitamente para que el
 * modelo no lo prometa; lo que no existe en el sistema (menú, precios) se
 * prohíbe inventar.
 */
export function buildFoodDomainSection(params: {
  caps:             FoodCapabilities
  publicCatalogUrl: string | null
  canSendLinks:     boolean
  /** Productos publicados en la carta. 0 = la carta está vacía. */
  publishedMenuItemCount: number
}): string {
  const { caps, publicCatalogUrl, canSendLinks, publishedMenuItemCount } = params
  const hayCarta   = publishedMenuItemCount > 0
  const puedeLinks = canSendLinks && publicCatalogUrl !== null

  const tomaPedidos = caps.delivery || caps.takeaway
  const modalidades: string[] = []
  if (caps.delivery) modalidades.push('DELIVERY (envío a domicilio)')
  if (caps.takeaway) modalidades.push('RETIRO EN EL LOCAL (take away)')

  const lines: string[] = [
    '═══ QUÉ OFRECE ESTE NEGOCIO ═══',
    '',
    'Es un negocio gastronómico. NO es una inmobiliaria: NUNCA hables de propiedades, venta, alquiler, visitas ni estadías.',
    '',
  ]

  if (tomaPedidos) {
    lines.push(
      `PEDIDOS: SÍ. Modalidades disponibles: ${modalidades.join(' y ')}.`,
      ...(caps.delivery
        ? ['  • Si preguntan por delivery: confirmá que SÍ hay delivery.']
        : ['  • Si preguntan por delivery: NO hay delivery. Ofrecé retiro en el local.']),
      ...(caps.takeaway
        ? ['  • Si preguntan por retirar / pasar a buscar / take away: confirmá que SÍ se puede retirar.']
        : ['  • Si preguntan por retirar: NO hay retiro en el local. Ofrecé delivery.']),
    )
  } else {
    lines.push(
      'PEDIDOS: NO. Este local no toma pedidos por este canal (ni delivery ni retiro).',
      '  • Si preguntan por delivery o por retirar: decí que por el momento no se toman pedidos, y ofrecé la carta para consultar y responder dudas.',
    )
  }

  lines.push('')
  if (caps.tableReservations) {
    lines.push(
      'RESERVAS DE MESA: SÍ, por formulario. Vos NO tomás fecha, hora ni personas por este chat: no hay forma de crear la reserva desde acá.',
      ...(puedeLinks
        ? [
            '  • Si el cliente quiere reservar (o menciona fecha/hora/personas para ir a comer), llamá send_table_reservation_link: manda el formulario de reserva. No pidas los datos vos.',
            '  • Cuando el cliente complete el formulario va a recibir una referencia (SUB-XXXXXX) y te la va a mandar; el sistema la resume y le pide confirmar. Eso lo hace el sistema, no vos.',
          ]
        : ['  • No podés mandar el formulario ahora: derivá a una persona con escalate_to_human.']),
      '  • NUNCA digas que la reserva está confirmada, tomada ni asegurada. La confirma el local después. Podés decir que "queda como solicitud" o "el local la confirma".',
    )
  } else {
    lines.push('RESERVAS DE MESA: NO. Si preguntan, decí que no se toman reservas de mesa.')
  }

  lines.push(
    '',
    '═══ REGLAS ABSOLUTAS ═══',
    '',
    hayCarta
      ? `REGLA 1 — MENÚ Y PRECIOS: la carta tiene ${publishedMenuItemCount} producto${publishedMenuItemCount === 1 ? '' : 's'} publicado${publishedMenuItemCount === 1 ? '' : 's'}, pero vos NO los tenés cargados en este chat. NUNCA inventes productos, platos, promociones ni precios. NUNCA confirmes que "tenemos X" si el cliente nombra un plato.`
      : 'REGLA 1 — MENÚ Y PRECIOS: la carta TODAVÍA NO TIENE productos publicados. NUNCA digas que hay platos, productos o precios disponibles, ni ofrezcas "la carta con los platos": no existe todavía. Si preguntan qué hay, decí con naturalidad que la carta aún no está publicada y ofrecé derivar a una persona con escalate_to_human.',
    hayCarta && puedeLinks
      ? `  • Para cualquier consulta de menú, precios o pedido, enviá la carta con send_public_catalog_link (${publicCatalogUrl}). Ahí el cliente ve los productos reales y arma el pedido.`
      : hayCarta
        ? '  • No podés mandar la carta ahora: para consultas de menú o precios, derivá a una persona con escalate_to_human.'
        : '  • NO llames send_public_catalog_link: no hay nada que mostrar.',
    '',
    'REGLA 2 — NO PROMETAS LO QUE NO EXISTE: horarios, zonas de entrega, costos de envío, tiempos de demora y medios de pago no están cargados acá. Si te los preguntan, decí que no tenés ese dato y ofrecé derivar a una persona.',
    '',
    'REGLA 3 — SÉ BREVE: una o dos frases. Respondé lo que preguntaron y, si corresponde, ofrecé la carta.',
    '',
    'REGLA 4 — Si el cliente quiere hablar con una persona, o pide algo que no podés resolver, usá escalate_to_human.',
  )

  return lines.join('\n')
}

/** La regla de nombre, sin vocabulario inmobiliario. */
export function foodNameRule(): string {
  return [
    'Nombre del cliente: desconocido.',
    'REGLA DE NOMBRE:',
    '  - Si el cliente solo saluda ("Hola", "Buenos días"), NO pidas el nombre todavía.',
    '  - Pedí el nombre UNA SOLA VEZ y sólo cuando haya una operación que requiera seguimiento: el cliente quiere hacer un pedido, quiere reservar mesa, o pide que alguien lo contacte.',
    '  - NO pidas el nombre por una consulta genérica (qué platos hay, si hacen delivery, horarios, la carta). Eso se responde y listo.',
    '  - Texto sugerido: "Perfecto, te ayudo. ¿Me decís tu nombre para dejarlo anotado?"',
    '  - Cuando el cliente responda con su nombre (aunque sea sin "soy" o "me llamo", ej: solo "Juan Pérez"), tenés que llamar a save_contact_name en ese mismo turno antes de responder. NUNCA digas que el nombre quedó guardado si no llamaste la tool.',
    '  - Si el cliente ignora la pregunta, continuá ayudando sin repetirla.',
  ].join('\n')
}

/** La regla de links para gastronomía: sólo la carta. */
export function foodLinksRule(canSendLinks: boolean, publicCatalogUrl: string | null): string {
  if (!canSendLinks) {
    return '\nREGLA DE LINKS: No podés enviar links en este tenant. No uses send_public_catalog_link.'
  }
  return [
    '\nREGLA DE LINKS: NUNCA inventes URLs.',
    `  • send_public_catalog_link: envía la carta del local (${publicCatalogUrl ?? '(carta del tenant)'}). Usalo cuando pidan el menú, precios, o quieran hacer un pedido.`,
    '  • No repitas el link dentro de la misma respuesta.',
  ].join('\n')
}
