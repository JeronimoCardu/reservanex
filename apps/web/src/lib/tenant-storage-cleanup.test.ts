import { describe, expect, it } from 'vitest'
import { extractStoragePathFromPublicUrl, isPathOwnedByTenant, dedupeStorageRefs } from './tenant-storage-cleanup'

describe('extractStoragePathFromPublicUrl', () => {
  it('extracts the path from a matching public URL', () => {
    const url = 'https://abcd.supabase.co/storage/v1/object/public/property-images/tenant-1/photo.jpg'
    expect(extractStoragePathFromPublicUrl('property-images', url)).toBe('tenant-1/photo.jpg')
  })

  it('returns null for a URL pointing at a DIFFERENT bucket', () => {
    const url = 'https://abcd.supabase.co/storage/v1/object/public/property-videos/tenant-1/photo.jpg'
    expect(extractStoragePathFromPublicUrl('property-images', url)).toBeNull()
  })

  it('returns null for a completely external URL (free-text columns may hold these)', () => {
    expect(extractStoragePathFromPublicUrl('tenant-public-assets', 'https://cdn.example.com/logo.png')).toBeNull()
  })

  it('returns null for null/undefined input', () => {
    expect(extractStoragePathFromPublicUrl('property-images', null)).toBeNull()
    expect(extractStoragePathFromPublicUrl('property-images', undefined)).toBeNull()
  })

  it('returns null for an empty string', () => {
    expect(extractStoragePathFromPublicUrl('property-images', '')).toBeNull()
  })
})

describe('isPathOwnedByTenant', () => {
  it('accepts a path whose first segment exactly matches the tenant id', () => {
    expect(isPathOwnedByTenant('tenant-1', 'tenant-1/conv-2/msg-3.jpg')).toBe(true)
  })

  it('rejects a path belonging to a different tenant', () => {
    expect(isPathOwnedByTenant('tenant-1', 'tenant-2/conv-2/msg-3.jpg')).toBe(false)
  })

  it('rejects a path where the tenant id is only a PREFIX of the first segment, not an exact match', () => {
    expect(isPathOwnedByTenant('tenant-1', 'tenant-10/conv-2/msg-3.jpg')).toBe(false)
  })

  it('rejects a path with no separator at all', () => {
    expect(isPathOwnedByTenant('tenant-1', 'tenant-1')).toBe(true) // whole string is the first segment
    expect(isPathOwnedByTenant('tenant-1', 'not-a-tenant-path.jpg')).toBe(false)
  })
})

describe('dedupeStorageRefs', () => {
  it('removes exact (bucket, path) duplicates, keeping the first occurrence', () => {
    const refs = [
      { bucket: 'whatsapp-media', path: 't1/c1/m1.jpg', source: 'messages.media_storage_path' },
      { bucket: 'whatsapp-media', path: 't1/c1/m1.jpg', source: 'media_events.storage_path' },
      { bucket: 'whatsapp-media', path: 't1/c1/m1.jpg', source: 'documents.storage_path' },
    ]
    const result = dedupeStorageRefs(refs)
    expect(result).toHaveLength(1)
    expect(result[0]?.source).toBe('messages.media_storage_path')
  })

  it('keeps refs with the same path in DIFFERENT buckets distinct', () => {
    const refs = [
      { bucket: 'property-images', path: 't1/x.jpg', source: 'a' },
      { bucket: 'property-videos', path: 't1/x.jpg', source: 'b' },
    ]
    expect(dedupeStorageRefs(refs)).toHaveLength(2)
  })

  it('keeps distinct paths in the same bucket', () => {
    const refs = [
      { bucket: 'property-images', path: 't1/a.jpg', source: 'a' },
      { bucket: 'property-images', path: 't1/b.jpg', source: 'b' },
    ]
    expect(dedupeStorageRefs(refs)).toHaveLength(2)
  })

  it('handles an empty list', () => {
    expect(dedupeStorageRefs([])).toEqual([])
  })
})
