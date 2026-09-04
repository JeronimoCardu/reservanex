// DB/Storage-IO orchestration for tenant-scoped Storage cleanup. Pure logic
// (path extraction, tenant-ownership validation, dedup) lives in
// apps/web/src/lib/tenant-storage-cleanup.ts — this file only touches the DB
// and Supabase Storage. Shared by both hardDeleteTenantBySuperAdminAction and
// resetQaDataExceptSuperAdminAction (apps/web/src/actions/platform-danger.ts)
// so there is exactly one implementation, not two partial ones.

import { createAdminClient } from '@orderflow/supabase/admin'
import {
  extractStoragePathFromPublicUrl,
  isPathOwnedByTenant,
  dedupeStorageRefs,
} from '@/lib/tenant-storage-cleanup'
import type { StorageObjectRef } from '@/lib/tenant-storage-cleanup'

// Collects every Storage object belonging to a tenant BEFORE any DB rows are
// deleted — admin_purge_tenant() removes the very rows that hold these
// paths, so this MUST run first (see the Fase 8 "purge Storage" report §3).
// Read-only: makes no Storage or DB mutation.
export async function collectTenantStorageObjects(
  tenantId: string,
): Promise<{ refs: StorageObjectRef[]; warnings: string[] }> {
  const admin = createAdminClient()
  const raw: StorageObjectRef[] = []

  // ── documents — dynamic bucket per row (never assume reservation-docs) ────
  const { data: docs } = await admin
    .from('documents')
    .select('storage_bucket, storage_path')
    .eq('tenant_id', tenantId)
  for (const d of docs ?? []) {
    if (d.storage_bucket && d.storage_path) {
      raw.push({ bucket: d.storage_bucket, path: d.storage_path, source: 'documents.storage_path' })
    }
  }

  // ── media_events — always whatsapp-media ──────────────────────────────────
  const { data: mediaEvents } = await admin
    .from('media_events')
    .select('storage_path')
    .eq('tenant_id', tenantId)
    .not('storage_path', 'is', null)
  for (const m of mediaEvents ?? []) {
    if (m.storage_path) raw.push({ bucket: 'whatsapp-media', path: m.storage_path, source: 'media_events.storage_path' })
  }

  // ── messages — always whatsapp-media; may duplicate media_events/documents
  //    above when the same inbound media was later promoted to a document ──
  const { data: msgs } = await admin
    .from('messages')
    .select('media_storage_path')
    .eq('tenant_id', tenantId)
    .not('media_storage_path', 'is', null)
  for (const m of msgs ?? []) {
    if (m.media_storage_path) raw.push({ bucket: 'whatsapp-media', path: m.media_storage_path, source: 'messages.media_storage_path' })
  }

  // ── properties — cover image (storage_path preferred, URL fallback) ───────
  const { data: props } = await admin
    .from('properties')
    .select('id, cover_image_url, cover_image_storage_path')
    .eq('tenant_id', tenantId)
  const propertyIds = (props ?? []).map((p) => p.id)
  for (const p of props ?? []) {
    const path = p.cover_image_storage_path ?? extractStoragePathFromPublicUrl('property-images', p.cover_image_url)
    if (path) raw.push({ bucket: 'property-images', path, source: 'properties.cover_image' })
  }

  // ── property_images ────────────────────────────────────────────────────────
  if (propertyIds.length > 0) {
    const { data: images } = await admin
      .from('property_images')
      .select('image_url, storage_path')
      .in('property_id', propertyIds)
    for (const img of images ?? []) {
      const path = img.storage_path ?? extractStoragePathFromPublicUrl('property-images', img.image_url)
      if (path) raw.push({ bucket: 'property-images', path, source: 'property_images' })
    }
  }

  // ── property_videos ─────────────────────────────────────────────────────────
  const { data: videos } = await admin
    .from('property_videos')
    .select('storage_path')
    .eq('tenant_id', tenantId)
  for (const v of videos ?? []) {
    if (v.storage_path) raw.push({ bucket: 'property-videos', path: v.storage_path, source: 'property_videos.storage_path' })
  }

  // ── unit_images — no known active writer in the current app code, kept
  //    defensively in case legacy rows exist ──────────────────────────────────
  const { data: units } = await admin.from('units').select('id').eq('tenant_id', tenantId)
  const unitIds = (units ?? []).map((u) => u.id)
  if (unitIds.length > 0) {
    const { data: unitImages } = await admin.from('unit_images').select('image_url').in('unit_id', unitIds)
    for (const img of unitImages ?? []) {
      const path = extractStoragePathFromPublicUrl('property-images', img.image_url)
      if (path) raw.push({ bucket: 'property-images', path, source: 'unit_images.image_url' })
    }
  }

  // ── tenants — public-site branding + legacy internal logo ──────────────────
  const { data: tenant } = await admin
    .from('tenants')
    .select('logo_url, public_logo_url, public_logo_storage_path, public_cover_image_url, public_cover_image_storage_path')
    .eq('id', tenantId)
    .maybeSingle()
  if (tenant) {
    const legacyLogoPath = extractStoragePathFromPublicUrl('tenant-public-assets', tenant.logo_url)
    if (legacyLogoPath) raw.push({ bucket: 'tenant-public-assets', path: legacyLogoPath, source: 'tenants.logo_url' })

    const publicLogoPath = tenant.public_logo_storage_path ?? extractStoragePathFromPublicUrl('tenant-public-assets', tenant.public_logo_url)
    if (publicLogoPath) raw.push({ bucket: 'tenant-public-assets', path: publicLogoPath, source: 'tenants.public_logo' })

    const coverPath = tenant.public_cover_image_storage_path ?? extractStoragePathFromPublicUrl('tenant-public-assets', tenant.public_cover_image_url)
    if (coverPath) raw.push({ bucket: 'tenant-public-assets', path: coverPath, source: 'tenants.public_cover_image' })
  }

  // ── Safety filter: every resolved path MUST literally start with this
  //    tenant's id as its first path segment — never delete "on trust" from
  //    a DB row's tenant_id column alone. ────────────────────────────────────
  const safe: StorageObjectRef[] = []
  const warnings: string[] = []
  for (const ref of raw) {
    if (isPathOwnedByTenant(tenantId, ref.path)) {
      safe.push(ref)
    } else {
      warnings.push(`Excluido por seguridad (path no empieza con el tenant_id): ${ref.source} → ${ref.bucket}/${ref.path}`)
    }
  }

  return { refs: dedupeStorageRefs(safe), warnings }
}

export type StorageDeleteFailure = { bucket: string; path: string; error: string }

// Best-effort. A path that no longer exists is NOT treated as a failure —
// Supabase Storage's remove() does not error on missing keys (verified by
// validate:purge-tenant test 6).
export async function deleteStorageObjects(
  refs: StorageObjectRef[],
): Promise<{ deletedCount: number; failures: StorageDeleteFailure[] }> {
  const admin = createAdminClient()

  const byBucket = new Map<string, string[]>()
  for (const ref of refs) {
    const list = byBucket.get(ref.bucket) ?? []
    list.push(ref.path)
    byBucket.set(ref.bucket, list)
  }

  let deletedCount = 0
  const failures: StorageDeleteFailure[] = []

  for (const [bucket, paths] of byBucket) {
    const { data, error } = await admin.storage.from(bucket).remove(paths)
    if (error) {
      for (const path of paths) failures.push({ bucket, path, error: error.message })
    } else {
      deletedCount += data?.length ?? 0
    }
  }

  return { deletedCount, failures }
}

export type TenantPurgeWithStorageResult = {
  dbResult: Record<string, number> | null
  dbError:  string | null
  storage: {
    attempted:    boolean
    deletedCount: number
    failures:     StorageDeleteFailure[]
    warnings:     string[]
  }
}

// Order (see the Fase 8 "purge Storage" report §3 for the full reasoning):
//   1. collect Storage refs from DB rows (BEFORE anything is deleted)
//   2. run the already-approved admin_purge_tenant() RPC
//   3. if the DB purge failed → return immediately, NEVER touch Storage
//   4. if it succeeded → best-effort delete the collected Storage objects,
//      reporting any failures honestly rather than claiming full success
export async function purgeTenantWithStorage(tenantId: string): Promise<TenantPurgeWithStorageResult> {
  const admin = createAdminClient()
  const { refs, warnings } = await collectTenantStorageObjects(tenantId)

  const rpc = admin as unknown as {
    rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: null | { message: string } }>
  }
  const { data: dbResult, error: dbError } = await rpc.rpc('admin_purge_tenant', { p_tenant_id: tenantId })

  if (dbError) {
    return { dbResult: null, dbError: dbError.message, storage: { attempted: false, deletedCount: 0, failures: [], warnings } }
  }

  const { deletedCount, failures } = await deleteStorageObjects(refs)

  return {
    dbResult: dbResult as Record<string, number>,
    dbError:  null,
    storage:  { attempted: true, deletedCount, failures, warnings },
  }
}
