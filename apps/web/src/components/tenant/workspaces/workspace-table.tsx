'use client'

import { useState } from 'react'
import { Plus, Pencil, Archive, Building2 } from 'lucide-react'
import type { WorkspaceRow } from '@orderflow/types'
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
import { CreateWorkspaceDialog } from './create-workspace-dialog'
import { UpdateWorkspaceDialog } from './update-workspace-dialog'
import { ArchiveWorkspaceDialog } from './archive-workspace-dialog'

const WORKSPACE_TYPE_LABELS: Record<string, string> = {
  general: 'General',
  physical_branch: 'Sucursal',
  zone: 'Zona',
  team: 'Equipo',
}

const WORKSPACE_TYPE_VARIANT: Record<string, 'default' | 'secondary' | 'outline'> = {
  general: 'default',
  physical_branch: 'secondary',
  zone: 'outline',
  team: 'outline',
}

interface WorkspaceTableProps {
  workspaces: WorkspaceRow[]
}

export function WorkspaceTable({ workspaces }: WorkspaceTableProps) {
  const [createOpen, setCreateOpen] = useState(false)
  const [updateTarget, setUpdateTarget] = useState<WorkspaceRow | null>(null)
  const [archiveTarget, setArchiveTarget] = useState<WorkspaceRow | null>(null)

  const activeWorkspaces = workspaces.filter((w) => w.active)
  const archivedWorkspaces = workspaces.filter((w) => !w.active)

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Workspaces</h1>
          <p className="text-sm text-muted-foreground">
            {activeWorkspaces.length} activo{activeWorkspaces.length !== 1 ? 's' : ''}
            {archivedWorkspaces.length > 0 &&
              ` · ${archivedWorkspaces.length} archivado${archivedWorkspaces.length !== 1 ? 's' : ''}`}
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="mr-1 h-4 w-4" />
          Nuevo Workspace
        </Button>
      </div>

      {/* Empty state */}
      {workspaces.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-16 text-center">
          <Building2 className="mb-3 h-10 w-10 text-muted-foreground" />
          <p className="text-sm font-medium">No hay workspaces</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Creá el primero para organizar tu equipo.
          </p>
          <Button className="mt-4" size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="mr-1 h-4 w-4" />
            Crear Workspace
          </Button>
        </div>
      )}

      {/* Table */}
      {workspaces.length > 0 && (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nombre</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead>Ciudad</TableHead>
                <TableHead>Teléfono</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead className="w-[120px] text-right">Acciones</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {workspaces.map((workspace) => (
                <TableRow
                  key={workspace.id}
                  className={!workspace.active ? 'opacity-60' : undefined}
                >
                  <TableCell className="font-medium">{workspace.name}</TableCell>
                  <TableCell>
                    <Badge variant={WORKSPACE_TYPE_VARIANT[workspace.type] ?? 'outline'}>
                      {WORKSPACE_TYPE_LABELS[workspace.type] ?? workspace.type}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {workspace.city ?? '—'}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {workspace.phone ?? '—'}
                  </TableCell>
                  <TableCell>
                    <Badge variant={workspace.active ? 'default' : 'secondary'}>
                      {workspace.active ? 'Activo' : 'Archivado'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Editar"
                        onClick={() => setUpdateTarget(workspace)}
                      >
                        <Pencil className="h-4 w-4" />
                        <span className="sr-only">Editar</span>
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        title={
                          workspace.type === 'general'
                            ? 'El workspace General no puede archivarse'
                            : !workspace.active
                              ? 'Ya archivado'
                              : 'Archivar'
                        }
                        disabled={workspace.type === 'general' || !workspace.active}
                        onClick={() => setArchiveTarget(workspace)}
                        className="text-muted-foreground hover:text-destructive"
                      >
                        <Archive className="h-4 w-4" />
                        <span className="sr-only">Archivar</span>
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
      <CreateWorkspaceDialog open={createOpen} onOpenChange={setCreateOpen} />

      <UpdateWorkspaceDialog
        workspace={updateTarget}
        open={!!updateTarget}
        onOpenChange={(open) => {
          if (!open) setUpdateTarget(null)
        }}
      />

      <ArchiveWorkspaceDialog
        workspace={archiveTarget}
        open={!!archiveTarget}
        onOpenChange={(open) => {
          if (!open) setArchiveTarget(null)
        }}
      />
    </div>
  )
}
