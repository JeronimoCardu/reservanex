// Pure, DB/env-independent constants describing the CURRENT, physically-
// validated AutoResponder wire contract. Single source of truth for the
// Android install guide UI so it can never silently drift from what the
// real route handlers expect. These mirror — never redefine differently —
// the literal header names the routes under
// apps/web/src/app/api/webhooks/autoresponder/* already use.
//
// Fase 2A (AUTORESPONDER-ONLY): every MacroDroid macro constant
// (rn_* variables, outbound/media actions, macro wait timings, media
// content types) was deleted along with that transport.

// NOT re-exported from autoresponder-webhook.ts on purpose — that module
// pulls in node:crypto (hashDeviceToken), and this contract module is
// imported by a 'use client' component (android-install-guide.tsx).
// Re-exporting from it broke the webpack client build ("node:crypto" is
// not handled by plugins). Small, deliberate duplicate instead — same
// "shared pure constant duplicated across a module boundary" pattern
// already established for the web/worker split elsewhere in this codebase.
export const AUTORESPONDER_APP_PACKAGE = 'tkstudio.autoresponderforwa'
export const WHATSAPP_BUSINESS_PACKAGE = 'com.whatsapp.w4b'

export const HEADER_DEVICE_TOKEN = 'x-reservanex-device-token'


// Cadencia sugerida para el endpoint de heartbeat OPCIONAL. No es un
// requisito de instalación: la guía ya no la pide, porque AutoResponder no
// puede emitir un POST periódico y ReservaNex verifica el Android por el
// primer inbound autenticado. Se conserva porque el contrato del endpoint
// (y su test) fija que esta cadencia sea menor que el umbral "reciente" de
// autoresponder-device-health.ts — si alguien lo usa, tiene que caber.
export const HEARTBEAT_INTERVAL_MINUTES        = 2

