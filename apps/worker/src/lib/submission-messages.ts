// Fase 3B — todos los textos fijos del flujo de confirmación, en un solo lugar.
//
// AUDITORÍA DE LOCALE (§11), antes de decidir:
//
//   · apps/web usa next-intl con locales ['es','pt','en'] — pero SOLO para el
//     sitio de marketing (rutas /[locale]). Es una librería de Next.js: no
//     corre ni puede correr en el worker.
//   · tenants.language EXISTE (text, default 'es', sin CHECK). Hoy todos los
//     tenants están en 'es', y el código que crea tenants lo deja fijo con el
//     comentario "único idioma implementado hoy" (actions/platform.ts).
//   · el worker nunca tuvo i18n: sus textos fijos son constantes en español
//     (HUMAN_HANDOFF_MESSAGE, AUDIO_TRANSCRIPTION_FAILED_TEXT,
//     AUTORESPONDER_MEDIA_NOT_SUPPORTED_TEXT).
//
// DECISIÓN: no se crea un sistema i18n paralelo (§11 lo prohíbe) ni se mete
// next-intl donde no puede correr. Se centralizan los textos acá, tipados por
// idioma y resueltos desde tenants.language, con 'es' como default y único
// idioma poblado — igual que el resto del producto. Agregar 'pt'/'en' es
// completar el objeto; el resto del código no cambia.
//
// Los textos evitan deliberadamente decir que algo "está reservado" o
// "confirmado" como operación: una submission confirmada NO es una reserva
// (§14). La operación la crea Fase 3C.

export const SUPPORTED_MESSAGE_LANGUAGES = ['es'] as const
export type MessageLanguage = (typeof SUPPORTED_MESSAGE_LANGUAGES)[number]
export const DEFAULT_MESSAGE_LANGUAGE: MessageLanguage = 'es'

// tenants.language es TEXT libre (sin CHECK), así que puede traer cualquier
// cosa. Se cae a 'es' en vez de romper: un idioma desconocido no debe dejar
// al cliente sin respuesta.
export function resolveMessageLanguage(raw: string | null | undefined): MessageLanguage {
  const value = (raw ?? '').trim().toLowerCase()
  return (SUPPORTED_MESSAGE_LANGUAGES as readonly string[]).includes(value)
    ? (value as MessageLanguage)
    : DEFAULT_MESSAGE_LANGUAGE
}

interface SubmissionMessages {
  /** Encabezado del resumen, antes de las líneas de datos. */
  summaryIntro:      string
  /** La pregunta de confirmación, después de las líneas. */
  summaryQuestion:   string
  /** El cliente confirmó. NO dice que haya una reserva hecha (§14). */
  confirmed:         string
  /** El cliente dijo que los datos están mal (§16). */
  rejected:          string
  /** No se entendió la respuesta; se vuelve a preguntar (§17). */
  ambiguous:         string
  /** La referencia no existe, es de otro tenant, o es de otro contacto (§6, §8). */
  notFound:          string
  /** La submission venció (§7). */
  expired:           string
  /** Ya se había confirmado antes (§18). */
  alreadyConfirmed:  string
  /** Estado cancelado (§19). */
  cancelled:         string
  /**
   * Fase 3C §22 — la confirmación transaccional falló y se revirtió entera.
   * La submission sigue en submitted y la pendiente sigue viva, así que el
   * cliente PUEDE reintentar: el reintento es idempotente. Nunca se le dice
   * que quedó confirmado cuando no lo está.
   */
  confirmationFailed: string
}

const MESSAGES: Record<MessageLanguage, SubmissionMessages> = {
  es: {
    summaryIntro:     'Recibí estos datos:',
    summaryQuestion:  '¿Es correcto?',
    confirmed:        'Perfecto, confirmé los datos de tu solicitud. Un asesor va a continuar con vos.',
    rejected:         'Ningún problema. Completá el formulario de nuevo con los datos corregidos y volvé a escribirme con la nueva referencia.',
    ambiguous:        '¿Confirmás que los datos del formulario son correctos? Respondé Sí o No.',
    // Genérico A PROPÓSITO (§6): no revela si la referencia existe, si es de
    // otro tenant o si está vinculada a otro teléfono. Los tres casos dicen
    // exactamente lo mismo.
    notFound:         'No pude encontrar ese formulario asociado a este WhatsApp.',
    expired:          'Ese formulario ya venció. Completalo nuevamente para continuar.',
    alreadyConfirmed: 'Estos datos ya fueron confirmados.',
    cancelled:        'Ese formulario fue cancelado. Completá uno nuevo para continuar.',
    // No dice "hubo un error": dice qué hacer. Y NO afirma que se haya
    // confirmado nada, porque no se confirmó.
    confirmationFailed: 'No pude registrar la confirmación en este momento. ¿Podés responder "Sí" de nuevo en un minuto?',
  },
}

export function getSubmissionMessages(language: MessageLanguage): SubmissionMessages {
  return MESSAGES[language]
}

// Arma el mensaje de resumen completo: intro + líneas + pregunta.
// El formato es fijo; el contenido sale de buildSummaryLines(), que es
// determinístico (ver submission-summary.ts).
export function renderSummaryMessage(
  language: MessageLanguage,
  lines:    Array<{ label: string; value: string }>,
): string {
  const m = getSubmissionMessages(language)
  const body = lines.map((l) => `${l.label}: ${l.value}`).join('\n')
  return `${m.summaryIntro}\n\n${body}\n\n${m.summaryQuestion}`
}
