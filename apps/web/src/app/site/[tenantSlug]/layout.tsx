import type { CSSProperties } from 'react'
import { notFound } from 'next/navigation'
import { getPublicTenant } from '@/lib/repositories/public-site.repository'
import { CrmHtmlShell } from '@/components/layout/crm-html-shell'

interface Props {
  children: React.ReactNode
  params:   Promise<{ tenantSlug: string }>
}

// Fixed premium palette — not configurable per-tenant.
// Using CSS var names from the existing components for backward compat.
// Future: tenant public theme light/dark (stored in tenants table, applied here via data-theme attribute).
const PUBLIC_SITE_VARS: CSSProperties = {
  '--tenant-primary':        '#0F766E',
  '--tenant-secondary':      '#C8A24A',
  '--tenant-primary-soft':   '#ECFDF5',
  '--tenant-secondary-soft': 'rgba(200,162,74,0.12)',
} as CSSProperties

export default async function PublicSiteLayout({ children, params }: Props) {
  const { tenantSlug } = await params
  const tenant = await getPublicTenant(tenantSlug)

  if (!tenant || !tenant.public_site_enabled) notFound()

  return (
    <CrmHtmlShell>
      <div style={PUBLIC_SITE_VARS}>
        {children}
      </div>
    </CrmHtmlShell>
  )
}
