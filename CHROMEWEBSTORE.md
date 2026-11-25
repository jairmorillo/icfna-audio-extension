# Chrome Web Store Listing — ICFNA — Grabador y Publicador de Prédicas

> Last Updated: 2026-11-22

## Store Listing

**Extension Name** [REQUIRED]
ICFNA — Grabador y Publicador de Prédicas

**Short Description** [REQUIRED]
Graba solo audio de los servicios en Google Meet, genera MP3 y actualiza automáticamente podcast.xml en Cloudflare R2.

**Detailed Description** [REQUIRED]
Graba únicamente el audio de los servicios y estudios bíblicos transmitidos por Google Meet, conviértelo automáticamente a MP3 y publícalo en el feed de podcast de la congregación sin depender de video ni edición manual.

Funciones principales:
Graba desde el micrófono o consola de la computadora, o mezcla micrófono y audio de la pestaña de Google Meet para servicios en línea.
Guarda fragmentos locales de respaldo de forma continua para recuperar el audio ante cierres inesperados o cortes de energía.
Convierte la grabación a un archivo MP3 liviano optimizado para voz directamente en el equipo.
Sube el MP3, la portada oficial y el archivo podcast.xml directamente al depósito de Cloudflare R2 configurado por el operador para alimentar YouTube Podcasts, Spotify e iVoox.
También permite subir archivos MP3 ya grabados y descargar copias locales del audio.

Cómo usarla:
1. Abre la pestaña Config R2 e introduce tus credenciales locales de Cloudflare R2 (Account ID, Access Key ID, Secret Access Key y nombre del depósito).
2. Al abrir una reunión en Google Meet, haz clic en el ícono de la extensión para abrir el panel lateral.
3. Selecciona la fuente de audio, verifica el título de la prédica y presiona Iniciar grabación.
4. Al finalizar el servicio o cerrar Google Meet, la extensión convierte el audio a MP3 y actualiza tu feed podcast.xml.

Privacidad y transparencia:
La extensión nunca graba de forma oculta ni automática sin que el usuario inicie la grabación. Tus credenciales de Cloudflare R2 se almacenan únicamente en el navegador local y los archivos se envían directamente al depósito que tú configures, sin intermediarios ni servidores de terceros.

Soporte: icfnuevoamanecer@gmail.com

**Category** [REQUIRED]
Productivity

**Single Purpose** [REQUIRED]
Record audio from Google Meet church services, encode it to MP3 locally, and publish it directly to the user's configured Cloudflare R2 podcast bucket.

**Primary Language** [REQUIRED]
Spanish (Latin America)

## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|-------|-----------|--------|----------|
| Store Icon [REQUIRED] | 128×128 PNG | ✅ Ready | `icons/icon-128.png` |
| Screenshot 1 [REQUIRED] | 1280×800 or 640×400 | ⬜ Not created | *(Capturar panel lateral junto a Google Meet)* |
| Screenshot 2 [RECOMMENDED] | 1280×800 or 640×400 | ⬜ Not created | *(Capturar pestaña Episodios con podcast.xml)* |
| Small Promo Tile [RECOMMENDED] | 440×280 | ⬜ Not created | |

## Permissions Justification

| Permission | Type | Justification |
|------------|------|---------------|
| `sidePanel` | permissions | Displays the persistent recording controls, live audio level meter, sermon metadata form, episode list, and R2 settings alongside Google Meet without closing when the user interacts with the meeting. |
| `offscreen` | permissions | Performs audio capture, real-time microphone/tab mixing, crash-safe local audio persistence, and local MP3 encoding in the background even if the user collapses the side panel during a long service. |
| `tabCapture` | permissions | Captures the audio stream of the active Google Meet tab when the operator explicitly selects the "Micrófono + Audio de Meet" recording mode for online services. |
| `tabs` | permissions | Detects when a Google Meet tab (`https://meet.google.com/*`) is opened so the badge indicates readiness, and detects when that Meet tab closes to trigger the optional auto-stop recording feature. |
| `storage` | permissions | Stores the operator's local Cloudflare R2 bucket configuration (in `chrome.storage.local`) and temporary recording session state (in `chrome.storage.session`). |
| `downloads` | permissions | Allows the operator to save a local `.mp3` backup copy of any recorded sermon to their computer via the "Descargar MP3" button. |
| `notifications` | permissions | Notifies the operator when a recording finishes converting to MP3 or finishes uploading to Cloudflare R2 and updating `podcast.xml`. |
| `https://meet.google.com/*` | host_permissions | Restricts Google Meet detection and tab audio capture strictly to Google Meet meetings. |
| `https://*.r2.cloudflarestorage.com/*` | host_permissions | Allows direct signed uploads of MP3 audio files, cover artwork, `catalog.json`, and `podcast.xml` to the user's own Cloudflare R2 bucket without third-party servers. |
| `https://*.r2.dev/*` | host_permissions | Allows reading the public `catalog.json` from the user's Cloudflare R2 bucket to list published episodes in the side panel. |

## Privacy & Data Use

### Data Collection

**Does the extension collect user data?** Yes (only user-initiated audio recordings and operator-provided R2 credentials stored locally)

| Data Type | Collected? | Transmitted Off-Device? | Purpose | Shared with Third Parties? |
|-----------|-----------|------------------------|---------|---------------------------|
| Personally identifiable info | No | No | — | No |
| Health info | No | No | — | No |
| Financial info | No | No | — | No |
| Authentication info | Yes (R2 API keys entered by user) | Only used locally to sign requests to user's own Cloudflare R2 bucket | Authenticate direct uploads to the user's own Cloudflare R2 storage | No |
| Personal communications | Yes (audio explicitly recorded by user during a service) | Only uploaded directly to the user's own Cloudflare R2 bucket when initiated by user | Publish recorded church sermons to the congregation's podcast feed | No |
| Location | No | No | — | No |
| Web history | No | No | — | No |
| User activity | No | No | — | No |
| Website content | No | No | — | No |

### Data Use Certification
- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes

## Privacy Policy

**Privacy Policy URL** [REQUIRED]
*(Publicar página de privacidad simple antes de enviar a la Chrome Web Store — no requerida para uso gratuito en Modo Desarrollador)*

## Distribution

**Visibility**: Unlisted *(recomendado para equipo interno de ICFNA)*
**Regions**: All regions

## Developer Info

**Publisher Name** [REQUIRED]
Iglesia Comunidad de Fe Nuevo Amanecer (ICFNA)

**Contact Email** [REQUIRED]
icfnuevoamanecer@gmail.com

**Support URL / Email** [RECOMMENDED]
icfnuevoamanecer@gmail.com

## Version History

| Version | Date | Changes | Status |
|---------|------|---------|--------|
| 1.0.0 | 2026-11-22 | Versión inicial Manifest V3: grabación solo audio en Meet, respaldo local anti-apagones, codificación MP3, subida directa SigV4 a Cloudflare R2 y generación de `podcast.xml`. | Draft |

## Packaging Command (Exclude Dev Docs Before Upload)
When creating the `.zip` for Chrome Web Store, include ONLY:
`manifest.json`, `icons/`, `assets/`, `lib/`, `shared/`, `background/`, `offscreen/`, `sidepanel/`
Exclude: `CHROMEWEBSTORE.md`, `README.md`, `.git/`.
