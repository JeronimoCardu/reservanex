import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Server-only. Never import this from a 'use client' component — `node:fs`
 * can't be bundled for the browser. Server Components resolve these paths
 * and pass the result down as plain string props.
 */
const PRODUCT_DIR = join(process.cwd(), 'public', 'product')

export type ProductImageKey = 'conversations' | 'properties' | 'reservations' | 'team'

function existsInProductDir(filename: string): boolean {
  try {
    return existsSync(join(PRODUCT_DIR, filename))
  } catch {
    return false
  }
}

/**
 * Real screenshots are expected as public/product/{key}.webp. Until a given
 * one exists, callers should keep rendering the fictional mockup for that
 * tab instead — this never throws or breaks the build for a missing file.
 */
export function getProductImagePath(key: ProductImageKey): string | null {
  const filename = `${key}.webp`
  return existsInProductDir(filename) ? `/product/${filename}` : null
}

export function getVideoPosterPath(): string | null {
  const filename = 'video-poster.webp'
  return existsInProductDir(filename) ? `/product/${filename}` : null
}
