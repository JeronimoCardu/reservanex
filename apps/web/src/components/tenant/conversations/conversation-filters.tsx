'use client'

import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { useCallback } from 'react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Input } from '@/components/ui/input'

export function ConversationFilters() {
  const router       = useRouter()
  const pathname     = usePathname()
  const searchParams = useSearchParams()

  const updateParam = useCallback(
    (key: string, value: string) => {
      const params = new URLSearchParams(searchParams.toString())
      if (value && value !== 'all') {
        params.set(key, value)
      } else {
        params.delete(key)
      }
      params.delete('page')
      router.replace(`${pathname}?${params.toString()}`)
    },
    [router, pathname, searchParams],
  )

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Input
        placeholder="Buscar por contacto..."
        className="w-[200px]"
        defaultValue={searchParams.get('q') ?? ''}
        onChange={(e) => updateParam('q', e.target.value)}
      />

      <Select
        defaultValue={searchParams.get('status') ?? 'all'}
        onValueChange={(v) => updateParam('status', v)}
      >
        <SelectTrigger className="w-[140px]">
          <SelectValue placeholder="Estado" />
        </SelectTrigger>
        <SelectContent className="z-50 bg-background text-foreground border shadow-md">
          <SelectItem value="all">Todos</SelectItem>
          <SelectItem value="open">Abiertas</SelectItem>
          <SelectItem value="waiting">Esperando</SelectItem>
          <SelectItem value="closed">Cerradas</SelectItem>
        </SelectContent>
      </Select>

      <Select
        defaultValue={searchParams.get('ai_mode') ?? 'all'}
        onValueChange={(v) => updateParam('ai_mode', v)}
      >
        <SelectTrigger className="w-[150px]">
          <SelectValue placeholder="Modo IA" />
        </SelectTrigger>
        <SelectContent className="z-50 bg-background text-foreground border shadow-md">
          <SelectItem value="all">Todos los modos</SelectItem>
          <SelectItem value="autonomous">IA activa</SelectItem>
          <SelectItem value="manual">Manual</SelectItem>
        </SelectContent>
      </Select>

      <Select
        defaultValue={searchParams.get('assigned') ?? 'all'}
        onValueChange={(v) => updateParam('assigned', v)}
      >
        <SelectTrigger className="w-[160px]">
          <SelectValue placeholder="Asignación" />
        </SelectTrigger>
        <SelectContent className="z-50 bg-background text-foreground border shadow-md">
          <SelectItem value="all">Todas</SelectItem>
          <SelectItem value="mine">Mis conversaciones</SelectItem>
          <SelectItem value="unassigned">Sin asignar</SelectItem>
        </SelectContent>
      </Select>
    </div>
  )
}
