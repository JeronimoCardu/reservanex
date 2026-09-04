import { createClient } from '../lib/supabase'
import type { LLMTool } from '../lib/llm'

export const saveContactNameTool: LLMTool = {
  type: 'function',
  function: {
    name: 'save_contact_name',
    description:
      'Guarda el nombre y apellido del cliente en el sistema. ' +
      'Usá esta herramienta SOLO cuando el cliente respondió con su nombre y apellido (ej: "Juan Pérez"). ' +
      'No la uses si el cliente respondió con una consulta, una pregunta, o texto que claramente no es un nombre.',
    parameters: {
      type:       'object',
      properties: {
        name: {
          type:        'string',
          description: 'Nombre completo del cliente tal como lo informó (ej: "Juan Pérez", "María García").',
        },
      },
      required:             ['name'],
      additionalProperties: false,
    },
  },
}

// Words that indicate the text is a query, not a name.
const QUERY_WORDS = /\b(precio|casa|departamento|depto|alquiler|alquilo|venta|alias|cbu|cvu|transferencia|reserva|disponibilidad|propiedad|consulta|hola|buenas|gracias|habitaci[oó]n|cuarto)\b/i
const INVALID_CHARS = /\d{3,}|https?:|\/\/|\?|@/

export async function executeSaveContactName(
  tenantId:  string,
  contactId: string,
  rawArgs:   Record<string, unknown>,
): Promise<string> {
  const name = typeof rawArgs['name'] === 'string' ? rawArgs['name'].trim() : ''

  // Basic length check
  if (!name || name.length < 2 || name.length > 80) {
    return JSON.stringify({ saved: false, reason: 'Nombre inválido o demasiado largo.' })
  }

  // Reject text that looks like a query, URL, phone, or number
  if (QUERY_WORDS.test(name) || INVALID_CHARS.test(name)) {
    return JSON.stringify({ saved: false, reason: 'El texto no parece un nombre.' })
  }

  const supabase = createClient()

  // Guard: don't overwrite an existing name
  const { data: existing } = await supabase
    .from('contacts')
    .select('name')
    .eq('id', contactId)
    .eq('tenant_id', tenantId)
    .maybeSingle()

  if (existing?.name) {
    const firstName = existing.name.split(/\s+/)[0] ?? existing.name
    return JSON.stringify({ saved: false, reason: 'El contacto ya tiene nombre.', name: existing.name, firstName })
  }

  const { error } = await supabase
    .from('contacts')
    .update({ name })
    .eq('id', contactId)
    .eq('tenant_id', tenantId)

  if (error) {
    console.warn('[save_contact_name] DB error:', error.message)
    return JSON.stringify({ saved: false, reason: 'Error al guardar el nombre.' })
  }

  const firstName = name.split(/\s+/)[0] ?? name
  console.log('[save_contact_name] saved:', { contactId, name })
  return JSON.stringify({ saved: true, name, firstName })
}
