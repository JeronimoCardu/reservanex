import { NextResponse } from 'next/server'
import { contactSchema } from '@/lib/marketing/validation/contact-schema'
import { deliverContactSubmission } from '@/lib/marketing/contact'
import { MAX_PUBLIC_POST_BODY_BYTES, readPublicJsonBody } from '@/lib/http/public-post-guard'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  // Content-Type, Sec-Fetch-Site and size (MAX_PUBLIC_POST_BODY_BYTES, real
  // UTF-8 bytes), all before parsing and before any email goes out. See the
  // public-post-guard module.
  const guarded = await readPublicJsonBody(request, MAX_PUBLIC_POST_BODY_BYTES)
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
