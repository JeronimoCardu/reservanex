# Android / MacroDroid setup — AutoResponder provider

Complete reference for configuring the physical Android device (AutoResponder
for WA + WhatsApp Business + MacroDroid) that backs one tenant's
`provider='autoresponder'` WhatsApp account. Written from the validated Fase
8/9 physical E2E. **Every value below is a placeholder — never paste a real
device token, MacroDroid webhook URL, public base URL, or phone number into
this file or into any commit.**

**Fast path:** `/platform/tenants/[id]/whatsapp` → "Instalación Android" has
an interactive version of this same guide — endpoints/headers pre-filled
with the real values for that tenant, copy buttons, and a path generator for
the media shell scripts. This document is the complete reference for when
you need more context than the UI shows, or to install the UI itself.

## Required apps on the Android

- **AutoResponder for WA** (`tkstudio.autoresponderforwa`)
- **WhatsApp Business** (`com.whatsapp.w4b`) — **not** regular WhatsApp
  (`com.whatsapp`); paths and behavior below are validated only for Business.
- **MacroDroid**

## Two directions of traffic

```
Android → ReservaNex   (4 endpoints below, GLOBAL — shared by every tenant)
ReservaNex → Android   (1 URL per WhatsApp account, MacroDroid's own webhook trigger)
```

### Android → ReservaNex (global endpoints)

These four routes are the **same for every tenant** — they are never
prefixed or suffixed with a tenant name/id. A request is attributed to a
tenant/account entirely by which device token it presents; a token is
minted once per `whatsapp_accounts` row from `/platform`.

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/webhooks/autoresponder` | POST | Inbound WhatsApp message from a customer |
| `/api/webhooks/autoresponder/media` | POST | Upload of an extracted audio/image/document file |
| `/api/webhooks/autoresponder/heartbeat` | POST | Periodic "the Android is alive" ping |
| `/api/webhooks/autoresponder/outbound-ack` | POST | Physical confirmation that WhatsApp Send ran (Fase 8) |

These paths are relative to the app's **public webhook base URL** — see the
next section. In production that's `https://reservanex.com`; a phone can
never reach `http://localhost:3001` (the dev server's own address), so
development requires a real public tunnel.

Headers (fixed names, always `x-reservanex-*`, never renamed per tenant):

| Header | Used by | Value |
|---|---|---|
| `x-reservanex-device-token` | all four | the account's device token (placeholder: `<DEVICE_TOKEN>`) |
| `x-reservanex-event-id` | media | the media event id ReservaNex generated |
| `x-reservanex-media-type` | media | `audio` \| `image` \| `document` |
| `x-reservanex-filename` | media | only for `document` (AutoResponder gives no filename for audio/image) |
| `x-reservanex-outbox-id` | outbound-ack | echoes back `rn_outbox_id` from the trigger that fired the send |

### Public webhook base URL (Fase 9)

Distinct from `NEXT_PUBLIC_SITE_URL` (the browser-facing app origin used for
Supabase Auth email links) — that one is `http://localhost:3001` in dev,
which the Android cannot reach at all. The base URL Android calls is
configured as its own env var, global infrastructure, never per-tenant:

```
AUTORESPONDER_PUBLIC_BASE_URL
  Development: <https URL of your current public tunnel — never localhost>
  Production:  https://reservanex.com
```

If this isn't set, `/platform/tenants/[id]/whatsapp`'s install guide shows a
clear inline error instead of generating broken endpoint URLs — it never
silently falls back to something wrong. Never hardcode a specific tunnel
URL anywhere in code, a migration, or this doc; tunnels are ephemeral and
must live only in the environment.

### ReservaNex → Android (MacroDroid webhook trigger)

Each `whatsapp_accounts` row has its **own** MacroDroid webhook trigger URL
(placeholder form: `https://trigger.macrodroid.com/<MACRODROID_WEBHOOK_ID>/<MACRO_NAME>`),
configured once from `/platform/tenants/[id]/whatsapp` and never shared
between tenants. Treat it like a bearer token — it lives only in
`whatsapp_accounts.macrodroid_webhook_url` (never logged, never rendered
back to the browser after creation). Not to be confused with
`AUTORESPONDER_PUBLIC_BASE_URL` above — that one is ReservaNex's own address
(Android → ReservaNex), this one is the Android's address (ReservaNex →
Android).

ReservaNex fires this URL as an HTTP GET with query params; the macro must
respond with the literal body `OK` on success.

## Main macro — trigger variables

Configure the webhook trigger to capture these query params as MacroDroid
variables. `rn_action` is present on every request and must be the first
thing the macro branches on — never assume the other params from a previous
execution have been cleared.

| Param | Present when | Notes |
|---|---|---|
| `rn_action` | always | `outbound` \| `media` |
| `rn_phone` | `rn_action=outbound` | destination WhatsApp number |
| `rn_message` | `rn_action=outbound` | message text |
| `rn_outbox_id` | `rn_action=outbound` | UUID — echoed back in the ACK call, Fase 8 |
| `rn_event_id` | `rn_action=media` | UUID of the media event to extract/upload |
| `rn_media_type` | `rn_action=media` | `audio` \| `image` \| `document` |
| `rn_filename` | `rn_action=media`, document only | exact filename to upload |

No macro is ever created from code — it exists physically on the Android.
The superadmin builds it once per device following this doc, then pastes
the URL MacroDroid generates for it into `/platform`.

## Main macro — outbound branch (validated Fase 9 physical E2E: foreground, background, screen-off, post-reboot)

```
IF rn_action = outbound
  IF rn_phone != "" AND rn_message != ""
    Screen On
    Wait 3 seconds
    WhatsApp Send
      phone   = [rn_phone]
      message = [rn_message]
    Wait 3 seconds
    HTTP Request (POST) → {AUTORESPONDER_PUBLIC_BASE_URL}/api/webhooks/autoresponder/outbound-ack
      Header: x-reservanex-device-token = <DEVICE_TOKEN>
      Header: x-reservanex-outbox-id    = [rn_outbox_id]
      (no body required)
```

**Both waits are 3 seconds — neither is cosmetic, and neither should be
shortened without re-validating physically under foreground, background,
screen-off, AND post-reboot conditions, not just one of them.**

- **`Wait 3 seconds` before `WhatsApp Send`**: originally validated at 1
  second (Fase 8), but that was only ever exercised with the device active
  and in the foreground. The Fase 9 physical E2E (unattended operation —
  screen off, apps backgrounded, and after a full reboot) reproduced a real
  failure at 1s: the Android would wake, WhatsApp would open to the correct
  conversation and type the message, but it was left sitting as an unsent
  **draft** — 1 second wasn't reliably enough time for the device to fully
  wake and stabilize before `WhatsApp Send` ran. Raised to 3 seconds, then
  re-validated across all four conditions (foreground, background,
  screen-off, post-reboot) before being accepted as the current contract.
- **`Wait 3 seconds` after `WhatsApp Send`, before the ACK POST**: without
  it, WhatsApp can still show the message as an unsent draft while
  MacroDroid immediately continues to the ACK call, producing a
  false-positive confirmation.

Respond `OK` (exact, case-insensitive on the ReservaNex side) once the
`WhatsApp Send` step itself completes without error, so the trigger caller
gets its own dispatch confirmation independently of the later ACK call.

### Honesty of the ACK

`device_ack_at` (set by a successful outbound-ack call) means exactly "the
macro physically ran past its `WhatsApp Send` action." It is **not** a
WhatsApp delivery or read receipt — this architecture has no access to one.
Never relabel it as "entregado" / "leído" anywhere, in the app or in future
MacroDroid changes.

## Main macro — media branch

All three media types share one branch (`rn_action=media`), discriminated by
`rn_media_type`. Only **documents** get an exact filename from AutoResponder
(`rn_filename`) — audio and image require a "locate the most recently
modified file" shell step first.

### Document (PDF)

```
IF rn_action = media AND rn_media_type = document
  HTTP Request (POST, body = file bytes)
    → {AUTORESPONDER_PUBLIC_BASE_URL}/api/webhooks/autoresponder/media
    Header: x-reservanex-device-token = <DEVICE_TOKEN>
    Header: x-reservanex-event-id     = [rn_event_id]
    Header: x-reservanex-media-type   = document
    Header: x-reservanex-filename     = [rn_filename]
    Content-Type: application/pdf
    File path: {DOCUMENTS_PATH}/[rn_filename]
```

Validated documents folder:
```
/storage/emulated/0/Android/media/com.whatsapp.w4b/WhatsApp Business/Media/WhatsApp Business Documents
```

### Audio (voice notes)

```
IF rn_action = media AND rn_media_type = audio
  Wait 2 seconds
  Shell Script:
    ls -t "{VOICE_NOTES_PATH}"/*/*.opus 2>/dev/null | head -n 1
  Save result → local variable (e.g. rn_audio_path)
  HTTP Request (POST, body = file at [rn_audio_path])
    → {AUTORESPONDER_PUBLIC_BASE_URL}/api/webhooks/autoresponder/media
    Header: x-reservanex-device-token = <DEVICE_TOKEN>
    Header: x-reservanex-event-id     = [rn_event_id]
    Header: x-reservanex-media-type   = audio
    Content-Type: audio/ogg
```

Validated voice notes folder (note the extra date-subfolder level — hence
`*/*.opus`, not `*.opus`):
```
/storage/emulated/0/Android/media/com.whatsapp.w4b/WhatsApp Business/Media/WhatsApp Business Voice Notes
```

### Image

```
IF rn_action = media AND rn_media_type = image
  Wait 2 seconds
  Shell Script:
    ls -t "{IMAGES_PATH}"/*.jpg 2>/dev/null | head -n 1
  Save result → local variable (e.g. rn_image_path)
  HTTP Request (POST, body = file at [rn_image_path])
    → {AUTORESPONDER_PUBLIC_BASE_URL}/api/webhooks/autoresponder/media
    Header: x-reservanex-device-token = <DEVICE_TOKEN>
    Header: x-reservanex-event-id     = [rn_event_id]
    Header: x-reservanex-media-type   = image
    Content-Type: image/jpeg
```

Validated images folder:
```
/storage/emulated/0/Android/media/com.whatsapp.w4b/WhatsApp Business/Media/WhatsApp Business Images
```

If a device's WhatsApp Business installs to a different folder, the
`/platform` install guide's path generator lets you edit these three paths
and regenerates the two shell one-liners and the document template from
whatever you type — it validates strictly (must stay under
`/storage/emulated/0/`, rejects newlines/null bytes/shell metacharacters)
before showing a result, so a bad path never produces something unsafe to
paste into MacroDroid.

Accepted formats (server-side allowlist, both MIME type and magic bytes are
checked): audio → `.ogg`/Opus; image → `.jpg`/JPEG; document → `.pdf` only.
A JPEG sent through the document branch, or any other document extension,
is rejected — see backlog item **F**.

"Most recent file in the folder" is the only extraction mechanism currently
in use for audio/image — there is no filename handed back by AutoResponder
for those. A media dispatch and an outbound text dispatch for the **same
account** are deliberately never allowed to run concurrently (the shared
`device_dispatch_reserved_until` lease), which is what keeps this
race-prone approach safe today. See backlog item **D** for hardening this
under heavier physical concurrency.

## Heartbeat macro (separate macro, periodic trigger — not the webhook macro)

A second, independent MacroDroid macro on a periodic/interval trigger (not
tied to any WhatsApp event) that simply POSTs:

```
POST {AUTORESPONDER_PUBLIC_BASE_URL}/api/webhooks/autoresponder/heartbeat
  Header: x-reservanex-device-token = <DEVICE_TOKEN>
  (no body)
```

Suggested macro name (not technically relevant): `ReservaNex - Heartbeat`.

Interval: every 2 minutes — comfortably under the platform's 5-minute
"online" threshold, without firing so often it's wasteful. This is the
**only** thing that should ever update `whatsapp_accounts.last_device_seen_at`
on a schedule; a successful outbound-ack call also updates it (real physical
evidence from the Android), but the trigger-cloud accepting an outbound
dispatch request does **not** — that only proves `trigger.macrodroid.com`
itself is reachable, not that the Android received anything. Expected
result: `200 {ok:true}`, and the device shows "Online" in `/platform`.

## Preparing the Android

**Validated** = confirmed physically on the pilot device: **Samsung
SM-A135M, Android 14**. **General** = standard Android recommendation, not
confirmed on other manufacturers or Android versions — do not assume every
OEM's battery/background UI matches Samsung's, and do not claim this
guide's specific steps are universal. A different model/OEM/Android version
needs its own equivalent physical acceptance pass before being trusted the
same way.

- Dedicated device — not used for anything else.
- WhatsApp Business, AutoResponder for WA, MacroDroid installed.
- Permanent internet connection (WiFi or mobile data).
- Constant power or enough battery for continuous, unattended operation.
- No aggressive battery restrictions on MacroDroid, AutoResponder, or
  WhatsApp Business — each must be allowed to run in the background without
  limits.
- MacroDroid: accessibility permission + "display over other apps" granted.
- AutoResponder: notification access granted (this is how it detects
  incoming WhatsApp Business messages).
- WhatsApp Business: notifications enabled.
- **No PIN / pattern / password lock screen.** `WhatsApp Send` automation
  needs to interact with the screen unattended — a lock screen blocks it.
  Not evaluated with biometric-only unlock; do not assume it works without
  testing it physically first. The device is dedicated to this service, so
  this is an acceptable tradeoff here — never suggest it for a personal
  phone.
- **Do not save customer contacts on this device.** AutoResponder can
  resolve a sender's phone number to a saved contact name instead of the
  raw number — the current inbound parser only accepts a phone-number-
  shaped sender (`resolveAutoResponderSender()` in
  `apps/web/src/lib/autoresponder-webhook.ts` /
  `apps/worker/src/providers/autoresponder/inbound.ts`) and rejects
  anything else (recorded as `inbound_rejections`, never silently dropped).
  A contact name would be rejected outright today.

**Samsung-specific (validated):** in addition to the above, Samsung
typically requires individually disabling "Put unused apps to sleep" and
"Optimize battery usage" for MacroDroid, AutoResponder, and WhatsApp
Business (Settings → Battery and device care → Background usage limits),
and adding all three to "Never sleeping apps."

### Physical E2E result (Samsung SM-A135M, Android 14)

With the settings above applied, all of the following were confirmed
physically working — not assumed:

| Condition | heartbeat | inbound | AI outbound | human outbound | outbound ACK | media (image/audio/PDF) |
|---|---|---|---|---|---|---|
| Foreground | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Background (MacroDroid/AutoResponder/WhatsApp Business minimized, screen off) | ✅ | ✅ | ✅ | ✅ | ✅ | not re-tested separately — see post-reboot row |
| After a full reboot, **without opening any app manually** | ✅ (recovered on its own) | ✅ | ✅ | ✅ | ✅ | ✅ |

This is real evidence for this specific device/OS combination, not a
general guarantee — see the "Validated vs. General" note above.

## Setup checklist (per tenant)

1. From `/platform/tenants/[id]/whatsapp`, create the AutoResponder account
   (phone number, MacroDroid webhook URL) — this generates and shows the
   raw device token **once**. Copy it immediately; it is never shown again
   (only its hash is stored). If it's lost, the only recovery is rotating
   to a new one — there is no "show token again."
2. On the Android: install/open AutoResponder for WA, point its rule at the
   MacroDroid webhook trigger.
3. Build the main macro exactly as above (`rn_action` branch first).
4. Build the heartbeat macro as its own periodic trigger.
5. Send a real test message to the WhatsApp Business number → confirm the
   inbound webhook fires and the CRM conversation appears.
6. Send a reply from the CRM → confirm the outbound branch fires, WhatsApp
   physically sends, and the CRM eventually shows "Ejecutado en
   dispositivo" (Fase 8 outbound ACK).
7. Confirm `/platform/tenants/[id]/whatsapp` shows the device as online
   after the heartbeat macro's first run.
8. Test media: send an image, a voice note, and a PDF from a real WhatsApp
   number → confirm all three appear in the CRM conversation.
9. Repeat 5-8 with the screen off, then with MacroDroid/AutoResponder/
   WhatsApp Business minimized/in the background. Confirmed working on the
   validated device (see the table above) — still verify it on any new
   device, this is not assumed to be universal.
10. Reboot the Android **without opening any app manually**. On the
    validated device, heartbeat, inbound, AI outbound, human outbound,
    ACK, and media all recovered on their own within a few minutes —
    treat that as the expected outcome to reproduce, not a guarantee. If
    something doesn't come back by itself on a different device, diagnose
    the specific Android setting before adding any workaround (see the
    "Preparing the Android" battery/background section above) — never add
    an "On Boot" macro blindly as a first fix.

## Known limitations (see `docs/backlog.md` for the full list)

- No realtime update of the ACK status inside an open CRM conversation —
  requires a refresh/reconnect (backlog H).
- Audio/image extraction relies on "most recent file in the folder," which
  is not safe under heavy physical concurrency on the same device (backlog D).
- A JPEG sent through the document branch is rejected rather than
  reclassified as an image (backlog F).

## Security notes

- Never commit a real device token, MacroDroid webhook URL, or
  `AUTORESPONDER_PUBLIC_BASE_URL` tunnel value anywhere in this repository —
  not in code, not in a migration, not in a script, not in this file.
- Rotating a device token (from `/platform`) invalidates the old one
  immediately — update the macro's header value on the Android right after
  rotating, or the device goes silent until it's updated.
- `cleanup-auth-users.ts` (`apps/web/scripts/`) is a **dev-only, high-risk**
  script (it can delete auth users broadly) — never run it against a
  tenant with real users, and never as part of any customer-facing reset
  flow. The tenant reset/purge flow used from `/platform` is a completely
  separate, tenant-scoped, audited mechanism (`admin_purge_tenant` +
  Storage cleanup) — see `apps/web/src/lib/repositories/tenant-storage.repository.ts`.
- No MDM, Android Enterprise, ADB automation, remote MacroDroid
  configuration, or self-service Android setup exists or is planned for
  this phase — every step above is manual, by design, until real volume
  justifies that investment.
