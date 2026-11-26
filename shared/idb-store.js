const DB_NAME = "icfna_audio_recorder_db";
const DB_VERSION = 1;
const STORE_CHUNKS = "chunks";
const STORE_BLOBS = "blobs";

let writeQueue = Promise.resolve();

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_CHUNKS)) {
        db.createObjectStore(STORE_CHUNKS, { autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(STORE_BLOBS)) {
        db.createObjectStore(STORE_BLOBS);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function createStrictTransaction(db, storeName, mode) {
  if (mode !== "readwrite") {
    return db.transaction(storeName, mode);
  }
  try {
    return db.transaction(storeName, mode, { durability: "strict" });
  } catch {
    return db.transaction(storeName, mode);
  }
}

function enqueueWrite(task) {
  const run = writeQueue.then(task, task);
  writeQueue = run.catch(() => {});
  return run;
}

export function waitForPendingWrites() {
  return writeQueue;
}

export function appendMp3Chunk(chunkRecord) {
  return enqueueWrite(async () => {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = createStrictTransaction(db, STORE_CHUNKS, "readwrite");
      tx.objectStore(STORE_CHUNKS).add({
        format: "mp3",
        seq: Number(chunkRecord.seq) || 0,
        bytes: chunkRecord.bytes,
        durationSeconds: Number(chunkRecord.durationSeconds) || 0,
        createdAt: chunkRecord.createdAt || Date.now(),
      });
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
      tx.onabort = () => {
        db.close();
        reject(tx.error || new Error("IndexedDB write aborted"));
      };
    });
  });
}

export async function getAllAudioChunks() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = createStrictTransaction(db, STORE_CHUNKS, "readonly");
    const request = tx.objectStore(STORE_CHUNKS).getAll();
    request.onsuccess = () => {
      db.close();
      resolve(request.result || []);
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
  });
}

export function clearAudioChunks() {
  return enqueueWrite(async () => {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = createStrictTransaction(db, STORE_CHUNKS, "readwrite");
      tx.objectStore(STORE_CHUNKS).clear();
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  });
}

export function saveActiveSessionMeta(meta) {
  return enqueueWrite(async () => {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = createStrictTransaction(db, STORE_BLOBS, "readwrite");
      tx.objectStore(STORE_BLOBS).put(meta, "activeSessionMeta");
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  });
}

export async function getActiveSessionMeta() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = createStrictTransaction(db, STORE_BLOBS, "readonly");
    const request = tx.objectStore(STORE_BLOBS).get("activeSessionMeta");
    request.onsuccess = () => {
      db.close();
      resolve(request.result || null);
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
  });
}

export function clearActiveSessionMeta() {
  return enqueueWrite(async () => {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = createStrictTransaction(db, STORE_BLOBS, "readwrite");
      tx.objectStore(STORE_BLOBS).delete("activeSessionMeta");
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  });
}

export function saveReadyMp3(record) {
  return enqueueWrite(async () => {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = createStrictTransaction(db, STORE_BLOBS, "readwrite");
      tx.objectStore(STORE_BLOBS).put(record, "latestMp3");
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  });
}

export async function getReadyMp3() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = createStrictTransaction(db, STORE_BLOBS, "readonly");
    const request = tx.objectStore(STORE_BLOBS).get("latestMp3");
    request.onsuccess = () => {
      db.close();
      resolve(request.result || null);
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
  });
}

export function clearReadyMp3() {
  return enqueueWrite(async () => {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = createStrictTransaction(db, STORE_BLOBS, "readwrite");
      tx.objectStore(STORE_BLOBS).delete("latestMp3");
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  });
}

function isMp3ChunkRecord(item) {
  return Boolean(item && typeof item === "object" && item.format === "mp3" && item.bytes);
}

export async function inspectPendingChunks() {
  const [chunks, sessionMeta] = await Promise.all([
    getAllAudioChunks(),
    getActiveSessionMeta(),
  ]);

  if (!chunks.length) {
    return {
      hasPending: false,
      format: null,
      count: 0,
      totalBytes: 0,
      durationSeconds: 0,
      sessionMeta,
    };
  }

  const mp3Records = chunks.filter(isMp3ChunkRecord);
  if (mp3Records.length > 0) {
    let totalBytes = 0;
    let durationSeconds = 0;
    for (const rec of mp3Records) {
      totalBytes += rec.bytes.byteLength || rec.bytes.length || 0;
      durationSeconds += Number(rec.durationSeconds) || 0;
    }
    if (durationSeconds <= 0 && totalBytes > 0) {
      durationSeconds = totalBytes / 8000;
    }
    return {
      hasPending: true,
      format: "mp3",
      count: mp3Records.length,
      totalBytes,
      durationSeconds: Math.round(durationSeconds),
      sessionMeta,
    };
  }

  let totalBytes = 0;
  for (const item of chunks) {
    totalBytes += item?.size || item?.byteLength || 0;
  }

  return {
    hasPending: true,
    format: "legacy_webm",
    count: chunks.length,
    totalBytes,
    durationSeconds: 0,
    sessionMeta,
  };
}

export function assembleMp3FromChunks(chunks) {
  const mp3Records = chunks
    .filter(isMp3ChunkRecord)
    .sort((a, b) => (a.seq || 0) - (b.seq || 0));

  if (!mp3Records.length) {
    throw new Error("No se encontraron bloques MP3 válidos para recuperar.");
  }

  const byteParts = [];
  let durationSeconds = 0;

  for (const rec of mp3Records) {
    const view =
      rec.bytes instanceof Uint8Array ? rec.bytes : new Uint8Array(rec.bytes);
    if (view.byteLength > 0) {
      byteParts.push(view);
      durationSeconds += Number(rec.durationSeconds) || 0;
    }
  }

  const mp3Blob = new Blob(byteParts, { type: "audio/mpeg" });
  if (mp3Blob.size === 0) {
    throw new Error("La grabación recuperada está vacía (0 bytes).");
  }

  if (durationSeconds <= 0) {
    durationSeconds = mp3Blob.size / 8000;
  }

  return {
    mp3Blob,
    durationSeconds: Math.max(1, Math.round(durationSeconds)),
    chunkCount: byteParts.length,
  };
}
