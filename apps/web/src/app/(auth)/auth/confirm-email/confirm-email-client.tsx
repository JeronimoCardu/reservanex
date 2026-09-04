'use client'

import { use, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { MailCheck, RefreshCw, LinkIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { resendConfirmationEmailAction } from '@/actions/auth'
import { toast } from 'sonner'

interface Props {
  searchParams: Promise<{ error?: string }>
}

export function ConfirmEmailClient({ searchParams }: Props) {
  const { error } = use(searchParams)
  const router = useRouter()
  const [isPendingResend, startResend] = useTransition()
  const [isPendingRetry, startRetry] = useTransition()

  const [resent, setResent] = useState(false)

  const isExpiredLink = error === 'invalid_link'

  function handleResend() {
    startResend(async () => {
      const result = await resendConfirmationEmailAction()
      if (result.success) {
        setResent(true)
        toast.success('Email de confirmación reenviado.')
      } else {
        toast.error(result.error ?? 'No se pudo reenviar el email.')
      }
    })
  }

  function handleRetry() {
    startRetry(() => {
      router.push('/')
      router.refresh()
    })
  }

  // Expired/invalid link: user has no session — show a different state
  if (isExpiredLink) {
    return (
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-1 text-center">
          <div className="flex justify-center mb-2">
            <LinkIcon className="h-10 w-10 text-muted-foreground" />
          </div>
          <CardTitle className="text-2xl">El enlace venció</CardTitle>
          <CardDescription>
            Este link de invitación ya no es válido. Los links expiran luego de 24 horas.
            Pedile al administrador que te reenvíe el acceso desde el panel de usuarios.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            variant="outline"
            className="w-full"
            onClick={() => router.push('/login')}
          >
            Ir al login
          </Button>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader className="space-y-1 text-center">
        <div className="flex justify-center mb-2">
          <MailCheck className="h-10 w-10 text-muted-foreground" />
        </div>
        <CardTitle className="text-2xl">Confirmá tu email</CardTitle>
        <CardDescription>
          Te enviamos un correo de confirmación. Abrilo para activar tu cuenta.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!resent ? (
          <Button
            variant="outline"
            className="w-full"
            onClick={handleResend}
            disabled={isPendingResend}
          >
            {isPendingResend ? (
              <>
                <RefreshCw className="animate-spin" />
                Reenviando...
              </>
            ) : (
              'Reenviar email de confirmación'
            )}
          </Button>
        ) : (
          <p className="text-center text-sm text-muted-foreground">
            Email reenviado. Revisá tu bandeja de entrada.
          </p>
        )}

        <Button className="w-full" onClick={handleRetry} disabled={isPendingRetry}>
          Ya confirmé, volver a intentar
        </Button>
      </CardContent>
    </Card>
  )
}
