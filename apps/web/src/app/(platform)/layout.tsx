import { CrmHtmlShell } from '@/components/layout/crm-html-shell'

export default function PlatformLayout({ children }: { children: React.ReactNode }) {
  return (
    <CrmHtmlShell>
      <div className="min-h-screen bg-background">
        {children}
      </div>
    </CrmHtmlShell>
  )
}
