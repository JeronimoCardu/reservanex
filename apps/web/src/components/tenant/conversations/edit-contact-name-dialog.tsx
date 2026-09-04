'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { PencilIcon } from 'lucide-react'
import { updateContactAction } from '@/actions/contacts'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogTrigger,
} from '@/components/ui/dialog'

interface EditContactNameDialogProps {
  contactId:   string
  currentName: string | null
  phone:       string | null
}

export function EditContactNameDialog({
  contactId,
  currentName,
  phone,
}: EditContactNameDialogProps) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(currentName ?? '')
  const [isPending, startTransition] = useTransition()

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return

    startTransition(async () => {
      const result = await updateContactAction(contactId, { name: trimmed })
      if (result.success) {
        toast.success('Contacto actualizado')
        setOpen(false)
        router.refresh()
      } else {
        toast.error(result.error ?? 'Error al guardar')
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={(v) => {
      setOpen(v)
      if (v) setName(currentName ?? '')
    }}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
        >
          <PencilIcon className="h-3 w-3" />
          {currentName ? 'Editar contacto' : 'Guardar nombre'}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[360px]">
        <DialogHeader>
          <DialogTitle>Editar contacto</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 pt-1">
          <div className="space-y-1.5">
            <Label htmlFor="edit-contact-name">Nombre</Label>
            <Input
              id="edit-contact-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Nombre del contacto"
              autoFocus
            />
          </div>
          {phone && (
            <div className="space-y-1.5">
              <Label>Teléfono</Label>
              <Input
                value={phone}
                readOnly
                className="bg-muted/50 font-mono text-muted-foreground"
              />
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={isPending || !name.trim()}>
              {isPending ? 'Guardando…' : 'Guardar'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
