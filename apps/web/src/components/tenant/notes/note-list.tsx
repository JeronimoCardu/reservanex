'use client'

import { format } from 'date-fns'
import { es } from 'date-fns/locale'
import { StickyNoteIcon } from 'lucide-react'
import type { NoteWithAuthor } from '@/lib/repositories/notes.repository'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'

interface NoteListProps {
  notes: NoteWithAuthor[]
}

export function NoteList({ notes }: NoteListProps) {
  if (notes.length === 0) {
    return (
      <div className="flex flex-col items-center py-8 text-muted-foreground">
        <StickyNoteIcon className="mb-2 h-8 w-8 opacity-40" />
        <p className="text-sm">No hay notas todavía</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {notes.map((note) => {
        const authorName = note.author?.name ?? 'Desconocido'
        const initials   = authorName.charAt(0).toUpperCase()
        const date       = format(new Date(note.created_at), "d MMM yyyy 'a las' HH:mm", { locale: es })

        return (
          <div key={note.id} className="rounded-lg border bg-card p-3">
            <div className="mb-2 flex items-center gap-2">
              <Avatar className="h-6 w-6">
                <AvatarFallback className="text-xs">{initials}</AvatarFallback>
              </Avatar>
              <span className="text-sm font-medium">{authorName}</span>
              <span className="ml-auto text-xs text-muted-foreground">{date}</span>
            </div>
            <p className="whitespace-pre-wrap text-sm">{note.content}</p>
          </div>
        )
      })}
    </div>
  )
}
