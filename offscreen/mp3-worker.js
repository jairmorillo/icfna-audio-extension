importScripts("../lib/lame.min.js");

const TARGET_SAMPLE_RATE = 22050;
const BITRATE_KBPS = 64;
const MP3_BLOCK_SIZE = 1152;
const CHUNK_INTERVAL_SECONDS = 5;
const CHUNK_TARGET_SAMPLES = TARGET_SAMPLE_RATE * CHUNK_INTERVAL_SECONDS;

let encoder = null;
let inputSampleRate = 48000;
let resampleRatio = 48000 / TARGET_SAMPLE_RATE;
let resampleSum = 0;
let resampleWeight = 0;
let upsamplePhase = 0;
let prevSample = 0;

let pcmBlock = new Int16Array(MP3_BLOCK_SIZE);
let pcmOffset = 0;
let pendingMp3Buffers = [];
let chunkSamples = 0;
let totalSamples = 0;

function floatToInt16Sample(sample) {
  const clamped = sample < -1 ? -1 : sample > 1 ? 1 : sample;
  return clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
}

function concatUint8Arrays(arrays) {
  let totalLength = 0;
  for (const arr of arrays) {
    totalLength += arr.byteLength;
  }
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    merged.set(arr, offset);
    offset += arr.byteLength;
  }
  return merged;
}

function emitChunkIfReady(force = false) {
  if (pendingMp3Buffers.length === 0) {
    return;
  }
  if (!force && chunkSamples < CHUNK_TARGET_SAMPLES) {
    return;
  }

  const bytes = concatUint8Arrays(pendingMp3Buffers);
  const durationSeconds = chunkSamples / TARGET_SAMPLE_RATE;
  pendingMp3Buffers = [];
  chunkSamples = 0;

  self.postMessage(
    {
      type: "CHUNK",
      bytes: bytes.buffer,
      durationSeconds,
      totalDurationSeconds: totalSamples / TARGET_SAMPLE_RATE,
    },
    [bytes.buffer]
  );
}

function pushTargetSample(floatSample) {
  pcmBlock[pcmOffset] = floatToInt16Sample(floatSample);
  pcmOffset += 1;

  if (pcmOffset < MP3_BLOCK_SIZE) {
    return;
  }

  const encoded = encoder.encodeBuffer(pcmBlock);
  if (encoded.length > 0) {
    pendingMp3Buffers.push(new Uint8Array(encoded));
  }
  chunkSamples += MP3_BLOCK_SIZE;
  totalSamples += MP3_BLOCK_SIZE;
  pcmOffset = 0;

  if (chunkSamples >= CHUNK_TARGET_SAMPLES) {
    emitChunkIfReady(false);
  }
}

function processPcmFloat32(samples) {
  if (!encoder) return;

  if (inputSampleRate === TARGET_SAMPLE_RATE) {
    for (let i = 0; i < samples.length; i += 1) {
      pushTargetSample(samples[i]);
    }
    return;
  }

  if (inputSampleRate > TARGET_SAMPLE_RATE) {
    // Area-integrating boxcar resampler avoids aliasing and keeps zero clock drift
    for (let i = 0; i < samples.length; i += 1) {
      const sample = samples[i];
      const remaining = resampleRatio - resampleWeight;
      if (remaining > 1) {
        resampleSum += sample;
        resampleWeight += 1;
      } else {
        resampleSum += sample * remaining;
        pushTargetSample(resampleSum / resampleRatio);
        const leftover = 1 - remaining;
        resampleSum = sample * leftover;
        resampleWeight = leftover;
      }
    }
    return;
  }

  // Fallback linear upsampling for rare low-rate inputs (< 22050 Hz)
  for (let i = 0; i < samples.length; i += 1) {
    const current = samples[i];
    while (upsamplePhase < 1) {
      pushTargetSample(prevSample + (current - prevSample) * upsamplePhase);
      upsamplePhase += resampleRatio;
    }
    upsamplePhase -= 1;
    prevSample = current;
  }
}

function initEncoder(sampleRate) {
  if (!self.lamejs?.Mp3Encoder) {
    throw new Error("lamejs.Mp3Encoder no disponible en el worker.");
  }

  inputSampleRate = Number(sampleRate) || 48000;
  resampleRatio = inputSampleRate / TARGET_SAMPLE_RATE;
  resampleSum = 0;
  resampleWeight = 0;
  upsamplePhase = 0;
  prevSample = 0;

  pcmBlock = new Int16Array(MP3_BLOCK_SIZE);
  pcmOffset = 0;
  pendingMp3Buffers = [];
  chunkSamples = 0;
  totalSamples = 0;

  encoder = new self.lamejs.Mp3Encoder(1, TARGET_SAMPLE_RATE, BITRATE_KBPS);
}

function flushEncoder() {
  if (!encoder) {
    self.postMessage({ type: "FLUSHED", totalDurationSeconds: 0 });
    return;
  }

  if (pcmOffset > 0) {
    const tailPcm = pcmBlock.subarray(0, pcmOffset);
    const encoded = encoder.encodeBuffer(tailPcm);
    if (encoded.length > 0) {
      pendingMp3Buffers.push(new Uint8Array(encoded));
    }
    chunkSamples += pcmOffset;
    totalSamples += pcmOffset;
    pcmOffset = 0;
  }

  const finalBytes = encoder.flush();
  if (finalBytes.length > 0) {
    pendingMp3Buffers.push(new Uint8Array(finalBytes));
  }

  emitChunkIfReady(true);
  const totalDurationSeconds = totalSamples / TARGET_SAMPLE_RATE;
  encoder = null;
  self.postMessage({ type: "FLUSHED", totalDurationSeconds });
}

self.onmessage = (event) => {
  const data = event.data;
  if (!data?.type) return;

  try {
    if (data.type === "INIT") {
      initEncoder(data.sampleRate);
      self.postMessage({ type: "READY" });
      return;
    }

    if (data.type === "PCM") {
      processPcmFloat32(new Float32Array(data.samples));
      return;
    }

    if (data.type === "FLUSH") {
      flushEncoder();
    }
  } catch (err) {
    self.postMessage({
      type: "ERROR",
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
