'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { ClockIcon } from 'lucide-react'
import { updateReservationSettingsAction } from '@/actions/ai-settings'
import type { ReservationSettingsData } from '@/actions/ai-settings'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

interface ReservationSettingsFormProps {
  settings: ReservationSettingsData
}

export function ReservationSettingsForm({ settings }: ReservationSettingsFormProps) {
  const [isPending, startTransition] = useTransition()
  const [holdHours, setHoldHours] = useState(String(settings.hold_hours))

  function handleSave(e: React.FormEvent) {
    e.preventDefault()
    startTransition(async () => {
      const result = await updateReservationSettingsAction({ hold_hours: holdHours })
      if (result.success) {
        toast.success('Configuración guardada.')
      } else {
        toast.error(result.error ?? 'Error al guardar.')
      }
    })
  }

  const hours = Number(holdHours)
  const humanLabel = hours === 1
    ? '1 hora'
    : hours < 24
    ? `${hours} horas`
    : hours === 24
    ? '1 día'
    : hours % 24 === 0
    ? `${hours / 24} días`
    : `${Math.floor(hours / 24)} día${Math.floor(hours / 24) !== 1 ? 's' : ''} y ${hours % 24} h`

  return (
    <form onSubmit={handleSave} className="space-y-6 max-w-2xl">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ClockIcon className="h-4 w-4" />
            Tiempo de bloqueo de reserva pendiente
          </CardTitle>
          <CardDescription>
            Cuando la IA crea una reserva, queda pendiente de confirmación por este tiempo.
            Si un asesor no la confirma en ese lapso, el sistema la cancela automáticamente.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="hold_hours">
              Horas de bloqueo <span className="text-destructive">*</span>
            </Label>
            <div className="flex items-center gap-3">
              <Input
                id="hold_hours"
                type="number"
                min={1}
                max={168}
                step={1}
                value={holdHours}
                onChange={(e) => setHoldHours(e.target.value)}
                required
                disabled={isPending}
                className="w-28"
              />
              <span className="text-sm text-muted-foreground">horas</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Mínimo 1 hora · Máximo 168 horas (7 días) · Valor actual: <strong>{humanLabel}</strong>
            </p>
          </div>

          {/* Quick presets */}
          <div className="flex flex-wrap gap-2">
            {[{ label: '1 h', value: 1 }, { label: '4 h', value: 4 }, { label: '12 h', value: 12 }, { label: '24 h', value: 24 }, { label: '48 h', value: 48 }].map(p => (
              <button
                key={p.value}
                type="button"
                onClick={() => setHoldHours(String(p.value))}
                disabled={isPending}
                className={`rounded border px-3 py-1 text-xs transition-colors ${
                  Number(holdHours) === p.value
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border hover:bg-muted'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      <Button type="submit" disabled={isPending}>
        {isPending ? 'Guardando…' : 'Guardar configuración'}
      </Button>
    </form>
  )
}
