'use client'

import { useState, useTransition } from 'react'
import { CalendarIcon, PlusIcon } from 'lucide-react'
import { toast } from 'sonner'
import { createReservationAction } from '@/actions/reservations'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'

type ConversationProperty = {
  id:             string
  title:          string
  city:           string | null
  operation_type: string | null
}

type ConversationUnit = {
  id:   string
  name: string
}

interface CreateReservationDialogProps {
  conversationId: string
  contactId:      string
  property?:      ConversationProperty | null
  unit?:          ConversationUnit     | null
}

export function CreateReservationDialog({
  conversationId,
  contactId,
  property,
  unit,
}: CreateReservationDialogProps) {
  const [open, setOpen]              = useState(false)
  const [isPending, startTransition] = useTransition()
  const [startDate, setStartDate]    = useState('')
  const [endDate, setEndDate]        = useState('')
  const [guests, setGuests]          = useState('1')
  const [totalAmount, setTotalAmount] = useState('')
  const [status, setStatus]          = useState<'inquiry' | 'interested' | 'confirmed'>('inquiry')
  const [notes, setNotes]            = useState('')

  function resetForm() {
    setStartDate('')
    setEndDate('')
    setGuests('1')
    setTotalAmount('')
    setStatus('inquiry')
    setNotes('')
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!property) {
      toast.error('Primero asociá una propiedad a la conversación.')
      return
    }
    if (property.operation_type !== 'temporary_rental') {
      toast.error('Solo se pueden crear reservas para propiedades de alquiler temporario.')
      return
    }
    startTransition(async () => {
      const result = await createReservationAction({
        conversation_id: conversationId,
        contact_id:      contactId,
        property_id:     property.id,
        unit_id:         unit?.id ?? null,
        start_date:      startDate,
        end_date:        endDate,
        guests:          parseInt(guests, 10),
        total_amount:    totalAmount ? parseFloat(totalAmount) : null,
        currency:        'ARS',
        status,
        notes:           notes || null,
      })
      if (result.success) {
        toast.success('Reserva creada.')
        resetForm()
        setOpen(false)
      } else {
        toast.error(result.error)
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs">
          <PlusIcon className="h-3 w-3" />
          Nueva reserva
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Nueva reserva</DialogTitle>
        </DialogHeader>

        {!property && (
          <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/30 dark:border-amber-800 dark:text-amber-300">
            Asociá una propiedad a la conversación antes de crear una reserva.
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Property info (read-only) */}
          <div className="rounded-md bg-muted/50 border px-3 py-2.5 space-y-0.5">
            <p className="text-xs text-muted-foreground font-medium">Propiedad</p>
            <p className="text-sm font-medium">
              {property ? property.title : <span className="text-muted-foreground italic">Sin propiedad asociada</span>}
            </p>
            {property?.city && <p className="text-xs text-muted-foreground">{property.city}</p>}
            {unit && <p className="text-xs text-muted-foreground">Unidad: {unit.name}</p>}
          </div>

          {/* Dates */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="start_date" className="text-xs">Fecha inicio *</Label>
              <div className="relative">
                <CalendarIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  id="start_date"
                  type="date"
                  required
                  value={startDate}
                  onChange={e => setStartDate(e.target.value)}
                  className="pl-8 text-sm"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="end_date" className="text-xs">Fecha fin *</Label>
              <div className="relative">
                <CalendarIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  id="end_date"
                  type="date"
                  required
                  value={endDate}
                  min={startDate || undefined}
                  onChange={e => setEndDate(e.target.value)}
                  className="pl-8 text-sm"
                />
              </div>
            </div>
          </div>

          {/* Guests + amount */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="guests" className="text-xs">Personas *</Label>
              <Input
                id="guests"
                type="number"
                min="1"
                required
                value={guests}
                onChange={e => setGuests(e.target.value)}
                className="text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="total_amount" className="text-xs">Precio total (ARS)</Label>
              <Input
                id="total_amount"
                type="number"
                min="0"
                step="0.01"
                placeholder="0.00"
                value={totalAmount}
                onChange={e => setTotalAmount(e.target.value)}
                className="text-sm"
              />
            </div>
          </div>

          {/* Status */}
          <div className="space-y-1.5">
            <Label className="text-xs">Estado inicial</Label>
            <Select value={status} onValueChange={v => setStatus(v as typeof status)}>
              <SelectTrigger className="text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-background border shadow-md">
                <SelectItem value="inquiry">Consulta</SelectItem>
                <SelectItem value="interested">Interesado</SelectItem>
                <SelectItem value="confirmed">Confirmada</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Notes */}
          <div className="space-y-1.5">
            <Label htmlFor="notes" className="text-xs">Notas</Label>
            <Textarea
              id="notes"
              placeholder="Observaciones, requisitos especiales..."
              value={notes}
              onChange={e => setNotes(e.target.value)}
              className="text-sm resize-none"
              rows={2}
            />
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={isPending || !property}
            >
              {isPending ? 'Creando…' : 'Crear reserva'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
