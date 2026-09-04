'use client'

import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { createUnitSchema } from '@orderflow/validators'
import type { CreateUnitInput } from '@orderflow/validators'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

const CURRENCIES = ['ARS', 'USD', 'EUR', 'BRL'] as const

type FormValues = {
  name:     string
  capacity: string
  price:    string
  currency: 'ARS' | 'USD' | 'EUR' | 'BRL'
}

function toUnitInput(values: FormValues): CreateUnitInput {
  return {
    name:     values.name,
    capacity: Number(values.capacity),
    price:    values.price ? Number(values.price) : undefined,
    currency: values.currency,
  }
}

interface UnitFormProps {
  defaultValues?: Partial<FormValues>
  onSubmit:       (values: CreateUnitInput) => Promise<void>
  isPending:      boolean
  submitLabel?:   string
  onCancel?:      () => void
}

export function UnitForm({
  defaultValues,
  onSubmit,
  isPending,
  submitLabel = 'Guardar',
  onCancel,
}: UnitFormProps) {
  const form = useForm<FormValues>({
    resolver: zodResolver(createUnitSchema),
    defaultValues: {
      name:     '',
      capacity: '',
      price:    '',
      currency: 'ARS',
      ...defaultValues,
    },
  })

  function handleSubmit(values: FormValues) {
    return onSubmit(toUnitInput(values))
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Nombre *</FormLabel>
              <FormControl>
                <Input placeholder="Ej: Habitación 101" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="capacity"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Capacidad (personas) *</FormLabel>
              <FormControl>
                <Input type="number" min={1} max={999} placeholder="2" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="price"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Precio</FormLabel>
                <FormControl>
                  <Input type="number" min={0} placeholder="0.00" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="currency"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Moneda</FormLabel>
                <Select onValueChange={field.onChange} value={field.value}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {CURRENCIES.map((c) => (
                      <SelectItem key={c} value={c}>{c}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

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
