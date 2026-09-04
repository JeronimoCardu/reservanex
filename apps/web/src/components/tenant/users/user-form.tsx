'use client'

import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { createTenantUserSchema, updateTenantUserSchema } from '@orderflow/validators'
import type { WorkspaceRow } from '@orderflow/types'
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

// ─── Create User Form ────────────────────────────────────────────────────────

type CreateFormValues = {
  name: string
  email: string
  role: 'owner' | 'receptionist'
  workspaceIds: string[]
}

interface CreateUserFormProps {
  workspaces: WorkspaceRow[]
  onSubmit: (values: CreateFormValues) => Promise<void>
  isPending: boolean
  onCancel?: () => void
}

export function CreateUserForm({
  workspaces,
  onSubmit,
  isPending,
  onCancel,
}: CreateUserFormProps) {
  const form = useForm<CreateFormValues>({
    resolver: zodResolver(createTenantUserSchema),
    defaultValues: {
      name: '',
      email: '',
      role: 'receptionist',
      workspaceIds: [],
    },
  })

  const role = form.watch('role')
  const activeWorkspaces = workspaces.filter((w) => w.active)

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
                <Input placeholder="Juan Pérez" {...field} />
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
              <FormLabel>Email *</FormLabel>
              <FormControl>
                <Input type="email" placeholder="juan@empresa.com" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="role"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Rol *</FormLabel>
              <Select onValueChange={field.onChange} value={field.value}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder="Seleccioná un rol" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value="receptionist">Recepcionista</SelectItem>
                  <SelectItem value="owner">Owner</SelectItem>
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />

        {role === 'receptionist' && (
          <FormItem>
            <FormLabel>Workspaces asignados</FormLabel>
            {activeWorkspaces.length === 0 ? (
              <p className="text-sm text-muted-foreground rounded-md border px-3 py-2">
                No hay workspaces activos. Podés asignarlos después desde la tabla.
              </p>
            ) : (
              <FormField
                control={form.control}
                name="workspaceIds"
                render={({ field }) => (
                  <FormItem>
                    <div className="max-h-40 overflow-y-auto rounded-md border p-3 space-y-2">
                      {activeWorkspaces.map((w) => (
                        <label
                          key={w.id}
                          className="flex items-center gap-2 text-sm cursor-pointer select-none"
                        >
                          <input
                            type="checkbox"
                            checked={(field.value ?? []).includes(w.id)}
                            onChange={(e) => {
                              const current = field.value ?? []
                              if (e.target.checked) {
                                field.onChange([...current, w.id])
                              } else {
                                field.onChange(current.filter((id) => id !== w.id))
                              }
                            }}
                            className="h-4 w-4 rounded border-gray-300"
                          />
                          <span>{w.name}</span>
                        </label>
                      ))}
                    </div>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
          </FormItem>
        )}

        <div className="flex justify-end gap-2 pt-2">
          {onCancel && (
            <Button type="button" variant="outline" onClick={onCancel} disabled={isPending}>
              Cancelar
            </Button>
          )}
          <Button type="submit" disabled={isPending}>
            {isPending ? 'Enviando invitación...' : 'Enviar invitación'}
          </Button>
        </div>
      </form>
    </Form>
  )
}

// ─── Edit User Form ───────────────────────────────────────────────────────────

type EditFormValues = {
  name: string
  role: 'owner' | 'receptionist'
}

interface EditUserFormProps {
  defaultValues: EditFormValues
  onSubmit: (values: EditFormValues) => Promise<void>
  isPending: boolean
  onCancel?: () => void
}

export function EditUserForm({
  defaultValues,
  onSubmit,
  isPending,
  onCancel,
}: EditUserFormProps) {
  const form = useForm<EditFormValues>({
    resolver: zodResolver(updateTenantUserSchema),
    defaultValues,
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
                <Input {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="role"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Rol *</FormLabel>
              <Select onValueChange={field.onChange} value={field.value}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value="receptionist">Recepcionista</SelectItem>
                  <SelectItem value="owner">Owner</SelectItem>
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
            {isPending ? 'Guardando...' : 'Guardar cambios'}
          </Button>
        </div>
      </form>
    </Form>
  )
}
