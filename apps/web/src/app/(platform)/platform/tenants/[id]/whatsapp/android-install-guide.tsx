'use client'

// "Instalación Android" operative guide, embedded directly in
// /platform/tenants/[id]/whatsapp. Goal: a superadmin can install a brand
// new Android here without consulting chat history, remembering headers/
// endpoints, or copying the pilot tenant's specific config.
//
// Fase 2A (AUTORESPONDER-ONLY): the MacroDroid macro sections (trigger,
// outbound branch, media branches, path generator) were removed along with
// that transport. What remains is the real, current install: WhatsApp
// Business + AutoResponder for WA pointing at the inbound webhook, plus the
// heartbeat. Rendered from the SAME constants the live pipeline uses
// (autoresponder-install-contract.ts, autoresponder-public-url.ts), so it
// cannot silently drift from reality.

import { useState } from 'react'
import { toast } from 'sonner'
import {
  ChevronDownIcon,
  CopyIcon,
  CheckIcon,
  SmartphoneIcon,
  WifiIcon,
  WifiOffIcon,
  HelpCircleIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { AutoResponderPlatformData } from '@/lib/autoresponder-platform'
import { deriveDeviceStatus, DEVICE_STATUS_LABEL, type DeviceStatus } from '@/lib/autoresponder-device-health'
import type { AutoResponderEndpoints } from '@/lib/autoresponder-public-url'
import {
  HEADER_DEVICE_TOKEN,
  HEARTBEAT_INTERVAL_MINUTES,
  AUTORESPONDER_APP_PACKAGE,
  WHATSAPP_BUSINESS_PACKAGE,
} from '@/lib/autoresponder-install-contract'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

// ── Small local building blocks ──────────────────────────────────────────

function CopyField({ label, value, multiline = false }: { label?: string; value: string; multiline?: boolean }) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      toast.success('Copiado al portapapeles')
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error('No se pudo copiar — seleccioná el texto manualmente.')
    }
  }

  return (
    <div className="space-y-1">
      {label && <p className="text-xs font-medium text-muted-foreground">{label}</p>}
      <div className="flex items-start gap-2">
        <code
          className={cn(
            'flex-1 min-w-0 rounded-md border bg-muted/40 px-2.5 py-1.5 font-mono text-xs break-all',
            multiline && 'whitespace-pre-wrap',
          )}
        >
          {value}
        </code>
        <Button type="button" variant="outline" size="sm" onClick={handleCopy} className="shrink-0">
          {copied ? <CheckIcon className="h-3.5 w-3.5" /> : <CopyIcon className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </div>
  )
}

function CollapsibleSection({
  n, title, defaultOpen = false, children,
}: {
  n: number
  title: string
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="rounded-lg border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left hover:bg-muted/30"
      >
        <span className="text-sm font-medium">{n}. {title}</span>
        <ChevronDownIcon className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>
      {open && <div className="space-y-3 border-t px-4 py-4 text-sm text-muted-foreground">{children}</div>}
    </div>
  )
}

// Distinguishes what ReservaNex can actually observe from a step that is
// purely a manual instruction — never render a checkmark for something the
// backend has no signal for (Fase 9 §20/§21).
function AutoStatus({ ok, okLabel, pendingLabel }: { ok: boolean; okLabel: string; pendingLabel: string }) {
  return ok ? (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700 dark:text-green-400">
      <CheckIcon className="h-3.5 w-3.5" /> {okLabel} <span className="text-muted-foreground/70 font-normal">(verificado automáticamente)</span>
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
      <HelpCircleIcon className="h-3.5 w-3.5" /> {pendingLabel} <span className="text-muted-foreground/70 font-normal">(paso manual — sin evidencia todavía)</span>
    </span>
  )
}

function ManualStep({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
      <span>{children}</span>
    </li>
  )
}

const DEVICE_STATUS_STYLE: Record<DeviceStatus, { className: string; Icon: typeof WifiIcon }> = {
  disabled:       { className: 'bg-slate-100 text-slate-500 border-slate-200 dark:bg-slate-800 dark:text-slate-400',  Icon: WifiOffIcon },
  not_configured: { className: 'bg-slate-100 text-slate-500 border-slate-200 dark:bg-slate-800 dark:text-slate-400',  Icon: HelpCircleIcon },
  never_seen:     { className: 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400',  Icon: HelpCircleIcon },
  online:         { className: 'bg-green-100 text-green-800 border-green-200 dark:bg-green-950 dark:text-green-400', Icon: WifiIcon },
  stale:          { className: 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-400', Icon: WifiIcon },
  offline:        { className: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-400',            Icon: WifiOffIcon },
}

function relativeFromNow(iso: string | null): string {
  if (!iso) return 'nunca'
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return 'hace instantes'
  if (ms < 3_600_000) return `hace ${Math.floor(ms / 60_000)} min`
  if (ms < 86_400_000) return `hace ${Math.floor(ms / 3_600_000)} h`
  return `hace ${Math.floor(ms / 86_400_000)} d`
}

const recentEnough = (iso: string | null, withinMs: number) => !!iso && Date.now() - new Date(iso).getTime() < withinMs

// ── Media path generator ─────────────────────────────────────────────────

// ── Main component ──────────────────────────────────────────────────────

export type EndpointsResult =
  | { ok: true; endpoints: AutoResponderEndpoints }
  | { ok: false; error: string }

interface AndroidInstallGuideProps {
  settings:        AutoResponderPlatformData | null
  endpointsResult: EndpointsResult
}

export function AndroidInstallGuide({ settings, endpointsResult }: AndroidInstallGuideProps) {
  const deviceStatus = deriveDeviceStatus({
    configStatus:     settings?.status ?? 'not_configured',
    lastDeviceSeenAt: settings?.last_device_seen_at ?? null,
  })
  const statusCfg = DEVICE_STATUS_STYLE[deviceStatus]

  const hasDeviceToken   = settings?.has_device_token ?? false
  const heartbeatRecent  = recentEnough(settings?.last_device_seen_at ?? null, 15 * 60 * 1000)
  const inboundRecent    = recentEnough(settings?.last_inbound_at ?? null, 24 * 60 * 60 * 1000)

  const ep = endpointsResult.ok ? endpointsResult.endpoints : null

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/20 px-4 py-3">
        <div className="flex items-center gap-2">
          <SmartphoneIcon className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Configuración Android</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">
            Última señal: {relativeFromNow(settings?.last_device_seen_at ?? null)}
          </span>
          <Badge className={`gap-1 ${statusCfg.className}`}>
            <statusCfg.Icon className="h-3 w-3" /> {DEVICE_STATUS_LABEL[deviceStatus]}
          </Badge>
        </div>
      </div>

      {!endpointsResult.ok && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          No se puede generar la guía de endpoints: {endpointsResult.error}
        </div>
      )}

      <CollapsibleSection n={1} title="Preparar Android">
        <p>
          Requisitos operativos aprobados. <strong className="text-foreground">Validado</strong> = confirmado
          físicamente en el dispositivo piloto (Samsung). <strong className="text-foreground">General</strong> = recomendación
          Android estándar, no probada en todos los fabricantes.
        </p>
        <ul className="space-y-1.5">
          <ManualStep>Android <span className="font-medium text-foreground">dedicado</span> a este servicio — no de uso personal.</ManualStep>
          <ManualStep>WhatsApp Business y AutoResponder for WA instalados. <span className="font-medium text-foreground">MacroDroid ya no se usa</span> — no hace falta instalarlo.</ManualStep>
          <ManualStep>Conexión a internet permanente (WiFi o datos).</ManualStep>
          <ManualStep>Carga eléctrica constante o batería suficiente para uso continuo.</ManualStep>
          <ManualStep>Sin restricciones agresivas de batería para AutoResponder ni WhatsApp Business — permitilos correr en segundo plano sin limitaciones (Configuración → Batería → sin restricciones, por app).</ManualStep>
                    <ManualStep>AutoResponder: acceso a notificaciones habilitado (así detecta los mensajes entrantes de WhatsApp Business).</ManualStep>
          <ManualStep>WhatsApp Business: notificaciones activas.</ManualStep>
                    <ManualStep>No guardar contactos de clientes en la agenda del dispositivo. Ver sección 25.</ManualStep>
        </ul>
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          <strong>Samsung-específico (validado):</strong> además de lo anterior, Samsung suele requerir
          desactivar &quot;Poner apps inactivas en reposo&quot; y &quot;Optimizar uso de batería&quot; individualmente
          para AutoResponder y WhatsApp Business (Configuración → Batería y protección de
          dispositivo → Límites de uso en segundo plano), y agregar ambas apps a &quot;Nunca inactivas&quot;.
        </div>
      </CollapsibleSection>

      <CollapsibleSection n={2} title="WhatsApp Business">
        <div className="flex items-center gap-2">
          <Badge className="gap-1 bg-green-100 text-green-800 border-green-200 dark:bg-green-950 dark:text-green-400">
            <CheckIcon className="h-3 w-3" /> Validado
          </Badge>
          <span>package: <code className="font-mono text-xs">{WHATSAPP_BUSINESS_PACKAGE}</code></span>
        </div>
        <p>
          Esta integración usa exclusivamente WhatsApp Business (<code className="font-mono text-xs">{WHATSAPP_BUSINESS_PACKAGE}</code>).
          WhatsApp personal (<code className="font-mono text-xs">com.whatsapp</code>) no está caracterizado
          físicamente — no asumir que los mismos paths/comportamiento aplican.
        </p>
      </CollapsibleSection>

      <CollapsibleSection n={3} title="AutoResponder">
        <p>App: {AUTORESPONDER_APP_PACKAGE}. Configurá una regla que reciba todos los mensajes entrantes y dispare este webhook:</p>
        {ep && <CopyField label="Endpoint inbound" value={ep.inbound} />}
        <CopyField label="Header" value={`${HEADER_DEVICE_TOKEN}: <tu device token>`} />
        <ul className="space-y-1.5">
          <ManualStep>AutoResponder activo, con acceso a notificaciones concedido.</ManualStep>
          <ManualStep>Regla configurada para recibir TODOS los mensajes (no solo palabras clave).</ManualStep>
          <ManualStep>Webhook POST configurado con el endpoint y header de arriba.</ManualStep>
        </ul>
        <p className="text-xs text-muted-foreground/70">
          El payload real (sender, message, isGroup, package names) no requiere configuración manual —
          AutoResponder lo arma solo. El contrato inbound no cambió en esta fase.
        </p>
      </CollapsibleSection>

      <CollapsibleSection n={4} title="Heartbeat">
        <p>
          Señal de vida del Android. Configurá en AutoResponder (o en cualquier scheduler del
          teléfono) un POST cada {HEARTBEAT_INTERVAL_MINUTES} minutos a este endpoint, con el mismo
          header de device token. Es lo que alimenta el estado &quot;Conectado / Sin señal&quot; de arriba.
        </p>
        {ep && <CopyField label="Endpoint heartbeat" value={ep.heartbeat} />}
        <CopyField label="Header" value={`${HEADER_DEVICE_TOKEN}: <tu device token>`} />
      </CollapsibleSection>

      <CollapsibleSection n={5} title="Probar instalación" defaultOpen>
        <p>Orden recomendado. Los puntos verificables muestran evidencia real; el resto son instrucciones — nunca se marcan como &quot;pasó&quot; sin evidencia.</p>
        <ol className="space-y-2.5">
          <li className="flex items-center justify-between gap-2">
            <span>1. Heartbeat</span>
            <AutoStatus ok={heartbeatRecent} okLabel="Recibido" pendingLabel="Esperando" />
          </li>
          <li className="flex items-center justify-between gap-2">
            <span>2. Inbound de texto</span>
            <AutoStatus ok={inboundRecent} okLabel="Recibido" pendingLabel="Sin señal reciente" />
          </li>
          <ManualStep>3. IA outbound — escribile al número desde otro teléfono y confirmá que DeepSeek responde.</ManualStep>
          <ManualStep>4. Handoff humano — respondé desde WhatsApp / WhatsApp Web en el propio teléfono (ReservaNex ya no envía mensajes manuales para este canal).</ManualStep>
          <ManualStep>5. Pantalla apagada — repetí 3-4 con la pantalla del Android apagada.</ManualStep>
          <ManualStep>6. Apps en segundo plano — repetí 3-4 con AutoResponder/WhatsApp Business minimizados.</ManualStep>
          <ManualStep>7. Reboot — reiniciá el Android y verificá que todo vuelve solo, sin abrir ninguna app manualmente.</ManualStep>
        </ol>
        <div className="rounded-md border px-3 py-2 text-xs text-muted-foreground">
          &quot;Dispositivo conectado&quot; (AutoResponder configurado + heartbeat online) <strong className="text-foreground">no implica</strong> que
          el outbound de IA ya haya sido probado — son señales independientes.
        </div>
      </CollapsibleSection>

      {!hasDeviceToken && (
        <p className="text-xs text-muted-foreground">
          Todavía no hay device token configurado para esta cuenta — generá uno arriba
          antes de usar esta guía.
        </p>
      )}
    </div>
  )
}
