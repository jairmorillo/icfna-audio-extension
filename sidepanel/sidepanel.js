import {
  assembleMp3FromChunks,
  clearActiveSessionMeta,
  clearAudioChunks,
  clearReadyMp3,
  getActiveSessionMeta,
  getAllAudioChunks,
  getReadyMp3,
  inspectPendingChunks,
  saveReadyMp3,
} from "../shared/idb-store.js";
import {
  initializePodcastBucket,
  publishMp3Episode,
  removePublishedEpisode,
} from "../shared/publisher.js";
import { getR2Json, testR2Connection } from "../shared/r2-client.js";
import { PODCAST_DEFAULTS, slugifyFilename } from "../shared/rss-builder.js";

const elements = {
  meetBadge: document.getElementById("meet-badge"),
  statusBanner: document.getElementById("status-banner"),
  tabs: Array.from(document.querySelectorAll(".tab")),
  panels: {
    record: document.getElementById("tab-record"),
    episodes: document.getElementById("tab-episodes"),
    settings: document.getElementById("tab-settings"),
  },
  recoveryCard: document.getElementById("recovery-card"),
  recoveryTitle: document.getElementById("recovery-title"),
  recoveryDetail: document.getElementById("recovery-detail"),
  btnRecover: document.getElementById("btn-recover"),
  btnDownloadRaw: document.getElementById("btn-download-raw"),
  btnDiscardChunks: document.getElementById("btn-discard-chunks"),
  recordingIndicator: document.getElementById("recording-indicator"),
  timerDisplay: document.getElementById("timer-display"),
  levelBar: document.getElementById("level-bar"),
  backupStatus: document.getElementById("backup-status"),
  chkAutoStop: document.getElementById("chk-auto-stop"),
  chkAutoUpload: document.getElementById("chk-auto-upload"),
  chkAutoBackup: document.getElementById("chk-auto-backup"),
  selectBackupMinutes: document.getElementById("select-backup-minutes"),
  btnStart: document.getElementById("btn-start"),
  btnStop: document.getElementById("btn-stop"),
  inputTitle: document.getElementById("input-title"),
  inputPreacher: document.getElementById("input-preacher"),
  inputScripture: document.getElementById("input-scripture"),
  inputDescription: document.getElementById("input-description"),
  readyMp3Card: document.getElementById("ready-mp3-card"),
  readyMp3Meta: document.getElementById("ready-mp3-meta"),
  readyAudioPlayer: document.getElementById("ready-audio-player"),
  btnPublishReady: document.getElementById("btn-publish-ready"),
  btnDownloadReady: document.getElementById("btn-download-ready"),
  btnDiscardReady: document.getElementById("btn-discard-ready"),
  fileMp3Input: document.getElementById("file-mp3-input"),
  btnUploadFile: document.getElementById("btn-upload-file"),
  rssUrlDisplay: document.getElementById("rss-url-display"),
  btnCopyRss: document.getElementById("btn-copy-rss"),
  btnRefreshEpisodes: document.getElementById("btn-refresh-episodes"),
  episodesList: document.getElementById("episodes-list"),
  cfgAccountId: document.getElementById("cfg-account-id"),
  cfgAccessKey: document.getElementById("cfg-access-key"),
  cfgSecretKey: document.getElementById("cfg-secret-key"),
  cfgBucket: document.getElementById("cfg-bucket"),
  cfgPublicUrl: document.getElementById("cfg-public-url"),
  btnSaveConfig: document.getElementById("btn-save-config"),
  btnTestR2: document.getElementById("btn-test-r2"),
  btnInitR2: document.getElementById("btn-init-r2"),
};

let currentReadyObjectUrl = null;
let timerIntervalId = null;
let pendingInspection = null;
let activeSessionState = null;

function formatElapsed(totalSeconds) {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

function formatMegabytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function defaultSermonTitle() {
  const now = new Date();
  const formatted = new Intl.DateTimeFormat("es-VE", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(now);
  const day = now.getDay();
  if (day === 0) return `Servicio Especial Familiar — ${formatted}`;
  if (day === 1) return `Servicio de Mujeres — ${formatted}`;
  if (day === 2) return `Servicio de Hombres (Real Sacerdocio) — ${formatted}`;
  if (day === 3) return `Servicio de Adoración, Sanidad y Milagros — ${formatted}`;
  if (day === 4) return `Estudio Bíblico — ${formatted}`;
  if (day === 6) return `Ayuno y Oración — ${formatted}`;
  return `Servicio ICFNA — ${formatted}`;
}

function showBanner(text, type = "info") {
  elements.statusBanner.textContent = text;
  elements.statusBanner.className = `banner banner-${type}`;
}

function clearBanner() {
  elements.statusBanner.className = "banner hidden";
  elements.statusBanner.textContent = "";
}

function getSelectedCaptureMode() {
  const checked = document.querySelector('input[name="captureMode"]:checked');
  return checked ? checked.value : "mic_only";
}

function readMetadataFromForm() {
  return {
    title: elements.inputTitle.value.trim() || defaultSermonTitle(),
    preacher: elements.inputPreacher.value.trim() || PODCAST_DEFAULTS.author,
    scripture: elements.inputScripture.value.trim(),
    description: elements.inputDescription.value.trim(),
  };
}

function applySavedMetadataToForm(savedMeta) {
  if (!savedMeta) return;
  if (savedMeta.title) elements.inputTitle.value = savedMeta.title;
  if (savedMeta.preacher && savedMeta.preacher !== PODCAST_DEFAULTS.author) {
    elements.inputPreacher.value = savedMeta.preacher;
  }
  if (savedMeta.scripture) elements.inputScripture.value = savedMeta.scripture;
  if (savedMeta.description) elements.inputDescription.value = savedMeta.description;
}

async function getStoredR2Config() {
  const { r2Config } = await chrome.storage.local.get("r2Config");
  return {
    accountId: r2Config?.accountId || "",
    accessKeyId: r2Config?.accessKeyId || "",
    secretAccessKey: r2Config?.secretAccessKey || "",
    bucketName: r2Config?.bucketName || PODCAST_DEFAULTS.defaultBucket,
    publicUrl: r2Config?.publicUrl || PODCAST_DEFAULTS.defaultPublicUrl,
  };
}

function readR2ConfigFromForm() {
  return {
    accountId: elements.cfgAccountId.value.trim(),
    accessKeyId: elements.cfgAccessKey.value.trim(),
    secretAccessKey: elements.cfgSecretKey.value.trim(),
    bucketName: elements.cfgBucket.value.trim() || PODCAST_DEFAULTS.defaultBucket,
    publicUrl:
      elements.cfgPublicUrl.value.trim().replace(/\/+$/, "") ||
      PODCAST_DEFAULTS.defaultPublicUrl,
  };
}

async function loadBackupPrefs() {
  const { backupPrefs } = await chrome.storage.local.get("backupPrefs");
  const enabled = Boolean(backupPrefs?.enabled);
  const minutes = String(backupPrefs?.minutes || 15);
  elements.chkAutoBackup.checked = enabled;
  elements.selectBackupMinutes.value = minutes;
  elements.selectBackupMinutes.disabled = !enabled;
}

async function saveBackupPrefs() {
  const enabled = elements.chkAutoBackup.checked;
  const minutes = Number(elements.selectBackupMinutes.value) || 15;
  elements.selectBackupMinutes.disabled = !enabled;
  await chrome.storage.local.set({
    backupPrefs: { enabled, minutes },
  });
}

function renderBackupStatus(state, partsOverride = null) {
  if (state?.recordingState !== "recording") {
    elements.backupStatus.classList.add("hidden");
    elements.backupStatus.textContent = "";
    return;
  }

  const parts =
    partsOverride !== null ? partsOverride : Number(state.backupPartsSaved) || 0;

  if (state.autoBackupEnabled) {
    const partsText =
      parts === 1 ? "1 parte guardada" : `${parts} partes guardadas`;
    elements.backupStatus.textContent = `MP3 en vivo (cada 5s) · Auto-descarga cada ${state.autoBackupMinutes} min (${partsText})`;
  } else {
    elements.backupStatus.textContent =
      "Respaldo MP3 en vivo activo (guardando bloques cada 5s)";
  }
  elements.backupStatus.classList.remove("hidden");
}

function updateRecordingUi(state, meetTab) {
  activeSessionState = state;
  const isRecording = state.recordingState === "recording";
  const isBusy =
    state.recordingState === "starting" || state.recordingState === "stopping";

  elements.chkAutoBackup.disabled = isRecording || isBusy;
  elements.selectBackupMinutes.disabled =
    isRecording || isBusy || !elements.chkAutoBackup.checked;

  if (isRecording) {
    elements.meetBadge.textContent = "GRABANDO";
    elements.meetBadge.className = "pill pill-rec";
    elements.recordingIndicator.textContent = "Grabando MP3 en vivo...";
    elements.recordingIndicator.className = "indicator-rec";
    elements.btnStart.classList.add("hidden");
    elements.btnStop.classList.remove("hidden");
    elements.btnStop.disabled = false;
    renderBackupStatus(state);

    if (timerIntervalId) clearInterval(timerIntervalId);
    timerIntervalId = setInterval(() => {
      if (!state.startedAt) return;
      const elapsed = Math.floor((Date.now() - state.startedAt) / 1000);
      elements.timerDisplay.textContent = formatElapsed(elapsed);
    }, 500);
    return;
  }

  if (timerIntervalId) {
    clearInterval(timerIntervalId);
    timerIntervalId = null;
  }

  elements.levelBar.style.width = "0%";
  elements.btnStart.classList.remove("hidden");
  elements.btnStop.classList.add("hidden");
  elements.btnStart.disabled = isBusy;
  elements.recordingIndicator.textContent = isBusy
    ? "Finalizando MP3..."
    : "Listo para grabar";
  elements.recordingIndicator.className = "indicator-idle";
  renderBackupStatus(state);

  if (meetTab) {
    elements.meetBadge.textContent = "Meet activo";
    elements.meetBadge.className = "pill pill-meet";
  } else {
    elements.meetBadge.textContent = "Sin Meet";
    elements.meetBadge.className = "pill pill-muted";
  }
}

async function refreshReadyMp3Card() {
  const ready = await getReadyMp3();
  if (currentReadyObjectUrl) {
    URL.revokeObjectURL(currentReadyObjectUrl);
    currentReadyObjectUrl = null;
  }

  if (!ready?.blob) {
    elements.readyMp3Card.classList.add("hidden");
    return;
  }

  currentReadyObjectUrl = URL.createObjectURL(ready.blob);
  elements.readyAudioPlayer.src = currentReadyObjectUrl;
  elements.readyMp3Meta.textContent = `Duración: ${formatElapsed(
    ready.durationSeconds
  )} · Tamaño: ${formatMegabytes(ready.sizeBytes)}`;
  elements.readyMp3Card.classList.remove("hidden");
}

async function refreshRecoveryCard(recordingState) {
  if (recordingState !== "idle") {
    elements.recoveryCard.classList.add("hidden");
    return;
  }

  const inspection = await inspectPendingChunks();
  pendingInspection = inspection;

  if (!inspection.hasPending) {
    elements.recoveryCard.classList.add("hidden");
    return;
  }

  if (inspection.format === "mp3") {
    elements.recoveryTitle.textContent = "Grabación MP3 interrumpida detectada";
    elements.recoveryDetail.textContent = `Respaldo listo: ~${formatElapsed(
      inspection.durationSeconds
    )} · ${formatMegabytes(inspection.totalBytes)} (${
      inspection.count
    } bloques). Se recupera al instante sin decodificar.`;
    elements.btnRecover.textContent = "Recuperar MP3 al instante";
    elements.btnRecover.className = "btn btn-amber";
    elements.btnDownloadRaw.textContent = "Descargar MP3 directo";
    elements.btnDownloadRaw.className = "btn btn-secondary";
  } else {
    elements.recoveryTitle.textContent = "Grabación anterior (WebM) detectada";
    elements.recoveryDetail.textContent = `${formatMegabytes(
      inspection.totalBytes
    )} (${
      inspection.count
    } fragmentos). Descarga el .webm crudo para rescatarla sin errores y luego conviértela a MP3.`;
    elements.btnDownloadRaw.textContent = "Descargar .webm crudo";
    elements.btnDownloadRaw.className = "btn btn-amber";
    elements.btnRecover.textContent = "Intentar convertir a MP3";
    elements.btnRecover.className = "btn btn-secondary";
  }

  elements.recoveryCard.classList.remove("hidden");
}

async function checkMicPermissionGranted() {
  try {
    const status = await navigator.permissions.query({ name: "microphone" });
    return status.state === "granted";
  } catch {
    return false;
  }
}

async function openMicPermissionTab() {
  await chrome.tabs.create({
    url: chrome.runtime.getURL("permissions/mic.html"),
    active: true,
  });
}

async function syncState() {
  const response = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  if (!response?.ok) return;
  updateRecordingUi(response.state, response.meetTab);
  await refreshRecoveryCard(response.state.recordingState);
  await refreshReadyMp3Card();
}

async function loadConfigForm() {
  const config = await getStoredR2Config();
  elements.cfgAccountId.value = config.accountId;
  elements.cfgAccessKey.value = config.accessKeyId;
  elements.cfgSecretKey.value = config.secretAccessKey;
  elements.cfgBucket.value = config.bucketName;
  elements.cfgPublicUrl.value = config.publicUrl;
  elements.rssUrlDisplay.textContent = `${config.publicUrl.replace(/\/+$/, "")}/podcast.xml`;
}

async function loadEpisodesTab() {
  const config = await getStoredR2Config();
  const baseUrl = config.publicUrl.replace(/\/+$/, "");
  elements.rssUrlDisplay.textContent = `${baseUrl}/podcast.xml`;
  elements.episodesList.innerHTML = `<p class="muted">Cargando episodios...</p>`;

  try {
    let catalog = null;
    if (config.accountId && config.accessKeyId && config.secretAccessKey) {
      catalog = await getR2Json(config, "catalog.json");
    } else {
      const publicResp = await fetch(`${baseUrl}/catalog.json?t=${Date.now()}`);
      if (publicResp.ok) {
        catalog = await publicResp.json();
      }
    }

    const episodes = Array.isArray(catalog?.episodes) ? catalog.episodes : [];
    if (episodes.length === 0) {
      elements.episodesList.innerHTML = `<div class="card"><p class="muted">Aún no hay prédicas publicadas en R2. Graba o sube tu primer MP3 para generar el catálogo y el feed podcast.xml.</p></div>`;
      return;
    }

    elements.episodesList.innerHTML = "";
    for (const ep of episodes) {
      const card = document.createElement("article");
      card.className = "episode-item";

      const title = document.createElement("h3");
      title.className = "episode-title";
      title.textContent = ep.title;

      const meta = document.createElement("p");
      meta.className = "episode-meta";
      const dateStr = new Intl.DateTimeFormat("es-VE", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      }).format(new Date(ep.publishedAt));
      meta.textContent = `${dateStr} · ${ep.preacher || "ICFNA"} · ${formatElapsed(
        ep.durationSeconds
      )} · ${formatMegabytes(ep.sizeBytes)}`;

      const actions = document.createElement("div");
      actions.className = "row-actions";

      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "btn btn-secondary";
      copyBtn.textContent = "Copiar enlace MP3";
      copyBtn.addEventListener("click", async () => {
        await navigator.clipboard.writeText(ep.audioUrl);
        showBanner("Enlace MP3 copiado para compartir por WhatsApp.", "success");
      });

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "btn btn-ghost";
      delBtn.textContent = "Eliminar";
      delBtn.addEventListener("click", async () => {
        const confirmed = window.confirm(
          `¿Eliminar "${ep.title}" de R2 y actualizar podcast.xml?`
        );
        if (!confirmed) return;
        try {
          showBanner("Eliminando episodio y regenerando podcast.xml...", "info");
          await removePublishedEpisode(config, ep.id);
          showBanner("Episodio eliminado y podcast.xml actualizado.", "success");
          await loadEpisodesTab();
        } catch (err) {
          showBanner(
            err instanceof Error ? err.message : String(err),
            "error"
          );
        }
      });

      actions.append(copyBtn, delBtn);
      card.append(title, meta, actions);
      elements.episodesList.append(card);
    }
  } catch (err) {
    elements.episodesList.innerHTML = `<div class="card"><p class="muted">${
      err instanceof Error ? err.message : String(err)
    }</p></div>`;
  }
}

function getAudioFileDuration(file) {
  return new Promise((resolve) => {
    const audio = document.createElement("audio");
    const url = URL.createObjectURL(file);
    audio.preload = "metadata";
    audio.onloadedmetadata = () => {
      const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
      URL.revokeObjectURL(url);
      resolve(Math.round(duration));
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(0);
    };
    audio.src = url;
  });
}

async function handleInstantMp3Recovery() {
  const chunks = await getAllAudioChunks();
  const savedSession = await getActiveSessionMeta();
  const { mp3Blob, durationSeconds } = assembleMp3FromChunks(chunks);

  if (savedSession?.metadata) {
    applySavedMetadataToForm(savedSession.metadata);
  }

  const metadata = readMetadataFromForm();
  await saveReadyMp3({
    blob: mp3Blob,
    sizeBytes: mp3Blob.size,
    durationSeconds,
    createdAt: savedSession?.startedAt || new Date().toISOString(),
    metadata,
  });
  await clearAudioChunks();
  await clearActiveSessionMeta();

  showBanner(
    `¡MP3 recuperado al instante! (${formatElapsed(
      durationSeconds
    )} · ${formatMegabytes(mp3Blob.size)}). Ya puedes escucharlo, descargarlo o subirlo a R2.`,
    "success"
  );
  await syncState();
}

async function handleDownloadRawBackup() {
  const chunks = await getAllAudioChunks();
  if (!chunks.length) {
    showBanner("No hay fragmentos guardados para descargar.", "error");
    return;
  }

  const savedSession = await getActiveSessionMeta();
  const titleBase =
    savedSession?.metadata?.title ||
    elements.inputTitle.value.trim() ||
    "rescate-predica-icfna";
  const dateIso = savedSession?.startedAt || new Date().toISOString();
  const slug = slugifyFilename(titleBase, dateIso);

  let blob;
  let filename;

  if (pendingInspection?.format === "mp3") {
    const { mp3Blob } = assembleMp3FromChunks(chunks);
    blob = mp3Blob;
    filename = `${slug}-recuperado.mp3`;
  } else {
    blob = new Blob(chunks, { type: chunks[0]?.type || "audio/webm" });
    filename = `${slug}-rescate.webm`;
  }

  const url = URL.createObjectURL(blob);
  const res = await chrome.runtime.sendMessage({
    type: "DOWNLOAD_URL",
    url,
    filename,
    saveAs: true,
  });
  setTimeout(() => URL.revokeObjectURL(url), 60000);

  if (!res?.ok) {
    showBanner(res?.error || "No se pudo descargar el respaldo.", "error");
    return;
  }

  if (pendingInspection?.format === "legacy_webm") {
    showBanner(
      "Respaldo .webm descargado. Conviértelo a MP3 (con FFmpeg o VLC) y súbelo en 'O subir un MP3 ya grabado' más abajo.",
      "success"
    );
  } else {
    showBanner("Copia MP3 descargada exitosamente.", "success");
  }
}

function bindEvents() {
  for (const tabBtn of elements.tabs) {
    tabBtn.addEventListener("click", async () => {
      const target = tabBtn.dataset.tab;
      for (const btn of elements.tabs) {
        const active = btn.dataset.tab === target;
        btn.classList.toggle("active", active);
        btn.setAttribute("aria-selected", String(active));
      }
      for (const [key, panel] of Object.entries(elements.panels)) {
        panel.classList.toggle("hidden", key !== target);
      }
      if (target === "episodes") {
        await loadEpisodesTab();
      }
    });
  }

  elements.chkAutoBackup.addEventListener("change", saveBackupPrefs);
  elements.selectBackupMinutes.addEventListener("change", saveBackupPrefs);

  elements.btnStart.addEventListener("click", async () => {
    clearBanner();

    if (pendingInspection?.hasPending) {
      const confirmed = window.confirm(
        "Hay una grabación interrumpida pendiente de recuperar. Si inicias una nueva grabación se borrará ese respaldo. ¿Deseas continuar?"
      );
      if (!confirmed) return;
    }

    elements.btnStart.disabled = true;
    try {
      const hasMicPermission = await checkMicPermissionGranted();
      if (!hasMicPermission) {
        await openMicPermissionTab();
        showBanner(
          "Se abrió una pestaña para autorizar el micrófono (solo 1 vez). Haz clic en 'Permitir' y vuelve aquí para iniciar.",
          "info"
        );
        elements.btnStart.disabled = false;
        return;
      }

      const result = await chrome.runtime.sendMessage({
        type: "START_RECORDING",
        payload: {
          captureMode: getSelectedCaptureMode(),
          autoStopOnMeetClose: elements.chkAutoStop.checked,
          autoUploadOnStop: elements.chkAutoUpload.checked,
          autoBackupEnabled: elements.chkAutoBackup.checked,
          autoBackupMinutes: Number(elements.selectBackupMinutes.value) || 15,
          metadata: readMetadataFromForm(),
        },
      });

      if (!result?.ok) {
        if (
          String(result?.error || "")
            .toLowerCase()
            .includes("permission")
        ) {
          await openMicPermissionTab();
          showBanner(
            "Autoriza el micrófono en la pestaña abierta y vuelve a presionar Iniciar.",
            "info"
          );
          elements.btnStart.disabled = false;
          return;
        }
        throw new Error(result?.error || "No se pudo iniciar la grabación.");
      }

      const backupNote = elements.chkAutoBackup.checked
        ? ` + auto-descarga cada ${elements.selectBackupMinutes.value} min`
        : "";
      showBanner(
        `Grabación MP3 en vivo iniciada (anti-apagones cada 5s${backupNote}).`,
        "success"
      );
      await syncState();
    } catch (err) {
      showBanner(err instanceof Error ? err.message : String(err), "error");
      elements.btnStart.disabled = false;
    }
  });

  elements.btnStop.addEventListener("click", async () => {
    elements.btnStop.disabled = true;
    showBanner("Finalizando grabación MP3...", "info");
    const result = await chrome.runtime.sendMessage({
      type: "STOP_RECORDING",
      metadata: readMetadataFromForm(),
    });

    if (!result?.ok) {
      showBanner(result?.error || "Error al detener la grabación.", "error");
      await syncState();
      return;
    }

    if (result.uploaded) {
      showBanner(
        `¡Publicado en R2! podcast.xml actualizado (${formatMegabytes(result.sizeBytes)}).`,
        "success"
      );
    } else {
      showBanner(
        result.uploadWarning || "MP3 listo para publicar o descargar.",
        "info"
      );
    }
    await syncState();
  });

  elements.btnRecover.addEventListener("click", async () => {
    elements.btnRecover.disabled = true;
    try {
      if (pendingInspection?.format === "mp3") {
        await handleInstantMp3Recovery();
        return;
      }

      showBanner("Intentando convertir respaldo WebM antiguo a MP3...", "info");
      const result = await chrome.runtime.sendMessage({
        type: "RECOVER_CHUNKS",
        metadata: readMetadataFromForm(),
      });
      if (!result?.ok) {
        showBanner(
          `${result?.error || "No se pudo decodificar el WebM."} Usa "Descargar .webm crudo" para rescatarlo sin pérdida.`,
          "error"
        );
        return;
      }
      showBanner("Audio recuperado a MP3 exitosamente.", "success");
      await syncState();
    } catch (err) {
      showBanner(err instanceof Error ? err.message : String(err), "error");
    } finally {
      elements.btnRecover.disabled = false;
    }
  });

  elements.btnDownloadRaw.addEventListener("click", async () => {
    elements.btnDownloadRaw.disabled = true;
    try {
      await handleDownloadRawBackup();
    } catch (err) {
      showBanner(err instanceof Error ? err.message : String(err), "error");
    } finally {
      elements.btnDownloadRaw.disabled = false;
    }
  });

  elements.btnDiscardChunks.addEventListener("click", async () => {
    const confirmed = window.confirm(
      "¿Seguro que deseas descartar esta grabación guardada en respaldo local? Esta acción no se puede deshacer."
    );
    if (!confirmed) return;

    await clearAudioChunks();
    await clearActiveSessionMeta();
    pendingInspection = null;
    elements.recoveryCard.classList.add("hidden");
    showBanner("Fragmentos temporales descartados.", "info");
  });

  elements.btnPublishReady.addEventListener("click", async () => {
    const ready = await getReadyMp3();
    if (!ready?.blob) return;

    const config = await getStoredR2Config();
    elements.btnPublishReady.disabled = true;
    try {
      const metadata = readMetadataFromForm();
      const published = await publishMp3Episode(
        config,
        ready.blob,
        {
          ...metadata,
          durationSeconds: ready.durationSeconds,
          publishedAt: ready.createdAt,
        },
        (step) => showBanner(step, "info")
      );
      showBanner(
        `Publicado en R2 y podcast.xml actualizado: ${published.episode.title}`,
        "success"
      );
      await chrome.runtime.sendMessage({
        type: "NOTIFY",
        title: "Prédica publicada en R2",
        body: `"${published.episode.title}" ya está en podcast.xml.`,
      });
    } catch (err) {
      showBanner(err instanceof Error ? err.message : String(err), "error");
    } finally {
      elements.btnPublishReady.disabled = false;
    }
  });

  elements.btnDownloadReady.addEventListener("click", async () => {
    const ready = await getReadyMp3();
    if (!ready?.blob || !currentReadyObjectUrl) return;
    const slug = slugifyFilename(
      elements.inputTitle.value.trim() || "predica-icfna",
      ready.createdAt
    );
    await chrome.runtime.sendMessage({
      type: "DOWNLOAD_URL",
      url: currentReadyObjectUrl,
      filename: `${slug}.mp3`,
      saveAs: true,
    });
  });

  elements.btnDiscardReady.addEventListener("click", async () => {
    await clearReadyMp3();
    await refreshReadyMp3Card();
    showBanner("Audio temporal eliminado del panel.", "info");
  });

  elements.btnUploadFile.addEventListener("click", async () => {
    const file = elements.fileMp3Input.files?.[0];
    if (!file) {
      showBanner("Selecciona primero un archivo .mp3 de tu computadora.", "error");
      return;
    }

    const config = await getStoredR2Config();
    elements.btnUploadFile.disabled = true;
    try {
      const durationSeconds = await getAudioFileDuration(file);
      const metadata = readMetadataFromForm();
      const published = await publishMp3Episode(
        config,
        file,
        {
          ...metadata,
          durationSeconds,
          publishedAt: new Date().toISOString(),
        },
        (step) => showBanner(step, "info")
      );
      elements.fileMp3Input.value = "";
      showBanner(
        `MP3 subido y podcast.xml actualizado: ${published.episode.title}`,
        "success"
      );
    } catch (err) {
      showBanner(err instanceof Error ? err.message : String(err), "error");
    } finally {
      elements.btnUploadFile.disabled = false;
    }
  });

  elements.btnCopyRss.addEventListener("click", async () => {
    const rss = elements.rssUrlDisplay.textContent;
    if (!rss) return;
    await navigator.clipboard.writeText(rss);
    showBanner("Enlace podcast.xml copiado al portapapeles.", "success");
  });

  elements.btnRefreshEpisodes.addEventListener("click", loadEpisodesTab);

  elements.btnSaveConfig.addEventListener("click", async () => {
    const config = readR2ConfigFromForm();
    await chrome.storage.local.set({ r2Config: config });
    elements.rssUrlDisplay.textContent = `${config.publicUrl}/podcast.xml`;
    showBanner("Configuración de Cloudflare R2 guardada localmente.", "success");
  });

  elements.btnTestR2.addEventListener("click", async () => {
    const config = readR2ConfigFromForm();
    await chrome.storage.local.set({ r2Config: config });
    elements.btnTestR2.disabled = true;
    try {
      showBanner("Probando conexión con el bucket R2...", "info");
      const result = await testR2Connection(config);
      showBanner(
        result.hasCatalog
          ? "Conexión exitosa con R2 (catalog.json encontrado)."
          : "Conexión exitosa con R2 (bucket listo para inicializar).",
        "success"
      );
    } catch (err) {
      showBanner(err instanceof Error ? err.message : String(err), "error");
    } finally {
      elements.btnTestR2.disabled = false;
    }
  });

  elements.btnInitR2.addEventListener("click", async () => {
    const config = readR2ConfigFromForm();
    await chrome.storage.local.set({ r2Config: config });
    elements.btnInitR2.disabled = true;
    try {
      showBanner("Subiendo cover.jpg e inicializando podcast.xml en R2...", "info");
      const res = await initializePodcastBucket(config);
      showBanner(
        `¡Bucket inicializado! Portada y feed activos en ${res.rssUrl}`,
        "success"
      );
    } catch (err) {
      showBanner(err instanceof Error ? err.message : String(err), "error");
    } finally {
      elements.btnInitR2.disabled = false;
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "AUDIO_LEVEL") {
      elements.levelBar.style.width = `${message.level}%`;
      elements.timerDisplay.textContent = formatElapsed(message.elapsedSeconds);
      if (activeSessionState && typeof message.backupPartsSaved === "number") {
        renderBackupStatus(activeSessionState, message.backupPartsSaved);
      }
    }
    if (message?.type === "BACKUP_PART_SAVED") {
      if (activeSessionState) {
        activeSessionState.backupPartsSaved = message.partNumber;
        renderBackupStatus(activeSessionState, message.partNumber);
      }
      showBanner(
        `Respaldo automático #${message.partNumber} guardado en Descargas.`,
        "info"
      );
    }
    if (message?.type === "PROCESSING_PROGRESS") {
      showBanner(message.detail || "Procesando...", "info");
    }
    if (message?.type === "MIC_PERMISSION_GRANTED") {
      showBanner(
        "¡Micrófono autorizado! Ahora sí puedes presionar Iniciar grabación.",
        "success"
      );
      elements.btnStart.disabled = false;
    }
  });
}

async function init() {
  elements.inputTitle.value = defaultSermonTitle();
  await loadConfigForm();
  await loadBackupPrefs();
  bindEvents();
  await syncState();
}

init();
