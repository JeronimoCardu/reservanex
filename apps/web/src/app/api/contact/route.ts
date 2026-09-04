import { NextResponse } from 'next/server'
import { contactSchema } from '@/lib/marketing/validation/contact-schema'
import { deliverContactSubmission } from '@/lib/marketing/contact'

export const dynamic = 'force-dynamic'

// Generous for this form's fields (message caps at 2000 chars in the
// schema); guards against a spoofed/missing Content-Length header hiding an
// oversized body from the platform's own limits.
const MAX_BODY_BYTES = 20_000

export async function POST(request: Request) {
  const contentLength = Number(request.headers.get('content-length') ?? 0)
  if (contentLength > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, reason: 'payload_too_large' }, { status: 413 })
  }

  let rawBody: string
  try {
    rawBody = await request.text()
  } catch {
    return NextResponse.json({ ok: false, reason: 'invalid_body' }, { status: 400 })
  }

  if (rawBody.length > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, reason: 'payload_too_large' }, { status: 413 })
  }

  let body: unknown
  try {
    body = JSON.parse(rawBody)
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
