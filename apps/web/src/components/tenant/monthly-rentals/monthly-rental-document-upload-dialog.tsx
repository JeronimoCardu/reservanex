'use client'

import { useState, useTransition, useRef } from 'react'
import { UploadIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { uploadMonthlyRentalDocumentAction } from '@/actions/monthly-rentals'

interface Props {
  open:       boolean
  onClose:    () => void
  contractId: string
}

const DOC_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: 'contract',          label: 'Contrato firmado'       },
  { value: 'regulation',        label: 'Reglamento'             },
  { value: 'policy',            label: 'Póliza'                 },
  { value: 'manual',            label: 'Manual / Instructivo'   },
  { value: 'identity_document', label: 'Documento de identidad' },
  { value: 'guarantee',         label: 'Garantía'               },
]

export function MonthlyRentalDocumentUploadDialog({ open, onClose, contractId }: Props) {
  const [isPending, startTrans] = useTransition()
  const [docType,   setDocType] = useState('contract')
  const [notes,     setNotes]   = useState('')
  const [file,      setFile]    = useState<File | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  function reset() {
    setDocType('contract')
    setNotes('')
    setFile(null)
    if (fileRef.current) fileRef.current.value = ''
  }

  function handleClose() {
    reset()
    onClose()
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!file) return

    startTrans(async () => {
      const fd = new FormData()
      fd.set('file',          file)
      fd.set('document_type', docType)
      if (notes.trim()) fd.set('notes', notes.trim())

      const result = await uploadMonthlyRentalDocumentAction(contractId, fd)
      if (result.success) {
        toast.success('Documento subido correctamente.')
        handleClose()
      } else {
        toast.error(result.error ?? 'Error al subir el documento.')
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) handleClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Subir documento</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1">
            <label className="text-xs font-medium">Tipo de documento *</label>
            <Select value={docType} onValueChange={setDocType}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-background border shadow-md">
                {DOC_TYPE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value} className="text-xs">
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium">
              Archivo *{' '}
              <span className="font-normal text-muted-foreground">
                (PDF, imagen o Word · máx. 10 MB)
              </span>
            </label>
            <input
              ref={fileRef}
              type="file"
              accept=".pdf,.jpg,.jpeg,.png,.webp,.doc,.docx"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="w-full cursor-pointer text-xs file:mr-3 file:rounded-md file:border file:border-input file:bg-background file:px-3 file:py-1 file:text-xs file:font-medium hover:file:bg-muted"
              required
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium">Notas <span className="font-normal text-muted-foreground">(opcional)</span></label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Observaciones adicionales..."
              rows={2}
              maxLength={2000}
              className="w-full resize-none rounded-md border bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={handleClose} disabled={isPending}>
              Cancelar
            </Button>
            <Button type="submit" size="sm" disabled={isPending || !file} className="gap-1.5">
              <UploadIcon className="h-3.5 w-3.5" />
              Subir
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
