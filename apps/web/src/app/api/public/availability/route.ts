import { type NextRequest, NextResponse } from 'next/server'
import { getPublicTenant, getPropertyBlockedIntervals } from '@/lib/repositories/public-site.repository'
import { createAdminClient } from '@orderflow/supabase/admin'

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl
  const tenantSlug   = searchParams.get('tenant')
  const propertySlug = searchParams.get('property')

  if (!tenantSlug || !propertySlug) {
    return NextResponse.json({ error: 'tenant and property params required' }, { status: 400 })
  }

  const tenant = await getPublicTenant(tenantSlug)
  if (!tenant || !tenant.public_site_enabled) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  const supabase = createAdminClient()
  const { data: prop } = await supabase
    .from('properties')
    .select('id')
    .eq('tenant_id', tenant.id)
    .eq('slug', propertySlug)
    .eq('published', true)
    .is('deleted_at', null)
    .maybeSingle()

  if (!prop) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  const fromDate = new Date().toISOString().split('T')[0]!
  const toDate   = new Date(Date.now() + 6 * 30 * 24 * 3600 * 1000).toISOString().split('T')[0]!

  const intervals = await getPropertyBlockedIntervals(tenant.id, prop.id, fromDate, toDate)

  return NextResponse.json(
    { blockedIntervals: intervals },
    {
      headers: {
        'Cache-Control': 'no-store',
      },
    }
  )
}
