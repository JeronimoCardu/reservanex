// Fase 2A (AUTORESPONDER-ONLY) §14 A/B/F — the worker bootstrap must start
// EXACTLY the two components this version has, and the MacroDroid transports
// must be gone from the codebase entirely, not merely unreferenced from
// index.ts. Reading the real source files is deliberate: a unit test that
// only imported index.ts would boot the poller and bind a real port.

import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(__dirname)
const indexSource = readFileSync(join(SRC, 'index.ts'), 'utf8')

describe('worker bootstrap (§14 A/B)', () => {
  it('A. does not start the outbound dispatcher', () => {
    expect(indexSource).not.toMatch(/startDispatcher/)
    expect(indexSource).not.toMatch(/from '\.\/dispatcher'/)
  })

  it('B. does not start the media dispatcher', () => {
    expect(indexSource).not.toMatch(/startMediaDispatcher/)
    expect(indexSource).not.toMatch(/from '\.\/media-dispatcher'/)
  })

  it('starts exactly the poller and the internal server', () => {
    expect(indexSource).toMatch(/startPoller\(\)/)
    expect(indexSource).toMatch(/startInternalServer\(\)/)
    const startCalls = indexSource.match(/start[A-Z]\w*\(/g) ?? []
    expect(startCalls.sort()).toEqual(['startInternalServer(', 'startPoller('])
  })
})

describe('MacroDroid transports are deleted from the worker (§14 F)', () => {
  const deletedModules = [
    'dispatcher.ts',
    'media-dispatcher.ts',
    'media-events.ts',
    'outbox.ts',
    'lib/device-lease.ts',
    'providers/autoresponder/outbound.ts',
    'providers/autoresponder/dispatcher-claim.ts',
  ]

  for (const mod of deletedModules) {
    it(`F. ${mod} no longer exists`, () => {
      expect(existsSync(join(SRC, mod))).toBe(false)
    })
  }
})

describe('no worker code can reach MacroDroid or messaging_outbox (§14 E/F)', () => {
  // processor.ts is the single delivery decision point — if MacroDroid could
  // still be reached from anywhere in the active pipeline, it would be here.
  const processorSource = readFileSync(join(SRC, 'processor.ts'), 'utf8')

  it('E. processor.ts never imports or calls an outbox enqueue', () => {
    expect(processorSource).not.toMatch(/enqueueOutboxMessage/)
    expect(processorSource).not.toMatch(/from '\.\/outbox'/)
  })

  it('F. processor.ts never imports or calls a MacroDroid dispatch', () => {
    expect(processorSource).not.toMatch(/dispatchToMacroDroid/)
    expect(processorSource).not.toMatch(/dispatchMediaTriggerToMacroDroid/)
    expect(processorSource).not.toMatch(/from '\.\/providers\/autoresponder\/outbound'/)
  })

  it('F. processor.ts never creates a media_events row', () => {
    expect(processorSource).not.toMatch(/createMediaEvent/)
    expect(processorSource).not.toMatch(/from '\.\/media-events'/)
  })
})
