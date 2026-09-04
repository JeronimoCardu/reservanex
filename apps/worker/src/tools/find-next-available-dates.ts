import { createClient } from '../lib/supabase'
import type { LLMTool } from '../lib/llm'

export const findNextAvailableDatesTool: LLMTool = {
  type: 'function',
  function: {
    name: 'find_next_available_dates',
    description:
      'Busca el próximo período disponible para una propiedad. ' +
      'Llamá esta herramienta cuando el cliente pregunte "¿cuándo está libre?" o cuando check_property_availability devuelva available=false. ' +
      'Devuelve next_available_start y next_available_end para el período libre más cercano.',
    parameters: {
      type:       'object',
      properties: {
        property_id: {
          type:        'string',
          description: 'ID de la propiedad.',
        },
        nights_count: {
          type:        'integer',
          description: 'Noches que necesita el cliente (si ya las sabe). Si no, usar 1.',
          minimum:     1,
        },
        desired_start_date: {
          type:        'string',
          description: 'Fecha desde la que buscar en formato YYYY-MM-DD. Por defecto: hoy.',
        },
        search_days: {
          type:        'integer',
          description: 'Días hacia adelante a buscar (por defecto 60, máximo 180).',
          minimum:     7,
          maximum:     180,
        },
      },
      required:             ['property_id'],
      additionalProperties: false,
    },
  },
}

interface DateRange {
  start: string
  end:   string
  type:  'confirmed' | 'pre_reserved' | 'blocked'
}

export async function executeFindNextAvailableDates(
  tenantId: string,
  rawArgs:  Record<string, unknown>,
): Promise<string> {
  const propertyId      = typeof rawArgs['property_id']        === 'string' ? rawArgs['property_id'].trim()        : ''
  const nightsCount     = typeof rawArgs['nights_count']       === 'number' ? Math.max(1, Math.floor(rawArgs['nights_count'])) : 1
  const desiredStartRaw = typeof rawArgs['desired_start_date'] === 'string' ? rawArgs['desired_start_date'].trim() : null
  const searchDays      = typeof rawArgs['search_days']        === 'number' ? Math.min(180, Math.max(7, Math.floor(rawArgs['search_days']))) : 60

  if (!propertyId) {
    return JSON.stringify({ error: 'property_id es requerido.' })
  }

  const supabase = createClient()
  const today    = new Date()
  today.setHours(0, 0, 0, 0)

  const searchStart = desiredStartRaw ? new Date(desiredStartRaw + 'T00:00:00') : new Date(today.getTime())
  if (searchStart < today) searchStart.setTime(today.getTime())

  const searchEnd = new Date(searchStart.getTime() + searchDays * 86400000)

  const toStr = (d: Date) => d.toISOString().split('T')[0]!

  const searchStartStr = toStr(searchStart)
  const searchEndStr   = toStr(searchEnd)

  const { data: property } = await supabase
    .from('properties')
    .select('id, title, minimum_stay_nights, operation_type, commercial_status')
    .eq('tenant_id', tenantId)
    .eq('id', propertyId)
    .eq('published', true)
    .is('deleted_at', null)
    .maybeSingle()

  if (!property) {
    return JSON.stringify({ error: 'Propiedad no encontrada.' })
  }

  if (property.commercial_status !== 'available') {
    const unavailableReasons: Record<string, string> = {
      rented: 'La propiedad está alquilada actualmente.',
      sold:   'La propiedad está vendida.',
      paused: 'La propiedad no está disponible actualmente.',
    }
    return JSON.stringify({
      error:             unavailableReasons[property.commercial_status] ?? 'La propiedad no está disponible comercialmente.',
      commercial_status: property.commercial_status,
    })
  }

  if (property.operation_type !== 'temporary_rental') {
    return JSON.stringify({ error: 'Esta propiedad no es de alquiler temporario y no admite reservas por noches.' })
  }

  const minStay = Math.max(nightsCount, property.minimum_stay_nights ?? 1)
  const now     = new Date().toISOString()

  const occupied: DateRange[] = []

  const { data: confirmed } = await supabase
    .from('reservations')
    .select('start_date, end_date')
    .eq('tenant_id', tenantId)
    .eq('property_id', propertyId)
    .eq('status', 'confirmed')
    .is('deleted_at', null)
    .lt('start_date', searchEndStr)
    .gt('end_date', searchStartStr)

  for (const r of confirmed ?? []) {
    occupied.push({ start: r.start_date, end: r.end_date, type: 'confirmed' })
  }

  const { data: pending } = await supabase
    .from('reservations')
    .select('start_date, end_date')
    .eq('tenant_id', tenantId)
    .eq('property_id', propertyId)
    .eq('status', 'pre_reserved')
    .is('deleted_at', null)
    .gt('expires_at', now)
    .lt('start_date', searchEndStr)
    .gt('end_date', searchStartStr)

  for (const r of pending ?? []) {
    occupied.push({ start: r.start_date, end: r.end_date, type: 'pre_reserved' })
  }

  const { data: blocks } = await supabase
    .from('property_availability_blocks')
    .select('start_date, end_date')
    .eq('tenant_id', tenantId)
    .eq('property_id', propertyId)
    .is('deleted_at', null)
    .lt('start_date', searchEndStr)
    .gt('end_date', searchStartStr)

  for (const b of blocks ?? []) {
    occupied.push({ start: b.start_date, end: b.end_date, type: 'blocked' })
  }

  occupied.sort((a, b) => a.start.localeCompare(b.start))

  // Merge overlapping ranges so the gap algorithm works cleanly
  const merged: DateRange[] = []
  for (const r of occupied) {
    const last = merged[merged.length - 1]
    if (last && r.start <= last.end) {
      last.end = last.end > r.end ? last.end : r.end
    } else {
      merged.push({ ...r })
    }
  }

  // Find first gap >= minStay nights
  let cursor = new Date(searchStart.getTime())

  for (const range of merged) {
    const rangeStart  = new Date(range.start + 'T00:00:00')
    const rangeEnd    = new Date(range.end   + 'T00:00:00')
    const gapNights   = Math.round((rangeStart.getTime() - cursor.getTime()) / 86400000)

    if (gapNights >= minStay) {
      const gapEndDate = new Date(cursor.getTime() + minStay * 86400000)
      return JSON.stringify({
        found:                true,
        property_title:       property.title,
        next_available_start: toStr(cursor),
        next_available_end:   toStr(gapEndDate),
        nights:               minStay,
        occupied_ranges:      occupied.slice(0, 8),
        message:
          `La próxima disponibilidad para ${minStay} noche${minStay !== 1 ? 's' : ''} ` +
          `es del ${toStr(cursor)} al ${toStr(gapEndDate)}.`,
      })
    }

    if (rangeEnd > cursor) cursor = new Date(rangeEnd.getTime())
  }

  // Check tail gap
  const remainingNights = Math.round((searchEnd.getTime() - cursor.getTime()) / 86400000)
  if (remainingNights >= minStay) {
    const gapEndDate = new Date(cursor.getTime() + minStay * 86400000)
    return JSON.stringify({
      found:                true,
      property_title:       property.title,
      next_available_start: toStr(cursor),
      next_available_end:   toStr(gapEndDate),
      nights:               minStay,
      occupied_ranges:      occupied.slice(0, 8),
      message:
        `La próxima disponibilidad para ${minStay} noche${minStay !== 1 ? 's' : ''} ` +
        `es del ${toStr(cursor)} al ${toStr(gapEndDate)}.`,
    })
  }

  return JSON.stringify({
    found:          false,
    property_title: property.title,
    occupied_ranges: occupied.slice(0, 8),
    search_days:    searchDays,
    message:
      `No hay disponibilidad para ${minStay} noche${minStay !== 1 ? 's' : ''} en los próximos ${searchDays} días. ` +
      `Hay ${occupied.length} período${occupied.length !== 1 ? 's' : ''} ocupado${occupied.length !== 1 ? 's' : ''}.`,
  })
}
