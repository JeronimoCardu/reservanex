import { createAdminClient } from '@orderflow/supabase/admin'

// ── Types ─────────────────────────────────────────────────────────────────────

export type PublicTenant = {
  // Fase 3A — rubro del tenant. Determina qué formularios dinámicos ofrece
  // su sitio público (packages/validators/src/forms.ts).
  vertical: string
  id:                       string
  name:                     string
  logo_url:                 string | null
  public_logo_url:          string | null
  primary_color:            string | null
  public_slug:              string | null
  public_site_enabled:      boolean
  public_name:              string | null
  public_description:       string | null
  public_cover_image_url:   string | null
  public_primary_color:     string | null
  public_secondary_color:   string | null
  public_phone:             string | null
  public_email:             string | null
  public_instagram_url:     string | null
  public_website_url:       string | null
}

export type PublicPropertyImage = {
  id:        string
  image_url: string
  alt:       string | null
  is_cover:  boolean
  sort_order: number
}

export type PublicPropertyVideo = {
  id:               string
  title:            string | null
  mime_type:        string
  duration_seconds: number | null
  sort_order:       number
}

export type PublicProperty = {
  id:                        string
  title:                     string
  slug:                      string | null
  public_code:               string | null
  description:               string | null
  location_label:            string | null
  internal_address:          string | null
  show_exact_address_public: boolean
  cover_image_url:           string | null
  capacity:                  number | null
  area_m2:                   number | null
  custom_fields:             Array<{ key: string; value: string }>
  commercial_status:         string
  operation_type:            'sale' | 'long_term_rental' | 'temporary_rental'
  pricing_mode:              'fixed' | 'consult'
  currency:                  string
  show_price_public:         boolean
  sale_price:                number | null
  monthly_rent_price:        number | null
  expenses_amount:           number | null
  long_term_price_notes:     string | null
  base_price_per_night:      number | null
  minimum_stay_nights:       number
  cleaning_fee:              number
  temporary_price_notes:     string | null
  check_in_time:             string | null
  check_out_time:            string | null
  google_maps_url:           string | null
  images:                    PublicPropertyImage[]
  videos:                    PublicPropertyVideo[]
  video_count:               number
}

export type BlockedInterval = {
  start: string  // YYYY-MM-DD inclusive
  end:   string  // YYYY-MM-DD exclusive (checkout date — can be check-in of next reservation)
}

// ── Tenant ────────────────────────────────────────────────────────────────────

export async function getPublicTenant(publicSlug: string): Promise<PublicTenant | null> {
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('tenants')
    .select(
      'id, name, logo_url, public_logo_url, primary_color, public_slug, public_site_enabled, public_name, public_description, public_cover_image_url, public_primary_color, public_secondary_color, public_phone, public_email, public_instagram_url, public_website_url, status, vertical'
    )
    .eq('public_slug', publicSlug)
    .is('deleted_at', null)
    .maybeSingle()

  if (error || !data) return null
  // Fase 8 §14 — a suspended/cancelled/churned tenant must not keep serving
  // its public site (its CRM login is already blocked the same way by
  // checkTenantAccess() in require-tenant-context.ts — this closes the gap
  // where deactivating a tenant left the marketing site + WhatsApp CTA
  // running). Checked here, not via a public_site_enabled flip, so the
  // owner's own public_site_enabled preference is preserved and
  // automatically resumes once the tenant is reactivated.
  if (data.status !== 'trial' && data.status !== 'active') return null
  // Fase 10 Paso 3 — every real caller already checks
  // `!tenant || !tenant.public_site_enabled` identically (notFound()/404/
  // empty metadata either way), so this changes no behavior today. Moving
  // the check here means a future caller can't accidentally skip it and
  // serve a tenant that never opted into a public site.
  if (!data.public_site_enabled) return null
  return (data as unknown) as PublicTenant
}

export async function getPublicTenantWhatsApp(tenantId: string): Promise<string | null> {
  const supabase = createAdminClient()
  const { data } = await supabase
    .from('whatsapp_accounts')
    .select('display_phone_number, phone_number')
    .eq('tenant_id', tenantId)
    .eq('active', true)
    .maybeSingle()

  if (!data) return null
  const raw = data.display_phone_number ?? data.phone_number ?? null
  if (!raw) return null
  return raw.replace(/\D/g, '')  // strip non-digits for wa.me
}

// Fase 3B — el número al que debe escribir quien completó un formulario.
//
// Distinto de getPublicTenantWhatsApp() a propósito, y no es duplicación:
// aquella resuelve "el WhatsApp público del tenant" para los CTA del sitio y
// es agnóstica de proveedor. Acá hace falta específicamente la cuenta
// AUTORESPONDER, porque es la única cuyo inbound ejecuta el flujo de
// confirmación (apps/worker/src/submissions/handler.ts devuelve 'skip' si el
// provider no es autoresponder). Si mandáramos al número de Meta, el cliente
// escribiría la referencia y nadie la procesaría.
//
// Devuelve null si no hay cuenta AutoResponder activa. El caller debe mostrar
// un estado controlado, NUNCA inventar un número (§2).
export async function getTenantAutoResponderWhatsApp(tenantId: string): Promise<string | null> {
  const supabase = createAdminClient()
  const { data } = await supabase
    .from('whatsapp_accounts')
    .select('display_phone_number, phone_number')
    .eq('tenant_id', tenantId)
    .eq('provider', 'autoresponder')
    .eq('active', true)
    // Un tenant puede tener más de una cuenta AutoResponder activa: en el
    // proyecto de QA conviven la real y varias que quedaron de corridas de
    // validación anteriores. Elegir "la más nueva" o "la más vieja" sería
    // arbitrario y podría mandar al cliente a un número muerto.
    //
    // El criterio es cuál tiene un dispositivo VIVO: last_device_seen_at lo
    // actualiza el heartbeat del Android, así que la cuenta que más
    // recientemente dio señales es la que efectivamente va a recibir el
    // mensaje. NULLS LAST deja al final a las que nunca conectaron, y
    // created_at desempata de forma estable.
    .order('last_device_seen_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (!data) return null
  const raw = data.display_phone_number ?? data.phone_number ?? null
  if (!raw) return null
  const digits = raw.replace(/\D/g, '')   // wa.me exige solo dígitos
  return digits.length > 0 ? digits : null
}

// ── Properties ────────────────────────────────────────────────────────────────

export async function listPublicProperties(tenantId: string): Promise<PublicProperty[]> {
  const supabase = createAdminClient()

  const { data: props, error } = await supabase
    .from('properties')
    .select(
      // NOTE: internal_address and google_maps_url are intentionally EXCLUDED here.
      // The catalog is a client component — all props are serialized to the browser.
      // Both fields are potentially sensitive and are only revealed on the server-side
      // detail page when show_exact_address_public = true.
      'id, title, slug, public_code, description, location_label, ' +
      'show_exact_address_public, cover_image_url, capacity, area_m2, custom_fields, ' +
      'commercial_status, operation_type, pricing_mode, currency, show_price_public, sale_price, ' +
      'monthly_rent_price, expenses_amount, long_term_price_notes, ' +
      'base_price_per_night, minimum_stay_nights, cleaning_fee, temporary_price_notes, ' +
      'check_in_time, check_out_time'
    )
    .eq('tenant_id', tenantId)
    .eq('published', true)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })

  if (error || !props) return []

  // Supabase can't infer column types from concatenated string selects — cast to
  // a typed intermediate shape that matches the DB row without the computed fields.
  type RawRow = Omit<PublicProperty, 'images' | 'custom_fields'> & { custom_fields: unknown }
  type RawImg = { id: string; property_id: string; image_url: string; alt: string | null; is_cover: boolean; sort_order: number }

  const rows = (props as unknown) as RawRow[]
  const ids  = rows.map(p => p.id)
  if (ids.length === 0) return []

  const [imagesResult, videosResult] = await Promise.all([
    supabase
      .from('property_images')
      .select('id, property_id, image_url, alt, is_cover, sort_order')
      .in('property_id', ids)
      .order('sort_order', { ascending: true }),
    supabase
      .from('property_videos')
      .select('property_id')
      .in('property_id', ids),
  ])

  const imgMap      = new Map<string, PublicPropertyImage[]>()
  const videoCountMap = new Map<string, number>()

  for (const img of ((imagesResult.data ?? []) as unknown) as RawImg[]) {
    const list = imgMap.get(img.property_id) ?? []
    list.push({ id: img.id, image_url: img.image_url, alt: img.alt ?? null, is_cover: img.is_cover, sort_order: img.sort_order })
    imgMap.set(img.property_id, list)
  }
  for (const v of ((videosResult.data ?? []) as unknown) as { property_id: string }[]) {
    videoCountMap.set(v.property_id, (videoCountMap.get(v.property_id) ?? 0) + 1)
  }

  return rows.map(p => ({
    ...p,
    internal_address: null,  // excluded from select — detail page uses getPublicPropertyBySlug (server only)
    google_maps_url:  null,  // excluded from select — same reason
    // Fase 10 Paso 3: this listing feeds a 'use client' component
    // (catalog-client.tsx), so every prop returned here is serialized into
    // the page's hydration payload regardless of what the component chooses
    // to render — catalog-client.tsx's own formatPrice()/getNumericPrice()
    // already gate DISPLAY on show_price_public, but that only hid the
    // number visually; the raw value was still present in the page's
    // initial HTML/RSC props. Redact at the source instead, the same way
    // internal_address/google_maps_url already are above.
    sale_price:           p.show_price_public ? p.sale_price : null,
    monthly_rent_price:   p.show_price_public ? p.monthly_rent_price : null,
    base_price_per_night: p.show_price_public ? p.base_price_per_night : null,
    custom_fields: Array.isArray(p.custom_fields) ? (p.custom_fields as Array<{ key: string; value: string }>) : [],
    images:      imgMap.get(p.id) ?? [],
    videos:      [],  // full video data not needed on the listing page — only fetched for the detail page
    video_count: videoCountMap.get(p.id) ?? 0,
  }))
}

export async function getPublicPropertyBySlug(
  tenantId: string,
  slug: string,
): Promise<PublicProperty | null> {
  const supabase = createAdminClient()

  const { data: prop, error } = await supabase
    .from('properties')
    .select(
      'id, title, slug, public_code, description, location_label, internal_address, ' +
      'show_exact_address_public, cover_image_url, capacity, area_m2, custom_fields, ' +
      'commercial_status, operation_type, pricing_mode, currency, show_price_public, sale_price, ' +
      'monthly_rent_price, expenses_amount, long_term_price_notes, google_maps_url, ' +
      'base_price_per_night, minimum_stay_nights, cleaning_fee, temporary_price_notes, ' +
      'check_in_time, check_out_time'
    )
    .eq('tenant_id', tenantId)
    .eq('slug', slug)
    .eq('published', true)
    .is('deleted_at', null)
    .maybeSingle()

  if (error || !prop) return null

  type RawRow = Omit<PublicProperty, 'images' | 'videos' | 'custom_fields'> & { custom_fields: unknown }
  type RawImg = { id: string; image_url: string; alt: string | null; is_cover: boolean; sort_order: number }
  type RawVid = { id: string; title: string | null; mime_type: string; duration_seconds: number | null; sort_order: number }

  const p = (prop as unknown) as RawRow

  const videoPromise = supabase
    .from('property_videos')
    .select('id, title, mime_type, duration_seconds, sort_order')
    .eq('property_id', p.id)
    .order('sort_order', { ascending: true })

  const [imagesResult, videosResult] = await Promise.all([
    supabase
      .from('property_images')
      .select('id, image_url, alt, is_cover, sort_order')
      .eq('property_id', p.id)
      .order('sort_order', { ascending: true }),
    videoPromise,
  ])

  const images = imagesResult.data
  const videos = videosResult.data

  const coverUrl = p.cover_image_url as string | null

  // Gallery images ordered by sort_order, deduped against the cover URL
  const galleryImages: PublicPropertyImage[] = (((images ?? []) as unknown) as RawImg[])
    .filter(img => img.image_url !== coverUrl)
    .map(img => ({
      id:        img.id,
      image_url: img.image_url,
      alt:       img.alt ?? null,
      is_cover:  false,
      sort_order: img.sort_order,
    }))

  // Cover is always first; gallery follows; videos are separate
  const orderedImages: PublicPropertyImage[] = [
    ...(coverUrl
      ? [{ id: 'cover', image_url: coverUrl, alt: p.title as string | null, is_cover: true, sort_order: -1 }]
      : []),
    ...galleryImages,
  ]

  const mappedVideos = (((videos ?? []) as unknown) as RawVid[]).map(v => ({
    id: v.id,
    title: v.title,
    mime_type: v.mime_type,
    duration_seconds: v.duration_seconds,
    sort_order: v.sort_order,
  }))

  return {
    ...p,
    custom_fields: Array.isArray(p.custom_fields) ? (p.custom_fields as Array<{ key: string; value: string }>) : [],
    images:      orderedImages,
    videos:      mappedVideos,
    video_count: mappedVideos.length,
  }
}

// ── Availability ──────────────────────────────────────────────────────────────

export async function getPropertyBlockedIntervals(
  tenantId: string,
  propertyId: string,
  fromDate: string,
  toDate: string,
): Promise<BlockedInterval[]> {
  const supabase = createAdminClient()
  const now = new Date().toISOString()

  // Active confirmed reservations
  const [{ data: reservations }, { data: blocks }] = await Promise.all([
    supabase
      .from('reservations')
      .select('start_date, end_date, status, expires_at')
      .eq('tenant_id', tenantId)
      .eq('property_id', propertyId)
      .or(`status.eq.confirmed,and(status.eq.pre_reserved,expires_at.gt.${now})`)
      .lt('start_date', toDate)
      .gt('end_date', fromDate),
    supabase
      .from('property_availability_blocks')
      .select('start_date, end_date')
      .eq('tenant_id', tenantId)
      .eq('property_id', propertyId)
      .is('deleted_at', null)
      .lt('start_date', toDate)
      .gt('end_date', fromDate),
  ])

  const intervals: BlockedInterval[] = []

  for (const r of reservations ?? []) {
    intervals.push({ start: r.start_date, end: r.end_date })
  }
  for (const b of blocks ?? []) {
    intervals.push({ start: b.start_date, end: b.end_date })
  }

  return intervals
}
