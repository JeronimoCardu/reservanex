import { NextResponse } from 'next/server'
import { contactSchema } from '@/lib/marketing/validation/contact-schema'
import { deliverContactSubmission } from '@/lib/marketing/contact'
import { readPublicJsonBody } from '@/lib/http/public-post-guard'

export const dynamic = 'force-dynamic'

// Generous for this form's fields (message caps at 2000 chars in the
// schema). Measured in real UTF-8 bytes, checked against Content-Length first
// and against the body actually read afterwards.
const MAX_BODY_BYTES = 20_000

export async function POST(request: Request) {
  // Content-Type, Sec-Fetch-Site and size, all before parsing and before any
  // email goes out. See the public-post-guard module.
  const guarded = await readPublicJsonBody(request, MAX_BODY_BYTES)
  if (!guarded.ok) {
    return NextResponse.json({ ok: false, reason: guarded.reason }, { status: guarded.status })
  }

  let body: unknown
  try {
    body = JSON.parse(guarded.raw)
  } catch {
    return NextResponse.json({ ok: false, reason: 'invalid_body' }, { status: 400 })
  }

  const parsed = contactSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ ok: false, reason: 'invalid_fields' }, { status: 422 })
  }

  // Honeypot tripped: report success without actually delivering anything,
  // so bots get no signal that they were caught.
  if (parsed.data.company_website) {
    return NextResponse.json({ ok: true })
  }

  const result = await deliverContactSubmission(parsed.data)

  if (!result.ok) {
    const status = result.reason === 'not_configured' ? 503 : 502
    return NextResponse.json({ ok: false, reason: result.reason }, { status })
  }

  return NextResponse.json({ ok: true })
}
