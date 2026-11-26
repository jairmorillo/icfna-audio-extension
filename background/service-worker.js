import { PODCAST_DEFAULTS } from "../shared/rss-builder.js";

const OFFSCREEN_PATH = "offscreen/offscreen.html";

async function setBadge(text, color) {
  await chrome.action.setBadgeText({ text });
  if (color) {
    await chrome.action.setBadgeBackgroundColor({ color });
  }
}

async function notifyUser(id, title, message) {
  try {
    await chrome.notifications.create(id, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
      title,
      message,
    });
  } catch (err) {
    console.warn("Notification failed:", err);
  }
}

async function ensureOffscreenDocument() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });

  if (existing.length > 0) {
    return;
  }

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["USER_MEDIA", "AUDIO_PLAYBACK"],
    justification:
      "Grabar audio del micrófono y/o pestaña de Google Meet y codificarlo a MP3 en tiempo real de forma segura ante cortes de luz.",
  });
}

async function findActiveMeetTab() {
  const meetTabs = await chrome.tabs.query({
    url: ["https://meet.google.com/*"],
  });
  const activeMeet = meetTabs.find((tab) => tab.active);
  return activeMeet || meetTabs[0] || null;
}

async function getSessionState() {
  const data = await chrome.storage.session.get([
    "recordingState",
    "startedAt",
    "activeMeetTabId",
    "captureMode",
    "autoStopOnMeetClose",
    "autoUploadOnStop",
    "autoBackupEnabled",
    "autoBackupMinutes",
    "backupPartsSaved",
    "pendingMeta",
    "lastError",
  ]);
  return {
    recordingState: data.recordingState || "idle",
    startedAt: data.startedAt || null,
    activeMeetTabId: data.activeMeetTabId || null,
    captureMode: data.captureMode || "mic_only",
    autoStopOnMeetClose: data.autoStopOnMeetClose ?? true,
    autoUploadOnStop: data.autoUploadOnStop ?? true,
    autoBackupEnabled: data.autoBackupEnabled ?? false,
    autoBackupMinutes: data.autoBackupMinutes || 15,
    backupPartsSaved: data.backupPartsSaved || 0,
    pendingMeta: data.pendingMeta || null,
    lastError: data.lastError || "",
  };
}

async function handleStartRecording(payload) {
  const state = await getSessionState();
  if (state.recordingState !== "idle") {
    return { ok: false, error: "Ya hay una grabación o procesamiento en curso." };
  }

  await chrome.storage.session.set({
    recordingState: "starting",
    backupPartsSaved: 0,
    lastError: "",
  });

  try {
    await ensureOffscreenDocument();

    const meetTab = await findActiveMeetTab();
    let tabStreamId = null;

    if (payload.captureMode === "mic_and_meet") {
      if (!meetTab?.id) {
        throw new Error(
          "No se detectó ninguna pestaña de Google Meet abierta. Abre Meet o usa 'Solo Micrófono'."
        );
      }
      tabStreamId = await chrome.tabCapture.getMediaStreamId({
        targetTabId: meetTab.id,
      });
    }

    const autoBackupEnabled = Boolean(payload.autoBackupEnabled);
    const autoBackupMinutes = Math.max(
      1,
      Math.min(60, Number(payload.autoBackupMinutes) || 15)
    );

    const response = await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "OFFSCREEN_START",
      captureMode: payload.captureMode,
      tabStreamId,
      metadata: payload.metadata || {},
      autoBackupEnabled,
      autoBackupMinutes,
    });

    if (!response?.ok) {
      throw new Error(response?.error || "No se pudo iniciar la captura de audio.");
    }

    const startedAt = Date.now();
    await chrome.storage.session.set({
      recordingState: "recording",
      startedAt,
      activeMeetTabId: meetTab?.id || null,
      captureMode: payload.captureMode,
      autoStopOnMeetClose: Boolean(payload.autoStopOnMeetClose),
      autoUploadOnStop: Boolean(payload.autoUploadOnStop),
      autoBackupEnabled,
      autoBackupMinutes,
      backupPartsSaved: 0,
      pendingMeta: payload.metadata || null,
      lastError: "",
    });

    await setBadge("REC", "#DC2626");
    return { ok: true, startedAt, activeMeetTabId: meetTab?.id || null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await chrome.storage.session.set({
      recordingState: "idle",
      startedAt: null,
      activeMeetTabId: null,
      backupPartsSaved: 0,
      lastError: message,
    });
    await setBadge("", "#00469B");
    return { ok: false, error: message };
  }
}

async function handleStopRecording(metadataOverride = null, reason = "manual") {
  const state = await getSessionState();
  if (state.recordingState !== "recording") {
    return { ok: false, error: "No hay una grabación activa en este momento." };
  }

  await chrome.storage.session.set({ recordingState: "stopping" });
  await setBadge("MP3", "#F78E1E");

  const finalMeta = metadataOverride || state.pendingMeta || {};
  const { r2Config } = await chrome.storage.local.get("r2Config");

  try {
    await ensureOffscreenDocument();
    const response = await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "OFFSCREEN_STOP",
      metadata: finalMeta,
      autoUpload: Boolean(state.autoUploadOnStop),
      r2Config: r2Config || null,
      reason,
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Error al finalizar la grabación.");
    }

    await chrome.storage.session.set({
      recordingState: "idle",
      startedAt: null,
      activeMeetTabId: null,
      backupPartsSaved: 0,
      lastError: "",
    });
    await setBadge("", "#00469B");

    if (response.uploaded) {
      await notifyUser(
        `icfna-uploaded-${Date.now()}`,
        "Prédica publicada en Cloudflare R2",
        `"${response.episode?.title || "Prédica"}" ya está en línea y podcast.xml fue actualizado.`
      );
    } else {
      await notifyUser(
        `icfna-ready-${Date.now()}`,
        "Audio MP3 listo",
        response.uploadWarning ||
          "La grabación MP3 está lista en el panel para subir o descargar."
      );
    }

    return response;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await chrome.storage.session.set({
      recordingState: "idle",
      startedAt: null,
      activeMeetTabId: null,
      lastError: message,
    });
    await setBadge("", "#00469B");
    return { ok: false, error: message };
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

  const { r2Config } = await chrome.storage.local.get("r2Config");
  if (!r2Config) {
    await chrome.storage.local.set({
      r2Config: {
        accountId: "",
        accessKeyId: "",
        secretAccessKey: "",
        bucketName: PODCAST_DEFAULTS.defaultBucket,
        publicUrl: PODCAST_DEFAULTS.defaultPublicUrl,
      },
    });
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (!tab.url || !tab.url.startsWith("https://meet.google.com/")) return;

  const state = await getSessionState();
  if (state.recordingState !== "idle") return;

  await setBadge("MEET", "#00469B");
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await getSessionState();

  if (
    state.recordingState === "recording" &&
    state.autoStopOnMeetClose &&
    state.activeMeetTabId === tabId
  ) {
    await handleStopRecording(null, "meet_closed");
    return;
  }

  if (state.recordingState === "idle") {
    const remainingMeet = await findActiveMeetTab();
    if (!remainingMeet) {
      await setBadge("", "#00469B");
    }
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target === "offscreen") {
    return;
  }

  if (message?.type === "GET_STATE") {
    (async () => {
      const state = await getSessionState();
      const meetTab = await findActiveMeetTab();
      sendResponse({
        ok: true,
        state,
        meetTab: meetTab ? { id: meetTab.id, title: meetTab.title, url: meetTab.url } : null,
      });
    })();
    return true;
  }

  if (message?.type === "START_RECORDING") {
    (async () => {
      const result = await handleStartRecording(message.payload || {});
      sendResponse(result);
    })();
    return true;
  }

  if (message?.type === "STOP_RECORDING") {
    (async () => {
      const result = await handleStopRecording(message.metadata || null, "manual");
      sendResponse(result);
    })();
    return true;
  }

  if (message?.type === "RECOVER_CHUNKS") {
    (async () => {
      try {
        await ensureOffscreenDocument();
        const result = await chrome.runtime.sendMessage({
          target: "offscreen",
          type: "OFFSCREEN_RECOVER",
          metadata: message.metadata || {},
        });
        sendResponse(result);
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
  }

  if (message?.type === "AUTO_BACKUP_PART") {
    (async () => {
      try {
        const downloadId = await chrome.downloads.download({
          url: message.url,
          filename: message.filename || `ICFNA-Backups/parte-${Date.now()}.mp3`,
          saveAs: false,
          conflictAction: "uniquify",
        });
        const partNumber = Number(message.partNumber) || 1;
        await chrome.storage.session.set({ backupPartsSaved: partNumber });
        chrome.runtime
          .sendMessage({
            type: "BACKUP_PART_SAVED",
            partNumber,
            filename: message.filename,
          })
          .catch(() => {});
        sendResponse({ ok: true, downloadId });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
  }

  if (message?.type === "DOWNLOAD_URL") {
    (async () => {
      try {
        await chrome.downloads.download({
          url: message.url,
          filename: message.filename || "predica-icfna.mp3",
          saveAs: message.saveAs ?? true,
        });
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
  }

  if (message?.type === "NOTIFY") {
    (async () => {
      await notifyUser(
        `icfna-note-${Date.now()}`,
        message.title || "ICFNA Audio",
        message.body || ""
      );
      sendResponse({ ok: true });
    })();
    return true;
  }
});
