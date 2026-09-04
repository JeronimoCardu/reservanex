'use client'

import { CheckCircle2Icon, XCircleIcon, MessageCircleIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { WhatsAppSettingsData } from '@/actions/whatsapp-settings'

interface WhatsAppSettingsFormProps {
  settings: WhatsAppSettingsData | null
}

export function WhatsAppSettingsForm({ settings }: WhatsAppSettingsFormProps) {
  const fmt = (d: string | null) =>
    d
      ? new Date(d).toLocaleString('es-AR', {
          day: '2-digit', month: '2-digit', year: 'numeric',
          hour: '2-digit', minute: '2-digit',
        })
      : '—'

  return (
    <div className="space-y-4 max-w-lg">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium">Estado de conexión</CardTitle>
            {!settings ? (
              <Badge variant="outline" className="text-muted-foreground">Sin configurar</Badge>
            ) : settings.active && settings.has_token ? (
              <Badge className="gap-1 bg-green-100 text-green-800 border-green-200 hover:bg-green-100 dark:bg-green-950 dark:text-green-400 dark:border-green-800">
                <CheckCircle2Icon className="h-3 w-3" />
                Conectado
              </Badge>
            ) : (
              <Badge className="gap-1 bg-red-50 text-red-700 border-red-200 hover:bg-red-50 dark:bg-red-950 dark:text-red-400 dark:border-red-800">
                <XCircleIcon className="h-3 w-3" />
                Inactivo
              </Badge>
            )}
          </div>
        </CardHeader>
        {settings && (
          <CardContent className="text-sm space-y-1.5 text-muted-foreground">
            {(settings.display_phone_number ?? settings.phone_number) && (
              <div className="flex justify-between gap-4">
                <span>Número</span>
                <span className="font-medium text-foreground">
                  {settings.display_phone_number ?? settings.phone_number}
                </span>
              </div>
            )}
            <div className="flex justify-between gap-4">
              <span>Token</span>
              <span className={settings.has_token ? 'text-green-700 dark:text-green-400' : 'text-muted-foreground'}>
                {settings.has_token ? '✓ configurado' : 'no configurado'}
              </span>
            </div>
            {settings.last_verified_at && (
              <div className="flex justify-between gap-4">
                <span>Último test</span>
                <span>{fmt(settings.last_verified_at)}</span>
              </div>
            )}
          </CardContent>
        )}
      </Card>

      <div className="rounded-lg border bg-muted/40 p-4 flex gap-3">
        <MessageCircleIcon className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          La configuración técnica de WhatsApp (token, número y WABA) la realiza el equipo de
          ReservaNex. Para solicitar cambios o reportar un problema, contactá a soporte.
        </p>
      </div>
    </div>
  )
}
