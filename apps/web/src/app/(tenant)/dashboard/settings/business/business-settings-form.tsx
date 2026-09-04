'use client'

import { useState, useTransition }      from 'react'
import { toast }                         from 'sonner'
import { GlobeIcon, PhoneIcon, ClockIcon, MessageCircleIcon } from 'lucide-react'
import { updateBusinessInfoAction }      from '@/actions/tenant-settings'
import type { BusinessSettings }         from '@/actions/tenant-settings'
import { Button }                        from '@/components/ui/button'
import { Input }                         from '@/components/ui/input'
import { Label }                         from '@/components/ui/label'
import { Textarea }                      from '@/components/ui/textarea'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'

const DAYS = [
  { key: 'lunes',     label: 'Lunes'      },
  { key: 'martes',    label: 'Martes'     },
  { key: 'miercoles', label: 'Miércoles'  },
  { key: 'jueves',    label: 'Jueves'     },
  { key: 'viernes',   label: 'Viernes'    },
  { key: 'sabado',    label: 'Sábado'     },
  { key: 'domingo',   label: 'Domingo'    },
]

interface BusinessSettingsFormProps {
  settings: BusinessSettings
  readOnly: boolean
}

export function BusinessSettingsForm({ settings, readOnly }: BusinessSettingsFormProps) {
  const [isPending, startTransition] = useTransition()

  const [phone,     setPhone]     = useState(settings.public_phone          ?? '')
  const [email,     setEmail]     = useState(settings.public_email          ?? '')
  const [website,   setWebsite]   = useState(settings.public_website_url    ?? '')
  const [instagram, setInstagram] = useState(settings.public_instagram_url  ?? '')
  const [facebook,  setFacebook]  = useState(settings.public_facebook_url   ?? '')
  const [tiktok,    setTiktok]    = useState(settings.public_tiktok_url     ?? '')
  const [about,     setAbout]     = useState(settings.public_about_html     ?? '')
  const [waPretext, setWaPretext] = useState(settings.public_wa_pretext     ?? '')

  const [hours, setHours] = useState<Record<string, string>>(
    Object.fromEntries(DAYS.map(d => [d.key, settings.business_hours[d.key] ?? ''])),
  )

  const disabled = isPending || readOnly

  function handleSave(e: React.FormEvent) {
    e.preventDefault()
    startTransition(async () => {
      const result = await updateBusinessInfoAction({
        public_phone:         phone,
        public_email:         email,
        public_website_url:   website,
        public_instagram_url: instagram,
        public_facebook_url:  facebook,
        public_tiktok_url:    tiktok,
        public_about_html:    about,
        public_wa_pretext:    waPretext,
        business_hours:       hours,
      })
      if (result.success) toast.success('Configuración guardada.')
      else                toast.error(result.error ?? 'Error al guardar.')
    })
  }

  return (
    <form onSubmit={handleSave} className="space-y-6 max-w-2xl">

      {/* Nombre del negocio (read-only, gestionado por ReservaNex) */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Nombre de la inmobiliaria</CardTitle>
          <CardDescription>Gestionado por ReservaNex. Para cambios, contactá al soporte.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm font-medium text-foreground">{settings.name}</p>
        </CardContent>
      </Card>

      {/* Contacto */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <PhoneIcon className="h-4 w-4" />
            Contacto
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="public_phone">Teléfono</Label>
            <Input
              id="public_phone"
              type="tel"
              placeholder="+54 9 11 1234-5678"
              value={phone}
              onChange={e => setPhone(e.target.value)}
              disabled={disabled}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="public_email">Email de contacto</Label>
            <Input
              id="public_email"
              type="email"
              placeholder="hola@tuinmobiliaria.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
              disabled={disabled}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="public_website">Sitio web</Label>
            <Input
              id="public_website"
              type="url"
              placeholder="https://tuinmobiliaria.com"
              value={website}
              onChange={e => setWebsite(e.target.value)}
              disabled={disabled}
            />
          </div>
        </CardContent>
      </Card>

      {/* Redes sociales */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <GlobeIcon className="h-4 w-4" />
            Redes sociales
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="instagram">Instagram</Label>
            <Input
              id="instagram"
              type="url"
              placeholder="https://instagram.com/tuinmobiliaria"
              value={instagram}
              onChange={e => setInstagram(e.target.value)}
              disabled={disabled}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="facebook">Facebook</Label>
            <Input
              id="facebook"
              type="url"
              placeholder="https://facebook.com/tuinmobiliaria"
              value={facebook}
              onChange={e => setFacebook(e.target.value)}
              disabled={disabled}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="tiktok">TikTok</Label>
            <Input
              id="tiktok"
              type="url"
              placeholder="https://tiktok.com/@tuinmobiliaria"
              value={tiktok}
              onChange={e => setTiktok(e.target.value)}
              disabled={disabled}
            />
          </div>
        </CardContent>
      </Card>

      {/* Textos */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <MessageCircleIcon className="h-4 w-4" />
            Textos del negocio
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="about">Quiénes somos</Label>
            <Textarea
              id="about"
              placeholder="Breve descripción de tu inmobiliaria, trayectoria, servicios..."
              value={about}
              onChange={e => setAbout(e.target.value)}
              disabled={disabled}
              rows={5}
              maxLength={5000}
            />
            <p className="text-xs text-muted-foreground">{about.length} / 5000 caracteres</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="wa_pretext">Texto del botón WhatsApp</Label>
            <Input
              id="wa_pretext"
              placeholder="Hola! Me gustaría consultar sobre..."
              value={waPretext}
              onChange={e => setWaPretext(e.target.value)}
              disabled={disabled}
              maxLength={300}
            />
            <p className="text-xs text-muted-foreground">
              Texto pre-cargado cuando el cliente toca el botón de WhatsApp en el sitio público.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Horarios */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ClockIcon className="h-4 w-4" />
            Horarios de atención
          </CardTitle>
          <CardDescription>
            Indicá el horario de cada día o escribí &ldquo;Cerrado&rdquo; si no atendés.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {DAYS.map(d => (
              <div key={d.key} className="flex items-center gap-3">
                <span className="w-24 shrink-0 text-sm text-muted-foreground">{d.label}</span>
                <Input
                  placeholder="9:00 - 18:00"
                  value={hours[d.key] ?? ''}
                  onChange={e => setHours(prev => ({ ...prev, [d.key]: e.target.value }))}
                  disabled={disabled}
                  className="flex-1"
                  maxLength={50}
                />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {!readOnly && (
        <Button type="submit" disabled={isPending}>
          {isPending ? 'Guardando…' : 'Guardar configuración'}
        </Button>
      )}
    </form>
  )
}
