import { createAdminClient } from '@orderflow/supabase/admin'
import { requireTenantContext } from '@/lib/auth/require-tenant-context'
import { countPendingHumanAttention } from '@/lib/repositories/conversations.repository'
import type { NavBadges } from '@/lib/dashboard/nav-items'
import { DashboardSidebar } from '@/components/tenant/shared/dashboard-sidebar'
import { MobileNav } from '@/components/tenant/shared/mobile-nav'
import { SetupModeBanner } from '@/components/tenant/shared/setup-mode-banner'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireTenantContext()

  const isSetupOperator = ctx.accessMode === 'setup_operator'

  // Atención humana V2 — el badge del nav. UNA query acá, con el cliente del
  // usuario (las RLS de conversations deciden qué cuenta cada rol), y los dos
  // navs la reciben por props. El operator de setup no atiende clientes: no se
  // consulta. Si la lectura falla, el nav se pinta sin badge — nunca se bloquea
  // el dashboard por un contador.
  let badges: NavBadges = {}
  if (!isSetupOperator) {
    try {
      badges = { attention: await countPendingHumanAttention(ctx.tenantId) }
    } catch (err) {
      console.warn('[dashboard:layout] countPendingHumanAttention failed (non-fatal)', {
        tenantId: ctx.tenantId, error: err instanceof Error ? err.message : String(err),
      })
    }
  }

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
          vertical={ctx.vertical}
          capabilities={ctx.capabilities}
          isSetupOperator={isSetupOperator}
          badges={badges}
        />
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <MobileNav
            role={ctx.role}
            canAccessSettings={ctx.canAccessSettings}
            vertical={ctx.vertical}
            capabilities={ctx.capabilities}
            isSetupOperator={isSetupOperator}
            badges={badges}
          />
          <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
            {children}
          </main>
        </div>
      </div>
    </div>
  )
}
