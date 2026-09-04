'use client'

import { useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Loader2 } from 'lucide-react'
import { createClient } from '@orderflow/supabase/browser'
import { loginSchema, type LoginInput } from '@orderflow/validators'
import { parseAccessTokenClaims } from '@/lib/claims'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Form, FormField, FormItem, FormLabel, FormControl, FormMessage } from '@/components/ui/form'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

// Only ever returns an internal path. `next` is user-controlled (a query
// param), so this is the one thing standing between it and an open
// redirect: reject anything that isn't a same-origin path, including the
// classic `//evil.com` (protocol-relative) and `/\evil.com` (backslash,
// which some browsers normalize to `//`) bypasses.
function getSafeRedirectPath(next: string | null, fallback: string): string {
  if (next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\')) {
    return next
  }
  return fallback
}

export function LoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [serverError, setServerError] = useState<string | null>(null)

  const form = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  })

  async function onSubmit(data: LoginInput) {
    setServerError(null)
    const supabase = createClient()

    const { data: signInData, error } = await supabase.auth.signInWithPassword({
      email: data.email,
      password: data.password,
    })

    if (error) {
      // Supabase returns this message when email confirmation is required
      if (
        error.message === 'Email not confirmed' ||
        error.message.toLowerCase().includes('email not confirmed')
      ) {
        router.push('/auth/confirm-email')
        return
      }

      setServerError(
        error.message === 'Invalid login credentials'
          ? 'Email o contraseña incorrectos'
          : error.message
      )
      return
    }

    // Default landing spot depends on account type — a platform user has no
    // access to /dashboard (requireTenantContext would just bounce them
    // straight back to /login). Everyone else defaults to /dashboard, not
    // "/": "/" is the public marketing site now, not part of the CRM.
    const claims = parseAccessTokenClaims(signInData.session?.access_token)
    const defaultTarget = claims?.user_type === 'platform_user' ? '/platform' : '/dashboard'
    const target = getSafeRedirectPath(searchParams.get('next'), defaultTarget)

    router.push(target)
    router.refresh()
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader className="space-y-1">
        <CardTitle className="text-2xl">Iniciar sesión</CardTitle>
        <CardDescription>Ingresá tu email y contraseña para continuar</CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Email</FormLabel>
                  <FormControl>
                    <Input
                      type="email"
                      placeholder="tu@email.com"
                      autoComplete="email"
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
              name="password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Contraseña</FormLabel>
                  <FormControl>
                    <Input
                      type="password"
                      placeholder="••••••••"
                      autoComplete="current-password"
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
                  Ingresando...
                </>
              ) : (
                'Ingresar'
              )}
            </Button>
          </form>
        </Form>
      </CardContent>
    </Card>
  )
}
