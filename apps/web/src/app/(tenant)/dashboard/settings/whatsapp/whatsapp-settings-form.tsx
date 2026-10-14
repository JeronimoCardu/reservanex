'use client'

import { CheckCircle2Icon, XCircleIcon, MessageCircleIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { WhatsAppSettingsData } from '@/actions/whatsapp-settings'
import { whatsAppStatusBadge } from '@/lib/whatsapp-status'

interface WhatsAppSettingsFormProps {
  settings: WhatsAppSettingsData
}

const BADGE_CLASS = {
  muted: 'text-muted-foreground',
  ok:    'gap-1 bg-green-100 text-green-800 border-green-200 hover:bg-green-100 dark:bg-green-950 dark:text-green-400 dark:border-green-800',
  error: 'gap-1 bg-red-50 text-red-700 border-red-200 hover:bg-red-50 dark:bg-red-950 dark:text-red-400 dark:border-red-800',
} as const

export function WhatsAppSettingsForm({ settings }: WhatsAppSettingsFormProps) {
  const fmt = (d: string | null) =>
    d
      ? new Date(d).toLocaleString('es-AR', {
          day: '2-digit', month: '2-digit', year: 'numeric',
          hour: '2-digit', minute: '2-digit',
        })
      : '—'

  const badge = whatsAppStatusBadge(settings)

  return (
    <div className="space-y-4 max-w-lg">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium">Estado</CardTitle>
            <Badge variant={badge.tone === 'muted' ? 'outline' : undefined} className={BADGE_CLASS[badge.tone]}>
              {badge.tone === 'ok' && <CheckCircle2Icon className="h-3 w-3" />}
              {badge.tone === 'error' && <XCircleIcon className="h-3 w-3" />}
              {badge.label}
            </Badge>
          </div>
        </CardHeader>

        {settings.kind === 'autoresponder' && (
          <CardContent className="text-sm space-y-1.5 text-muted-foreground">
            {settings.phone && (
              <div className="flex justify-between gap-4">
                <span>Número</span>
                <span className="font-medium text-foreground">{settings.phone}</span>
              </div>
            )}
            <div className="flex justify-between gap-4">
              <span>Última actividad</span>
              <span className={settings.lastActivityAt ? 'text-foreground' : undefined}>
                {settings.lastActivityAt ? fmt(settings.lastActivityAt) : 'Sin actividad registrada'}
              </span>
            </div>
            <p className="pt-1 text-xs">
              {settings.active
                ? 'Se actualiza cada vez que llega un mensaje de un cliente a este número.'
                : 'ReservaNex desactivó este número: sus mensajes no se procesan. Para volver a activarlo, contactá a soporte.'}
            </p>
          </CardContent>
        )}

        {settings.kind === 'meta' && (
          <CardContent className="text-sm space-y-1.5 text-muted-foreground">
            {settings.phone && (
              <div className="flex justify-between gap-4">
                <span>Número</span>
                <span className="font-medium text-foreground">{settings.phone}</span>
              </div>
            )}
            <div className="flex justify-between gap-4">
              <span>Token</span>
              <span className={settings.hasToken ? 'text-green-700 dark:text-green-400' : 'text-muted-foreground'}>
                {settings.hasToken ? '✓ configurado' : 'no configurado'}
              </span>
            </div>
            {settings.lastVerifiedAt && (
              <div className="flex justify-between gap-4">
                <span>Último test</span>
                <span>{fmt(settings.lastVerifiedAt)}</span>
              </div>
            )}
          </CardContent>
        )}
      </Card>

      <div className="rounded-lg border bg-muted/40 p-4 flex gap-3">
        <MessageCircleIcon className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          La configuración técnica de WhatsApp la realiza el equipo de ReservaNex. Para pedir
          cambios o reportar un problema, contactá a soporte.
        </p>
      </div>
    </div>
  )
}
