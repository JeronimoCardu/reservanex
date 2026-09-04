'use client'

import { useTransition, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Pencil } from 'lucide-react'
import { updateContactAction } from '@/actions/contacts'
import type { ContactRow } from '@orderflow/types'
import type { CreateContactInput } from '@orderflow/validators'
import { ContactForm } from './contact-form'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'

export function EditContactDialog({ contact }: { contact: ContactRow }) {
  const [open, setOpen] = useState(false)
  const [isPending, startTransition] = useTransition()
  const router = useRouter()

  function handleSubmit(values: CreateContactInput) {
    return new Promise<void>((resolve) => {
      startTransition(async () => {
        const result = await updateContactAction(contact.id, values)
        if (result.success) {
          toast.success('Contacto actualizado')
          setOpen(false)
          router.refresh()
        } else {
          toast.error(result.error)
        }
        resolve()
      })
    })
  }

  const defaults: Partial<CreateContactInput> = {
    name:   contact.name   ?? '',
    email:  contact.email  ?? '',
    phone:  contact.phone  ?? '',
    source: contact.source as CreateContactInput['source'],
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon">
          <Pencil className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Editar contacto</DialogTitle>
        </DialogHeader>
        <ContactForm
          key={contact.id}
          defaultValues={defaults}
          onSubmit={handleSubmit}
          isPending={isPending}
          submitLabel="Guardar cambios"
          onCancel={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  )
}
