const TEXT_ENCODER = new TextEncoder();

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(data) {
  const bytes =
    typeof data === "string"
      ? TEXT_ENCODER.encode(data)
      : data instanceof Uint8Array
        ? data
        : new Uint8Array(data);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return toHex(hash);
}

async function hmacSha256(keyBytes, message) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    TEXT_ENCODER.encode(message)
  );
  return new Uint8Array(signature);
}

async function deriveSigningKey(secretAccessKey, dateStamp, region, service) {
  const kDate = await hmacSha256(
    TEXT_ENCODER.encode(`AWS4${secretAccessKey}`),
    dateStamp
  );
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  return hmacSha256(kService, "aws4_request");
}

function encodeObjectPath(key) {
  return key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

async function signedR2Fetch(config, method, key, bodyBytes = null, extraHeaders = {}) {
  if (!config?.accountId || !config?.accessKeyId || !config?.secretAccessKey || !config?.bucketName) {
    throw new Error("Faltan credenciales de Cloudflare R2 en Configuración.");
  }

  const host = `${config.accountId.trim()}.r2.cloudflarestorage.com`;
  const canonicalUri = `/${encodeURIComponent(config.bucketName.trim())}/${encodeObjectPath(key)}`;
  const url = `https://${host}${canonicalUri}`;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const region = "auto";
  const service = "s3";

  const payloadHash = await sha256Hex(bodyBytes ?? new Uint8Array(0));

  const headersMap = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };

  for (const [headerName, headerValue] of Object.entries(extraHeaders)) {
    if (headerValue) {
      headersMap[headerName.toLowerCase()] = headerValue;
    }
  }

  const sortedNames = Object.keys(headersMap).sort();
  const canonicalHeaders = sortedNames
    .map((name) => `${name}:${headersMap[name].trim()}\n`)
    .join("");
  const signedHeaders = sortedNames.join(";");

  const canonicalRequest = [
    method,
    canonicalUri,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = await deriveSigningKey(
    config.secretAccessKey.trim(),
    dateStamp,
    region,
    service
  );
  const signature = toHex(await hmacSha256(signingKey, stringToSign));

  const fetchHeaders = { ...extraHeaders };
  fetchHeaders["x-amz-content-sha256"] = payloadHash;
  fetchHeaders["x-amz-date"] = amzDate;
  fetchHeaders["Authorization"] =
    `AWS4-HMAC-SHA256 Credential=${config.accessKeyId.trim()}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return fetch(url, {
    method,
    headers: fetchHeaders,
    body: bodyBytes ?? undefined,
  });
}

export async function putR2Object(config, key, data, contentType, cacheControl) {
  let bytes;
  if (typeof data === "string") {
    bytes = TEXT_ENCODER.encode(data);
  } else if (data instanceof Blob) {
    bytes = new Uint8Array(await data.arrayBuffer());
  } else if (data instanceof Uint8Array) {
    bytes = data;
  } else {
    bytes = new Uint8Array(data);
  }

  const headers = { "content-type": contentType };
  if (cacheControl) {
    headers["cache-control"] = cacheControl;
  }

  const response = await signedR2Fetch(config, "PUT", key, bytes, headers);
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Error al subir ${key} a R2 (${response.status}): ${detail.slice(0, 160)}`);
  }

  return true;
}

export async function getR2Json(config, key) {
  const response = await signedR2Fetch(config, "GET", key);
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`No se pudo leer ${key} desde R2 (${response.status}).`);
  }
  return response.json();
}

export async function headR2Object(config, key) {
  const response = await signedR2Fetch(config, "HEAD", key);
  return response.ok;
}

export async function deleteR2Object(config, key) {
  const response = await signedR2Fetch(config, "DELETE", key);
  if (!response.ok && response.status !== 404) {
    throw new Error(`No se pudo eliminar ${key} de R2 (${response.status}).`);
  }
  return true;
}

export async function testR2Connection(config) {
  const response = await signedR2Fetch(config, "GET", "catalog.json");
  if (response.status === 200 || response.status === 404) {
    return { ok: true, hasCatalog: response.status === 200 };
  }
  const detail = await response.text().catch(() => "");
  throw new Error(`Conexión rechazada (${response.status}): ${detail.slice(0, 140)}`);
}
