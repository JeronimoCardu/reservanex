import { CrmHtmlShell } from '@/components/layout/crm-html-shell'

export default function TenantLayout({ children }: { children: React.ReactNode }) {
  return (
    <CrmHtmlShell>
      <div className="min-h-screen bg-background">
        {children}
      </div>
    </CrmHtmlShell>
  )
}
