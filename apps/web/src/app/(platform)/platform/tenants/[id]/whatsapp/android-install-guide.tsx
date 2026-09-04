'use client'

// Fase 9 — "Instalación Android" operative guide, embedded directly in
// /platform/tenants/[id]/whatsapp. Goal: a superadmin can install a brand
// new Android here without consulting chat history, remembering headers/
// endpoints/variables, or copying the pilot tenant's specific config.
//
// Nothing here changes any of the already-validated pipelines (inbound,
// media, heartbeat, outbound-ack, dispatcher) — this is documentation +
// small, safe helper tooling (path → shell-command generation) rendered
// from the SAME constants those pipelines already use
// (autoresponder-install-contract.ts, autoresponder-public-url.ts,
// android-media-paths.ts), so it cannot silently drift from reality.

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
  HEADER_EVENT_ID,
  HEADER_MEDIA_TYPE,
  HEADER_FILENAME,
  HEADER_OUTBOX_ID,
  RN_VAR_ACTION,
  RN_VAR_PHONE,
  RN_VAR_MESSAGE,
  RN_VAR_EVENT_ID,
  RN_VAR_MEDIA_TYPE,
  RN_VAR_FILENAME,
  RN_VAR_OUTBOX_ID,
  RN_ACTION_OUTBOUND,
  RN_ACTION_MEDIA,
  OUTBOUND_WAIT_BEFORE_SEND_SECONDS,
  OUTBOUND_WAIT_AFTER_SEND_SECONDS,
  MEDIA_WAIT_BEFORE_EXTRACT_SECONDS,
  HEARTBEAT_INTERVAL_MINUTES,
  MEDIA_CONTENT_TYPE,
  AUTORESPONDER_APP_PACKAGE,
  WHATSAPP_BUSINESS_PACKAGE,
} from '@/lib/autoresponder-install-contract'
import {
  DEFAULT_VOICE_NOTES_PATH,
  DEFAULT_IMAGES_PATH,
  DEFAULT_DOCUMENTS_PATH,
  isValidAndroidStoragePath,
  buildAudioShellCommand,
  buildImageShellCommand,
  buildDocumentPathTemplate,
} from '@/lib/android-media-paths'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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

function PathGenerator() {
  const [voicePath, setVoicePath]     = useState(DEFAULT_VOICE_NOTES_PATH)
  const [imagePath, setImagePath]     = useState(DEFAULT_IMAGES_PATH)
  const [documentPath, setDocumentPath] = useState(DEFAULT_DOCUMENTS_PATH)

  const voiceValid    = isValidAndroidStoragePath(voicePath)
  const imageValid    = isValidAndroidStoragePath(imagePath)
  const documentValid = isValidAndroidStoragePath(documentPath)

  const audioShell    = buildAudioShellCommand(voicePath)
  const imageShell     = buildImageShellCommand(imagePath)
  const documentTemplate = buildDocumentPathTemplate(documentPath)

  return (
    <div className="space-y-5">
      <p className="text-xs text-muted-foreground/80">
        Prellenado con los paths validados en el dispositivo piloto. Solo modificalos si
        este Android tiene WhatsApp Business instalado en una ubicación distinta — no se
        guardan en la base de datos, son datos de instalación del teléfono, no del backend.
      </p>

      <div className="space-y-2">
        <label htmlFor="voice-path" className="text-xs font-medium text-foreground">Carpeta de notas de voz</label>
        <Input
          id="voice-path"
          value={voicePath}
          onChange={(e) => setVoicePath(e.target.value)}
          className="font-mono text-xs"
          autoComplete="off"
        />
        {!voiceValid && <p className="text-xs text-destructive">Path inválido — debe empezar con /storage/emulated/0/ y no puede contener caracteres especiales.</p>}
        {audioShell && <CopyField label="Shell — audio (más reciente .opus)" value={audioShell} />}
      </div>

      <div className="space-y-2">
        <label htmlFor="image-path" className="text-xs font-medium text-foreground">Carpeta de imágenes</label>
        <Input
          id="image-path"
          value={imagePath}
          onChange={(e) => setImagePath(e.target.value)}
          className="font-mono text-xs"
          autoComplete="off"
        />
        {!imageValid && <p className="text-xs text-destructive">Path inválido — debe empezar con /storage/emulated/0/ y no puede contener caracteres especiales.</p>}
        {imageShell && <CopyField label="Shell — imagen (más reciente .jpg)" value={imageShell} />}
      </div>

      <div className="space-y-2">
        <label htmlFor="document-path" className="text-xs font-medium text-foreground">Carpeta de documentos</label>
        <Input
          id="document-path"
          value={documentPath}
          onChange={(e) => setDocumentPath(e.target.value)}
          className="font-mono text-xs"
          autoComplete="off"
        />
        {!documentValid && <p className="text-xs text-destructive">Path inválido — debe empezar con /storage/emulated/0/ y no puede contener caracteres especiales.</p>}
        {documentTemplate && <CopyField label="Path del archivo (documento — usa rn_filename exacto)" value={documentTemplate} />}
      </div>

      <p className="text-xs text-muted-foreground/70">
        Audio e imagen usan la heurística &quot;archivo más reciente en la carpeta&quot; — AutoResponder
        no da nombre de archivo para esos dos tipos. Ver limitación conocida bajo concurrencia
        en el backlog (ítem D).
      </p>
    </div>
  )
}

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
  const ackRecent        = recentEnough(settings?.last_outbound_device_ack_at ?? null, 24 * 60 * 60 * 1000)
  const mediaRecent      = recentEnough(settings?.last_media_upload_at ?? null, 24 * 60 * 60 * 1000)

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
          <ManualStep>WhatsApp Business, AutoResponder for WA y MacroDroid instalados.</ManualStep>
          <ManualStep>Conexión a internet permanente (WiFi o datos).</ManualStep>
          <ManualStep>Carga eléctrica constante o batería suficiente para uso continuo.</ManualStep>
          <ManualStep>Sin restricciones agresivas de batería para MacroDroid, AutoResponder ni WhatsApp Business — permitilos correr en segundo plano sin limitaciones (Configuración → Batería → sin restricciones, por app).</ManualStep>
          <ManualStep>MacroDroid: permiso de accesibilidad y &quot;mostrar sobre otras apps&quot; habilitados.</ManualStep>
          <ManualStep>AutoResponder: acceso a notificaciones habilitado (así detecta los mensajes entrantes de WhatsApp Business).</ManualStep>
          <ManualStep>WhatsApp Business: notificaciones activas.</ManualStep>
          <ManualStep>Sin PIN/patrón/contraseña de bloqueo — la automatización de &quot;WhatsApp Send&quot; necesita interactuar con la pantalla sin intervención humana. Ver sección 24.</ManualStep>
          <ManualStep>No guardar contactos de clientes en la agenda del dispositivo. Ver sección 25.</ManualStep>
        </ul>
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          <strong>Samsung-específico (validado):</strong> además de lo anterior, Samsung suele requerir
          desactivar &quot;Poner apps inactivas en reposo&quot; y &quot;Optimizar uso de batería&quot; individualmente
          para MacroDroid, AutoResponder y WhatsApp Business (Configuración → Batería y protección de
          dispositivo → Límites de uso en segundo plano), y agregar las tres apps a &quot;Nunca inactivas&quot;.
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

      <CollapsibleSection n={4} title="MacroDroid principal — trigger">
        <p>Una sola macro maneja los dos ramales (outbound y media), discriminados por <code className="font-mono text-xs">{RN_VAR_ACTION}</code>.</p>
        <p>Variables del trigger webhook (whitelist exacta):</p>
        <CopyField
          multiline
          label="Variables"
          value={[RN_VAR_ACTION, RN_VAR_PHONE, RN_VAR_MESSAGE, RN_VAR_EVENT_ID, RN_VAR_MEDIA_TYPE, RN_VAR_FILENAME, RN_VAR_OUTBOX_ID].join('\n')}
        />
        <p>
          Copiá la URL que MacroDroid genera para este trigger y pegala en el campo <strong className="text-foreground">&quot;URL de MacroDroid&quot;</strong> más
          arriba en esta misma página. No se crea ninguna macro desde código — la macro vive físicamente en el Android.
        </p>
      </CollapsibleSection>

      <CollapsibleSection n={5} title="Rama outbound">
        <CopyField
          multiline
          label={`IF ${RN_VAR_ACTION} = ${RN_ACTION_OUTBOUND}`}
          value={[
            `IF ${RN_VAR_ACTION} = ${RN_ACTION_OUTBOUND}`,
            `  IF ${RN_VAR_PHONE} != "" AND ${RN_VAR_MESSAGE} != ""`,
            `    Screen On`,
            `    Wait ${OUTBOUND_WAIT_BEFORE_SEND_SECONDS} seconds`,
            `    WhatsApp Send`,
            `      phone = [${RN_VAR_PHONE}]`,
            `      message = [${RN_VAR_MESSAGE}]`,
            `    Wait ${OUTBOUND_WAIT_AFTER_SEND_SECONDS} seconds`,
            `    HTTP POST → outbound-ack (ver abajo)`,
          ].join('\n')}
        />
        {ep && <CopyField label="Endpoint outbound-ack" value={ep.outboundAck} />}
        <CopyField label="Header" value={`${HEADER_DEVICE_TOKEN}: <tu device token>`} />
        <CopyField label="Header" value={`${HEADER_OUTBOX_ID}: [${RN_VAR_OUTBOX_ID}]`} />
        <p>Body: vacío.</p>
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          <strong>
            Los dos Wait ({OUTBOUND_WAIT_BEFORE_SEND_SECONDS}s antes y {OUTBOUND_WAIT_AFTER_SEND_SECONDS}s después de &quot;WhatsApp Send&quot;) son obligatorios
          </strong>, ninguno es cosmético — están físicamente caracterizados. El primero: con menos tiempo, el
          dispositivo puede no haber terminado de despertar/estabilizarse en background o pantalla apagada, y
          el mensaje queda escrito como borrador sin enviarse (validado en Fase 9 — con 1s foreground andaba
          bien, pero fallaba en background/post-reboot). El segundo: sin él, WhatsApp puede dejar el mensaje
          como borrador mientras MacroDroid ya sigue con el ACK, produciendo una confirmación falsa. El ACK
          nunca significa &quot;entregado&quot; ni &quot;leído&quot; — solo que el macro llegó físicamente hasta
          después de &quot;WhatsApp Send&quot;.
        </div>
      </CollapsibleSection>

      <CollapsibleSection n={6} title="Macro heartbeat">
        <p>Macro independiente, disparador por intervalo regular (no ligado a ningún evento de WhatsApp).</p>
        <p>Nombre sugerido (no técnicamente relevante): <code className="font-mono text-xs">ReservaNex - Heartbeat</code></p>
        <p>Trigger: Regular Interval, cada {HEARTBEAT_INTERVAL_MINUTES} minutos.</p>
        {ep && <CopyField label="Endpoint heartbeat" value={ep.heartbeat} />}
        <CopyField label="Header" value={`${HEADER_DEVICE_TOKEN}: <tu device token>`} />
        <p>Body: vacío. No necesita Screen On ni ninguna otra variable rn_*.</p>
        <p className="text-xs text-muted-foreground/70">Resultado esperado: 200 {'{ok:true}'}, y en esta página el dispositivo pasa a &quot;Online&quot;.</p>
      </CollapsibleSection>

      <CollapsibleSection n={7} title="Media — documento (PDF)">
        <p>
          Los tres tipos de media (documento, audio, imagen) usan el mismo branch del macro
          (<code className="font-mono text-xs">{RN_VAR_ACTION} = {RN_ACTION_MEDIA}</code>), discriminado por{' '}
          <code className="font-mono text-xs">{RN_VAR_MEDIA_TYPE}</code>. AutoResponder da el nombre de archivo exacto
          solo para documentos (<code className="font-mono text-xs">{RN_VAR_FILENAME}</code>) — no hace falta
          heurística de &quot;archivo más reciente&quot; en este caso.
        </p>
        {ep && <CopyField label="Endpoint media" value={ep.media} />}
        <CopyField label="Header" value={`${HEADER_DEVICE_TOKEN}: <tu device token>`} />
        <CopyField label="Header" value={`${HEADER_EVENT_ID}: [${RN_VAR_EVENT_ID}]`} />
        <CopyField label="Header" value={`${HEADER_MEDIA_TYPE}: ${RN_VAR_MEDIA_TYPE}`} />
        <CopyField label="Header" value={`${HEADER_FILENAME}: [${RN_VAR_FILENAME}]`} />
        <CopyField label="Content-Type" value={MEDIA_CONTENT_TYPE.document} />
        <p className="text-xs text-muted-foreground/70">Solo .pdf está soportado como documento hoy — ver backlog ítem F.</p>
      </CollapsibleSection>

      <CollapsibleSection n={8} title="Media — audio e imagen (generador de paths)">
        <p>
          Wait {MEDIA_WAIT_BEFORE_EXTRACT_SECONDS}s antes de correr el shell script de cada rama (dale tiempo a WhatsApp
          de terminar de guardar el archivo). Mismos headers/endpoint que documento, cambiando
          <code className="font-mono text-xs"> {HEADER_MEDIA_TYPE}</code> y el Content-Type.
        </p>
        {ep && <CopyField label="Endpoint media" value={ep.media} />}
        <CopyField label="Content-Type audio" value={MEDIA_CONTENT_TYPE.audio} />
        <CopyField label="Content-Type imagen" value={MEDIA_CONTENT_TYPE.image} />
        <div className="pt-2">
          <PathGenerator />
        </div>
      </CollapsibleSection>

      <CollapsibleSection n={9} title="Probar instalación" defaultOpen>
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
          <ManualStep>4. Humano outbound — respondé manualmente desde el CRM.</ManualStep>
          <li className="flex items-center justify-between gap-2">
            <span>5. Outbound ACK</span>
            <AutoStatus ok={ackRecent} okLabel="Confirmado" pendingLabel="Sin confirmación reciente" />
          </li>
          <li className="flex items-center justify-between gap-2">
            <span>6/7/8. Imagen, audio, PDF</span>
            <AutoStatus ok={mediaRecent} okLabel="Media recibido" pendingLabel="Sin media reciente" />
          </li>
          <ManualStep>9. Pantalla apagada — repetí 3-5 con la pantalla del Android apagada.</ManualStep>
          <ManualStep>10. Apps en segundo plano — repetí 3-5 con MacroDroid/AutoResponder/WhatsApp Business minimizados.</ManualStep>
          <ManualStep>11. Reboot — ver sección de abajo. Reiniciá el Android y verificá que todo vuelve solo, sin abrir ninguna app manualmente.</ManualStep>
        </ol>
        <div className="rounded-md border px-3 py-2 text-xs text-muted-foreground">
          &quot;Dispositivo conectado&quot; (AutoResponder configurado + heartbeat online) <strong className="text-foreground">no implica</strong> que
          media u outbound ya hayan sido probados — son señales independientes.
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
