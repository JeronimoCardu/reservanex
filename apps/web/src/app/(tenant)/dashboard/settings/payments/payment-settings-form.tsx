'use client'

import { useState, useTransition }   from 'react'
import { toast }                      from 'sonner'
import { CreditCardIcon, FileTextIcon, InfoIcon } from 'lucide-react'
import { updatePaymentConfigAction }  from '@/actions/tenant-settings'
import type { PaymentConfig }         from '@/actions/tenant-settings'
import { Button }                     from '@/components/ui/button'
import { Input }                      from '@/components/ui/input'
import { Label }                      from '@/components/ui/label'
import { Textarea }                   from '@/components/ui/textarea'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'

const DEFAULT_PAYMENT_REQUEST =
  'Para confirmar tu reserva, por favor enviá el comprobante de transferencia. ' +
  'Podés hacerlo directamente por este chat.'

interface PaymentSettingsFormProps {
  settings: PaymentConfig
}

export function PaymentSettingsForm({ settings }: PaymentSettingsFormProps) {
  const [isPending, startTransition] = useTransition()

  const [alias,       setAlias]       = useState(settings.payment_alias           ?? '')
  const [cbu,         setCbu]         = useState(settings.payment_cbu             ?? '')
  const [holder,      setHolder]      = useState(settings.payment_account_holder  ?? '')
  const [bank,        setBank]        = useState(settings.payment_bank            ?? '')
  const [notes,       setNotes]       = useState(settings.payment_notes           ?? '')
  const [requestMsg,  setRequestMsg]  = useState(settings.payment_request_message ?? DEFAULT_PAYMENT_REQUEST)
  const [footerText,  setFooterText]  = useState(settings.receipt_footer_text     ?? '')
  const [showLogo,    setShowLogo]    = useState(settings.receipt_show_logo       ?? true)

  function handleSave(e: React.FormEvent) {
    e.preventDefault()
    startTransition(async () => {
      const result = await updatePaymentConfigAction({
        payment_alias:           alias,
        payment_cbu:             cbu,
        payment_account_holder:  holder,
        payment_bank:            bank,
        payment_notes:           notes,
        payment_request_message: requestMsg,
        receipt_footer_text:     footerText,
        receipt_show_logo:       showLogo,
      })
      if (result.success) toast.success('Configuración guardada.')
      else                toast.error(result.error ?? 'Error al guardar.')
    })
  }

  return (
    <form onSubmit={handleSave} className="space-y-6 max-w-2xl">

      {/* Datos bancarios */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <CreditCardIcon className="h-4 w-4" />
            Datos de pago
          </CardTitle>
          <CardDescription>
            Estos datos se usarán en acciones rápidas como <strong>Enviar datos de pago</strong> y <strong>Pedir comprobante</strong>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="alias">Alias</Label>
              <Input
                id="alias"
                placeholder="mi.inmobiliaria.mp"
                value={alias}
                onChange={e => setAlias(e.target.value)}
                disabled={isPending}
                maxLength={100}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="cbu">CBU / CVU</Label>
              <Input
                id="cbu"
                placeholder="0000003100012345678901"
                value={cbu}
                onChange={e => setCbu(e.target.value)}
                disabled={isPending}
                maxLength={30}
              />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="holder">Titular de la cuenta</Label>
              <Input
                id="holder"
                placeholder="Nombre Apellido / Razón Social"
                value={holder}
                onChange={e => setHolder(e.target.value)}
                disabled={isPending}
                maxLength={200}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="bank">Banco / Entidad</Label>
              <Input
                id="bank"
                placeholder="Mercado Pago / Banco Galicia"
                value={bank}
                onChange={e => setBank(e.target.value)}
                disabled={isPending}
                maxLength={100}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="notes">Aclaraciones adicionales</Label>
            <Textarea
              id="notes"
              placeholder="Ej: Solo transferencias en pesos. No aceptamos efectivo."
              value={notes}
              onChange={e => setNotes(e.target.value)}
              disabled={isPending}
              rows={3}
              maxLength={1000}
            />
          </div>
        </CardContent>
      </Card>

      {/* Mensajes del bot/CRM */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <InfoIcon className="h-4 w-4" />
            Mensaje para pedir comprobante
          </CardTitle>
          <CardDescription>
            Texto que se envía al cliente cuando se usa la acción <strong>Pedir comprobante</strong> desde el CRM.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <Textarea
              id="request_msg"
              value={requestMsg}
              onChange={e => setRequestMsg(e.target.value)}
              disabled={isPending}
              rows={4}
              maxLength={500}
            />
            <p className="text-xs text-muted-foreground">{requestMsg.length} / 500 caracteres</p>
          </div>
        </CardContent>
      </Card>

      {/* Recibos PDF */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <FileTextIcon className="h-4 w-4" />
            Recibos PDF
          </CardTitle>
          <CardDescription>
            Configuración del pie y logo en los recibos generados por ReservaNex.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="footer_text">Pie del recibo</Label>
            <Textarea
              id="footer_text"
              placeholder="Ej: Este comprobante es válido como recibo oficial. CUIT 20-12345678-9."
              value={footerText}
              onChange={e => setFooterText(e.target.value)}
              disabled={isPending}
              rows={3}
              maxLength={500}
            />
            <p className="text-xs text-muted-foreground">{footerText.length} / 500 caracteres</p>
          </div>
          <label className="flex items-center gap-2.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showLogo}
              onChange={e => setShowLogo(e.target.checked)}
              disabled={isPending}
              className="rounded border"
            />
            <span className="text-sm">Mostrar logo de la inmobiliaria en los recibos</span>
          </label>
        </CardContent>
      </Card>

      <Button type="submit" disabled={isPending}>
        {isPending ? 'Guardando…' : 'Guardar configuración'}
      </Button>
    </form>
  )
}
