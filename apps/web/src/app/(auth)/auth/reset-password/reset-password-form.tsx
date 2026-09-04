'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { zodResolver } from '@hookform/resolvers/zod'
import { Loader2, KeyRound } from 'lucide-react'
import { createClient } from '@orderflow/supabase/browser'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

const schema = z
  .object({
    password:        z.string().min(8, 'Mínimo 8 caracteres').max(72, 'Máximo 72 caracteres'),
    passwordConfirm: z.string(),
  })
  .refine((d) => d.password === d.passwordConfirm, {
    message: 'Las contraseñas no coinciden',
    path: ['passwordConfirm'],
  })

type FormValues = z.infer<typeof schema>

export function ResetPasswordForm() {
  const router = useRouter()
  const [serverError, setServerError] = useState<string | null>(null)

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { password: '', passwordConfirm: '' },
  })

  async function onSubmit(data: FormValues) {
    setServerError(null)
    const supabase = createClient()

    const { error } = await supabase.auth.updateUser({ password: data.password })

    if (error) {
      setServerError('No se pudo actualizar la contraseña. El link puede haber expirado.')
      return
    }

    router.push('/dashboard')
    router.refresh()
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader className="space-y-1 text-center">
        <div className="flex justify-center mb-2">
          <KeyRound className="h-10 w-10 text-muted-foreground" />
        </div>
        <CardTitle className="text-2xl">Crear nueva contraseña</CardTitle>
        <CardDescription>
          Elegí una contraseña segura para acceder a ReservaNex.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Nueva contraseña</FormLabel>
                  <FormControl>
                    <Input
                      type="password"
                      placeholder="Mínimo 8 caracteres"
                      autoComplete="new-password"
                      disabled={form.formState.isSubmitting}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="passwordConfirm"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Confirmá tu contraseña</FormLabel>
                  <FormControl>
                    <Input
                      type="password"
                      placeholder="Repetí la contraseña"
                      autoComplete="new-password"
                      disabled={form.formState.isSubmitting}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {serverError && (
              <p className="text-sm font-medium text-destructive">{serverError}</p>
            )}

            <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting ? (
                <>
                  <Loader2 className="animate-spin" />
                  Guardando...
                </>
              ) : (
                'Guardar contraseña'
              )}
            </Button>
          </form>
        </Form>
      </CardContent>
    </Card>
  )
}
