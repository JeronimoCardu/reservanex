'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { toggleSellerActiveAction } from '@/actions/platform'

type Props = {
  sellerId: string
  active:   boolean
  name:     string
}

export function ToggleSellerButton({ sellerId, active, name }: Props) {
  const [isPending, startTransition] = useTransition()
  const router = useRouter()

  function handleClick() {
    startTransition(async () => {
      const res = await toggleSellerActiveAction(sellerId, !active)
      if (res.success) {
        toast.success(`${name} ${!active ? 'activado' : 'desactivado'}.`)
        router.refresh()
      } else {
        toast.error(res.error)
      }
    })
  }

  return (
    <button
      onClick={handleClick}
      disabled={isPending}
      className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
        active
          ? 'border-destructive/40 text-destructive hover:bg-destructive/10'
          : 'border-green-500/40 text-green-700 hover:bg-green-50 dark:text-green-400 dark:hover:bg-green-900/20'
      }`}
    >
      {isPending ? '...' : active ? 'Desactivar' : 'Activar'}
    </button>
  )
}
