'use client'

import { useState, useTransition, useRef } from 'react'
import { UploadIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { uploadMonthlyRentalPaymentProofAction } from '@/actions/monthly-rentals'

interface Props {
  open:      boolean
  onClose:   () => void
  paymentId: string | null
}

export function PaymentProofUploadDialog({ open, onClose, paymentId }: Props) {
  const [isPending, startTrans] = useTransition()
  const [file,      setFile]    = useState<File | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  function reset() {
    setFile(null)
    if (fileRef.current) fileRef.current.value = ''
  }

  function handleClose() {
    reset()
    onClose()
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!file || !paymentId) return

    startTrans(async () => {
      const fd = new FormData()
      fd.set('file', file)

      const result = await uploadMonthlyRentalPaymentProofAction(paymentId, fd)
      if (result.success) {
        toast.success('Comprobante subido correctamente.')
        handleClose()
      } else {
        toast.error(result.error ?? 'Error al subir el comprobante.')
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) handleClose() }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Subir comprobante de pago</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1">
            <label className="text-xs font-medium">
              Archivo *{' '}
              <span className="font-normal text-muted-foreground">
                (PDF o imagen · máx. 10 MB)
              </span>
            </label>
            <input
              ref={fileRef}
              type="file"
              accept=".pdf,.jpg,.jpeg,.png,.webp"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="w-full cursor-pointer text-xs file:mr-3 file:rounded-md file:border file:border-input file:bg-background file:px-3 file:py-1 file:text-xs file:font-medium hover:file:bg-muted"
              required
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={handleClose} disabled={isPending}>
              Cancelar
            </Button>
            <Button type="submit" size="sm" disabled={isPending || !file} className="gap-1.5">
              <UploadIcon className="h-3.5 w-3.5" />
              Subir comprobante
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
