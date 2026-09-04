'use client'

import { useTransition, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { PlusIcon } from 'lucide-react'
import { createNoteAction } from '@/actions/notes'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'

interface AddNoteDialogProps {
  contactId?:      string
  conversationId?: string
  reservationId?:  string
}

export function AddNoteDialog({ contactId, conversationId, reservationId }: AddNoteDialogProps) {
  const [open, setOpen] = useState(false)
  const [content, setContent] = useState('')
  const [isPending, startTransition] = useTransition()
  const router = useRouter()

  function handleSubmit() {
    if (!content.trim()) return

    startTransition(async () => {
      const result = await createNoteAction({
        content:          content.trim(),
        contact_id:       contactId,
        conversation_id:  conversationId,
        reservation_id:   reservationId,
      })
      if (result.success) {
        toast.success('Nota guardada')
        setContent('')
        setOpen(false)
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <PlusIcon className="mr-2 h-4 w-4" />
          Agregar nota
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nueva nota</DialogTitle>
        </DialogHeader>
        <Textarea
          placeholder="Escribí tu nota aquí..."
          value={content}
          onChange={(e) => setContent(e.target.value)}
          className="min-h-[120px] resize-none"
          disabled={isPending}
        />
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setOpen(false)} disabled={isPending}>
            Cancelar
          </Button>
          <Button onClick={handleSubmit} disabled={isPending || !content.trim()}>
            {isPending ? 'Guardando...' : 'Guardar'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
