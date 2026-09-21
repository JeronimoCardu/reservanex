import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { requireSuperAdmin } from '@/lib/auth/require-platform-context'
import * as repo from '@/lib/repositories/platform.repository'
import { getTenantWhatsAppSettingsForPlatformAction } from '@/actions/platform-whatsapp'
import { getTenantAutoResponderSettingsForPlatformAction } from '@/actions/platform-autoresponder'
import { getAutoResponderEndpoints } from '@/lib/autoresponder-public-url'
import { WhatsAppPlatformForm } from './whatsapp-platform-form'
import { AutoResponderPlatformForm } from './autoresponder-platform-form'
import { AndroidInstallGuide, type EndpointsResult } from './android-install-guide'

export const metadata: Metadata = { title: 'WhatsApp — Plataforma — ReservaNex' }

export default async function TenantWhatsAppPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await requireSuperAdmin()

  const tenant = await repo.getTenantById(id)
  if (!tenant) notFound()

  const [metaResult, autoresponderResult] = await Promise.all([
    getTenantWhatsAppSettingsForPlatformAction(id),
    getTenantAutoResponderSettingsForPlatformAction(id),
  ])
  const metaSettings          = metaResult.success ? metaResult.data : null
  const autoresponderSettings = autoresponderResult.success ? autoresponderResult.data : null

  // Fase 9 — computed server-side (env var is not NEXT_PUBLIC_*, never read
  // in the browser). A missing/invalid AUTORESPONDER_PUBLIC_BASE_URL must
  // never crash this page — the guide renders a clear inline error instead.
  let endpointsResult: EndpointsResult
  try {
    endpointsResult = { ok: true, endpoints: getAutoResponderEndpoints() }
  } catch (err) {
    endpointsResult = { ok: false, error: err instanceof Error ? err.message : String(err) }
  }

  return (
    <div className="max-w-2xl space-y-8">
      <div>
        <Link href={`/platform/tenants/${id}`} className="text-xs text-muted-foreground hover:underline">
          ← {tenant.name}
        </Link>
        <h1 className="mt-1 text-xl font-semibold">Configuración WhatsApp</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">{tenant.name}</p>
      </div>

      {/* Two independent channels/providers — never merged into one form.
          conversation.whatsapp_account_id (Fase 4.1) remains the canonical
          source of which account an existing conversation routes through;
          this page only manages the account records themselves.

          ORDEN (cierre V2): AutoResponder es el proveedor con el que se pone
          en marcha un cliente nuevo — WhatsApp / WhatsApp Business en un
          Android + AutoResponder for WA — así que va PRIMERO, seguido de su
          guía de instalación. Meta Cloud API sigue soportado en el backend
          (provider CHECK, /api/webhooks/whatsapp, ramas del worker) pero no es
          el camino de un alta nueva: queda al final, colapsado, para que un
          super_admin nuevo no crea que tiene que configurarlo. */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">AutoResponder for WA</h2>
        <p className="text-xs text-muted-foreground">
          El canal de WhatsApp de ReservaNex V2: un Android con WhatsApp / WhatsApp Business
          y AutoResponder for WA apuntando a los endpoints de abajo.
        </p>
        <AutoResponderPlatformForm
          tenantId={id}
          settings={autoresponderSettings ?? null}
        />
      </section>

      {/* Fase 9 — operative install guide, self-contained: what to install,
          which permissions, which endpoints/headers/variables, which paths,
          and how to test it. Source of truth for installing a new Android. */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">Instalación Android</h2>
        <AndroidInstallGuide
          settings={autoresponderSettings ?? null}
          endpointsResult={endpointsResult}
        />
      </section>

      <details className="rounded-lg border bg-muted/20">
        <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold text-muted-foreground">
          Meta (WhatsApp Cloud API) — proveedor alternativo
        </summary>
        <div className="space-y-3 px-4 pb-4">
          <p className="text-xs text-muted-foreground">
            Sólo para un cliente que opere con la API oficial de Meta. Un alta AutoResponder
            no necesita nada de esta sección.
          </p>
          <WhatsAppPlatformForm
            tenantId={id}
            settings={metaSettings ?? null}
          />
        </div>
      </details>
    </div>
  )
}
