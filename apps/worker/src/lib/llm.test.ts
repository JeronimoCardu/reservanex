import { describe, expect, it } from 'vitest'
import { addUsage, type LLMUsage } from './llm'

describe('addUsage', () => {
  it('accumulates inputTokens and outputTokens across multiple calls', () => {
    const usages: LLMUsage[] = [
      { inputTokens: 100, outputTokens: 20 },
      { inputTokens: 150, outputTokens: 30 },
      { inputTokens: 200, outputTokens: 40 },
    ]

    const total = usages.reduce(addUsage, { inputTokens: 0, outputTokens: 0 })

    expect(total).toEqual({ inputTokens: 450, outputTokens: 90 })
  })

  it('starts from zero and accumulates a single call correctly', () => {
    const total = addUsage({ inputTokens: 0, outputTokens: 0 }, { inputTokens: 7000, outputTokens: 50 })
    expect(total).toEqual({ inputTokens: 7000, outputTokens: 50 })
  })

  it('leaves the accumulator unchanged when a call reported no usage', () => {
    const acc = { inputTokens: 10, outputTokens: 5 }
    expect(addUsage(acc, undefined)).toEqual({ inputTokens: 10, outputTokens: 5 })
  })

  it('does not mutate the accumulator passed in (pure function)', () => {
    const acc = { inputTokens: 10, outputTokens: 5 }
    const result = addUsage(acc, { inputTokens: 1, outputTokens: 1 })
    expect(acc).toEqual({ inputTokens: 10, outputTokens: 5 })
    expect(result).toEqual({ inputTokens: 11, outputTokens: 6 })
  })
})
