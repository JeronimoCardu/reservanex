// Fase 3B — detección de referencias SUB-XXXXXX en un mensaje entrante.
//
// COPIA STANDALONE, a propósito. El worker no tiene NINGUNA dependencia de
// workspace en runtime (@orderflow/types es devDependency porque es `import
// type` y se borra al compilar), así que no puede importar
// apps/web/src/lib/forms/submission-reference.ts. Mismo precedente que
// lib/phone.ts y lib/assert-safe-target.ts.
//
// Lo COMPARTIDO con la web es normalizeSubmissionReference() (+ el alfabeto,
// el prefijo y la regex de formato): esas cuatro cosas deben seguir siendo
// idénticas, y submission-reference.test.ts repite la misma batería de casos
// que el test de la web para que una divergencia se rompa en CI.
//
// extractSubmissionReference() es EXCLUSIVA del worker y deliberadamente más
// estricta que normalize(): normalize() se usa sobre un string que ya se sabe
// que es un código, mientras que extract() sale a buscarlo dentro de texto
// libre escrito por un cliente, que es donde está el riesgo de falso positivo.
//
// La referencia es CORRELACIÓN, nunca AUTORIZACIÓN (§3). Que este módulo
// encuentre un código en un texto no habilita nada: quien decide es
// submissions/handler.ts, y recién después de un inbound autenticado.

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const SUBMISSION_REFERENCE_PREFIX = 'SUB-'

// Debe coincidir con form_submissions_reference_format_check en la DB.
export const SUBMISSION_REFERENCE_REGEX = /^SUB-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/

// Normaliza lo que venga de un WhatsApp: la gente escribe en minúscula, mete
// espacios, se olvida el guion. Devuelve null si no es un código válido.
export function normalizeSubmissionReference(raw: string): string | null {
  const cleaned = raw.trim().toUpperCase().replace(/\s+/g, '')
  const withPrefix = cleaned.startsWith(SUBMISSION_REFERENCE_PREFIX)
    ? cleaned
    : SUBMISSION_REFERENCE_PREFIX + cleaned.replace(/^SUB-?/, '')
  return SUBMISSION_REFERENCE_REGEX.test(withPrefix) ? withPrefix : null
}

// Busca un código CON prefijo dentro de un texto. Tolera "SUB-X72K9A",
// "sub-x72k9a" y "SUB X72K9A", que es lo que produce el CTA del formulario y
// lo que la gente reescribe a mano.
//
// El separador (guion o espacio) es OBLIGATORIO, no opcional. Sin él,
// "SUB" + 6 caracteres válidos matchearía dentro de palabras reales:
// "SUBCLASES" daría SUB-CLASES. Las cuatro variantes que tenemos que aceptar
// llevan separador, así que exigirlo no cuesta nada y elimina toda esa clase
// de falso positivo.
//
// Los bordes a ambos lados evitan recortes que parezcan válidos:
//   · atrás  — "XSUB-ABC234" no es una referencia;
//   · adelante — "SUB-ABC2345" y "SUB-ABC2340" son códigos de 7 caracteres,
//     inválidos, y no deben leerse como los primeros 6. Por eso el lookahead
//     rechaza CUALQUIER alfanumérico, no solo los del alfabeto: si mirara
//     únicamente el alfabeto, "SUB-ABC2340" pasaría (el 0 está excluido del
//     alfabeto) y extraería un código que el cliente nunca tuvo.
const IN_TEXT = new RegExp(
  `(?<![A-Za-z0-9])SUB[-\\s]([${ALPHABET}]{6})(?![A-Za-z0-9])`,
  'i',
)

// Extrae LA referencia de un mensaje entrante, o null.
//
// EXIGE el prefijo SUB, siempre. Un código pelado NO se acepta, ni siquiera
// cuando es el mensaje entero.
//
// Antes sí se aceptaba, con el argumento de que un mensaje que es solo el
// código no tiene ambigüedad. Es falso: el alfabeto de las referencias son
// letras y dígitos comunes, así que cualquier palabra de 6 caracteres que
// caiga dentro de él se interpretaría como una referencia.
//
// Estas son palabras REALES de una conversación inmobiliaria, todas con sus 6
// caracteres dentro del alfabeto (verificado, no supuesto):
//
//   VENTAS · FECHAS · SEMANA · MANANA · TARDES · PUEDES · VENDER · CHALET
//
// Cualquiera de ellas, mandada sola, se resolvía como SUB-<palabra>, no
// existía, y el cliente recibía "no pude encontrar ese formulario" en vez de
// que la IA le contestara normalmente. Un cliente escribiendo "SEMANA" para
// pedir disponibilidad se topaba con un error.
//
// (Palabras como PRECIO, CUANDO o METROS zafaban solo porque contienen O, que
// está excluida del alfabeto — o sea que la protección era pura casualidad.)
//
// La conveniencia no hacía falta: el CTA del formulario SIEMPRE emite
// "Referencia: SUB-XXXXXX", así que el prefijo está garantizado en el único
// camino que produce referencias de verdad.
//
// Cuando no hay match devuelve null y el mensaje sigue por el pipeline de IA
// normal, que es exactamente lo que un mensaje común tiene que hacer.
//
// normalizeSubmissionReference() sigue tolerando códigos sin prefijo: se usa
// para normalizar un código que ya se sabe que ES un código. Lo estricto es
// la DETECCIÓN dentro de texto libre, que es donde está el riesgo.
export function extractSubmissionReference(text: string | null | undefined): string | null {
  if (!text) return null

  const match = IN_TEXT.exec(text)
  if (!match || !match[1]) return null

  return normalizeSubmissionReference(SUBMISSION_REFERENCE_PREFIX + match[1])
}
