'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  PlusIcon, ExternalLinkIcon, Trash2Icon, FileTextIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction,
} from '@/components/ui/alert-dialog'
import { MonthlyRentalDocumentUploadDialog } from './monthly-rental-document-upload-dialog'
import { deleteMonthlyRentalDocumentAction } from '@/actions/monthly-rentals'
import type { MonthlyRentalDocument } from '@/lib/repositories/monthly-rentals.repository'

interface Props {
  contractId: string
  documents:  MonthlyRentalDocument[]
  isOwner:    boolean
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DOC_TYPE_LABEL: Record<string, string> = {
  contract:          'Contrato firmado',
  regulation:        'Reglamento',
  policy:            'Póliza',
  manual:            'Manual',
  identity_document: 'Documento de identidad',
  guarantee:         'Garantía',
  payment_proof:     'Comprobante de pago',
  receipt:           'Recibo',
}

const DOC_TYPE_ORDER = [
  'contract', 'guarantee', 'identity_document',
  'regulation', 'policy', 'manual',
  'payment_proof', 'receipt',
]

function fmtFileSize(bytes: number | null): string {
  if (!bytes) return ''
  if (bytes < 1024)            return `${bytes} B`
  if (bytes < 1024 * 1024)     return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function fmtDate(d: string): string {
  const part = d.slice(0, 10)
  const [y, m, day] = part.split('-')
  return `${day}/${m}/${y}`
}

// ─── Component ────────────────────────────────────────────────────────────────

export function MonthlyRentalDocumentsSection({ contractId, documents, isOwner }: Props) {
  const router                 = useRouter()
  const [isPending, startTrans] = useTransition()
  const [uploadOpen,    setUploadOpen]    = useState(false)
  const [deletingDocId, setDeletingDocId] = useState<string | null>(null)

  function handleDeleteConfirm() {
    if (!deletingDocId) return
    const id = deletingDocId
    setDeletingDocId(null)
    startTrans(async () => {
      const result = await deleteMonthlyRentalDocumentAction(id)
      if (result.success) {
        toast.success('Documento eliminado.')
        router.refresh()
      } else {
        toast.error(result.error ?? 'Error al eliminar el documento.')
      }
    })
  }

  // Group by type, preserve display order
  const grouped = new Map<string, MonthlyRentalDocument[]>()
  for (const doc of documents) {
    const key = doc.document_type
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key)!.push(doc)
  }

  const orderedKeys = [
    ...DOC_TYPE_ORDER.filter((k) => grouped.has(k)),
    ...[...grouped.keys()].filter((k) => !DOC_TYPE_ORDER.includes(k)),
  ]

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          Documentos
        </p>
        {isOwner && (
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5 h-7 text-xs"
            onClick={() => setUploadOpen(true)}
          >
            <PlusIcon className="h-3 w-3" />
            Subir documento
          </Button>
        )}
      </div>

      {documents.length === 0 ? (
        <div className="rounded-lg border border-dashed p-6 text-center">
          <FileTextIcon className="mx-auto mb-2 h-6 w-6 text-muted-foreground/30" />
          <p className="text-xs text-muted-foreground">No hay documentos adjuntos al contrato.</p>
          {isOwner && (
            <Button
              size="sm"
              variant="outline"
              className="mt-2 text-xs"
              onClick={() => setUploadOpen(true)}
            >
              Subir documento
            </Button>
          )}
        </div>
      ) : (
        <div className="rounded-lg border overflow-hidden divide-y">
          {orderedKeys.map((typeKey) => {
            const docs = grouped.get(typeKey) ?? []
            return (
              <div key={typeKey}>
                <div className="px-4 py-1.5 bg-muted/30">
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                    {DOC_TYPE_LABEL[typeKey] ?? typeKey}
                  </p>
                </div>
                {docs.map((doc) => {
                  const canDelete = isOwner && doc.source !== 'generated'
                  const size      = fmtFileSize(doc.file_size_bytes)
                  return (
                    <div key={doc.id} className="px-4 py-2.5 flex items-center gap-3">
                      <FileTextIcon className="h-3.5 w-3.5 text-muted-foreground/60 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium line-clamp-1">{doc.name}</p>
                        <p className="text-[10px] text-muted-foreground">
                          {fmtDate(doc.created_at)}
                          {size && <span> · {size}</span>}
                          {doc.notes && <span> · {doc.notes}</span>}
                        </p>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <a
                          href={doc.file_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="Ver documento"
                          className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:text-primary transition-colors"
                        >
                          <ExternalLinkIcon className="h-3 w-3" />
                        </a>
                        {canDelete && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 text-muted-foreground hover:text-destructive"
                            title="Eliminar documento"
                            disabled={isPending}
                            onClick={() => setDeletingDocId(doc.id)}
                          >
                            <Trash2Icon className="h-3 w-3" />
                          </Button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      )}

      {isOwner && (
        <MonthlyRentalDocumentUploadDialog
          open={uploadOpen}
          onClose={() => setUploadOpen(false)}
          contractId={contractId}
        />
      )}

      <AlertDialog
        open={deletingDocId !== null}
        onOpenChange={(o) => { if (!o) setDeletingDocId(null) }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Eliminar documento</AlertDialogTitle>
            <AlertDialogDescription>
              ¿Seguro que querés eliminar este documento? Esta acción no se puede deshacer.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              disabled={isPending}
              onClick={handleDeleteConfirm}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Eliminar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
