import { createClient } from '../lib/supabase'

const GRAPH_API_VERSION = 'v23.0'
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`

export interface WhatsAppMediaInfo {
  type:     'image' | 'document' | 'audio'
  mediaId:  string
  mimeType: string
  filename: string | null
  sha256:   string | null
  caption:  string | null
  voice?:   boolean  // true for WhatsApp voice notes
}

// Extracts media metadata from a Meta Cloud API webhook payload.
// Returns null for text messages or unknown types.
export function extractWhatsAppMediaInfo(
  payload: Record<string, unknown>,
): WhatsAppMediaInfo | null {
  try {
    const entry    = (payload['entry']   as Record<string, unknown>[] | undefined)?.[0]
    const change   = (entry?.['changes'] as Record<string, unknown>[] | undefined)?.[0]
    const value    = change?.['value']   as Record<string, unknown> | undefined
    const msg      = (value?.['messages'] as Record<string, unknown>[] | undefined)?.[0]

    if (!msg) return null

    const type = msg['type'] as string
    if (type !== 'image' && type !== 'document' && type !== 'audio') return null

    const mediaObj = msg[type] as Record<string, unknown> | undefined
    if (!mediaObj) return null

    const mediaId = typeof mediaObj['id'] === 'string' ? mediaObj['id'] : null
    if (!mediaId) return null

    return {
      type:     type as 'image' | 'document' | 'audio',
      mediaId,
      mimeType: typeof mediaObj['mime_type'] === 'string' ? mediaObj['mime_type'] : 'application/octet-stream',
      filename: typeof mediaObj['filename']  === 'string' ? mediaObj['filename']  : null,
      sha256:   typeof mediaObj['sha256']    === 'string' ? mediaObj['sha256']    : null,
      caption:  typeof mediaObj['caption']   === 'string' ? mediaObj['caption']   : null,
      ...(type === 'audio' ? { voice: typeof mediaObj['voice'] === 'boolean' ? mediaObj['voice'] : undefined } : {}),
    }
  } catch {
    return null
  }
}

// Downloads a media file from Meta Graph API.
// Step 1: fetches the temporary download URL, Step 2: downloads the bytes.
// Never logs the bearer token.
export async function downloadMetaMedia(
  mediaId: string,
  token:   string,
): Promise<{ buffer: Buffer; contentType: string } | null> {
  // Step 1: resolve the temporary URL
  let mediaUrl: string
  try {
    const urlRes = await fetch(`${GRAPH_BASE}/${mediaId}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal:  AbortSignal.timeout(15_000),
    })

    if (!urlRes.ok) {
      console.warn('[media] Meta media URL fetch failed', { status: urlRes.status, mediaId })
      return null
    }

    const meta = await urlRes.json() as { url?: string; error?: { message: string } }
    if (!meta.url) {
      console.warn('[media] Meta returned no URL', { mediaId })
      return null
    }
    mediaUrl = meta.url
  } catch (err) {
    console.error('[media] network error fetching Meta media URL:', err instanceof Error ? err.message : String(err))
    return null
  }

  // Step 2: download bytes
  try {
    const fileRes = await fetch(mediaUrl, {
      headers: { Authorization: `Bearer ${token}` },
      signal:  AbortSignal.timeout(30_000),
    })

    if (!fileRes.ok) {
      console.warn('[media] Meta media download failed', { status: fileRes.status })
      return null
    }

    const contentType = fileRes.headers.get('content-type') ?? 'application/octet-stream'
    const arrayBuf    = await fileRes.arrayBuffer()
    return { buffer: Buffer.from(arrayBuf), contentType }
  } catch (err) {
    console.error('[media] network error downloading media bytes:', err instanceof Error ? err.message : String(err))
    return null
  }
}

function mimeToExt(mimeType: string): string {
  // Strip parameters (e.g. 'audio/ogg; codecs=opus' → 'audio/ogg')
  const base = (mimeType.split(';')[0]?.trim().toLowerCase()) ?? ''
  const map: Record<string, string> = {
    'image/jpeg':        'jpg',
    'image/jpg':         'jpg',
    'image/png':         'png',
    'image/webp':        'webp',
    'image/gif':         'gif',
    'application/pdf':   'pdf',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    // Audio — WhatsApp voice notes arrive as audio/ogg; codecs=opus
    'audio/ogg':   'ogg',
    'audio/mpeg':  'mp3',
    'audio/mp4':   'm4a',
    'audio/aac':   'aac',
    'audio/opus':  'opus',
    'audio/wav':   'wav',
    'audio/x-m4a': 'm4a',
    'audio/amr':   'amr',
  }
  return map[base] ?? 'bin'
}

// Uploads a media buffer to the private whatsapp-media bucket.
// Path: {tenantId}/{conversationId}/{messageId}.{ext}
// Returns the storage path on success, null on failure.
export async function uploadWhatsAppMediaToStorage(params: {
  tenantId:       string
  conversationId: string
  messageId:      string
  buffer:         Buffer
  mimeType:       string
  contentType:    string
}): Promise<string | null> {
  const { tenantId, conversationId, messageId, buffer, mimeType, contentType } = params

  const ext         = mimeToExt(mimeType)
  const storagePath = `${tenantId}/${conversationId}/${messageId}.${ext}`
  const supabase    = createClient()

  const { error } = await supabase.storage
    .from('whatsapp-media')
    .upload(storagePath, buffer, { contentType, upsert: true })

  if (error) {
    console.error('[media] storage upload failed', { storagePath, error: error.message })
    return null
  }

  console.log('[media] uploaded to storage', { storagePath })
  return storagePath
}
