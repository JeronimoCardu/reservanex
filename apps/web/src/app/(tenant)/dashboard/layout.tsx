import { createAdminClient } from '@orderflow/supabase/admin'
import { requireTenantContext } from '@/lib/auth/require-tenant-context'
import { DashboardSidebar } from '@/components/tenant/shared/dashboard-sidebar'
import { MobileNav } from '@/components/tenant/shared/mobile-nav'
import { SetupModeBanner } from '@/components/tenant/shared/setup-mode-banner'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireTenantContext()

  const isSetupOperator = ctx.accessMode === 'setup_operator'

  // Fetch tenant name for the setup banner (only when needed).
  let tenantName = ''
  if (isSetupOperator) {
    const admin = createAdminClient()
    const { data } = await admin
      .from('tenants')
      .select('name')
      .eq('id', ctx.tenantId)
      .maybeSingle()
    tenantName = data?.name ?? ctx.tenantId
  }

  return (
    <div className="flex h-screen flex-col bg-background">
      {isSetupOperator && <SetupModeBanner tenantName={tenantName} />}

      <div className="flex min-w-0 flex-1 overflow-hidden">
        <DashboardSidebar
          role={ctx.role}
          canAccessSettings={ctx.canAccessSettings}
          isSetupOperator={isSetupOperator}
        />
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <MobileNav
            role={ctx.role}
            canAccessSettings={ctx.canAccessSettings}
            isSetupOperator={isSetupOperator}
          />
          <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
            {children}
          </main>
        </div>
      </div>
    </div>
  )
}
