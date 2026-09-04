'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import {
  CheckCircle2Icon,
  XCircleIcon,
  AlertCircleIcon,
  PhoneIcon,
  KeyIcon,
  WifiIcon,
  ZapIcon,
} from 'lucide-react'
import type { WhatsAppPlatformData, TestConnectionResult, SubscriptionStatus } from '@/actions/platform-whatsapp'
import {
  saveWhatsAppSettingsBySuperAdminAction,
  deactivateTenantWhatsAppAccountBySAAction,
  testTenantWhatsAppConnectionAction,
} from '@/actions/platform-whatsapp'
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

function SubscriptionBadge({ status }: { status: SubscriptionStatus }) {
  if (status === 'subscribed') {
    return (
      <span className="flex items-center gap-1 text-green-700 dark:text-green-400">
        <CheckCircle2Icon className="h-3.5 w-3.5" /> sí
      </span>
    )
  }
  if (status === 'subscribed_now') {
    return (
      <span className="flex items-center gap-1 text-blue-700 dark:text-blue-400">
        <ZapIcon className="h-3.5 w-3.5" /> activado ahora
      </span>
    )
  }
  if (status === 'failed') {
    return (
      <span className="flex items-center gap-1 text-red-600 dark:text-red-400">
        <XCircleIcon className="h-3.5 w-3.5" /> falló
      </span>
    )
  }
  return (
    <span className="flex items-center gap-1 text-muted-foreground">
      <AlertCircleIcon className="h-3.5 w-3.5" /> desconocido
    </span>
  )
}

interface WhatsAppPlatformFormProps {
  tenantId: string
  settings: WhatsAppPlatformData | null
}

export function WhatsAppPlatformForm({ tenantId, settings }: WhatsAppPlatformFormProps) {
  const [isPending, startTransition] = useTransition()
  const [showToken,    setShowToken]    = useState(false)
  const [replaceToken, setReplaceToken] = useState(!settings?.has_token)

  const [phoneNumberId, setPhoneNumberId] = useState(settings?.phone_number ?? '')
  const [wabaId,        setWabaId]        = useState(settings?.business_account_id ?? '')
  const [displayPhone,  setDisplayPhone]  = useState(settings?.display_phone_number ?? '')
  const [accessToken,   setAccessToken]   = useState('')

  const [testResult, setTestResult] = useState<TestConnectionResult | null>(null)

  const fmt = (d: string | null) =>
    d
      ? new Date(d).toLocaleString('es-AR', {
          day: '2-digit', month: '2-digit', year: 'numeric',
          hour: '2-digit', minute: '2-digit',
        })
      : '—'

  function handleSave(e: React.FormEvent) {
    e.preventDefault()
    startTransition(async () => {
      const result = await saveWhatsAppSettingsBySuperAdminAction(tenantId, {
        phone_number:         phoneNumberId,
        business_account_id:  wabaId,
        display_phone_number: displayPhone,
        access_token:         replaceToken ? (accessToken || undefined) : undefined,
      })
      if (result.success) {
        toast.success('Configuración guardada.')
        setAccessToken('')
        setReplaceToken(false)
      } else {
        toast.error(result.error)
      }
    })
  }

  function handleDeactivate() {
    if (!settings?.id) return
    startTransition(async () => {
      const result = await deactivateTenantWhatsAppAccountBySAAction(settings.id)
      if (result.success) toast.success('Cuenta desactivada.')
      else                toast.error(result.error)
    })
  }

  function handleTest() {
    if (!settings?.id) return
    startTransition(async () => {
      setTestResult(null)
      const result = await testTenantWhatsAppConnectionAction(settings.id)
      if (result.success) {
        const testData = result.data
        if (testData) {
          setTestResult(testData)
          if (testData.ok) toast.success('Conexión verificada correctamente.')
          else             toast.error(`Error: ${testData.error}`)
        }
      } else {
        toast.error(result.error)
      }
    })
  }

  return (
    <div className="space-y-5">
      {/* Status card */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium">Estado actual</CardTitle>
            {!settings ? (
              <Badge variant="outline" className="text-muted-foreground">Sin configurar</Badge>
            ) : settings.active && settings.has_token ? (
              <Badge className="gap-1 bg-green-100 text-green-800 border-green-200 hover:bg-green-100 dark:bg-green-950 dark:text-green-400 dark:border-green-800">
                <CheckCircle2Icon className="h-3 w-3" /> Activo
              </Badge>
            ) : (
              <Badge className="gap-1 bg-red-50 text-red-700 border-red-200 hover:bg-red-50 dark:bg-red-950 dark:text-red-400 dark:border-red-800">
                <XCircleIcon className="h-3 w-3" /> Inactivo
              </Badge>
            )}
          </div>
        </CardHeader>
        {settings && (
          <CardContent className="text-sm space-y-1.5 text-muted-foreground">
            <div className="flex justify-between gap-4">
              <span>Phone Number ID</span>
              <span className="font-mono text-foreground">{settings.phone_number}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span>WABA ID</span>
              <span className="font-mono text-foreground">{settings.business_account_id}</span>
            </div>
            {settings.display_phone_number && (
              <div className="flex justify-between gap-4">
                <span>Número visible</span>
                <span className="text-foreground">{settings.display_phone_number}</span>
              </div>
            )}
            <div className="flex justify-between gap-4">
              <span>Token</span>
              <span className={settings.has_token ? 'text-green-700 dark:text-green-400' : 'text-destructive'}>
                {settings.has_token ? '✓ configurado' : 'no configurado'}
              </span>
            </div>
            <div className="flex justify-between gap-4">
              <span>Último test</span>
              <span>{fmt(settings.last_verified_at)}</span>
            </div>
          </CardContent>
        )}
      </Card>

      {/* Config form */}
      <form onSubmit={handleSave} className="space-y-5">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <PhoneIcon className="h-4 w-4" />
              Números e IDs
            </CardTitle>
            <CardDescription>IDs de Meta para este tenant.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="phone_number_id">
                Phone Number ID <span className="text-destructive">*</span>
              </Label>
              <Input
                id="phone_number_id"
                placeholder="123456789012345"
                value={phoneNumberId}
                onChange={(e) => setPhoneNumberId(e.target.value)}
                required
                disabled={isPending}
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">
                ID numérico del número en Meta Developers → WhatsApp → Phone Numbers.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="waba_id">
                WABA ID <span className="text-destructive">*</span>
              </Label>
              <Input
                id="waba_id"
                placeholder="987654321098765"
                value={wabaId}
                onChange={(e) => setWabaId(e.target.value)}
                required
                disabled={isPending}
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">
                WhatsApp Business Account ID del Business Manager.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="display_phone">Número visible</Label>
              <Input
                id="display_phone"
                placeholder="+54 9 11 1234-5678"
                value={displayPhone}
                onChange={(e) => setDisplayPhone(e.target.value)}
                disabled={isPending}
              />
              <p className="text-xs text-muted-foreground">
                Número formateado que verá el tenant en el dashboard. No afecta el envío.
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <KeyIcon className="h-4 w-4" />
              Access Token
            </CardTitle>
            <CardDescription>
              {settings?.has_token
                ? 'Hay un token configurado. Marcá "Reemplazar" para cambiarlo.'
                : 'Aún no hay token — es requerido para enviar mensajes.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {settings?.has_token && (
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={replaceToken}
                  onChange={(e) => {
                    setReplaceToken(e.target.checked)
                    if (!e.target.checked) setAccessToken('')
                  }}
                  disabled={isPending}
                  className="rounded border"
                />
                <span className="text-sm">Reemplazar token existente</span>
              </label>
            )}

            {(!settings?.has_token || replaceToken) && (
              <div className="space-y-2">
                <Label htmlFor="access_token">
                  Token{' '}
                  {!settings?.has_token && <span className="text-destructive">*</span>}
                </Label>
                <div className="flex gap-2">
                  <Input
                    id="access_token"
                    type={showToken ? 'text' : 'password'}
                    placeholder="Pegá el token de Meta aquí"
                    value={accessToken}
                    onChange={(e) => setAccessToken(e.target.value)}
                    required={!settings?.has_token}
                    disabled={isPending}
                    autoComplete="new-password"
                    className="flex-1 font-mono text-sm"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setShowToken((v) => !v)}
                    disabled={isPending}
                  >
                    {showToken ? 'Ocultar' : 'Mostrar'}
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="flex items-center gap-3 flex-wrap">
          <Button type="submit" disabled={isPending}>
            {isPending ? 'Guardando…' : 'Guardar configuración'}
          </Button>

          {settings?.id && (
            <Button
              type="button"
              variant="outline"
              disabled={isPending || !settings.active || !settings.has_token}
              onClick={handleTest}
            >
              <WifiIcon className="h-4 w-4 mr-1.5" />
              {isPending ? 'Probando…' : 'Probar conexión'}
            </Button>
          )}

          {settings?.id && settings.active && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive hover:bg-destructive/10 ml-auto"
              disabled={isPending}
              onClick={handleDeactivate}
            >
              Desactivar cuenta
            </Button>
          )}
        </div>
      </form>

      {/* Test result */}
      {testResult && (
        <Card className={testResult.ok
          ? 'border-green-200 dark:border-green-800'
          : 'border-red-200 dark:border-red-800'}
        >
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              {testResult.ok ? (
                <CheckCircle2Icon className="h-4 w-4 text-green-600 dark:text-green-400" />
              ) : (
                <AlertCircleIcon className="h-4 w-4 text-red-600 dark:text-red-400" />
              )}
              {testResult.ok ? 'Conexión exitosa' : 'Error de conexión'}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm space-y-3 text-muted-foreground">
            {testResult.ok ? (
              <>
                {/* Phone number details */}
                <div className="space-y-1.5">
                  {testResult.verified_name        && <div className="flex justify-between gap-4"><span>Nombre verificado</span><span className="text-foreground">{testResult.verified_name}</span></div>}
                  {testResult.display_phone_number && <div className="flex justify-between gap-4"><span>Número</span><span className="text-foreground">{testResult.display_phone_number}</span></div>}
                  {testResult.quality_rating       && <div className="flex justify-between gap-4"><span>Calidad</span><span className="text-foreground">{testResult.quality_rating}</span></div>}
                  {testResult.platform_type        && <div className="flex justify-between gap-4"><span>Plataforma</span><span className="text-foreground">{testResult.platform_type}</span></div>}
                </div>

                {/* WABA / Webhook checks */}
                <div className="border-t pt-2.5 space-y-1.5">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground/70">Verificaciones WABA</p>

                  {testResult.phone_number_in_waba !== undefined && (
                    <div className="flex items-center justify-between gap-4">
                      <span>Phone Number ID en WABA</span>
                      {testResult.phone_number_in_waba ? (
                        <span className="flex items-center gap-1 text-green-700 dark:text-green-400">
                          <CheckCircle2Icon className="h-3.5 w-3.5" /> sí
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-red-600 dark:text-red-400">
                          <XCircleIcon className="h-3.5 w-3.5" /> no
                        </span>
                      )}
                    </div>
                  )}

                  {testResult.subscription_status && (
                    <div className="flex items-center justify-between gap-4">
                      <span>App suscripta al WABA</span>
                      <SubscriptionBadge status={testResult.subscription_status} />
                    </div>
                  )}

                  {testResult.subscription_status === 'subscribed_now' && (
                    <div className="flex items-center gap-1.5 rounded-md bg-blue-50 px-2.5 py-1.5 text-xs text-blue-700 dark:bg-blue-950/40 dark:text-blue-400">
                      <ZapIcon className="h-3.5 w-3.5 shrink-0" />
                      Webhook activado para esta cuenta. Los mensajes inbound llegarán desde ahora.
                    </div>
                  )}

                  {testResult.subscription_error && (
                    <p className="text-xs text-yellow-700 dark:text-yellow-400">
                      Suscripción: {testResult.subscription_error}
                    </p>
                  )}
                </div>
              </>
            ) : (
              <div className="space-y-1.5">
                <p className="text-red-600 dark:text-red-400">{testResult.error}</p>
                {testResult.phone_number_in_waba === false && (
                  <p className="text-xs text-muted-foreground">
                    Verificá que el Phone Number ID y el WABA ID correspondan a la misma cuenta en Meta Business Manager.
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
