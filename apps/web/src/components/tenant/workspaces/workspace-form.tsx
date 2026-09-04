'use client'

import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { createWorkspaceSchema, type CreateWorkspaceInput } from '@orderflow/validators'
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

const WORKSPACE_TYPE_LABELS: Record<string, string> = {
  general: 'General',
  physical_branch: 'Sucursal física',
  zone: 'Zona',
  team: 'Equipo',
}

type FormValues = {
  name: string
  type: 'general' | 'physical_branch' | 'zone' | 'team'
  city: string
  address: string
  phone: string
  email: string
}

interface WorkspaceFormProps {
  defaultValues?: Partial<FormValues>
  onSubmit: (values: CreateWorkspaceInput) => Promise<void>
  isPending: boolean
  submitLabel?: string
  onCancel?: () => void
}

export function WorkspaceForm({
  defaultValues,
  onSubmit,
  isPending,
  submitLabel = 'Guardar',
  onCancel,
}: WorkspaceFormProps) {
  const form = useForm<FormValues>({
    resolver: zodResolver(createWorkspaceSchema),
    defaultValues: {
      name: '',
      type: 'general',
      city: '',
      address: '',
      phone: '',
      email: '',
      ...defaultValues,
    },
  })

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Nombre *</FormLabel>
              <FormControl>
                <Input placeholder="Ej: Sucursal Centro" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="type"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Tipo *</FormLabel>
              <Select onValueChange={field.onChange} value={field.value}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder="Seleccioná un tipo" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {Object.entries(WORKSPACE_TYPE_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="city"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Ciudad</FormLabel>
                <FormControl>
                  <Input placeholder="Buenos Aires" {...field} />
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
                <FormLabel>Teléfono</FormLabel>
                <FormControl>
                  <Input placeholder="+54 11 1234-5678" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={form.control}
          name="address"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Dirección</FormLabel>
              <FormControl>
                <Input placeholder="Av. Corrientes 1234, CABA" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Email</FormLabel>
              <FormControl>
                <Input type="email" placeholder="workspace@empresa.com" {...field} />
              </FormControl>
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
