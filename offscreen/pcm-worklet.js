const CHUNK_SAMPLES = 4096;

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(CHUNK_SAMPLES);
    this.offset = 0;
    this.active = true;

    this.port.onmessage = (event) => {
      if (event.data?.type === "stop") {
        this.flushRemaining();
        this.active = false;
        this.port.postMessage({ type: "flushed" });
      }
    };
  }

  flushRemaining() {
    if (this.offset <= 0) return;
    const partial = this.buffer.slice(0, this.offset);
    this.offset = 0;
    this.port.postMessage(
      { type: "pcm", samples: partial.buffer },
      [partial.buffer]
    );
  }

  process(inputs) {
    if (!this.active) {
      return false;
    }

    const input = inputs[0];
    if (!input || input.length === 0) {
      return true;
    }

    const ch0 = input[0];
    if (!ch0 || ch0.length === 0) {
      return true;
    }

    const ch1 = input.length > 1 ? input[1] : null;
    const frameCount = ch0.length;

    for (let i = 0; i < frameCount; i += 1) {
      const sample = ch1 ? (ch0[i] + ch1[i]) * 0.5 : ch0[i];
      this.buffer[this.offset] = sample;
      this.offset += 1;

      if (this.offset >= CHUNK_SAMPLES) {
        const ready = this.buffer;
        this.buffer = new Float32Array(CHUNK_SAMPLES);
        this.offset = 0;
        this.port.postMessage(
          { type: "pcm", samples: ready.buffer },
          [ready.buffer]
        );
      }
    }

    return true;
  }
}

registerProcessor("pcm-capture-processor", PcmCaptureProcessor);
