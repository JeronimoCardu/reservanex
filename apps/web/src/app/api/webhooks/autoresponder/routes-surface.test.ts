// Fase 2A (AUTORESPONDER-ONLY) §14 F — the AutoResponder webhook surface is
// now exactly two routes. The MacroDroid-era endpoints (media upload,
// outbound ACK) were deleted along with the transport that called them;
// this asserts they cannot come back silently, and that the inbound route
// itself never reaches for MacroDroid or messaging_outbox.

import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROUTES_DIR = join(__dirname)

describe('AutoResponder webhook surface (§14 F)', () => {
  it('the media upload endpoint is deleted', () => {
    expect(existsSync(join(ROUTES_DIR, 'media', 'route.ts'))).toBe(false)
  })

  it('the outbound-ack endpoint is deleted', () => {
    expect(existsSync(join(ROUTES_DIR, 'outbound-ack', 'route.ts'))).toBe(false)
  })

  it('exactly two routes remain: the inbound webhook and the heartbeat', () => {
    const entries = readdirSync(ROUTES_DIR, { withFileTypes: true })
    const subRoutes = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort()
    expect(subRoutes).toEqual(['heartbeat'])
    expect(existsSync(join(ROUTES_DIR, 'route.ts'))).toBe(true)
  })
})

describe('the inbound route never reaches MacroDroid or the outbox (§14 E/F)', () => {
  const routeSource = readFileSync(join(ROUTES_DIR, 'route.ts'), 'utf8')

  // These check for real code, not for the word appearing in prose — the
  // doc comments deliberately explain what was retired and why.
  const withoutComments = routeSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')

  it('E. never queries or writes messaging_outbox', () => {
    expect(withoutComments).not.toMatch(/messaging_outbox/)
  })

  it('F. contains no MacroDroid dispatch of any kind', () => {
    expect(withoutComments).not.toMatch(/macrodroid/i)
    expect(routeSource).not.toMatch(/trigger\.macrodroid\.com/)
  })

  it('§2. the temporary 401-diagnostic logging is gone', () => {
    expect(routeSource).not.toMatch(/\[DIAG\]/)
    // The operational log line stays.
    expect(routeSource).toMatch(/\[webhook:autoresponder\]/)
  })

  it('§2. never logs the raw device token or a full hash', () => {
    expect(routeSource).not.toMatch(/console\.log\([^)]*deviceTokenHeader/)
    expect(routeSource).not.toMatch(/console\.log\([^)]*tokenHash/)
  })
})
