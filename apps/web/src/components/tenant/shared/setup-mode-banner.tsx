'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { endSetupImpersonationAction } from '@/actions/platform'

interface SetupModeBannerProps {
  tenantName: string
}

export function SetupModeBanner({ tenantName }: SetupModeBannerProps) {
  const router = useRouter()
  const [isPending, startTx] = useTransition()

  function handleExit() {
    startTx(async () => {
      const res = await endSetupImpersonationAction()
      if (res.success) {
        router.push('/platform/setup')
      } else {
        toast.error(res.error)
      }
    })
  }

  return (
    <div className="flex shrink-0 items-center justify-between gap-3 border-b bg-amber-50 px-4 py-2 dark:bg-amber-950/30">
      <div className="flex items-center gap-2 text-sm">
        <span className="inline-flex h-2 w-2 rounded-full bg-amber-500" />
        <span className="font-medium text-amber-900 dark:text-amber-300">
          Modo setup activo
        </span>
        <span className="text-amber-700 dark:text-amber-400">
          — estás configurando el CRM de{' '}
          <strong>{tenantName}</strong> como equipo ReservaNex.
        </span>
      </div>
      <button
        disabled={isPending}
        onClick={handleExit}
        className="shrink-0 rounded-md border border-amber-300 bg-amber-100 px-3 py-1 text-xs font-medium text-amber-800 hover:bg-amber-200 disabled:opacity-50 dark:border-amber-700 dark:bg-amber-900/40 dark:text-amber-300 dark:hover:bg-amber-900/60"
      >
        {isPending ? 'Saliendo…' : 'Salir del modo setup'}
      </button>
    </div>
  )
}
