'use server'

import { revalidatePath } from 'next/cache'
import { randomUUID } from 'crypto'
import { requireTenantContext } from '@/lib/auth/require-tenant-context'
import { createPropertySchema, updatePropertySchema } from '@orderflow/validators'
import * as repo from '@/lib/repositories/properties.repository'
import { createClient } from '@orderflow/supabase/server'
import type { ActionResult } from '@/lib/action-result'
import type { PropertyVideoRow } from '@orderflow/types'

const LIST_PATH   = '/dashboard/properties'
const DETAIL_PATH = (id: string) => `/dashboard/properties/${id}`

function canManageProperties(ctx: Awaited<ReturnType<typeof requireTenantContext>>): boolean {
  return ctx.role === 'owner' || ctx.canCreateProperties
}

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp']
const MAX_BYTES    = 5 * 1024 * 1024 // 5 MB

// Extrae el path dentro del bucket property-images de una URL pública de Supabase Storage.
// Devuelve null si la URL no pertenece a ese bucket.
function extractStoragePath(publicUrl: string | null | undefined): string | null {
  if (!publicUrl) return null
  const marker = '/storage/v1/object/public/property-images/'
  const idx = publicUrl.indexOf(marker)
  if (idx === -1) return null
  const path = publicUrl.slice(idx + marker.length)
  return path || null
}

// ── Upload ────────────────────────────────────────────────────────────────────

export async function uploadPropertyImageAction(
  formData: FormData,
): Promise<ActionResult<{ publicUrl: string; path: string }>> {
  const ctx = await requireTenantContext()

  if (!canManageProperties(ctx)) {
    return { success: false, error: 'No tenés permiso para subir imágenes.' }
  }

  const raw = formData.get('file')
  if (!raw || typeof raw === 'string') {
    return { success: false, error: 'No se recibió ningún archivo.' }
  }
  const file = raw as File

  if (!ALLOWED_MIME.includes(file.type)) {
    return { success: false, error: 'Solo se admiten imágenes JPG, PNG o WebP.' }
  }
  if (file.size > MAX_BYTES) {
    return { success: false, error: 'La imagen no puede superar 5 MB.' }
  }

  const ext  = file.type === 'image/jpeg' ? 'jpg' : file.type === 'image/png' ? 'png' : 'webp'
  const path = `${ctx.tenantId}/${randomUUID()}.${ext}`

  const supabase = await createClient()
  const { error } = await supabase.storage
    .from('property-images')
    .upload(path, file, { contentType: file.type, upsert: false })

  if (error) {
    console.error('[properties] uploadPropertyImageAction failed:', error)
    return { success: false, error: 'Error al subir la imagen. Intentá de nuevo.' }
  }

  const { data: urlData } = supabase.storage.from('property-images').getPublicUrl(path)
  return { success: true, data: { publicUrl: urlData.publicUrl, path } }
}

// ── Create ────────────────────────────────────────────────────────────────────

export async function createPropertyAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  const ctx = await requireTenantContext()

  if (!canManageProperties(ctx)) {
    return { success: false, error: 'No tenés permiso para crear propiedades.' }
  }

  const parsed = createPropertySchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.errors[0]?.message ?? 'Datos inválidos' }
  }

  let property: Awaited<ReturnType<typeof repo.createProperty>>
  try {
    property = await repo.createProperty(ctx.tenantId, parsed.data)
  } catch (err) {
    console.error('[properties] createProperty failed:', err)
    return { success: false, error: 'Error al crear la propiedad. Intentá de nuevo.' }
  }

  // Save gallery — if images fail, roll back the property
  const images = parsed.data.images ?? []
  if (images.length > 0) {
    try {
      await repo.replacePropertyImages(property.id, images)
    } catch (err) {
      console.error('[properties] replacePropertyImages failed, rolling back:', err)
      await repo.archiveProperty(ctx.tenantId, property.id).catch(() => undefined)
      return { success: false, error: 'Error al guardar las imágenes. Intentá de nuevo.' }
    }
  }

  revalidatePath(LIST_PATH)
  return { success: true, data: { id: property.id } }
}

// ── Update ────────────────────────────────────────────────────────────────────

export async function updatePropertyAction(
  id: string,
  input: unknown,
): Promise<ActionResult> {
  const ctx = await requireTenantContext()

  if (!canManageProperties(ctx)) {
    return { success: false, error: 'No tenés permiso para editar propiedades.' }
  }

  const property = await repo.getPropertyById(ctx.tenantId, id)
  if (!property) return { success: false, error: 'Propiedad no encontrada.' }

  const parsed = updatePropertySchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.errors[0]?.message ?? 'Datos inválidos' }
  }

  // Capturar datos viejos ANTES de actualizar (para cleanup de Storage)
  const oldImages    = property.images
  const oldCoverUrl  = property.cover_image_url
  const oldCoverPath =
    property.cover_image_storage_path ?? extractStoragePath(oldCoverUrl)

  try {
    await repo.updateProperty(ctx.tenantId, id, parsed.data)
  } catch (err) {
    console.error('[properties] updateProperty failed:', err)
    return { success: false, error: 'Error al actualizar la propiedad. Intentá de nuevo.' }
  }

  // Replace gallery if images were provided in the update
  const newImages = parsed.data.images
  if (newImages !== undefined) {
    try {
      await repo.replacePropertyImages(id, newImages ?? [])
    } catch (err) {
      console.error('[properties] replacePropertyImages on update failed:', err)
      // Propiedad ya guardada — no fallar la action, pero las imágenes quedaron sin cambios
    }
  }

  // ── Cleanup Storage: borrar archivos huérfanos (best-effort) ─────────────
  const pathsToDelete: string[] = []

  // Galería: imágenes viejas que ya no están en la nueva lista
  if (newImages !== undefined) {
    const newUrls = new Set(newImages.map((i) => i.url))
    for (const img of oldImages) {
      if (!newUrls.has(img.image_url)) {
        const path = img.storage_path ?? extractStoragePath(img.image_url)
        if (path) pathsToDelete.push(path)
      }
    }
  }

  // Cover: si se cambió, borrar el anterior
  const newCoverUrl = parsed.data.cover_image_url
  if (
    newCoverUrl !== undefined &&
    oldCoverUrl &&
    newCoverUrl !== oldCoverUrl &&
    oldCoverPath
  ) {
    pathsToDelete.push(oldCoverPath)
  }

  if (pathsToDelete.length > 0) {
    const supabase = await createClient()
    const { error: delErr } = await supabase.storage
      .from('property-images')
      .remove(pathsToDelete)
    if (delErr) {
      console.warn('[properties] cleanup orphaned storage paths failed:', delErr, pathsToDelete)
    }
  }

  revalidatePath(LIST_PATH)
  revalidatePath(DETAIL_PATH(id))
  return { success: true }
}

// ── Publish / Unpublish ───────────────────────────────────────────────────────

export async function activatePropertyAction(id: string): Promise<ActionResult> {
  const ctx = await requireTenantContext()

  if (ctx.role !== 'owner') {
    return { success: false, error: 'Solo los owners pueden publicar propiedades.' }
  }

  const property = await repo.getPropertyById(ctx.tenantId, id)
  if (!property) return { success: false, error: 'Propiedad no encontrada.' }

  try {
    await repo.setPublished(ctx.tenantId, id, true)
    revalidatePath(LIST_PATH)
    revalidatePath(DETAIL_PATH(id))
    return { success: true }
  } catch (err) {
    console.error('[properties] activateProperty failed:', err)
    return { success: false, error: 'Error al activar la propiedad. Intentá de nuevo.' }
  }
}

export async function deactivatePropertyAction(id: string): Promise<ActionResult> {
  const ctx = await requireTenantContext()

  if (ctx.role !== 'owner') {
    return { success: false, error: 'Solo los owners pueden desactivar propiedades.' }
  }

  const property = await repo.getPropertyById(ctx.tenantId, id)
  if (!property) return { success: false, error: 'Propiedad no encontrada.' }

  try {
    await repo.setPublished(ctx.tenantId, id, false)
    revalidatePath(LIST_PATH)
    revalidatePath(DETAIL_PATH(id))
    return { success: true }
  } catch (err) {
    console.error('[properties] deactivateProperty failed:', err)
    return { success: false, error: 'Error al desactivar la propiedad. Intentá de nuevo.' }
  }
}

// ── Delete (soft delete — internamente usa archiveProperty) ───────────────────

export async function deletePropertyAction(id: string): Promise<ActionResult> {
  const ctx = await requireTenantContext()

  if (ctx.role !== 'owner') {
    return { success: false, error: 'Solo los owners pueden eliminar propiedades.' }
  }

  const property = await repo.getPropertyById(ctx.tenantId, id)
  if (!property) return { success: false, error: 'Propiedad no encontrada.' }

  const hasReservations = await repo.hasActiveReservationsForProperty(ctx.tenantId, id)
  if (hasReservations) {
    return {
      success: false,
      error: 'La propiedad tiene reservas activas. Cancelalas antes de eliminarla.',
    }
  }

  try {
    await repo.archiveProperty(ctx.tenantId, id)
    revalidatePath(LIST_PATH)
    revalidatePath(DETAIL_PATH(id))
    return { success: true }
  } catch (err) {
    console.error('[properties] deleteProperty failed:', err)
    return { success: false, error: 'Error al eliminar la propiedad. Intentá de nuevo.' }
  }
}

// Mantenido para rollback interno en createPropertyAction
export async function archivePropertyAction(id: string): Promise<ActionResult> {
  return deletePropertyAction(id)
}

// ── Commercial status ─────────────────────────────────────────────────────────

const VALID_COMMERCIAL_STATUSES = ['available', 'rented', 'paused', 'sold'] as const
type CommercialStatus = typeof VALID_COMMERCIAL_STATUSES[number]

export async function changePropertyCommercialStatusAction(
  id:        string,
  newStatus: string,
): Promise<ActionResult> {
  const ctx = await requireTenantContext()

  if (ctx.role !== 'owner') {
    return { success: false, error: 'Solo los owners pueden cambiar el estado comercial.' }
  }

  if (!VALID_COMMERCIAL_STATUSES.includes(newStatus as CommercialStatus)) {
    return { success: false, error: 'Estado comercial no válido.' }
  }

  const supabase = await createClient()

  // Guard: no se puede cambiar el estado si hay contrato mensual activo
  // (bloquea cualquier cambio excepto mantener 'rented')
  if (newStatus !== 'rented') {
    const { data: activeContract } = await supabase
      .from('monthly_rental_contracts')
      .select('id')
      .eq('tenant_id', ctx.tenantId)
      .eq('property_id', id)
      .eq('status', 'active')
      .is('deleted_at', null)
      .maybeSingle()

    if (activeContract) {
      return {
        success: false,
        error:
          'No podés cambiar el estado comercial de esta propiedad porque tiene un contrato mensual activo. ' +
          'Finalizá o cancelá el contrato primero.',
      }
    }
  }

  const { error } = await supabase
    .from('properties')
    .update({ commercial_status: newStatus, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)

  if (error) {
    console.error('[properties] changePropertyCommercialStatusAction failed:', error)
    return { success: false, error: 'Error al cambiar el estado comercial. Intentá de nuevo.' }
  }

  revalidatePath(LIST_PATH)
  revalidatePath(DETAIL_PATH(id))
  return { success: true }
}

// ── Videos ────────────────────────────────────────────────────────────────────

const ALLOWED_VIDEO_MIME = ['video/mp4', 'video/webm', 'video/quicktime']
const MAX_VIDEO_BYTES    = 80 * 1024 * 1024 // 80 MB
const MAX_VIDEOS_PER_PROPERTY = 2

export async function getPropertyVideosAction(
  propertyId: string,
): Promise<ActionResult<PropertyVideoRow[]>> {
  const ctx = await requireTenantContext()

  if (!canManageProperties(ctx)) {
    return { success: false, error: 'No tenés permiso para ver videos.' }
  }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('property_videos')
    .select('id, tenant_id, property_id, storage_path, title, mime_type, file_size_bytes, duration_seconds, sort_order, created_by, created_at')
    .eq('property_id', propertyId)
    .eq('tenant_id', ctx.tenantId)
    .order('sort_order', { ascending: true })

  if (error) {
    console.error('[properties] getPropertyVideosAction failed:', error)
    return { success: false, error: 'Error al obtener los videos.' }
  }

  return { success: true, data: (data ?? []) as PropertyVideoRow[] }
}

export async function uploadPropertyVideoAction(
  propertyId: string,
  formData: FormData,
): Promise<ActionResult<{ id: string }>> {
  const ctx = await requireTenantContext()

  if (!canManageProperties(ctx)) {
    return { success: false, error: 'No tenés permiso para subir videos.' }
  }

  const raw = formData.get('file')
  if (!raw || typeof raw === 'string') {
    return { success: false, error: 'No se recibió ningún archivo.' }
  }
  const file = raw as File

  if (!ALLOWED_VIDEO_MIME.includes(file.type)) {
    return { success: false, error: 'Solo se admiten videos MP4, WebM o MOV.' }
  }
  if (file.size > MAX_VIDEO_BYTES) {
    return { success: false, error: 'El video no puede superar 80 MB.' }
  }

  const rawDuration = formData.get('duration_seconds')
  const durationSeconds = rawDuration ? parseInt(String(rawDuration), 10) : null
  if (durationSeconds != null && durationSeconds > 60) {
    return { success: false, error: 'El video no puede superar 60 segundos.' }
  }

  const title = formData.get('title')
  const titleStr = title && typeof title === 'string' && title.trim() ? title.trim() : null

  const supabase = await createClient()

  // Enforce max 2 videos per property
  const { count } = await supabase
    .from('property_videos')
    .select('id', { count: 'exact', head: true })
    .eq('property_id', propertyId)
    .eq('tenant_id', ctx.tenantId)

  if ((count ?? 0) >= MAX_VIDEOS_PER_PROPERTY) {
    return { success: false, error: `Esta propiedad ya tiene ${MAX_VIDEOS_PER_PROPERTY} videos (máximo permitido).` }
  }

  const ext  = file.type === 'video/mp4'      ? 'mp4'
             : file.type === 'video/webm'     ? 'webm'
             : 'mov'
  const path = `${ctx.tenantId}/${randomUUID()}.${ext}`

  const { error: uploadError } = await supabase.storage
    .from('property-videos')
    .upload(path, file, { contentType: file.type, upsert: false })

  if (uploadError) {
    console.error('[properties] uploadPropertyVideoAction storage error:', uploadError)
    return { success: false, error: 'Error al subir el video. Intentá de nuevo.' }
  }

  const { data: inserted, error: insertError } = await supabase
    .from('property_videos')
    .insert({
      tenant_id:        ctx.tenantId,
      property_id:      propertyId,
      storage_path:     path,
      title:            titleStr,
      mime_type:        file.type,
      file_size_bytes:  file.size,
      duration_seconds: durationSeconds,
      sort_order:       count ?? 0,
      created_by:       ctx.userId,
    })
    .select('id')
    .single()

  if (insertError || !inserted) {
    // Clean up orphaned file
    await supabase.storage.from('property-videos').remove([path]).catch(() => undefined)
    console.error('[properties] uploadPropertyVideoAction insert error:', insertError)
    return { success: false, error: 'Error al guardar el video. Intentá de nuevo.' }
  }

  revalidatePath(LIST_PATH)
  return { success: true, data: { id: inserted.id } }
}

export async function deletePropertyVideoAction(
  videoId: string,
): Promise<ActionResult> {
  const ctx = await requireTenantContext()

  if (!canManageProperties(ctx)) {
    return { success: false, error: 'No tenés permiso para eliminar videos.' }
  }

  const supabase = await createClient()

  const { data: video } = await supabase
    .from('property_videos')
    .select('id, tenant_id, storage_path')
    .eq('id', videoId)
    .eq('tenant_id', ctx.tenantId)
    .maybeSingle()

  if (!video) {
    return { success: false, error: 'Video no encontrado.' }
  }

  const { error: deleteError } = await supabase
    .from('property_videos')
    .delete()
    .eq('id', videoId)
    .eq('tenant_id', ctx.tenantId)

  if (deleteError) {
    console.error('[properties] deletePropertyVideoAction db error:', deleteError)
    return { success: false, error: 'Error al eliminar el video.' }
  }

  // Best-effort storage cleanup
  const { error: storageError } = await supabase.storage
    .from('property-videos')
    .remove([video.storage_path])
  if (storageError) {
    console.warn('[properties] deletePropertyVideoAction storage cleanup failed:', storageError, video.storage_path)
  }

  revalidatePath(LIST_PATH)
  return { success: true }
}

export async function reorderPropertyVideosAction(
  propertyId: string,
  orderedVideoIds: string[],
): Promise<ActionResult> {
  const ctx = await requireTenantContext()

  if (!canManageProperties(ctx)) {
    return { success: false, error: 'No tenés permiso para reordenar videos.' }
  }
  if (orderedVideoIds.length === 0) return { success: true }

  const supabase = await createClient()

  // Verify property belongs to tenant
  const { data: property } = await supabase
    .from('properties')
    .select('id')
    .eq('id', propertyId)
    .eq('tenant_id', ctx.tenantId)
    .single()

  if (!property) return { success: false, error: 'Propiedad no encontrada.' }

  // Update sort_order for each video; filter by tenant to prevent cross-tenant writes
  for (let i = 0; i < orderedVideoIds.length; i++) {
    const { error } = await supabase
      .from('property_videos')
      .update({ sort_order: i })
      .eq('id', orderedVideoIds[i]!)
      .eq('property_id', propertyId)
      .eq('tenant_id', ctx.tenantId)

    if (error) {
      console.error('[properties] reorderPropertyVideosAction failed:', error)
      return { success: false, error: 'Error al reordenar los videos.' }
    }
  }

  revalidatePath(LIST_PATH)
  return { success: true }
}
