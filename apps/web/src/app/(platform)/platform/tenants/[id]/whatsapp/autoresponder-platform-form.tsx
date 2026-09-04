'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { formatDistanceToNow } from 'date-fns'
import { es } from 'date-fns/locale'
import {
  CheckCircle2Icon,
  XCircleIcon,
  AlertCircleIcon,
  SmartphoneIcon,
  KeyIcon,
  LinkIcon,
  CopyIcon,
  RefreshCwIcon,
  WifiIcon,
  WifiOffIcon,
  HelpCircleIcon,
} from 'lucide-react'
import type { AutoResponderPlatformData } from '@/lib/autoresponder-platform'
import { deriveDeviceStatus, DEVICE_STATUS_LABEL, type DeviceStatus } from '@/lib/autoresponder-device-health'
import {
  createAutoResponderAccountAction,
  updateAutoResponderPhoneAndNameAction,
  rotateAutoResponderDeviceTokenAction,
  replaceAutoResponderWebhookUrlAction,
  setAutoResponderActiveAction,
} from '@/actions/platform-autoresponder'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

const STATUS_LABEL: Record<AutoResponderPlatformData['status'], { label: string; className: string; Icon: typeof CheckCircle2Icon }> = {
  not_configured: { label: 'No configurado',           className: 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400', Icon: AlertCircleIcon },
  incomplete:     { label: 'Configuración incompleta',  className: 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-400', Icon: AlertCircleIcon },
  ready:          { label: 'Listo',                     className: 'bg-green-100 text-green-800 border-green-200 dark:bg-green-950 dark:text-green-400', Icon: CheckCircle2Icon },
  disabled:       { label: 'Desactivado',                className: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-400',          Icon: XCircleIcon },
}

// Fase 7 Parte A — DEVICE health, separate from the config-completeness
// badge above (STATUS_LABEL/AutoResponderPlatformData['status']). Never
// says "Listo"/"No configurado" here — those belong to the other badge.
const DEVICE_STATUS_STYLE: Record<DeviceStatus, { className: string; Icon: typeof WifiIcon }> = {
  disabled:       { className: 'bg-slate-100 text-slate-500 border-slate-200 dark:bg-slate-800 dark:text-slate-400',      Icon: WifiOffIcon },
  not_configured: { className: 'bg-slate-100 text-slate-500 border-slate-200 dark:bg-slate-800 dark:text-slate-400',      Icon: HelpCircleIcon },
  never_seen:     { className: 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400',      Icon: HelpCircleIcon },
  online:         { className: 'bg-green-100 text-green-800 border-green-200 dark:bg-green-950 dark:text-green-400',     Icon: WifiIcon },
  stale:          { className: 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-400',     Icon: WifiIcon },
  offline:        { className: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-400',                Icon: WifiOffIcon },
}

// One-time secret reveal — used for both the initial device token and every
// rotation. Closing this dialog is the point of no return: nothing in this
// UI (or any endpoint) can show this value again afterward.
function TokenRevealDialog({
  token,
  onClose,
}: {
  token:   string | null
  onClose: () => void
}) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(token ?? '')
      setCopied(true)
      toast.success('Token copiado al portapapeles')
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error('No se pudo copiar — copialo manualmente.')
    }
  }

  return (
    <Dialog open={token !== null} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyIcon className="h-5 w-5" />
            Token del dispositivo
          </DialogTitle>
          <DialogDescription>
            Copialo ahora. Por seguridad no vas a poder volver a verlo — ni acá ni en ningún otro lado.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md border bg-muted/40 p-3">
          <code className="block break-all font-mono text-sm">{token}</code>
        </div>

        <p className="text-xs text-muted-foreground">
          Pegalo en MacroDroid como el valor del header <code className="font-mono">x-reservanex-device-token</code>.
        </p>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button type="button" variant="outline" onClick={handleCopy}>
            <CopyIcon className="h-4 w-4 mr-1.5" />
            {copied ? 'Copiado ✓' : 'Copiar'}
          </Button>
          <Button type="button" onClick={onClose}>
            Ya lo copié — cerrar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RotateTokenConfirm({
  open,
  onOpenChange,
  onConfirm,
  isPending,
}: {
  open:         boolean
  onOpenChange: (open: boolean) => void
  onConfirm:    () => void
  isPending:    boolean
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <RefreshCwIcon className="h-5 w-5 text-destructive" />
            Rotar token del dispositivo
          </AlertDialogTitle>
          <AlertDialogDescription>
            El token actual va a dejar de funcionar <span className="font-medium text-foreground">inmediatamente</span>.
            Vas a tener que actualizar MacroDroid con el token nuevo antes de que el Android pueda volver a recibir mensajes.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancelar</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            disabled={isPending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {isPending ? 'Rotando…' : 'Rotar token'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

interface AutoResponderPlatformFormProps {
  tenantId: string
  settings: AutoResponderPlatformData | null
}

export function AutoResponderPlatformForm({ tenantId, settings }: AutoResponderPlatformFormProps) {
  const [isPending, startTransition] = useTransition()

  // Create / edit inline forms
  const [showCreateForm, setShowCreateForm] = useState(!settings)
  const [showEditNumber, setShowEditNumber] = useState(false)
  const [showEditWebhook, setShowEditWebhook] = useState(false)
  const [showRotateConfirm, setShowRotateConfirm] = useState(false)

  const [phoneNumber, setPhoneNumber] = useState(settings?.phone_number ?? '')
  const [deviceName,  setDeviceName]  = useState(settings?.device_name ?? '')
  const [webhookUrl,  setWebhookUrl]  = useState('')
  const [active,      setActiveField] = useState(settings?.active ?? true)

  // Non-null exactly once, right after create/rotate — the ONLY place the
  // raw token ever lives client-side, and only in transient React state.
  const [revealedToken, setRevealedToken] = useState<string | null>(null)

  const fmt = (d: string | null) =>
    d ? new Date(d).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'

  // Relative time ("hace 45 segundos") as the primary display, exact
  // timestamp as a secondary title/tooltip — never the other way around,
  // per the Fase 7 spec.
  const fmtRelative = (d: string | null) =>
    d ? formatDistanceToNow(new Date(d), { addSuffix: true, locale: es }) : 'nunca'

  function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    startTransition(async () => {
      const result = await createAutoResponderAccountAction(tenantId, {
        phone_number:           phoneNumber,
        device_name:            deviceName || undefined,
        macrodroid_webhook_url: webhookUrl,
        active,
      })
      if (result.success && result.data) {
        toast.success('Cuenta AutoResponder creada.')
        setShowCreateForm(false)
        setWebhookUrl('')
        setRevealedToken(result.data.raw_device_token)
      } else if (!result.success) {
        toast.error(result.error)
      }
    })
  }

  function handleSaveNumber(e: React.FormEvent) {
    e.preventDefault()
    if (!settings) return
    startTransition(async () => {
      const result = await updateAutoResponderPhoneAndNameAction(settings.id, tenantId, {
        phone_number: phoneNumber,
        device_name:  deviceName || undefined,
      })
      if (result.success) {
        toast.success('Número/dispositivo actualizado.')
        setShowEditNumber(false)
      } else {
        toast.error(result.error)
      }
    })
  }

  function handleReplaceWebhook(e: React.FormEvent) {
    e.preventDefault()
    if (!settings) return
    startTransition(async () => {
      const result = await replaceAutoResponderWebhookUrlAction(settings.id, tenantId, {
        macrodroid_webhook_url: webhookUrl,
      })
      if (result.success) {
        toast.success('URL de MacroDroid reemplazada.')
        setShowEditWebhook(false)
        setWebhookUrl('')
      } else {
        toast.error(result.error)
      }
    })
  }

  function handleRotate() {
    if (!settings) return
    startTransition(async () => {
      const result = await rotateAutoResponderDeviceTokenAction(settings.id, tenantId)
      setShowRotateConfirm(false)
      if (result.success && result.data) {
        toast.success('Token rotado — el anterior ya no es válido.')
        setRevealedToken(result.data.raw_device_token)
      } else if (!result.success) {
        toast.error(result.error)
      }
    })
  }

  function handleToggleActive() {
    if (!settings) return
    const next = !settings.active
    startTransition(async () => {
      const result = await setAutoResponderActiveAction(settings.id, tenantId, next)
      if (result.success) toast.success(next ? 'Cuenta activada.' : 'Cuenta desactivada.')
      else                toast.error(result.error)
    })
  }

  const statusCfg = STATUS_LABEL[settings?.status ?? 'not_configured']
  const deviceStatus = deriveDeviceStatus({
    configStatus:     settings?.status ?? 'not_configured',
    lastDeviceSeenAt: settings?.last_device_seen_at ?? null,
  })
  const deviceStatusCfg = DEVICE_STATUS_STYLE[deviceStatus]

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium">AutoResponder / MacroDroid</CardTitle>
            <Badge className={`gap-1 ${statusCfg.className}`}>
              <statusCfg.Icon className="h-3 w-3" /> {statusCfg.label}
            </Badge>
          </div>
          <CardDescription>Canal WhatsApp vía Android + AutoResponder for WA + MacroDroid.</CardDescription>
        </CardHeader>

        {settings && (
          <CardContent className="text-sm space-y-1.5 text-muted-foreground">
            <div className="flex justify-between gap-4">
              <span>Número</span>
              <span className="font-mono text-foreground">+{settings.phone_number}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span>Dispositivo</span>
              <span className="text-foreground">{settings.device_name ?? '—'}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span>Token</span>
              <span className={settings.has_device_token ? 'text-green-700 dark:text-green-400' : 'text-destructive'}>
                {settings.has_device_token ? '✓ configurado' : 'no configurado'}
              </span>
            </div>
            <div className="flex justify-between gap-4">
              <span>MacroDroid</span>
              <span className={settings.has_macrodroid_url ? 'text-green-700 dark:text-green-400' : 'text-destructive'}>
                {settings.has_macrodroid_url ? '✓ configurado' : 'no configurado'}
              </span>
            </div>
            <div className="flex justify-between gap-4">
              <span>Actualizado</span>
              <span>{fmt(settings.updated_at)}</span>
            </div>
            {settings.status === 'ready' && (
              <p className="pt-1.5 text-xs text-muted-foreground/70">
                &quot;Listo&quot; confirma que la configuración está completa — no que el Android esté online ahora mismo.
              </p>
            )}

            {/* ── Fase 7 Parte A — device health, separate section ────────── */}
            <div className="mt-3 border-t pt-3 space-y-1.5">
              <div className="flex items-center justify-between gap-4">
                <span className="font-medium text-foreground">Dispositivo</span>
                <Badge className={`gap-1 ${deviceStatusCfg.className}`}>
                  <deviceStatusCfg.Icon className="h-3 w-3" /> {DEVICE_STATUS_LABEL[deviceStatus]}
                </Badge>
              </div>
              <div className="flex justify-between gap-4">
                <span>Última señal del dispositivo</span>
                <span className="text-foreground" title={fmt(settings.last_device_seen_at)}>
                  {fmtRelative(settings.last_device_seen_at)}
                </span>
              </div>
              <div className="flex justify-between gap-4">
                <span>Último inbound</span>
                <span className="text-foreground" title={fmt(settings.last_inbound_at)}>
                  {fmtRelative(settings.last_inbound_at)}
                </span>
              </div>
              <div className="flex justify-between gap-4">
                <span>Último envío disparado</span>
                <span className="text-foreground" title={fmt(settings.last_outbound_dispatch_at)}>
                  {fmtRelative(settings.last_outbound_dispatch_at)}
                </span>
              </div>
              <div className="flex justify-between gap-4">
                <span>Última ejecución confirmada</span>
                <span className="text-foreground" title={fmt(settings.last_outbound_device_ack_at)}>
                  {fmtRelative(settings.last_outbound_device_ack_at)}
                </span>
              </div>
              <div className="flex justify-between gap-4">
                <span>Último media recibido</span>
                <span className="text-foreground" title={fmt(settings.last_media_upload_at)}>
                  {fmtRelative(settings.last_media_upload_at)}
                </span>
              </div>
              <p className="pt-1.5 text-xs text-muted-foreground/70">
                &quot;Último envío disparado&quot; confirma que MacroDroid aceptó la orden — no que el mensaje fue entregado o leído.
                &quot;Última ejecución confirmada&quot; es una confirmación física del dispositivo, tampoco un recibo de entrega o lectura de WhatsApp.
              </p>
            </div>
          </CardContent>
        )}
      </Card>

      {/* ── No account yet: create form ─────────────────────────────────── */}
      {!settings && (
        showCreateForm ? (
          <form onSubmit={handleCreate}>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <SmartphoneIcon className="h-4 w-4" />
                  Configurar AutoResponder
                </CardTitle>
                <CardDescription>El token del dispositivo se genera automáticamente — no lo inventes vos.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="ar_phone">
                    Número de WhatsApp Business <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="ar_phone"
                    placeholder="+54 9 11 1234-5678"
                    value={phoneNumber}
                    onChange={(e) => setPhoneNumber(e.target.value)}
                    required
                    disabled={isPending}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="ar_device_name">Nombre del dispositivo</Label>
                  <Input
                    id="ar_device_name"
                    placeholder="Samsung Palermo #1"
                    value={deviceName}
                    onChange={(e) => setDeviceName(e.target.value)}
                    disabled={isPending}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="ar_webhook">
                    URL de MacroDroid <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="ar_webhook"
                    type="url"
                    placeholder="https://trigger.macrodroid.com/..."
                    value={webhookUrl}
                    onChange={(e) => setWebhookUrl(e.target.value)}
                    required
                    disabled={isPending}
                    autoComplete="off"
                    className="font-mono text-sm"
                  />
                  <p className="text-xs text-muted-foreground">
                    Es secreta — una vez guardada no se vuelve a mostrar. Solo se puede reemplazar.
                  </p>
                </div>
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={active}
                    onChange={(e) => setActiveField(e.target.checked)}
                    disabled={isPending}
                    className="rounded border"
                  />
                  <span className="text-sm">Activar al crear</span>
                </label>
              </CardContent>
            </Card>
            <div className="mt-3">
              <Button type="submit" disabled={isPending}>
                {isPending ? 'Creando…' : 'Crear cuenta'}
              </Button>
            </div>
          </form>
        ) : (
          <Button onClick={() => setShowCreateForm(true)}>Configurar</Button>
        )
      )}

      {/* ── Existing account: edit actions ──────────────────────────────── */}
      {settings && (
        <div className="space-y-4">
          {showEditNumber ? (
            <form onSubmit={handleSaveNumber}>
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Editar número / nombre</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="edit_phone">Número de WhatsApp Business</Label>
                    <Input id="edit_phone" value={phoneNumber} onChange={(e) => setPhoneNumber(e.target.value)} required disabled={isPending} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="edit_device_name">Nombre del dispositivo</Label>
                    <Input id="edit_device_name" value={deviceName} onChange={(e) => setDeviceName(e.target.value)} disabled={isPending} />
                  </div>
                </CardContent>
              </Card>
              <div className="mt-3 flex gap-2">
                <Button type="submit" disabled={isPending}>{isPending ? 'Guardando…' : 'Guardar'}</Button>
                <Button type="button" variant="outline" disabled={isPending} onClick={() => setShowEditNumber(false)}>Cancelar</Button>
              </div>
            </form>
          ) : showEditWebhook ? (
            <form onSubmit={handleReplaceWebhook}>
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <LinkIcon className="h-4 w-4" />
                    Reemplazar URL de MacroDroid
                  </CardTitle>
                  <CardDescription>La URL actual no se muestra por seguridad. Pegá la nueva para reemplazarla.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                  <Label htmlFor="new_webhook">URL nueva</Label>
                  <Input
                    id="new_webhook"
                    type="url"
                    placeholder="https://trigger.macrodroid.com/..."
                    value={webhookUrl}
                    onChange={(e) => setWebhookUrl(e.target.value)}
                    required
                    disabled={isPending}
                    autoComplete="off"
                    className="font-mono text-sm"
                  />
                </CardContent>
              </Card>
              <div className="mt-3 flex gap-2">
                <Button type="submit" disabled={isPending}>{isPending ? 'Guardando…' : 'Reemplazar'}</Button>
                <Button type="button" variant="outline" disabled={isPending} onClick={() => { setShowEditWebhook(false); setWebhookUrl('') }}>Cancelar</Button>
              </div>
            </form>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" variant="outline" size="sm" onClick={() => setShowEditNumber(true)} disabled={isPending}>
                Editar número/nombre
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => setShowEditWebhook(true)} disabled={isPending}>
                Reemplazar webhook MacroDroid
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => setShowRotateConfirm(true)} disabled={isPending}>
                <RefreshCwIcon className="h-3.5 w-3.5 mr-1.5" />
                Rotar token
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={settings.active ? 'text-destructive hover:text-destructive hover:bg-destructive/10 ml-auto' : 'ml-auto'}
                disabled={isPending}
                onClick={handleToggleActive}
              >
                {settings.active ? 'Desactivar cuenta' : 'Activar cuenta'}
              </Button>
            </div>
          )}
        </div>
      )}

      <RotateTokenConfirm
        open={showRotateConfirm}
        onOpenChange={setShowRotateConfirm}
        onConfirm={handleRotate}
        isPending={isPending}
      />

      <TokenRevealDialog token={revealedToken} onClose={() => setRevealedToken(null)} />
    </div>
  )
}
