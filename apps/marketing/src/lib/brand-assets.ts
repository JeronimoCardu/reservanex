import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Server-only. Never import this from a 'use client' component — `node:fs`
 * can't be bundled for the browser. Server Components resolve the path (or
 * read the file) and pass the result down as a plain prop/string.
 */
const PUBLIC_DIR = join(process.cwd(), 'public')

function firstExistingBrandPath(filenames: string[]): string | null {
  for (const filename of filenames) {
    try {
      if (existsSync(join(PUBLIC_DIR, 'brand', filename))) return `/brand/${filename}`
    } catch {
      // fall through to next candidate
    }
  }
  return null
}

/**
 * Prefers .svg if one is ever dropped in, otherwise the delivered .png —
 * both render fine through <Logo>.
 */
export function getBrandLogoIconPath(): string | null {
  return firstExistingBrandPath(['reservanex-logo.svg', 'reservanex-logo.png'])
}

/**
 * `tone: 'dark'` = dark-colored wordmark, for light backgrounds (current
 * header/footer/mobile-menu usage). `tone: 'light'` = white wordmark, for
 * dark backgrounds (not currently used anywhere, but available).
 */
export function getBrandLogoHorizontalPath(tone: 'dark' | 'light' = 'dark'): string | null {
  return tone === 'light'
    ? firstExistingBrandPath([
      'reservanex-logo-horizontal-white.svg',
      'reservanex-logo-horizontal-white.png',
      'reservanex-logo-horizontal.svg',
    ])
    : firstExistingBrandPath([
      'reservanex-logo-horizontal-black.svg',
      'reservanex-logo-horizontal-black.png',
      'reservanex-logo-horizontal.svg',
    ])
}

export type StaticAsset = { buffer: Uint8Array<ArrayBuffer>; contentType: string }

/**
 * Reads a static brand asset for use inside a metadata route (icon.tsx,
 * opengraph-image.tsx) that otherwise generates a placeholder on the fly.
 * Returns null if the file doesn't exist yet, so callers can fall back to
 * their generated placeholder without the build ever depending on the file.
 */
export function readPublicBrandFile(
  relativePath: string,
  contentType: string,
): StaticAsset | null {
  const fullPath = join(PUBLIC_DIR, relativePath)
  if (!existsSync(fullPath)) return null

  try {
    // Buffer is generic over ArrayBufferLike (which includes
    // SharedArrayBuffer); DOM's BodyInit/BlobPart want a concrete
    // ArrayBuffer. Uint8Array.from() gives us that concrete type back.
    return { buffer: Uint8Array.from(readFileSync(fullPath)), contentType }
  } catch {
    return null
  }
}
