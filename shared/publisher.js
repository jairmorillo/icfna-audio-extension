import {
  deleteR2Object,
  getR2Json,
  headR2Object,
  putR2Object,
} from "./r2-client.js";
import {
  PODCAST_DEFAULTS,
  buildPodcastRss,
  slugifyFilename,
} from "./rss-builder.js";

function cleanPublicUrl(url) {
  return String(url || PODCAST_DEFAULTS.defaultPublicUrl).replace(/\/+$/, "");
}

export async function ensureCoverInR2(config, forceOverwrite = false) {
  if (!forceOverwrite) {
    const exists = await headR2Object(config, "cover.jpg");
    if (exists) {
      return false;
    }
  }

  const coverUrl = chrome.runtime.getURL("assets/cover.jpg");
  const coverResponse = await fetch(coverUrl);
  if (!coverResponse.ok) {
    throw new Error("No se pudo leer assets/cover.jpg dentro de la extensión.");
  }

  const coverBytes = new Uint8Array(await coverResponse.arrayBuffer());
  await putR2Object(
    config,
    "cover.jpg",
    coverBytes,
    "image/jpeg",
    "public, max-age=300"
  );
  return true;
}

export async function initializePodcastBucket(config) {
  await ensureCoverInR2(config, true);
  const existingCatalog = await getR2Json(config, "catalog.json");
  const episodes = Array.isArray(existingCatalog?.episodes)
    ? existingCatalog.episodes
    : [];

  if (!existingCatalog) {
    await putR2Object(
      config,
      "catalog.json",
      JSON.stringify({ updatedAt: new Date().toISOString(), episodes }, null, 2),
      "application/json; charset=utf-8",
      "no-cache"
    );
  }

  const publicUrl = cleanPublicUrl(config.publicUrl);
  const rssXml = buildPodcastRss(episodes, publicUrl);
  await putR2Object(
    config,
    "podcast.xml",
    rssXml,
    "application/rss+xml; charset=utf-8",
    "public, max-age=300"
  );

  return {
    episodesCount: episodes.length,
    rssUrl: `${publicUrl}/podcast.xml`,
    coverUrl: `${publicUrl}/cover.jpg`,
  };
}

export async function publishMp3Episode(config, mp3Blob, metadata, onProgress) {
  const report = (stepText) => {
    if (typeof onProgress === "function") onProgress(stepText);
  };

  const publicUrl = cleanPublicUrl(config.publicUrl);
  const publishedAt = metadata.publishedAt || new Date().toISOString();
  const slug = slugifyFilename(metadata.title, publishedAt);
  const audioKey = `audio/${slug}.mp3`;
  const audioUrl = `${publicUrl}/${audioKey}`;

  report("Verificando portada oficial en R2...");
  await ensureCoverInR2(config);

  report("Subiendo archivo MP3 a Cloudflare R2...");
  await putR2Object(
    config,
    audioKey,
    mp3Blob,
    "audio/mpeg",
    "public, max-age=31536000, immutable"
  );

  report("Actualizando catalog.json...");
  const currentCatalog = await getR2Json(config, "catalog.json");
  const episodes = Array.isArray(currentCatalog?.episodes)
    ? [...currentCatalog.episodes]
    : [];

  const episode = {
    id: slug,
    title: String(metadata.title || "Prédica ICFNA").trim(),
    preacher: String(metadata.preacher || PODCAST_DEFAULTS.author).trim(),
    scripture: String(metadata.scripture || "").trim(),
    description: String(metadata.description || "").trim(),
    publishedAt,
    durationSeconds: Math.max(1, Math.round(Number(metadata.durationSeconds) || 0)),
    sizeBytes: mp3Blob.size,
    audioKey,
    audioUrl,
  };

  episodes.unshift(episode);

  await putR2Object(
    config,
    "catalog.json",
    JSON.stringify({ updatedAt: new Date().toISOString(), episodes }, null, 2),
    "application/json; charset=utf-8",
    "no-cache"
  );

  report("Generando y subiendo podcast.xml...");
  const rssXml = buildPodcastRss(episodes, publicUrl);
  await putR2Object(
    config,
    "podcast.xml",
    rssXml,
    "application/rss+xml; charset=utf-8",
    "public, max-age=300"
  );

  return {
    episode,
    rssUrl: `${publicUrl}/podcast.xml`,
    episodes,
  };
}

export async function removePublishedEpisode(config, episodeId) {
  const publicUrl = cleanPublicUrl(config.publicUrl);
  const currentCatalog = await getR2Json(config, "catalog.json");
  const episodes = Array.isArray(currentCatalog?.episodes)
    ? currentCatalog.episodes
    : [];

  const target = episodes.find((item) => item.id === episodeId);
  if (target?.audioKey) {
    await deleteR2Object(config, target.audioKey);
  }

  const remaining = episodes.filter((item) => item.id !== episodeId);
  await putR2Object(
    config,
    "catalog.json",
    JSON.stringify({ updatedAt: new Date().toISOString(), episodes: remaining }, null, 2),
    "application/json; charset=utf-8",
    "no-cache"
  );

  const rssXml = buildPodcastRss(remaining, publicUrl);
  await putR2Object(
    config,
    "podcast.xml",
    rssXml,
    "application/rss+xml; charset=utf-8",
    "public, max-age=300"
  );

  return remaining;
}
