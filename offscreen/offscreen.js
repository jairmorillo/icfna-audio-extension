import {
  appendAudioChunk,
  clearAudioChunks,
  getAllAudioChunks,
  saveReadyMp3,
} from "../shared/idb-store.js";
import { publishMp3Episode } from "../shared/publisher.js";

let mediaRecorder = null;
let activeStreams = [];
let audioContext = null;
let levelIntervalId = null;
let recordingStartMs = 0;

function stopActiveMedia() {
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

  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
}

function sendProgress(stage, detail) {
  chrome.runtime.sendMessage({
    type: "PROCESSING_PROGRESS",
    stage,
    detail,
  }).catch(() => {});
}

function floatToInt16(float32Array) {
  const output = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, float32Array[i]));
    output[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return output;
}

async function encodeWebmChunksToMp3(chunks) {
  const sourceBlob = new Blob(chunks, {
    type: chunks[0]?.type || "audio/webm",
  });

  if (sourceBlob.size === 0) {
    throw new Error("La grabación está vacía (0 bytes). Verifica el micrófono.");
  }

  sendProgress("encoding", "Decodificando audio grabado...");
  const arrayBuffer = await sourceBlob.arrayBuffer();
  const decodeCtx = new AudioContext();
  let decodedBuffer;
  try {
    decodedBuffer = await decodeCtx.decodeAudioData(arrayBuffer);
  } finally {
    await decodeCtx.close().catch(() => {});
  }

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

  const monoSamples = renderedBuffer.getChannelData(0);
  const pcm16 = floatToInt16(monoSamples);

  if (!globalThis.lamejs?.Mp3Encoder) {
    throw new Error("El codificador MP3 local (lamejs) no se cargó correctamente.");
  }

  sendProgress("encoding", "Codificando archivo MP3 (64 kbps)...");
  const encoder = new globalThis.lamejs.Mp3Encoder(1, targetSampleRate, 64);
  const blockSize = 1152;
  const mp3Parts = [];

  for (let i = 0; i < pcm16.length; i += blockSize) {
    const slice = pcm16.subarray(i, i + blockSize);
    const encoded = encoder.encodeBuffer(slice);
    if (encoded.length > 0) {
      mp3Parts.push(new Uint8Array(encoded));
    }
  }

  const tail = encoder.flush();
  if (tail.length > 0) {
    mp3Parts.push(new Uint8Array(tail));
  }

  const mp3Blob = new Blob(mp3Parts, { type: "audio/mpeg" });
  return { mp3Blob, durationSeconds };
}

async function startCapture(captureMode, tabStreamId) {
  stopActiveMedia();
  await clearAudioChunks();

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
  const mixDestination = audioContext.createMediaStreamDestination();
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;

  const micSource = audioContext.createMediaStreamSource(micStream);
  micSource.connect(mixDestination);
  micSource.connect(analyser);

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
    tabSource.connect(mixDestination);
    tabSource.connect(analyser);
    // Keep Google Meet audible to the operator locally
    tabSource.connect(audioContext.destination);
  }

  const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : "audio/webm";

  mediaRecorder = new MediaRecorder(mixDestination.stream, {
    mimeType,
    audioBitsPerSecond: 96000,
  });

  mediaRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      appendAudioChunk(event.data).catch((err) => {
        console.error("Failed persisting audio chunk:", err);
      });
    }
  };

  recordingStartMs = Date.now();
  mediaRecorder.start(5000);

  const levelData = new Uint8Array(analyser.frequencyBinCount);
  levelIntervalId = setInterval(() => {
    analyser.getByteTimeDomainData(levelData);
    let maxAmplitude = 0;
    for (let i = 0; i < levelData.length; i += 1) {
      const dist = Math.abs(levelData[i] - 128);
      if (dist > maxAmplitude) maxAmplitude = dist;
    }
    const level = Math.min(100, Math.round((maxAmplitude / 128) * 180));
    chrome.runtime.sendMessage({
      type: "AUDIO_LEVEL",
      level,
      elapsedSeconds: Math.floor((Date.now() - recordingStartMs) / 1000),
    }).catch(() => {});
  }, 150);
}

function stopRecorderGracefully() {
  return new Promise((resolve) => {
    if (!mediaRecorder || mediaRecorder.state === "inactive") {
      resolve();
      return;
    }
    mediaRecorder.addEventListener("stop", () => resolve(), { once: true });
    mediaRecorder.stop();
  });
}

async function finalizeAndMaybeUpload(metadata, autoUpload, r2Config) {
  await stopRecorderGracefully();
  stopActiveMedia();
  mediaRecorder = null;

  // Brief yield so the final ondataavailable chunk finishes writing to IndexedDB
  await new Promise((resolve) => setTimeout(resolve, 250));

  const chunks = await getAllAudioChunks();
  const { mp3Blob, durationSeconds } = await encodeWebmChunksToMp3(chunks);

  const record = {
    blob: mp3Blob,
    sizeBytes: mp3Blob.size,
    durationSeconds: Math.round(durationSeconds),
    createdAt: new Date().toISOString(),
    metadata,
  };
  await saveReadyMp3(record);
  await clearAudioChunks();

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
          durationSeconds: Math.round(durationSeconds),
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
        durationSeconds: Math.round(durationSeconds),
      };
    } catch (err) {
      return {
        ok: true,
        uploaded: false,
        uploadWarning: `MP3 guardado localmente, pero falló la subida automática: ${
          err instanceof Error ? err.message : String(err)
        }`,
        sizeBytes: mp3Blob.size,
        durationSeconds: Math.round(durationSeconds),
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
    durationSeconds: Math.round(durationSeconds),
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen") {
    return;
  }

  if (message.type === "OFFSCREEN_START") {
    (async () => {
      try {
        await startCapture(message.captureMode, message.tabStreamId);
        sendResponse({ ok: true });
      } catch (err) {
        stopActiveMedia();
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
        const chunks = await getAllAudioChunks();
        if (!chunks.length) {
          sendResponse({ ok: false, error: "No hay fragmentos pendientes por recuperar." });
          return;
        }
        const { mp3Blob, durationSeconds } = await encodeWebmChunksToMp3(chunks);
        await saveReadyMp3({
          blob: mp3Blob,
          sizeBytes: mp3Blob.size,
          durationSeconds: Math.round(durationSeconds),
          createdAt: new Date().toISOString(),
          metadata: message.metadata || {},
        });
        await clearAudioChunks();
        sendResponse({
          ok: true,
          sizeBytes: mp3Blob.size,
          durationSeconds: Math.round(durationSeconds),
        });
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
