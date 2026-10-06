import { describe, expect, it } from 'vitest'
import { checkLocalDatabaseUrl } from '../../../scripts/rate-limit-local-target'

// El validator físico de rate limiting escribe en la base: este guard es lo
// único que impide que lo apunten al proyecto remoto.

describe('checkLocalDatabaseUrl', () => {
  it.each([
    ['postgresql://postgres:postgres@127.0.0.1:54322/postgres', '127.0.0.1:54322/postgres'],
    ['postgres://postgres:secreto@localhost:5432/rl_proof', 'localhost:5432/rl_proof'],
    ['postgresql://postgres@[::1]:5433/postgres', '[::1]:5433/postgres'],
    ['postgresql://postgres:postgres@127.0.0.1/postgres?sslmode=disable', '127.0.0.1:5432/postgres'],
  ])('acepta %s', (url, label) => {
    expect(checkLocalDatabaseUrl(url)).toEqual({ ok: true, label })
  })

  it('el label nunca lleva usuario ni contraseña', () => {
    const r = checkLocalDatabaseUrl('postgresql://postgres:muy-secreto@127.0.0.1:54322/postgres')
    expect(JSON.stringify(r)).not.toContain('muy-secreto')
    expect(JSON.stringify(r)).not.toContain('postgres:')
  })

  it.each([
    [undefined],
    [''],
    ['postgresql://postgres:x@db.tjqfysbcmpqlwmzdvynr.supabase.co:5432/postgres'],
    ['postgresql://postgres.tjqfysbcmpqlwmzdvynr:x@aws-0-sa-east-1.pooler.supabase.com:6543/postgres'],
    ['postgresql://postgres:x@10.0.0.5:5432/postgres'],
    ['postgresql://postgres:x@192.168.1.10:5432/postgres'],
    ['postgresql://postgres:x@mi-servidor:5432/postgres'],
    ['postgresql://postgres:x@127.0.0.1:5432/postgres?host=db.example.com'],
    ['postgresql://postgres:x@127.0.0.1:5432/postgres?hostaddr=10.0.0.5'],
    ['postgresql://postgres:x@127.0.0.1:5432/postgres?service=remoto'],
    ['mysql://root@127.0.0.1/db'],
    ['https://127.0.0.1:54321'],
    ['no es una url'],
  ])('rechaza %j', (url) => {
    expect(checkLocalDatabaseUrl(url).ok).toBe(false)
  })
})
