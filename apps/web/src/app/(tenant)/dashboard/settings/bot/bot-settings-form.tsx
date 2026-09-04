'use client'

import { useState, useTransition }  from 'react'
import { toast }                     from 'sonner'
import { BotIcon, SlidersIcon }      from 'lucide-react'
import { updateBotSettingsAction }   from '@/actions/tenant-settings'
import type { BotSettings }          from '@/actions/tenant-settings'
import { Button }                    from '@/components/ui/button'
import { Input }                     from '@/components/ui/input'
import { Label }                     from '@/components/ui/label'
import { Textarea }                  from '@/components/ui/textarea'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'

type BotTone = BotSettings['bot_tone']

const TONES: { value: BotTone; label: string; description: string }[] = [
  { value: 'professional', label: 'Profesional',      description: 'Claro, formal y directo. Ideal para inmobiliarias de perfil corporativo.' },
  { value: 'friendly',     label: 'Cercano',          description: 'Amable y accesible. Genera confianza desde el primer mensaje.' },
  { value: 'premium',      label: 'Premium',          description: 'Elegante y exclusivo. Para propiedades de alto valor.' },
  { value: 'casual',       label: 'Descontracturado', description: 'Natural y conversacional. Perfecto para un perfil moderno y joven.' },
]

interface BotSettingsFormProps {
  settings: BotSettings
}

export function BotSettingsForm({ settings }: BotSettingsFormProps) {
  const [isPending, startTransition] = useTransition()

  const [active,         setActive]         = useState(settings.active)
  const [assistantName,  setAssistantName]  = useState(settings.assistant_name)
  const [tone,           setTone]           = useState<BotTone>(settings.bot_tone)
  const [useEmojis,      setUseEmojis]      = useState(settings.bot_use_emojis)
  const [sendLinks,      setSendLinks]      = useState(settings.bot_send_property_links)

  // Escalation keywords stored as TEXT[] in DB; edited as comma-separated string in UI
  const [keywordsRaw, setKeywordsRaw] = useState(
    settings.escalation_keywords.join(', '),
  )

  const [delayMs,       setDelayMs]       = useState(String(settings.response_delay_ms))
  const [contextMsgs,   setContextMsgs]   = useState(String(settings.max_context_messages))
  const [maxTurns,      setMaxTurns]      = useState(String(settings.max_turns_before_escalation))
  const [holdMinutes,   setHoldMinutes]   = useState(String(settings.pending_reservation_hold_minutes))

  function handleSave(e: React.FormEvent) {
    e.preventDefault()
    const keywords = keywordsRaw
      .split(',')
      .map(k => k.trim().toLowerCase())
      .filter(Boolean)

    startTransition(async () => {
      const result = await updateBotSettingsAction({
        active,
        assistant_name:              assistantName,
        bot_tone:                    tone,
        bot_use_emojis:              useEmojis,
        bot_send_property_links:     sendLinks,
        escalation_keywords:         keywords,
        response_delay_ms:           Number(delayMs),
        max_context_messages:        Number(contextMsgs),
        max_turns_before_escalation: Number(maxTurns),
        pending_reservation_hold_minutes: Number(holdMinutes),
      })
      if (result.success) toast.success('Configuración guardada.')
      else                toast.error(result.error ?? 'Error al guardar.')
    })
  }

  return (
    <form onSubmit={handleSave} className="space-y-6 max-w-2xl">

      {/* Estado y nombre */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <BotIcon className="h-4 w-4" />
            Asistente de IA
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="flex items-center gap-2.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={active}
              onChange={e => setActive(e.target.checked)}
              disabled={isPending}
              className="rounded border"
            />
            <span className="text-sm font-medium">Bot activo</span>
            <span className="text-xs text-muted-foreground">
              — {active ? 'el bot responde mensajes nuevos' : 'todos los chats nuevos arrancan en modo manual'}
            </span>
          </label>

          <div className="space-y-2">
            <Label htmlFor="assistant_name">Nombre del asistente</Label>
            <Input
              id="assistant_name"
              placeholder="Asistente"
              value={assistantName}
              onChange={e => setAssistantName(e.target.value)}
              disabled={isPending}
              maxLength={60}
            />
            <p className="text-xs text-muted-foreground">
              Así se presentará el bot con los clientes. Máx. 60 caracteres.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Tono del bot */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Tono de respuesta</CardTitle>
          <CardDescription>
            Define la personalidad del asistente. No podés editar el prompt directamente.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {TONES.map(t => (
              <label
                key={t.value}
                className={`flex cursor-pointer flex-col gap-1 rounded-lg border p-4 transition-colors ${
                  tone === t.value
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:bg-muted/50'
                } ${isPending ? 'pointer-events-none opacity-60' : ''}`}
              >
                <input
                  type="radio"
                  name="bot_tone"
                  value={t.value}
                  checked={tone === t.value}
                  onChange={() => setTone(t.value)}
                  disabled={isPending}
                  className="sr-only"
                />
                <span className="text-sm font-semibold">{t.label}</span>
                <span className="text-xs text-muted-foreground leading-snug">{t.description}</span>
              </label>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Personalidad */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Personalidad</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <label className="flex items-center gap-2.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={useEmojis}
              onChange={e => setUseEmojis(e.target.checked)}
              disabled={isPending}
              className="rounded border"
            />
            <div>
              <p className="text-sm">Usar emojis en respuestas</p>
              <p className="text-xs text-muted-foreground">El bot puede incluir emojis para hacer los mensajes más expresivos.</p>
            </div>
          </label>
          <label className="flex items-center gap-2.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={sendLinks}
              onChange={e => setSendLinks(e.target.checked)}
              disabled={isPending}
              className="rounded border"
            />
            <div>
              <p className="text-sm">Incluir links a propiedades</p>
              <p className="text-xs text-muted-foreground">Si está activo el sitio público, el bot puede enviar el link de cada propiedad.</p>
            </div>
          </label>
        </CardContent>
      </Card>

      {/* Configuración avanzada */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <SlidersIcon className="h-4 w-4" />
            Configuración avanzada
          </CardTitle>
        </CardHeader>
        <CardContent>
          <details className="group">
            <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground list-none flex items-center gap-2 pb-4">
              <span className="transition-transform group-open:rotate-90">▶</span>
              Ver opciones avanzadas
            </summary>

            <div className="space-y-5 pt-2 border-t">
              <div className="space-y-2">
                <Label htmlFor="keywords">Palabras clave para escalar a un asesor</Label>
                <Textarea
                  id="keywords"
                  placeholder="urgente, quiero hablar con una persona, no entiendo, precio especial"
                  value={keywordsRaw}
                  onChange={e => setKeywordsRaw(e.target.value)}
                  disabled={isPending}
                  rows={3}
                />
                <p className="text-xs text-muted-foreground">
                  Separadas por coma. Cuando el cliente las usa, el chat pasa a modo manual. Máx. 20 palabras.
                </p>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="delay_ms">Demora antes de responder (ms)</Label>
                  <Input
                    id="delay_ms"
                    type="number"
                    min={0}
                    max={5000}
                    step={100}
                    value={delayMs}
                    onChange={e => setDelayMs(e.target.value)}
                    disabled={isPending}
                  />
                  <p className="text-xs text-muted-foreground">0 – 5000 ms. Simula tiempo de escritura.</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="context_msgs">Mensajes de contexto</Label>
                  <Input
                    id="context_msgs"
                    type="number"
                    min={5}
                    max={30}
                    value={contextMsgs}
                    onChange={e => setContextMsgs(e.target.value)}
                    disabled={isPending}
                  />
                  <p className="text-xs text-muted-foreground">5 – 30. Cuántos mensajes previos ve el bot.</p>
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="max_turns">Turnos antes de escalar</Label>
                  <Input
                    id="max_turns"
                    type="number"
                    min={2}
                    max={8}
                    value={maxTurns}
                    onChange={e => setMaxTurns(e.target.value)}
                    disabled={isPending}
                  />
                  <p className="text-xs text-muted-foreground">2 – 8. Turnos sin avance antes de pedir ayuda humana.</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="hold_minutes">Hold de pre-reserva (minutos)</Label>
                  <Input
                    id="hold_minutes"
                    type="number"
                    min={15}
                    max={10080}
                    step={15}
                    value={holdMinutes}
                    onChange={e => setHoldMinutes(e.target.value)}
                    disabled={isPending}
                  />
                  <p className="text-xs text-muted-foreground">15 – 10080 min. Tiempo para confirmar reservas IA.</p>
                </div>
              </div>
            </div>
          </details>
        </CardContent>
      </Card>

      <Button type="submit" disabled={isPending}>
        {isPending ? 'Guardando…' : 'Guardar configuración'}
      </Button>
    </form>
  )
}
