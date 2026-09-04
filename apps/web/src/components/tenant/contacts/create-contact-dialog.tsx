'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { PlusIcon } from 'lucide-react'
import { createContactAction } from '@/actions/contacts'
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
import { useState } from 'react'

export function CreateContactDialog() {
  const [open, setOpen] = useState(false)
  const [isPending, startTransition] = useTransition()
  const router = useRouter()

  function handleSubmit(values: CreateContactInput) {
    return new Promise<void>((resolve) => {
      startTransition(async () => {
        const result = await createContactAction(values)
        if (result.success) {
          toast.success('Contacto creado')
          setOpen(false)
          router.refresh()
        } else {
          toast.error(result.error)
        }
        resolve()
      })
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <PlusIcon className="mr-2 h-4 w-4" />
          Nuevo contacto
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nuevo contacto</DialogTitle>
        </DialogHeader>
        <ContactForm
          onSubmit={handleSubmit}
          isPending={isPending}
          onCancel={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  )
}
