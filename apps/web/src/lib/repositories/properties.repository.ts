import type { PropertyRow, PropertyImageRow, UnitRow, Json } from '@orderflow/types'
import type { CreatePropertyInput, UpdatePropertyInput } from '@orderflow/validators'
import { createClient } from '@orderflow/supabase/server'
import { nullify } from './shared'

export type PropertyStatus = 'active' | 'draft' | 'archived'

export type PropertyListItem = PropertyRow & {
  unitCount: number
  images:    PropertyImageRow[]
  status:    PropertyStatus
}

export type PropertyWithUnits = PropertyRow & {
  units:  UnitRow[]
  images: PropertyImageRow[]
  status: PropertyStatus
}

function deriveStatus(p: { published: boolean; deleted_at: string | null }): PropertyStatus {
  if (p.deleted_at) return 'archived'
  if (p.published) return 'active'
  return 'draft'
}

export async function listPropertiesForReservation(
  tenantId: string,
): Promise<Pick<PropertyRow, 'id' | 'title' | 'city'>[]> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('properties')
    .select('id, title, city')
    .eq('tenant_id', tenantId)
    .eq('operation_type', 'temporary_rental')
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
  if (error) throw new Error(error.message)
  return data ?? []
}

export async function listProperties(tenantId: string): Promise<PropertyListItem[]> {
  const supabase = await createClient()

  const { data: properties, error } = await supabase
    .from('properties')
    .select('*')
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })

  if (error) throw new Error(error.message)
  if (!properties || properties.length === 0) return []

  const propertyIds = properties.map((p) => p.id)

  const [{ data: units }, { data: images }] = await Promise.all([
    supabase
      .from('units')
      .select('property_id')
      .eq('tenant_id', tenantId)
      .is('deleted_at', null)
      .in('property_id', propertyIds),
    supabase
      .from('property_images')
      .select('*')
      .in('property_id', propertyIds)
      .order('sort_order', { ascending: true }),
  ])

  const countMap  = new Map<string, number>()
  const imagesMap = new Map<string, PropertyImageRow[]>()

  for (const u of units ?? []) {
    countMap.set(u.property_id, (countMap.get(u.property_id) ?? 0) + 1)
  }
  for (const img of images ?? []) {
    const list = imagesMap.get(img.property_id) ?? []
    list.push(img)
    imagesMap.set(img.property_id, list)
  }

  return properties.map((p) => ({
    ...p,
    unitCount: countMap.get(p.id) ?? 0,
    images:    imagesMap.get(p.id) ?? [],
    status:    deriveStatus(p),
  }))
}

export async function getPropertyById(
  tenantId: string,
  id: string,
): Promise<PropertyWithUnits | null> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('properties')
    .select('*')
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .maybeSingle()

  if (error || !data) return null

  const [{ data: units }, { data: images }] = await Promise.all([
    supabase
      .from('units')
      .select('*')
      .eq('property_id', id)
      .eq('tenant_id', tenantId)
      .is('deleted_at', null)
      .order('created_at', { ascending: true }),
    supabase
      .from('property_images')
      .select('*')
      .eq('property_id', id)
      .order('sort_order', { ascending: true }),
  ])

  return {
    ...data,
    units:  units ?? [],
    images: images ?? [],
    status: deriveStatus(data),
  }
}

export async function createProperty(
  tenantId: string,
  input: CreatePropertyInput,
): Promise<PropertyRow> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('properties')
    .insert({
      tenant_id:                tenantId,
      title:                    input.title,
      description:              nullify(input.description),
      location_label:           nullify(input.location_label),
      internal_address:         nullify(input.internal_address),
      google_maps_url:          nullify(input.google_maps_url),
      cover_image_url:          nullify(input.cover_image_url),
      cover_image_storage_path: input.cover_image_storage_path ?? null,
      capacity:                 input.capacity ?? null,
      area_m2:                  input.area_m2  ?? null,
      custom_fields:            (input.custom_fields ?? []) as Json,
      published:                input.published ?? false,
      operation_type:             input.operation_type ?? 'temporary_rental',
      pricing_mode:               input.pricing_mode   ?? 'consult',
      currency:                   input.currency       ?? 'ARS',
      show_price_public:          input.show_price_public ?? true,
      sale_price:                 input.sale_price                ?? null,
      monthly_rent_price:         input.monthly_rent_price        ?? null,
      expenses_amount:            input.expenses_amount           ?? null,
      long_term_deposit_amount:   input.long_term_deposit_amount  ?? null,
      long_term_price_notes:      input.long_term_price_notes     ?? null,
      base_price_per_night:       input.base_price_per_night      ?? null,
      minimum_stay_nights:        input.minimum_stay_nights       ?? 1,
      cleaning_fee:               input.cleaning_fee              ?? 0,
      temporary_deposit_amount:   input.temporary_deposit_amount  ?? null,
      temporary_deposit_percent:  input.temporary_deposit_percent ?? null,
      temporary_price_notes:      input.temporary_price_notes     ?? null,
      check_in_time:              input.check_in_time             ?? null,
      check_out_time:             input.check_out_time            ?? null,
      slug:                       input.slug                      ?? null,
      public_code:                input.public_code               ?? null,
      show_exact_address_public:  input.show_exact_address_public ?? false,
    })
    .select()
    .single()

  if (error) throw new Error(error.message)
  return data
}

export async function replacePropertyImages(
  propertyId: string,
  images: { url: string; alt?: string; storage_path?: string }[],
): Promise<void> {
  const supabase = await createClient()

  const { error: delErr } = await supabase
    .from('property_images')
    .delete()
    .eq('property_id', propertyId)

  if (delErr) throw new Error(delErr.message)

  if (images.length === 0) return

  const rows = images.map((img, idx) => ({
    property_id:  propertyId,
    image_url:    img.url,
    alt:          img.alt ?? null,
    storage_path: img.storage_path ?? null,
    sort_order:   idx,
    is_cover:     false,
  }))

  const { error: insErr } = await supabase.from('property_images').insert(rows)
  if (insErr) throw new Error(insErr.message)
}

export async function updateProperty(
  tenantId: string,
  id: string,
  input: UpdatePropertyInput,
): Promise<PropertyRow> {
  const supabase = await createClient()

  const patch: {
    title?:                    string
    description?:              string | null
    location_label?:           string | null
    internal_address?:         string | null
    google_maps_url?:          string | null
    cover_image_url?:          string | null
    cover_image_storage_path?: string | null
    capacity?:                 number | null
    area_m2?:                  number | null
    custom_fields?:            Json
    operation_type?:            string
    pricing_mode?:              string
    currency?:                  string
    show_price_public?:         boolean
    sale_price?:                number | null
    monthly_rent_price?:        number | null
    expenses_amount?:           number | null
    long_term_deposit_amount?:  number | null
    long_term_price_notes?:     string | null
    base_price_per_night?:      number | null
    minimum_stay_nights?:       number
    cleaning_fee?:              number
    temporary_deposit_amount?:  number | null
    temporary_deposit_percent?: number | null
    temporary_price_notes?:     string | null
    check_in_time?:             string | null
    check_out_time?:            string | null
    published?:                 boolean
    slug?:                      string | null
    public_code?:               string | null
    show_exact_address_public?: boolean
  } = {}
  if (input.title                    !== undefined) patch.title                    = input.title
  if (input.description              !== undefined) patch.description              = nullify(input.description)
  if (input.location_label           !== undefined) patch.location_label           = nullify(input.location_label)
  if (input.internal_address         !== undefined) patch.internal_address         = nullify(input.internal_address)
  if (input.google_maps_url          !== undefined) patch.google_maps_url          = nullify(input.google_maps_url)
  if (input.cover_image_url          !== undefined) patch.cover_image_url          = nullify(input.cover_image_url)
  if (input.cover_image_storage_path !== undefined) patch.cover_image_storage_path = input.cover_image_storage_path ?? null
  if (input.capacity                 !== undefined) patch.capacity                 = input.capacity ?? null
  if (input.area_m2                  !== undefined) patch.area_m2                  = input.area_m2  ?? null
  if (input.custom_fields            !== undefined) patch.custom_fields            = (input.custom_fields ?? []) as Json
  if (input.operation_type           !== undefined) patch.operation_type           = input.operation_type
  if (input.pricing_mode             !== undefined) patch.pricing_mode             = input.pricing_mode
  if (input.currency                 !== undefined) patch.currency                 = input.currency
  if (input.show_price_public        !== undefined) patch.show_price_public        = input.show_price_public
  if (input.sale_price               !== undefined) patch.sale_price               = input.sale_price               ?? null
  if (input.monthly_rent_price       !== undefined) patch.monthly_rent_price       = input.monthly_rent_price       ?? null
  if (input.expenses_amount          !== undefined) patch.expenses_amount          = input.expenses_amount          ?? null
  if (input.long_term_deposit_amount !== undefined) patch.long_term_deposit_amount = input.long_term_deposit_amount ?? null
  if (input.long_term_price_notes    !== undefined) patch.long_term_price_notes    = input.long_term_price_notes    ?? null
  if (input.base_price_per_night     !== undefined) patch.base_price_per_night     = input.base_price_per_night     ?? null
  if (input.minimum_stay_nights      !== undefined) patch.minimum_stay_nights      = input.minimum_stay_nights      ?? 1
  if (input.cleaning_fee             !== undefined) patch.cleaning_fee             = input.cleaning_fee             ?? 0
  if (input.temporary_deposit_amount !== undefined) patch.temporary_deposit_amount = input.temporary_deposit_amount ?? null
  if (input.temporary_deposit_percent !== undefined) patch.temporary_deposit_percent = input.temporary_deposit_percent ?? null
  if (input.temporary_price_notes    !== undefined) patch.temporary_price_notes    = input.temporary_price_notes    ?? null
  if (input.check_in_time            !== undefined) patch.check_in_time            = input.check_in_time            ?? null
  if (input.check_out_time           !== undefined) patch.check_out_time           = input.check_out_time           ?? null
  if (input.published                !== undefined) patch.published                = input.published
  if (input.slug                     !== undefined) patch.slug                     = input.slug                     ?? null
  if (input.public_code              !== undefined) patch.public_code              = input.public_code              ?? null
  if (input.show_exact_address_public !== undefined) patch.show_exact_address_public = input.show_exact_address_public

  const { data, error } = await supabase
    .from('properties')
    .update(patch)
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .select()
    .single()

  if (error) throw new Error(error.message)
  return data
}

export async function setPublished(
  tenantId: string,
  id: string,
  published: boolean,
): Promise<void> {
  const supabase = await createClient()
  const { error } = await supabase
    .from('properties')
    .update({ published })
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
  if (error) throw new Error(error.message)
}

export async function hasActiveReservationsForProperty(
  tenantId: string,
  propertyId: string,
): Promise<boolean> {
  const supabase = await createClient()

  // Check via units (legacy path)
  const { data: units } = await supabase
    .from('units')
    .select('id')
    .eq('property_id', propertyId)
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)

  if (units && units.length > 0) {
    const unitIds = units.map((u) => u.id)
    const { count } = await supabase
      .from('reservations')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .in('unit_id', unitIds)
      .is('deleted_at', null)
      .neq('status', 'cancelled')
    if ((count ?? 0) > 0) return true
  }

  // Check via direct property_id (post-migration 20260710000002)
  const { count: directCount } = await supabase
    .from('reservations')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('property_id', propertyId)
    .is('deleted_at', null)
    .neq('status', 'cancelled')

  return (directCount ?? 0) > 0
}

export async function archiveProperty(tenantId: string, id: string): Promise<void> {
  const supabase = await createClient()
  const { error } = await supabase
    .from('properties')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
  if (error) throw new Error(error.message)
}

export { validateWorkspaceInTenant } from './shared'
