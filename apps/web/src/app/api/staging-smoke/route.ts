// STAGING ONLY — branch staging/hostinger-smoke. NEVER merge into main.
//
// PROD-HOSTINGER-B: measures, on Hostinger, (1) whether the proxy keeps a
// request open for 10/20/25/30 s (the AutoResponder webhook needs ~25 s) and
// (2) cold starts (uptimeS tells whether this request started the process).
// No DB, no external calls, no writes. Without STAGING_SMOKE_SECRET (≥ 32
// chars) configured and sent in x-staging-smoke-secret, it answers 404.

import { timingSafeEqual } from 'node:crypto'
import { NextResponse, type NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_SECONDS = 35

function authorized(request: NextRequest): boolean {
  const expected = process.env.STAGING_SMOKE_SECRET ?? ''
  if (expected.length < 32) return false
  const given = Buffer.from(request.headers.get('x-staging-smoke-secret') ?? '', 'utf8')
  const wanted = Buffer.from(expected, 'utf8')
  return given.length === wanted.length && timingSafeEqual(given, wanted)
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const requested = Number(request.nextUrl.searchParams.get('seconds') ?? '0')
  const seconds = Number.isFinite(requested) ? Math.min(MAX_SECONDS, Math.max(0, requested)) : 0
  const startedAt = Date.now()
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
  return NextResponse.json({
    ok:               true,
    requestedSeconds: seconds,
    elapsedMs:        Date.now() - startedAt,
    uptimeS:          Math.round(process.uptime()),
    pid:              process.pid,
    node:             process.version,
  })
}
