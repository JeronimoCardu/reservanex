'use client'

import { useState, useRef, useEffect, useTransition } from 'react'
import { toast } from 'sonner'
import { PlusIcon, Trash2Icon, LoaderIcon, ChevronUpIcon, ChevronDownIcon } from 'lucide-react'
import {
  getPropertyVideosAction,
  uploadPropertyVideoAction,
  deletePropertyVideoAction,
  reorderPropertyVideosAction,
} from '@/actions/properties'
import { cn } from '@/lib/utils'

type VideoRow = {
  id:               string
  title:            string | null
  mime_type:        string
  file_size_bytes:  number
  duration_seconds: number | null
  sort_order:       number
  created_at:       string
}

const ALLOWED_MIME = ['video/mp4', 'video/webm', 'video/quicktime']
const MAX_BYTES    = 80 * 1024 * 1024
const MAX_DURATION = 60
const MAX_VIDEOS   = 2

function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

function getVideoDuration(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    video.preload = 'metadata'
    const url = URL.createObjectURL(file)
    video.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve(video.duration) }
    video.onerror = () => { URL.revokeObjectURL(url); reject(new Error('No se pudo leer el video')) }
    video.src = url
  })
}

interface PropertyVideoManagerProps {
  propertyId: string
}

export function PropertyVideoManager({ propertyId }: PropertyVideoManagerProps) {
  const [videos,      setVideos]      = useState<VideoRow[]>([])
  const [isLoading,   setIsLoading]   = useState(true)
  const [isUploading, setIsUploading] = useState(false)
  const [deletingId,  setDeletingId]  = useState<string | null>(null)
  const [reorderingId, setReorderingId] = useState<string | null>(null)
  const [, startTransition]           = useTransition()
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    getPropertyVideosAction(propertyId).then((r) => {
      if (r.success && r.data) setVideos(r.data)
      setIsLoading(false)
    })
  }, [propertyId])

  async function handleMove(idx: number, dir: 'up' | 'down') {
    const swap = dir === 'up' ? idx - 1 : idx + 1
    if (swap < 0 || swap >= videos.length) return

    // Optimistic update
    const next = [...videos]
    ;[next[idx], next[swap]] = [next[swap]!, next[idx]!]
    setVideos(next)

    const movingId = videos[idx]!.id
    setReorderingId(movingId)
    startTransition(async () => {
      const r = await reorderPropertyVideosAction(propertyId, next.map(v => v.id))
      setReorderingId(null)
      if (!r.success) {
        // Revert on failure
        setVideos(videos)
        toast.error(r.error ?? 'Error al reordenar los videos.')
      }
    })
  }

  async function onFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return

    if (!ALLOWED_MIME.includes(file.type)) {
      toast.error('Solo se admiten videos MP4, WebM o MOV.')
      return
    }
    if (file.size > MAX_BYTES) {
      toast.error('El video no puede superar 80 MB.')
      return
    }

    let duration: number
    try {
      duration = await getVideoDuration(file)
    } catch {
      toast.error('No se pudo leer la duración del video. Verificá que sea un video válido.')
      return
    }

    if (!isFinite(duration) || duration <= 0) {
      toast.error('No se pudo determinar la duración del video.')
      return
    }
    if (duration > MAX_DURATION) {
      toast.error(`El video dura ${Math.ceil(duration)} segundos. El máximo permitido es ${MAX_DURATION} segundos.`)
      return
    }

    setIsUploading(true)
    const fd = new FormData()
    fd.append('file', file)
    fd.append('duration_seconds', String(Math.ceil(duration)))

    startTransition(async () => {
      const r = await uploadPropertyVideoAction(propertyId, fd)
      setIsUploading(false)
      if (!r.success) { toast.error(r.error); return }
      const listR = await getPropertyVideosAction(propertyId)
      if (listR.success && listR.data) setVideos(listR.data)
      toast.success('Video subido correctamente')
    })
  }

  async function handleDelete(videoId: string) {
    setDeletingId(videoId)
    startTransition(async () => {
      const r = await deletePropertyVideoAction(videoId)
      setDeletingId(null)
      if (!r.success) { toast.error(r.error); return }
      setVideos((prev) => prev.filter((v) => v.id !== videoId))
      toast.success('Video eliminado')
    })
  }

  const canUpload = !isUploading && videos.length < MAX_VIDEOS

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-4 text-muted-foreground">
        <LoaderIcon className="h-4 w-4 animate-spin" />
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {videos.map((video, idx) => (
        <div key={video.id} className="flex items-center gap-1.5">
          {/* ↑↓ reorder — only meaningful when there are 2 videos */}
          {videos.length > 1 && (
            <div className="flex shrink-0 flex-col">
              <button
                type="button"
                onClick={() => handleMove(idx, 'up')}
                disabled={idx === 0 || reorderingId === video.id}
                aria-label="Mover arriba"
                className="rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-25 disabled:cursor-not-allowed"
              >
                <ChevronUpIcon className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => handleMove(idx, 'down')}
                disabled={idx === videos.length - 1 || reorderingId === video.id}
                aria-label="Mover abajo"
                className="rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-25 disabled:cursor-not-allowed"
              >
                <ChevronDownIcon className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          {/* Thumbnail — real video frame via preload="metadata" */}
          <div className="relative h-16 w-20 shrink-0 overflow-hidden rounded bg-zinc-900">
            <video
              src={`/api/property-videos/${video.id}`}
              preload="metadata"
              muted
              playsInline
              className="absolute inset-0 h-full w-full object-cover pointer-events-none"
            />
            <div className="absolute inset-0 flex items-center justify-center bg-black/25">
              <svg
                className="h-5 w-5 text-white"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
                style={{ filter: 'drop-shadow(0 1px 4px rgba(0,0,0,0.7))' }}
              >
                <path d="M8 5v14l11-7z" />
              </svg>
            </div>
            {video.duration_seconds != null && (
              <span className="absolute bottom-1 right-1 rounded bg-black/60 px-1 text-[8px] font-medium text-white">
                {formatDuration(video.duration_seconds)}
              </span>
            )}
          </div>

          {/* Metadata */}
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium leading-tight">
              {video.title ?? 'Video'}
            </p>
            <p className="text-[10px] text-muted-foreground">
              {[
                video.duration_seconds != null && formatDuration(video.duration_seconds),
                formatFileSize(video.file_size_bytes),
              ].filter(Boolean).join(' · ')}
            </p>
          </div>

          {/* Delete */}
          <button
            type="button"
            onClick={() => handleDelete(video.id)}
            disabled={!!deletingId || !!reorderingId}
            aria-label="Eliminar video"
            className="shrink-0 text-muted-foreground hover:text-destructive disabled:opacity-40 transition-colors"
          >
            {deletingId === video.id
              ? <LoaderIcon className="h-4 w-4 animate-spin" />
              : <Trash2Icon className="h-4 w-4" />
            }
          </button>
        </div>
      ))}

      {videos.length === 0 && (
        <p className="text-xs text-muted-foreground">
          Sin videos. MP4, WebM o MOV · máx. {MAX_DURATION} seg · máx. 80 MB
        </p>
      )}

      {/* Upload trigger */}
      {canUpload && (
        <>
          <input
            ref={inputRef}
            type="file"
            accept="video/mp4,video/webm,video/quicktime,.mov"
            className="hidden"
            onChange={onFileSelect}
          />
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={isUploading}
            className={cn(
              'flex w-full items-center justify-center gap-2 rounded-lg border-2 border-dashed py-2.5 text-xs text-muted-foreground transition-colors',
              'hover:border-primary/50 hover:text-primary disabled:opacity-50 disabled:cursor-not-allowed',
            )}
          >
            {isUploading ? (
              <><LoaderIcon className="h-3.5 w-3.5 animate-spin" /> Subiendo…</>
            ) : (
              <><PlusIcon className="h-3.5 w-3.5" /> Agregar video ({videos.length}/{MAX_VIDEOS})</>
            )}
          </button>
        </>
      )}

      {!canUpload && !isUploading && videos.length >= MAX_VIDEOS && (
        <p className="text-xs text-muted-foreground text-center">
          Máximo {MAX_VIDEOS} videos por propiedad.
        </p>
      )}
    </div>
  )
}
