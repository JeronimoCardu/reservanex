'use server'

import { revalidatePath } from 'next/cache'
import { z }              from 'zod'
import { requireTenantContext } from '@/lib/auth/require-tenant-context'
import { createClient }         from '@orderflow/supabase/server'
import { createAdminClient }    from '@orderflow/supabase/admin'
import type { ActionResult }    from '@/lib/action-result'

const RESERVED_SLUGS = new Set([
  'dashboard','login','auth','api','admin','site',
  'platform','settings','properties','property',
])

const publicSiteSchema = z.object({
  public_site_enabled:     z.boolean(),
  public_slug:             z.preprocess(
    v => v === '' || v === null || v === undefined ? null : String(v).toLowerCase().trim(),
    z.string()
      .min(3, 'Mínimo 3 caracteres')
      .max(64, 'Máximo 64 caracteres')
      .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, 'Solo letras minúsculas, números y guiones')
      .refine(s => !RESERVED_SLUGS.has(s), 'Slug reservado — elegí otro')
      .nullable()
      .optional(),
  ),
  public_name:             z.string().max(200).optional().nullable(),
  public_description:      z.string().max(1000).optional().nullable(),
  public_cover_image_url:  z.string().url().max(1000).optional().nullable().or(z.literal('')).transform(v => v === '' ? null : v),
  public_cover_image_storage_path: z.string().max(500).optional().nullable(),
  public_logo_url:         z.string().url().max(1000).optional().nullable().or(z.literal('')).transform(v => v === '' ? null : v),
  public_logo_storage_path: z.string().max(500).optional().nullable(),
  public_primary_color:    z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Color primario inválido — usá formato #RRGGBB').optional().nullable().or(z.literal('')).transform(v => v === '' ? null : v),
  public_secondary_color:  z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Color secundario inválido — usá formato #RRGGBB').optional().nullable().or(z.literal('')).transform(v => v === '' ? null : v),
  public_phone:            z.string().max(30).optional().nullable(),
  public_email:            z.string().email().max(200).optional().nullable().or(z.literal('')).transform(v => v === '' ? null : v),
  public_instagram_url:    z.string().url().max(500).optional().nullable().or(z.literal('')).transform(v => v === '' ? null : v),
  public_website_url:      z.string().url().max(500).optional().nullable().or(z.literal('')).transform(v => v === '' ? null : v),
})

export type PublicSiteInput = z.input<typeof publicSiteSchema>

export async function savePublicSiteAction(
  input: PublicSiteInput,
): Promise<ActionResult<void>> {
  const ctx = await requireTenantContext()
  if (ctx.role !== 'owner') return { success: false, error: 'Solo el propietario puede editar el sitio público.' }

  const parsed = publicSiteSchema.safeParse(input)
  if (!parsed.success) {
    const first = parsed.error.errors[0]
    return { success: false, error: first?.message ?? 'Datos inválidos.' }
  }

  const d = parsed.data
  const supabase = await createClient()

  const { error } = await supabase
    .from('tenants')
    .update({
      public_site_enabled:              d.public_site_enabled,
      public_slug:                      d.public_slug                      ?? null,
      public_name:                      d.public_name                      ?? null,
      public_description:               d.public_description               ?? null,
      public_cover_image_url:           d.public_cover_image_url           ?? null,
      public_cover_image_storage_path:  d.public_cover_image_storage_path  ?? null,
      public_logo_url:                  d.public_logo_url                  ?? null,
      public_logo_storage_path:         d.public_logo_storage_path         ?? null,
      public_primary_color:             d.public_primary_color             ?? null,
      public_secondary_color:           d.public_secondary_color           ?? null,
      public_phone:                     d.public_phone                     ?? null,
      public_email:                     d.public_email                     ?? null,
      public_instagram_url:             d.public_instagram_url             ?? null,
      public_website_url:               d.public_website_url               ?? null,
      updated_at:                       new Date().toISOString(),
    })
    .eq('id', ctx.tenantId)

  if (error) {
    if (error.code === '23505') return { success: false, error: 'Ese slug ya está en uso. Elegí otro.' }
    return { success: false, error: error.message }
  }

  revalidatePath('/dashboard/settings/public-site')
  return { success: true }
}

export async function getPublicSiteSettingsAction(): Promise<ActionResult<{
  public_site_enabled:             boolean
  public_slug:                     string | null
  public_name:                     string | null
  public_description:              string | null
  public_cover_image_url:          string | null
  public_cover_image_storage_path: string | null
  public_logo_url:                 string | null
  public_logo_storage_path:        string | null
  public_primary_color:            string | null
  public_secondary_color:          string | null
  public_phone:                    string | null
  public_email:                    string | null
  public_instagram_url:            string | null
  public_website_url:              string | null
}>> {
  const ctx = await requireTenantContext()
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('tenants')
    .select(
      'public_site_enabled, public_slug, public_name, public_description, ' +
      'public_cover_image_url, public_cover_image_storage_path, ' +
      'public_logo_url, public_logo_storage_path, ' +
      'public_primary_color, public_secondary_color, public_phone, public_email, ' +
      'public_instagram_url, public_website_url'
    )
    .eq('id', ctx.tenantId)
    .single()

  if (error || !data) return { success: false, error: 'No se pudo cargar la configuración.' }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { success: true, data: data as any }
}

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp'])
const MAX_SIZE_LOGO  = 5 * 1024 * 1024  // 5 MB
const MAX_SIZE_COVER = 5 * 1024 * 1024  // 5 MB

export async function uploadTenantPublicAssetAction(
  formData: FormData,
  assetType: 'logo' | 'cover',
): Promise<ActionResult<{ publicUrl: string; path: string }>> {
  const ctx = await requireTenantContext()
  if (ctx.role !== 'owner') return { success: false, error: 'Solo el propietario puede subir assets.' }

  const file = formData.get('file') as File | null
  if (!file || file.size === 0) return { success: false, error: 'No se recibió ningún archivo.' }

  if (!ALLOWED_MIME.has(file.type)) {
    return { success: false, error: 'Solo se permiten imágenes JPEG, PNG o WebP.' }
  }

  const maxSize = assetType === 'logo' ? MAX_SIZE_LOGO : MAX_SIZE_COVER
  if (file.size > maxSize) {
    const mb = maxSize / (1024 * 1024)
    return { success: false, error: `El archivo supera el límite de ${mb} MB.` }
  }

  const ext  = file.type.split('/')[1]!.replace('jpeg', 'jpg')
  const uuid = crypto.randomUUID()
  const path = `${ctx.tenantId}/${assetType}/${uuid}.${ext}`

  const supabase = createAdminClient()
  const { error: uploadError } = await supabase.storage
    .from('tenant-public-assets')
    .upload(path, file, { contentType: file.type, upsert: false })

  if (uploadError) return { success: false, error: 'Error al subir la imagen. Intentá de nuevo.' }

  const { data: urlData } = supabase.storage
    .from('tenant-public-assets')
    .getPublicUrl(path)

  return { success: true, data: { publicUrl: urlData.publicUrl, path } }
}
