# ICFNA — Extensión Chrome de Grabación y Publicación de Prédicas (R2 + RSS)

Extensión **Manifest V3** independiente (no modifica el repositorio del sitio web) que graba únicamente el **audio** en Google Meet, lo convierte a **MP3 (64 kbps mono)** en tu PC y sube directamente el audio + portada (`cover.png`) + catálogo (`catalog.json`) + feed **`podcast.xml`** a tu bucket de **Cloudflare R2 (`icfna-predicas`)**.

---

## 1. Cargar gratis en Google Chrome (sin pagar los US\$5 de la tienda)

1. Abre Google Chrome y escribe en la barra de direcciones: `chrome://extensions`
2. Activa arriba a la derecha **Modo de desarrollador** (*Developer mode*).
3. Haz clic en **Cargar descomprimida** (*Load unpacked*).
4. Selecciona la carpeta: `F:\Proyectos\cyl\icfna\extension`
5. Fija el ícono de **ICFNA Audio** en la barra de Chrome (clic en el ícono de rompecabezas → chincheta).

---

## 2. Crear las llaves de Cloudflare R2 (1 sola vez, 30 segundos)

1. Entra a tu panel de Cloudflare → **R2 Object Storage**.
2. A la derecha haz clic en **Manage R2 API Tokens** → **Create API Token**.
3. Configura el token así:
   * **Token name:** `icfna-extension-upload`
   * **Permissions:** `Object Read & Write`
   * **Specify bucket(s):** selecciona **solo** `icfna-predicas` *(máxima seguridad)*.
4. Clic en **Create API Token** y copia los 2 valores que aparecen una sola vez:
   * **Access Key ID**
   * **Secret Access Key**
5. Abre el panel lateral de la extensión **ICFNA Audio** → pestaña **Config R2** y pega:
   * **Cloudflare Account ID** *(aparece en la barra lateral de R2 o en la URL del panel de Cloudflare)*
   * **R2 Access Key ID**
   * **R2 Secret Access Key**
   * **Bucket Name:** `icfna-predicas` *(ya prellenado)*
   * **Public Development URL:** `https://pub-b289a1bcfd614dd4a3877ba3e1c0a41c.r2.dev` *(ya prellenado)*
6. Haz clic en **Guardar configuración** → **Probar conexión con R2** → **Subir portada (`cover.png`) e inicializar `podcast.xml`**.

---

## 3. Conectar tu feed `podcast.xml` a YouTube, Spotify e iVoox (1 sola vez)

Tu enlace oficial del feed quedará activo 24/7 en:
`https://pub-b289a1bcfd614dd4a3877ba3e1c0a41c.r2.dev/podcast.xml`

* **YouTube (`@ICFNA`):** Entra a `studio.youtube.com` → **Contenido** → **Podcasts** → **Nuevo podcast** → **Enviar feed RSS** → pega tu enlace `podcast.xml`. YouTube generará el video automáticamente con la portada oficial (`cover.png`) cada vez que subas una prédica.
* **Spotify:** Entra a `creators.spotify.com` → agrega tu podcast con el mismo enlace `podcast.xml`.
* **iVoox:** Entra a tu cuenta de creador → **Subir desde RSS** → pega el mismo enlace `podcast.xml`.

---

## 4. Uso en cada servicio

1. Abre tu reunión en **Google Meet** (el ícono mostrará la etiqueta azul `MEET`).
2. Haz clic en el ícono de **ICFNA Audio** para abrir el panel lateral.
3. Elige **Solo Micrófono / Consola** (servicios presenciales del domingo/miércoles) o **Micrófono + Audio de Meet** (servicios online).
4. Escribe el **Título** y **Predicador** y presiona **Iniciar grabación de audio**.
5. Al presionar **Detener y convertir a MP3** (o al cerrar la pestaña de Meet si dejaste activa la opción automática), la extensión codifica el MP3, lo sube a R2 y actualiza `podcast.xml` automáticamente.
