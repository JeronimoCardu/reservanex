'use client'

import { useMemo } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import {
  createContactSchema,
  normalizePhoneForWhatsApp,
  isValidARWhatsAppPhone,
} from '@orderflow/validators'
import type { CreateContactInput } from '@orderflow/validators'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input }  from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

interface ContactFormProps {
  defaultValues?: Partial<CreateContactInput>
  onSubmit:       (values: CreateContactInput) => Promise<void>
  isPending:      boolean
  submitLabel?:   string
  onCancel?:      () => void
}

export function ContactForm({
  defaultValues,
  onSubmit,
  isPending,
  submitLabel = 'Guardar',
  onCancel,
}: ContactFormProps) {
  const form = useForm<CreateContactInput>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: zodResolver(createContactSchema) as any,
    defaultValues: {
      name:   '',
      phone:  '',
      email:  '',
      source: 'manual',
      ...defaultValues,
    },
  })

  const phoneValue = form.watch('phone')
  const phonePreview = useMemo(() => {
    if (!phoneValue) return null
    const normalized = normalizePhoneForWhatsApp(phoneValue)
    if (!isValidARWhatsAppPhone(normalized)) return null
    // Only show hint if normalization actually changed the value
    const rawDigits = phoneValue.replace(/\D/g, '')
    if (normalized === rawDigits) return null
    return normalized
  }, [phoneValue])

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">

        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                Nombre <span className="text-destructive">*</span>
              </FormLabel>
              <FormControl>
                <Input placeholder="Juan Pérez" {...field} value={field.value ?? ''} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="phone"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                Teléfono <span className="text-destructive">*</span>
              </FormLabel>
              <FormControl>
                <Input type="tel" placeholder="+54 9 11 1234 5678" {...field} value={field.value ?? ''} />
              </FormControl>
              {phonePreview && (
                <p className="text-xs text-muted-foreground">
                  Se guardará como: <span className="font-mono">{phonePreview}</span>
                </p>
              )}
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                Email <span className="text-muted-foreground text-xs">(opcional)</span>
              </FormLabel>
              <FormControl>
                <Input type="email" placeholder="juan@email.com" {...field} value={field.value ?? ''} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="source"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Origen</FormLabel>
              <Select onValueChange={field.onChange} value={field.value}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value="manual">Manual</SelectItem>
                  <SelectItem value="website">Sitio web</SelectItem>
                  <SelectItem value="whatsapp">WhatsApp</SelectItem>
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="flex justify-end gap-2 pt-2">
          {onCancel && (
            <Button type="button" variant="outline" onClick={onCancel} disabled={isPending}>
              Cancelar
            </Button>
          )}
          <Button type="submit" disabled={isPending}>
            {isPending ? 'Guardando...' : submitLabel}
          </Button>
        </div>
      </form>
    </Form>
  )
}
