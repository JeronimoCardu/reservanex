// DeepSeek official API client (OpenAI-compatible chat completions).
// Reads DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL / DEEPSEEK_MODEL — no OpenRouter dependency.
const DEFAULT_BASE_URL = 'https://api.deepseek.com'

// Finish reasons that mean the response must NOT be treated as a valid final
// answer, even if `message.content` happens to be non-empty. The caller
// (responder.ts) otherwise treats any finish_reason other than 'tool_calls'
// as a final text reply to send to the customer — these two must never reach
// that path silently.
const ERROR_FINISH_REASONS = new Set(['content_filter', 'insufficient_system_resource'])

// ── Tool types ────────────────────────────────────────────────────────────────

export interface LLMRawToolCall {
  id:       string
  type:     'function'
  function: { name: string; arguments: string }
}

export interface LLMTool {
  type: 'function'
  function: {
    name:        string
    description: string
    parameters:  Record<string, unknown>
  }
}

export interface LLMToolCall {
  id:   string
  name: string
  args: Record<string, unknown>
}

// ── Message shapes ────────────────────────────────────────────────────────────

export type LLMMessage =
  | { role: 'user';      content: string }
  | { role: 'assistant'; content: string }
  | { role: 'assistant'; content: null; tool_calls: LLMRawToolCall[] }
  | { role: 'tool';      content: string; tool_call_id: string }

// ── Call API ──────────────────────────────────────────────────────────────────

export interface LLMCallOptions {
  system:     string
  messages:   LLMMessage[]
  tools?:     LLMTool[]
  maxTokens?: number
  model?:     string
  // Fase 1B (AutoResponder sin MacroDroid) — an external cancellation signal
  // (e.g. the sync webhook's own budget, see processor.ts/internal-server.ts),
  // merged with the fixed 30s per-call timeout below. Aborting either one
  // aborts the fetch. Optional — every existing caller keeps working with
  // only the fixed timeout, unchanged.
  signal?:    AbortSignal
}

export interface LLMUsage {
  inputTokens:  number
  outputTokens: number
}

export interface LLMResult {
  text:         string
  finishReason: string
  model:        string
  toolCalls?:   LLMToolCall[]
  usage?:       LLMUsage
}

// Pure accumulator — no I/O. A single generateAIReply() turn can call
// callLLM() multiple times (tool-calling loop); this folds each call's
// usage into a running total so the caller can persist the true sum for
// the whole turn instead of just the last call's usage.
export function addUsage(acc: LLMUsage, next: LLMUsage | undefined): LLMUsage {
  if (!next) return acc
  return {
    inputTokens:  acc.inputTokens  + next.inputTokens,
    outputTokens: acc.outputTokens + next.outputTokens,
  }
}

// ── Internal response types ───────────────────────────────────────────────────

interface DeepSeekChoice {
  message: {
    role:        string
    content:     string | null
    tool_calls?: LLMRawToolCall[]
    // DeepSeek's reasoning models can return chain-of-thought here. Thinking is
    // explicitly disabled on every call below, so this should never be populated —
    // it is intentionally never read into LLMResult (never persisted).
    reasoning_content?: string | null
  }
  finish_reason: string | null
}

interface DeepSeekResponse {
  model?:    string
  choices?:  DeepSeekChoice[]
  usage?:    { prompt_tokens: number; completion_tokens: number }
  error?:    { message: string; code?: number; type?: string }
}

// ── callLLM ───────────────────────────────────────────────────────────────────

// Combines the fixed per-call timeout with an optional external signal
// without relying on AbortSignal.any (Node version/lib-typing uncertainty —
// a manual merge is safe everywhere and easy to unit-test). Aborting either
// input aborts the returned signal; its `reason` is whichever fired first.
function mergeAbortSignals(a: AbortSignal, b?: AbortSignal): AbortSignal {
  if (!b) return a
  if (a.aborted) return a
  if (b.aborted) return b

  const controller = new AbortController()
  const onAbortA = () => controller.abort(a.reason)
  const onAbortB = () => controller.abort(b.reason)
  a.addEventListener('abort', onAbortA, { once: true })
  b.addEventListener('abort', onAbortB, { once: true })
  return controller.signal
}

export async function callLLM({
  system,
  messages,
  tools,
  maxTokens = 1024,
  model: modelOverride,
  signal: externalSignal,
}: LLMCallOptions): Promise<LLMResult> {
  const apiKey = process.env.DEEPSEEK_API_KEY ?? ''
  if (!apiKey) {
    throw new Error('[llm] Missing DEEPSEEK_API_KEY. Check that the root .env.local is loaded.')
  }

  const model = modelOverride ?? process.env.DEEPSEEK_MODEL ?? ''
  if (!model) {
    throw new Error('[llm] Missing DEEPSEEK_MODEL. Check that the root .env.local is loaded.')
  }

  const base     = process.env.DEEPSEEK_BASE_URL ?? DEFAULT_BASE_URL
  const endpoint = `${base.replace(/\/$/, '')}/chat/completions`

  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    messages:   [{ role: 'system', content: system }, ...messages],
    // Thinking/reasoning is explicitly disabled — this app needs fast, predictable
    // tool-calling responses for WhatsApp, never the provider default.
    thinking: { type: 'disabled' },
  }
  if (tools && tools.length > 0) {
    body.tools       = tools
    body.tool_choice = 'auto'
  }

  const res = await fetch(endpoint, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type':  'application/json',
    },
    body:   JSON.stringify(body),
    signal: mergeAbortSignals(AbortSignal.timeout(30_000), externalSignal),
  })

  // Validate content-type before parsing to get a clear error when the server
  // returns HTML (e.g. a misconfigured base URL serving a 404/403 page).
  const contentType = res.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    const raw = await res.text()
    throw new Error(
      `[llm] Expected JSON from DeepSeek but got ${contentType || '(no content-type)'} ` +
      `(HTTP ${res.status}). Body: ${raw.slice(0, 300)}`,
    )
  }

  const data = await res.json() as DeepSeekResponse

  if (!res.ok) {
    const detail = data.error?.message ?? res.statusText
    throw new Error(`[llm] DeepSeek error ${res.status}: ${detail}`)
  }

  const choice = data.choices?.[0]
  if (!choice) {
    throw new Error(`[llm] Empty choices in response: ${JSON.stringify(data)}`)
  }

  // Non-recoverable finish reasons must never be forwarded as a valid answer,
  // even if message.content happens to be non-empty (e.g. a partial/filtered draft).
  if (choice.finish_reason && ERROR_FINISH_REASONS.has(choice.finish_reason)) {
    throw new Error(`[llm] DeepSeek returned a non-recoverable finish_reason: ${choice.finish_reason}`)
  }

  const hasText  = typeof choice.message.content === 'string'
  const hasCalls = (choice.message.tool_calls?.length ?? 0) > 0

  if (!hasText && !hasCalls) {
    throw new Error(`[llm] Unexpected response shape: ${JSON.stringify(data)}`)
  }

  const toolCalls = choice.message.tool_calls?.map((tc) => {
    let args: Record<string, unknown> = {}
    try {
      args = JSON.parse(tc.function.arguments) as Record<string, unknown>
    } catch {
      console.error(
        `[llm] Could not parse tool args for ${tc.function.name}:`,
        tc.function.arguments,
      )
    }
    return { id: tc.id, name: tc.function.name, args }
  })

  return {
    text:         choice.message.content ?? '',
    finishReason: choice.finish_reason ?? 'unknown',
    model:        data.model ?? model,
    toolCalls,
    usage: data.usage
      ? { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens }
      : undefined,
  }
}
