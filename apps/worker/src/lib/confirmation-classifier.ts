// Fase 3B — clasificar la respuesta del cliente a "¿Es correcto?".
//
// Puro, sin I/O, sin LLM. §13 exige que las respuestas obvias se resuelvan
// SIN llamar al modelo: son la abrumadora mayoría, y un "sí" no debería
// costar una llamada a DeepSeek ni correr riesgo de alucinación.
//
// Ante la duda devuelve AMBIGUOUS y el handler vuelve a preguntar. NUNCA
// asume intención positiva (§17): confirmar algo que el cliente no confirmó
// es peor que preguntar de nuevo.

export type ConfirmationVerdict = 'confirm' | 'reject' | 'ambiguous'

// El cliente puede escribir en cualquier idioma, sin importar el del tenant:
// alguien puede responder "yes" a una inmobiliaria argentina. Por eso el
// clasificador acepta es/pt/en SIEMPRE — es distinto del idioma de SALIDA,
// que sí sigue a tenants.language (ver submission-messages.ts).
//
// Se comparan TOKENS normalizados, no substrings. Un substring ingenuo
// clasificaría "no" dentro de "nos vemos" como rechazo, y "si" dentro de
// "siempre" como confirmación (§13: "No usar substring ingenuo").
const CONFIRM_TOKENS = new Set([
  // es
  'si', 'sii', 'siii', 'sip', 'sisi', 'claro', 'correcto', 'correctos',
  'confirmo', 'confirmado', 'confirmar', 'dale', 'ok', 'oka', 'okey', 'okay',
  'perfecto', 'exacto', 'exactamente', 'listo', 'obvio', 'afirmativo', 'tal',
  'bien', 'buenisimo', 'joya', 'barbaro',
  // pt
  'sim', 'certo', 'confirmado', 'correto', 'isso', 'exato', 'beleza',
  // en
  'yes', 'yeah', 'yep', 'yup', 'correct', 'confirm', 'confirmed', 'right',
  'sure', 'good',
])

const REJECT_TOKENS = new Set([
  // es
  'no', 'nop', 'nope', 'noo', 'nooo', 'incorrecto', 'incorrectos', 'mal',
  'error', 'errores', 'equivocado', 'cambiar', 'corregir', 'modificar',
  'negativo', 'falso',
  // pt
  'nao', 'errado', 'incorreto', 'corrigir', 'mudar',
  // en
  'wrong', 'incorrect', 'nah', 'change', 'edit', 'fix',
])

// Frases enteras que valen más que la suma de sus tokens. Se buscan sobre el
// texto normalizado completo, no por token, porque "está bien" solo significa
// confirmación junta — "bien" sola ya está en CONFIRM_TOKENS, pero
// "no está bien" tiene que ganar como rechazo, y de eso se encarga el orden
// de evaluación de abajo.
const CONFIRM_PHRASES = [
  'esta bien', 'estan bien', 'es correcto', 'son correctos', 'esta correcto',
  'estan correctos', 'asi es', 'todo bien', 'todo correcto', 'esta perfecto',
  'de acuerdo', 'lo confirmo', 'sin cambios',
  'esta certo', 'tudo certo', 'esta correto',
  'thats right', 'that is right', 'looks good', 'all good', 'thats correct',
]

const REJECT_PHRASES = [
  'no es correcto', 'no son correctos', 'no esta bien', 'no estan bien',
  'esta mal', 'estan mal', 'hay un error', 'tiene un error', 'quiero cambiarlo',
  'quiero cambiar', 'necesito cambiar', 'esta equivocado', 'no es asi',
  'nao esta certo', 'esta errado', 'quero mudar',
  'not correct', 'not right', 'is wrong', 'i want to change',
]

// Saca tildes/diacríticos y puntuación, y baja a minúscula. Así "Sí", "si",
// "SÍ" y "sí." son el mismo token, y "não" matchea 'nao'.
function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')   // marcas diacríticas combinantes
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function classifyConfirmation(rawText: string | null | undefined): ConfirmationVerdict {
  if (!rawText) return 'ambiguous'

  const text = normalize(rawText)
  if (!text) return 'ambiguous'

  // Las frases de RECHAZO se evalúan PRIMERO, y a propósito: casi todas son
  // una frase de confirmación negada ("no está bien" contiene "esta bien").
  // Si mirásemos confirmación primero, un rechazo explícito se leería como un
  // sí. Ante el choque, gana el no.
  if (REJECT_PHRASES.some((p) => text.includes(p)))  return 'reject'
  if (CONFIRM_PHRASES.some((p) => text.includes(p))) return 'confirm'

  const tokens = text.split(' ').filter(Boolean)

  // Un mensaje largo no es un sí/no aunque contenga uno. "sí, pero quería
  // preguntarte si el precio incluye las expensas" no es una confirmación
  // limpia: es una consulta. Preguntamos de nuevo en vez de confirmar algo
  // que el cliente no quiso confirmar.
  if (tokens.length > 4) return 'ambiguous'

  const hasReject  = tokens.some((t) => REJECT_TOKENS.has(t))
  const hasConfirm = tokens.some((t) => CONFIRM_TOKENS.has(t))

  // "no, está mal" → ambos matchean; gana el rechazo, misma razón que arriba.
  if (hasReject)  return 'reject'
  if (hasConfirm) return 'confirm'

  return 'ambiguous'
}
