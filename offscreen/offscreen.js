import {
  appendMp3Chunk,
  assembleMp3FromChunks,
  clearActiveSessionMeta,
  clearAudioChunks,
  getActiveSessionMeta,
  getAllAudioChunks,
  inspectPendingChunks,
  saveActiveSessionMeta,
  saveReadyMp3,
  waitForPendingWrites,
} from "../shared/idb-store.js";
import { publishMp3Episode } from "../shared/publisher.js";
import { slugifyFilename } from "../shared/rss-builder.js";

let activeStreams = [];
let audioContext = null;
let workletNode = null;
let mp3Worker = null;
let levelIntervalId = null;
let recordingStartMs = 0;
let chunkSeq = 0;
let activeBlobUrls = new Set();

let autoBackup = {
  enabled: false,
  intervalSeconds: 900,
  folderName: "",
  partNumber: 0,
  partChunks: [],
  partSeconds: 0,
};

function resetAutoBackupState() {
  autoBackup = {
    enabled: false,
    intervalSeconds: 900,
    folderName: "",
    partNumber: 0,
    partChunks: [],
    partSeconds: 0,
  };
}

function revokeTrackedBlobUrls() {
  for (const url of activeBlobUrls) {
    URL.revokeObjectURL(url);
  }
  activeBlobUrls.clear();
}

function stopMediaStreamsOnly() {
  if (levelIntervalId) {
    clearInterval(levelIntervalId);
    levelIntervalId = null;
  }

  for (const stream of activeStreams) {
    for (const track of stream.getTracks()) {
      track.stop();
    }
  }
  activeStreams = [];
}

function cleanupRecordingResources() {
  stopMediaStreamsOnly();

  if (workletNode) {
    workletNode.port.onmessage = null;
    workletNode.disconnect();
    workletNode = null;
  }

  if (mp3Worker) {
    mp3Worker.terminate();
    mp3Worker = null;
  }

  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
}

function sendProgress(stage, detail) {
  chrome.runtime
    .sendMessage({
      type: "PROCESSING_PROGRESS",
      stage,
      detail,
    })
    .catch(() => {});
}

function triggerAutoBackupPart() {
  if (!autoBackup.enabled || autoBackup.partChunks.length === 0) {
    return;
  }

  autoBackup.partNumber += 1;
  const partNum = autoBackup.partNumber;
  const padded = String(partNum).padStart(2, "0");
  const blob = new Blob(autoBackup.partChunks, { type: "audio/mpeg" });

  autoBackup.partChunks = [];
  autoBackup.partSeconds = 0;

  if (blob.size === 0) return;

  const blobUrl = URL.createObjectURL(blob);
  activeBlobUrls.add(blobUrl);

  const filename = `ICFNA-Backups/${autoBackup.folderName}/parte-${padded}.mp3`;
  chrome.runtime
    .sendMessage({
      type: "AUTO_BACKUP_PART",
      url: blobUrl,
      filename,
      partNumber: partNum,
      sizeBytes: blob.size,
    })
    .catch((err) => {
      console.error("Auto-backup download failed:", err);
    });

  // Revoke after Chrome has plenty of time to finish writing the local file
  setTimeout(() => {
    URL.revokeObjectURL(blobUrl);
    activeBlobUrls.delete(blobUrl);
  }, 90000);
}

function createAndInitWorker(sampleRate) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(chrome.runtime.getURL("offscreen/mp3-worker.js"));

    const onInitMessage = (event) => {
      if (event.data?.type === "READY") {
        worker.removeEventListener("message", onInitMessage);
        resolve(worker);
        return;
      }
      if (event.data?.type === "ERROR") {
        worker.removeEventListener("message", onInitMessage);
        worker.terminate();
        reject(new Error(event.data.error || "Error inicializando MP3 worker."));
      }
    };

    worker.addEventListener("message", onInitMessage);
    worker.onerror = (err) => {
      reject(new Error(err.message || "Error fatal en el codificador MP3."));
    };
    worker.postMessage({ type: "INIT", sampleRate });
  });
}

function handleWorkerChunk(bytesBuffer, durationSeconds) {
  const bytes = new Uint8Array(bytesBuffer);
  if (bytes.byteLength === 0) return;

  chunkSeq += 1;
  const seq = chunkSeq;

  if (autoBackup.enabled) {
    autoBackup.partChunks.push(bytes);
    autoBackup.partSeconds += Number(durationSeconds) || 0;
  }

  appendMp3Chunk({
    seq,
    bytes,
    durationSeconds,
    createdAt: Date.now(),
  }).catch((err) => {
    console.error("Failed persisting MP3 chunk:", err);
  });

  if (
    autoBackup.enabled &&
    autoBackup.partSeconds >= autoBackup.intervalSeconds
  ) {
    triggerAutoBackupPart();
  }
}

async function startCapture(options) {
  cleanupRecordingResources();
  resetAutoBackupState();
  revokeTrackedBlobUrls();

  await clearAudioChunks();
  await clearActiveSessionMeta();
  chunkSeq = 0;

  const {
    captureMode = "mic_only",
    tabStreamId = null,
    metadata = {},
    autoBackupEnabled = false,
    autoBackupMinutes = 15,
  } = options || {};

  const micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  });
  activeStreams.push(micStream);

  audioContext = new AudioContext();
  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }

  const mixBus = audioContext.createGain();
  mixBus.gain.value = 1;

  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;

  const micSource = audioContext.createMediaStreamSource(micStream);
  micSource.connect(mixBus);

  if (captureMode === "mic_and_meet" && tabStreamId) {
    const tabStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: tabStreamId,
        },
      },
      video: false,
    });
    activeStreams.push(tabStream);

    const tabSource = audioContext.createMediaStreamSource(tabStream);
    tabSource.connect(mixBus);
    // Keep Google Meet audible to the operator locally
    tabSource.connect(audioContext.destination);
  }

  mixBus.connect(analyser);

  mp3Worker = await createAndInitWorker(audioContext.sampleRate);
  mp3Worker.onmessage = (event) => {
    const data = event.data;
    if (data?.type === "CHUNK") {
      handleWorkerChunk(data.bytes, data.durationSeconds);
      return;
    }
    if (data?.type === "ERROR") {
      console.error("MP3 worker error:", data.error);
    }
  };

  await audioContext.audioWorklet.addModule(
    chrome.runtime.getURL("offscreen/pcm-worklet.js")
  );
  workletNode = new AudioWorkletNode(audioContext, "pcm-capture-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });

  workletNode.port.onmessage = (event) => {
    if (event.data?.type === "pcm" && mp3Worker) {
      mp3Worker.postMessage(
        { type: "PCM", samples: event.data.samples },
        [event.data.samples]
      );
    }
  };

  // Connect worklet through muted sink so Chrome keeps process() running continuously
  const silentSink = audioContext.createGain();
  silentSink.gain.value = 0;
  mixBus.connect(workletNode);
  workletNode.connect(silentSink);
  silentSink.connect(audioContext.destination);

  const startedAtIso = new Date().toISOString();
  await saveActiveSessionMeta({
    metadata,
    startedAt: startedAtIso,
    captureMode,
  });

  const safeMinutes = Math.max(1, Math.min(60, Number(autoBackupMinutes) || 15));
  if (autoBackupEnabled) {
    autoBackup.enabled = true;
    autoBackup.intervalSeconds = safeMinutes * 60;
    autoBackup.folderName = slugifyFilename(metadata?.title || "predica-icfna", startedAtIso);
  }

  recordingStartMs = Date.now();
  const levelData = new Uint8Array(analyser.frequencyBinCount);
  levelIntervalId = setInterval(() => {
    analyser.getByteTimeDomainData(levelData);
    let maxAmplitude = 0;
    for (let i = 0; i < levelData.length; i += 1) {
      const dist = Math.abs(levelData[i] - 128);
      if (dist > maxAmplitude) maxAmplitude = dist;
    }
    const level = Math.min(100, Math.round((maxAmplitude / 128) * 180));
    chrome.runtime
      .sendMessage({
        type: "AUDIO_LEVEL",
        level,
        elapsedSeconds: Math.floor((Date.now() - recordingStartMs) / 1000),
        backupPartsSaved: autoBackup.partNumber,
      })
      .catch(() => {});
  }, 150);
}

function flushWorkletGracefully() {
  return new Promise((resolve) => {
    if (!workletNode) {
      resolve();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timeoutId = setTimeout(finish, 400);
    const prevHandler = workletNode.port.onmessage;
    workletNode.port.onmessage = (event) => {
      if (event.data?.type === "flushed") {
        clearTimeout(timeoutId);
        finish();
        return;
      }
      if (prevHandler) prevHandler(event);
    };
    workletNode.port.postMessage({ type: "stop" });
  });
}

function flushWorkerGracefully() {
  return new Promise((resolve) => {
    if (!mp3Worker) {
      resolve();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timeoutId = setTimeout(finish, 5000);
    const prevHandler = mp3Worker.onmessage;
    mp3Worker.onmessage = (event) => {
      if (event.data?.type === "FLUSHED") {
        clearTimeout(timeoutId);
        finish();
        return;
      }
      if (prevHandler) prevHandler(event);
    };
    mp3Worker.postMessage({ type: "FLUSH" });
  });
}

async function finalizeAndMaybeUpload(metadata, autoUpload, r2Config) {
  sendProgress("encoding", "Cerrando los últimos frames MP3...");
  stopMediaStreamsOnly();
  await flushWorkletGracefully();
  await flushWorkerGracefully();
  await waitForPendingWrites();

  if (autoBackup.enabled && autoBackup.partChunks.length > 0) {
    triggerAutoBackupPart();
  }

  cleanupRecordingResources();

  sendProgress("encoding", "Ensamblando archivo MP3 final...");
  const chunks = await getAllAudioChunks();
  const { mp3Blob, durationSeconds } = assembleMp3FromChunks(chunks);

  const record = {
    blob: mp3Blob,
    sizeBytes: mp3Blob.size,
    durationSeconds,
    createdAt: new Date().toISOString(),
    metadata,
  };
  await saveReadyMp3(record);
  await clearAudioChunks();
  await clearActiveSessionMeta();

  const hasR2Creds =
    r2Config?.accountId &&
    r2Config?.accessKeyId &&
    r2Config?.secretAccessKey &&
    r2Config?.bucketName;

  if (autoUpload && hasR2Creds) {
    try {
      const published = await publishMp3Episode(
        r2Config,
        mp3Blob,
        {
          ...metadata,
          durationSeconds,
          publishedAt: record.createdAt,
        },
        (detail) => sendProgress("uploading", detail)
      );
      return {
        ok: true,
        uploaded: true,
        episode: published.episode,
        rssUrl: published.rssUrl,
        sizeBytes: mp3Blob.size,
        durationSeconds,
      };
    } catch (err) {
      return {
        ok: true,
        uploaded: false,
        uploadWarning: `MP3 guardado localmente, pero falló la subida automática: ${
          err instanceof Error ? err.message : String(err)
        }`,
        sizeBytes: mp3Blob.size,
        durationSeconds,
      };
    }
  }

  return {
    ok: true,
    uploaded: false,
    uploadWarning: hasR2Creds
      ? "MP3 listo para subir cuando quieras."
      : "MP3 listo. Configura tus llaves de Cloudflare R2 para subir automáticamente.",
    sizeBytes: mp3Blob.size,
    durationSeconds,
  };
}

function floatToInt16Array(float32Array) {
  const output = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, float32Array[i]));
    output[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return output;
}

async function decodeLegacyWebmWithTrim(chunks) {
  let totalBytes = 0;
  for (const chunk of chunks) {
    totalBytes += chunk?.size || 0;
  }
  const maxTrim = totalBytes > 15 * 1024 * 1024 ? 0 : Math.min(3, Math.max(0, chunks.length - 1));
  let lastError = null;

  for (let trim = 0; trim <= maxTrim; trim += 1) {
    const slice = trim === 0 ? chunks : chunks.slice(0, chunks.length - trim);
    const blob = new Blob(slice, { type: slice[0]?.type || "audio/webm" });
    const arrayBuffer = await blob.arrayBuffer();
    const decodeCtx = new AudioContext();
    try {
      const decoded = await decodeCtx.decodeAudioData(arrayBuffer);
      return decoded;
    } catch (err) {
      lastError = err;
    } finally {
      await decodeCtx.close().catch(() => {});
    }
  }

  throw (
    lastError ||
    new Error(
      "El respaldo antiguo WebM está truncado o es demasiado largo para decodificarse en memoria. Usa el botón 'Descargar .webm crudo'."
    )
  );
}

async function encodeLegacyWebmChunksToMp3(chunks) {
  sendProgress("encoding", "Intentando decodificar respaldo WebM antiguo...");
  const decodedBuffer = await decodeLegacyWebmWithTrim(chunks);

  const durationSeconds = decodedBuffer.duration;
  const targetSampleRate = 22050;
  const frameCount = Math.max(1, Math.ceil(durationSeconds * targetSampleRate));

  sendProgress("encoding", "Optimizando voz a mono (22 kHz)...");
  const offlineCtx = new OfflineAudioContext(1, frameCount, targetSampleRate);
  const bufferSource = offlineCtx.createBufferSource();
  bufferSource.buffer = decodedBuffer;
  bufferSource.connect(offlineCtx.destination);
  bufferSource.start(0);
  const renderedBuffer = await offlineCtx.startRendering();

  const pcm16 = floatToInt16Array(renderedBuffer.getChannelData(0));
  if (!globalThis.lamejs?.Mp3Encoder) {
    throw new Error("El codificador MP3 local (lamejs) no se cargó correctamente.");
  }

  sendProgress("encoding", "Codificando archivo MP3 (64 kbps)...");
  const encoder = new globalThis.lamejs.Mp3Encoder(1, targetSampleRate, 64);
  const mp3Parts = [];
  for (let i = 0; i < pcm16.length; i += 1152) {
    const encoded = encoder.encodeBuffer(pcm16.subarray(i, i + 1152));
    if (encoded.length > 0) {
      mp3Parts.push(new Uint8Array(encoded));
    }
  }
  const tail = encoder.flush();
  if (tail.length > 0) {
    mp3Parts.push(new Uint8Array(tail));
  }

  return {
    mp3Blob: new Blob(mp3Parts, { type: "audio/mpeg" }),
    durationSeconds: Math.max(1, Math.round(durationSeconds)),
  };
}

async function recoverPendingAudio(metadataOverride) {
  const inspection = await inspectPendingChunks();
  if (!inspection.hasPending) {
    throw new Error("No hay fragmentos pendientes por recuperar.");
  }

  const chunks = await getAllAudioChunks();
  const savedSession = await getActiveSessionMeta();
  const mergedMeta = {
    ...(savedSession?.metadata || {}),
    ...(metadataOverride || {}),
  };

  if (inspection.format === "mp3") {
    sendProgress("encoding", "Ensamblando bloques MP3 recuperados...");
    const { mp3Blob, durationSeconds } = assembleMp3FromChunks(chunks);
    await saveReadyMp3({
      blob: mp3Blob,
      sizeBytes: mp3Blob.size,
      durationSeconds,
      createdAt: savedSession?.startedAt || new Date().toISOString(),
      metadata: mergedMeta,
    });
    await clearAudioChunks();
    await clearActiveSessionMeta();
    return {
      ok: true,
      format: "mp3",
      sizeBytes: mp3Blob.size,
      durationSeconds,
    };
  }

  const { mp3Blob, durationSeconds } = await encodeLegacyWebmChunksToMp3(chunks);
  await saveReadyMp3({
    blob: mp3Blob,
    sizeBytes: mp3Blob.size,
    durationSeconds,
    createdAt: new Date().toISOString(),
    metadata: mergedMeta,
  });
  await clearAudioChunks();
  await clearActiveSessionMeta();
  return {
    ok: true,
    format: "legacy_webm",
    sizeBytes: mp3Blob.size,
    durationSeconds,
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen") {
    return;
  }

  if (message.type === "OFFSCREEN_START") {
    (async () => {
      try {
        await startCapture(message);
        sendResponse({ ok: true });
      } catch (err) {
        cleanupRecordingResources();
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return true;
  }

  if (message.type === "OFFSCREEN_STOP") {
    (async () => {
      try {
        const result = await finalizeAndMaybeUpload(
          message.metadata || {},
          Boolean(message.autoUpload),
          message.r2Config
        );
        sendResponse(result);
      } catch (err) {
        cleanupRecordingResources();
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return true;
  }

  if (message.type === "OFFSCREEN_RECOVER") {
    (async () => {
      try {
        const result = await recoverPendingAudio(message.metadata || {});
        sendResponse(result);
      } catch (err) {
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return true;
  }
});
