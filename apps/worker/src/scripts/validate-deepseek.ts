/**
 * Smoke test: validates the DeepSeek integration at the LLM layer only.
 *
 * Does NOT touch Supabase, Meta, or WhatsApp. Calls the real callLLM() directly
 * with a minimal system prompt and a tiny user message, twice:
 *
 *   A. Plain text response — confirms auth + endpoint + model work end to end.
 *   B. Tool calling — defines a throwaway tool and confirms callLLM() parses
 *      tool_calls correctly (id, name, parsed arguments). The tool call is
 *      never executed — this only verifies parsing.
 *
 * Usage:  pnpm validate:deepseek
 * Env:    DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL, DEEPSEEK_MODEL (required, from .env.local)
 */

import path from 'path'
import { config } from 'dotenv'

// __dirname = apps/worker/src/scripts  →  ../../../../ = monorepo root
config({ path: path.resolve(__dirname, '../../../../.env.local') })

import { callLLM } from '../lib/llm'
import type { LLMTool } from '../lib/llm'

const HR   = '─'.repeat(64)
const PASS = '  ✓'
const FAIL = '  ✗'

let passed = 0
let failed = 0

function ok(label: string): void { console.log(`${PASS} ${label}`); passed++ }
function nok(label: string, detail?: string): void {
  console.error(`${FAIL} ${label}`)
  if (detail) console.error(`       ${detail}`)
  failed++
}

// Never prints the key itself — only whether each required name is present.
function checkConfig(): boolean {
  const required = ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_MODEL']
  const missing  = required.filter((name) => !process.env[name])

  if (missing.length > 0) {
    console.error(`\n  [validate-deepseek] Faltan variables de entorno: ${missing.join(', ')}`)
    console.error('  Revisá .env.local — no se ejecuta el smoke test.')
    return false
  }
  return true
}

async function main(): Promise<void> {
  console.log(HR)
  console.log('  ReservaNex — DeepSeek Smoke Test  (solo capa LLM — sin Supabase/Meta/WhatsApp)')
  console.log(HR)

  if (!checkConfig()) {
    process.exitCode = 1
    return
  }

  // ── Test A: respuesta normal, sin tools ─────────────────────────────────────
  console.log('\n  Test A: respuesta normal (sin tools)')
  try {
    const result = await callLLM({
      system:    'Respondé en una sola palabra, sin explicaciones.',
      messages:  [{ role: 'user', content: 'Decí "hola" y nada más.' }],
      maxTokens: 20,
    })

    if (result.text && result.text.trim().length > 0) {
      ok(`Respuesta recibida — model=${result.model} finishReason=${result.finishReason}`)
      console.log(`       texto: "${result.text.trim()}"`)
      if (result.usage) {
        console.log(`       tokens: in=${result.usage.inputTokens} out=${result.usage.outputTokens}`)
      } else {
        console.log('       usage: no informado por la API')
      }
    } else {
      nok('Test A: respuesta vacía', JSON.stringify(result))
    }
  } catch (err) {
    nok('Test A: callLLM lanzó una excepción', err instanceof Error ? err.message : String(err))
  }

  // ── Test B: tool calling con una tool ficticia segura ───────────────────────
  console.log('\n  Test B: tool calling (tool_choice=auto, no se ejecuta nada real)')

  const getTestPropertyTool: LLMTool = {
    type: 'function',
    function: {
      name:        'get_test_property',
      description:
        'Devuelve información de una propiedad de PRUEBA dado su código. ' +
        'Usá esta tool siempre que se te pida el dato de una propiedad de prueba.',
      parameters: {
        type: 'object',
        properties: {
          code: {
            type:        'string',
            description: 'Código de la propiedad de prueba, por ejemplo "TEST-001".',
          },
        },
        required:             ['code'],
        additionalProperties: false,
      },
    },
  }

  try {
    const result = await callLLM({
      system:
        'Sos un asistente de pruebas técnicas. Cuando te pidan el dato de una propiedad ' +
        'de prueba, SIEMPRE llamá a la tool get_test_property con el código exacto — ' +
        'no respondas con texto, usá la tool.',
      messages: [
        { role: 'user', content: 'Necesito el dato de la propiedad de prueba con código TEST-001. Usá la tool.' },
      ],
      tools:     [getTestPropertyTool],
      maxTokens: 150,
    })

    if (result.finishReason === 'tool_calls' && result.toolCalls && result.toolCalls.length > 0) {
      const call    = result.toolCalls[0]!
      const hasId   = typeof call.id === 'string' && call.id.length > 0
      const hasName = call.name === 'get_test_property'
      const hasArgs = typeof call.args === 'object' && call.args !== null

      if (hasId && hasName && hasArgs) {
        ok('Tool call parseada correctamente — NO se ejecutó ninguna operación real')
        console.log(`       id=${call.id}`)
        console.log(`       name=${call.name}`)
        console.log(`       args=${JSON.stringify(call.args)}`)
      } else {
        nok('Tool call con forma inesperada', JSON.stringify(call))
      }

      if (result.usage) {
        console.log(`       tokens: in=${result.usage.inputTokens} out=${result.usage.outputTokens}`)
      }
    } else {
      nok(
        'Test B: el modelo no devolvió una tool call',
        `finishReason=${result.finishReason} text="${result.text.slice(0, 200)}"`,
      )
    }
  } catch (err) {
    nok('Test B: callLLM lanzó una excepción', err instanceof Error ? err.message : String(err))
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log()
  console.log(HR)
  console.log(`  Result: ${passed} passed, ${failed} failed`)
  console.log(HR)

  if (failed > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error('\n  [validate-deepseek] Fatal:', err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
