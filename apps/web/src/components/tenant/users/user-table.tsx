'use client'

import { useState } from 'react'
import { Plus, Pencil, UserX, Users, ShieldCheck, Send } from 'lucide-react'
import { toast } from 'sonner'
import type { TenantUserWithWorkspaceIds } from '@/lib/repositories/users.repository'
import { resendUserAccessAction } from '@/actions/users'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { CreateUserDialog } from './create-user-dialog'
import { EditUserDialog } from './edit-user-dialog'
import { DeactivateUserDialog } from './deactivate-user-dialog'
import { ReceptionistPermissionsDialog } from './receptionist-permissions-dialog'

const ROLE_LABELS: Record<string, string> = {
  owner: 'Owner',
  receptionist: 'Recepcionista',
}

const ROLE_VARIANT: Record<string, 'default' | 'secondary'> = {
  owner: 'default',
  receptionist: 'secondary',
}

interface UserTableProps {
  users: TenantUserWithWorkspaceIds[]
  currentUserId: string
}

export function UserTable({ users, currentUserId }: UserTableProps) {
  const [createOpen, setCreateOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<TenantUserWithWorkspaceIds | null>(null)
  const [deactivateTarget, setDeactivateTarget] = useState<TenantUserWithWorkspaceIds | null>(null)
  const [permissionsTarget, setPermissionsTarget] = useState<TenantUserWithWorkspaceIds | null>(null)
  const [resendPending, setResendPending] = useState<string | null>(null)

  async function handleResendAccess(user: TenantUserWithWorkspaceIds) {
    setResendPending(user.id)
    const result = await resendUserAccessAction(user.id)
    setResendPending(null)
    if (result.success) {
      if ('warning' in result && result.warning) {
        toast.warning(result.warning, { duration: 8000 })
      } else {
        toast.success(`Email enviado a ${user.email}.`)
      }
    } else {
      toast.error(result.error ?? 'No se pudo enviar el email.')
    }
  }

  return (
    <div className="space-y-6">
      {/* Table action bar */}
      <div className="flex justify-end">
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="mr-1 h-4 w-4" />
          Nuevo Usuario
        </Button>
      </div>

      {/* Empty state */}
      {users.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-16 text-center">
          <Users className="mb-3 h-10 w-10 text-muted-foreground" />
          <p className="text-sm font-medium">No hay usuarios</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Creá el primero para gestionar tu equipo.
          </p>
          <Button className="mt-4" size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="mr-1 h-4 w-4" />
            Crear Usuario
          </Button>
        </div>
      )}

      {/* Table */}
      {users.length > 0 && (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nombre</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Rol</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead className="w-[100px] text-right">Acciones</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((user) => (
                <TableRow
                  key={user.id}
                  className={!user.active ? 'opacity-60' : undefined}
                >
                  <TableCell className="font-medium">
                    {user.name}
                    {user.id === currentUserId && (
                      <span className="ml-2 text-xs text-muted-foreground">(vos)</span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{user.email}</TableCell>
                  <TableCell>
                    <Badge variant={ROLE_VARIANT[user.role] ?? 'secondary'}>
                      {ROLE_LABELS[user.role] ?? user.role}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={user.active ? 'default' : 'secondary'}>
                      {user.active ? 'Activo' : 'Inactivo'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      {/* Permissions (receptionists only) */}
                      {user.role === 'receptionist' && (
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Editar permisos"
                          onClick={() => setPermissionsTarget(user)}
                        >
                          <ShieldCheck className="h-4 w-4" />
                          <span className="sr-only">Permisos</span>
                        </Button>
                      )}

                      {/* Resend access (other active users only) */}
                      {user.id !== currentUserId && user.active && (
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Reenviar acceso por email"
                          disabled={resendPending === user.id}
                          onClick={() => handleResendAccess(user)}
                        >
                          <Send className="h-4 w-4" />
                          <span className="sr-only">Reenviar acceso</span>
                        </Button>
                      )}

                      {/* Edit */}
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Editar"
                        onClick={() => setEditTarget(user)}
                      >
                        <Pencil className="h-4 w-4" />
                        <span className="sr-only">Editar</span>
                      </Button>

                      {/* Deactivate */}
                      <Button
                        variant="ghost"
                        size="icon"
                        title={
                          user.id === currentUserId
                            ? 'No podés desactivarte a vos mismo'
                            : !user.active
                              ? 'Ya inactivo'
                              : 'Desactivar'
                        }
                        disabled={user.id === currentUserId || !user.active}
                        onClick={() => setDeactivateTarget(user)}
                        className="text-muted-foreground hover:text-destructive"
                      >
                        <UserX className="h-4 w-4" />
                        <span className="sr-only">Desactivar</span>
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Dialogs */}
      <CreateUserDialog
        workspaces={[]}
        open={createOpen}
        onOpenChange={setCreateOpen}
      />

      <EditUserDialog
        user={editTarget}
        open={!!editTarget}
        onOpenChange={(open) => {
          if (!open) setEditTarget(null)
        }}
      />

      <DeactivateUserDialog
        user={deactivateTarget}
        open={!!deactivateTarget}
        onOpenChange={(open) => {
          if (!open) setDeactivateTarget(null)
        }}
      />

      <ReceptionistPermissionsDialog
        user={permissionsTarget}
        open={!!permissionsTarget}
        onOpenChange={(open) => {
          if (!open) setPermissionsTarget(null)
        }}
      />
    </div>
  )
}
