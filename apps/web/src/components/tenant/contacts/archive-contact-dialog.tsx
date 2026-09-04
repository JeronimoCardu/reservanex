'use client'

import { useTransition, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { ArchiveIcon } from 'lucide-react'
import { archiveContactAction } from '@/actions/contacts'
import type { ContactRow } from '@orderflow/types'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'

export function ArchiveContactDialog({
  contact,
  redirectAfter = false,
}: {
  contact: ContactRow
  redirectAfter?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [isPending, startTransition] = useTransition()
  const router = useRouter()

  function handleConfirm() {
    startTransition(async () => {
      const result = await archiveContactAction(contact.id)
      if (result.success) {
        toast.success(`Contacto "${contact.name ?? contact.email ?? 'sin nombre'}" archivado`)
        setOpen(false)
        if (redirectAfter) {
          router.push('/dashboard/contacts')
        } else {
          router.refresh()
        }
      } else {
        toast.error(result.error)
        // Keep dialog open so user can read blocking reason
      }
    })
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="icon" className="text-destructive hover:text-destructive">
          <ArchiveIcon className="h-4 w-4" />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <ArchiveIcon className="h-5 w-5 text-destructive" />
            Archivar contacto
          </AlertDialogTitle>
          <AlertDialogDescription>
            ¿Archivás a{' '}
            <span className="font-medium text-foreground">
              &quot;{contact.name ?? contact.email ?? contact.phone ?? 'este contacto'}&quot;
            </span>
            ? El contacto dejará de aparecer en el CRM.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancelar</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            disabled={isPending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {isPending ? 'Archivando...' : 'Archivar'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
