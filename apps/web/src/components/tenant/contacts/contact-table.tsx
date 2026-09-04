'use client'

import { useState } from 'react'
import Link from 'next/link'
import type { ContactRow, TenantRole } from '@orderflow/types'
import { ContactSourceBadge } from './contact-source-badge'
import { CreateContactDialog } from './create-contact-dialog'
import { EditContactDialog } from './edit-contact-dialog'
import { ArchiveContactDialog } from './archive-contact-dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { ExternalLinkIcon, ArchiveIcon } from 'lucide-react'

interface ContactTableProps {
  contacts:    ContactRow[]
  currentRole: TenantRole
}

export function ContactTable({ contacts, currentRole }: ContactTableProps) {
  const [search, setSearch] = useState('')

  const filtered = contacts.filter((c) => {
    if (!search) return true
    const q = search.toLowerCase()
    return (
      c.name?.toLowerCase().includes(q) ||
      c.email?.toLowerCase().includes(q) ||
      c.phone?.toLowerCase().includes(q)
    )
  })

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <Input
          placeholder="Buscar por nombre, email o teléfono..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-sm"
        />
        <CreateContactDialog />
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nombre</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Teléfono</TableHead>
              <TableHead>Origen</TableHead>
              <TableHead className="w-[100px]">Acciones</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                  No hay contactos
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((contact) => (
                <TableRow key={contact.id}>
                  <TableCell className="font-medium">
                    {contact.name ?? <span className="text-muted-foreground italic">Sin nombre</span>}
                  </TableCell>
                  <TableCell>{contact.email ?? '—'}</TableCell>
                  <TableCell>{contact.phone ?? '—'}</TableCell>
                  <TableCell>
                    <ContactSourceBadge source={contact.source} />
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <Button variant="ghost" size="icon" asChild>
                        <Link href={`/dashboard/contacts/${contact.id}`}>
                          <ExternalLinkIcon className="h-4 w-4" />
                        </Link>
                      </Button>
                      <EditContactDialog contact={contact} />
                      {currentRole === 'owner' ? (
                        <ArchiveContactDialog contact={contact} />
                      ) : (
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span>
                                <Button variant="ghost" size="icon" disabled className="cursor-not-allowed opacity-40">
                                  <ArchiveIcon className="h-4 w-4" />
                                </Button>
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>Solo los owners pueden archivar</TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

