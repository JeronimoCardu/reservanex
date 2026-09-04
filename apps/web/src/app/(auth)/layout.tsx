import { CrmHtmlShell } from '@/components/layout/crm-html-shell'

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <CrmHtmlShell>
      <div className="flex min-h-screen items-center justify-center bg-muted/40 px-4">
        {children}
      </div>
    </CrmHtmlShell>
  )
}
