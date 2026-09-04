'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Send } from 'lucide-react'
import { resendSellerInviteAction } from '@/actions/platform'

type Props = {
  sellerId: string
  email:    string
}

export function ResendSellerButton({ sellerId, email }: Props) {
  const [isPending, startTransition] = useTransition()
  const router = useRouter()

  function handleClick() {
    startTransition(async () => {
      const res = await resendSellerInviteAction(sellerId)
      if (res.success) {
        if ('warning' in res && res.warning) {
          toast.warning(res.warning, { duration: 10000 })
        } else {
          toast.success(`Invitación reenviada a ${email}.`)
        }
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
      title="Reenviar invitación"
      className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-muted disabled:opacity-50"
    >
      <Send className="h-3 w-3" />
      {isPending ? '...' : 'Reenviar'}
    </button>
  )
}
