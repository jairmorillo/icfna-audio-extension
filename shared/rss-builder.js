export const PODCAST_DEFAULTS = {
  title: "Prédicas y Enseñanzas — Iglesia Comunidad de Fe Nuevo Amanecer (ICFNA)",
  description:
    "Prédicas, enseñanzas bíblicas y servicios de la Iglesia Comunidad de Fe Nuevo Amanecer (ICFNA), Maracaibo, Venezuela. Ministerio de Manifestación y Poder.",
  author: "Iglesia Comunidad de Fe Nuevo Amanecer (ICFNA)",
  email: "icfnuevoamanecer@gmail.com",
  language: "es-ve",
  siteLink: "https://icfna.org",
  defaultPublicUrl: "https://pub-b289a1bcfd614dd4a3877ba3e1c0a41c.r2.dev",
  defaultBucket: "icfna-predicas",
};

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function formatDuration(totalSeconds) {
  const safe = Math.max(1, Math.round(Number(totalSeconds) || 0));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  return [hours, minutes, seconds]
    .map((unit) => String(unit).padStart(2, "0"))
    .join(":");
}

function stripTrailingSlash(url) {
  return String(url || "").replace(/\/+$/, "");
}

export function slugifyFilename(title, isoDate) {
  const datePrefix = (isoDate || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const cleanTitle = String(title || "predica")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56);

  const uniqueSuffix = Date.now().toString(36).slice(-4);
  return `${datePrefix}-${cleanTitle || "predica"}-${uniqueSuffix}`;
}

export function buildPodcastRss(episodes, publicUrl) {
  const baseUrl = stripTrailingSlash(publicUrl || PODCAST_DEFAULTS.defaultPublicUrl);
  const feedUrl = `${baseUrl}/podcast.xml`;
  const coverUrl = `${baseUrl}/cover.jpg`;
  const lastBuildDate = new Date().toUTCString();

  const sorted = [...(episodes || [])].sort(
    (a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()
  );

  const itemsXml = sorted
    .map((ep) => {
      const audioUrl = ep.audioUrl || `${baseUrl}/${ep.audioKey}`;
      const pubDate = new Date(ep.publishedAt || Date.now()).toUTCString();
      const author = ep.preacher || PODCAST_DEFAULTS.author;
      const summaryParts = [
        ep.scripture ? `Pasaje: ${ep.scripture}.` : "",
        ep.description || `Prédica compartida por ${author} en ${PODCAST_DEFAULTS.author}.`,
      ].filter(Boolean);
      const description = summaryParts.join(" ");

      return `    <item>
      <title>${escapeXml(ep.title)}</title>
      <description>${escapeXml(description)}</description>
      <itunes:summary>${escapeXml(description)}</itunes:summary>
      <itunes:author>${escapeXml(author)}</itunes:author>
      <guid isPermaLink="false">${escapeXml(ep.id)}</guid>
      <pubDate>${escapeXml(pubDate)}</pubDate>
      <enclosure url="${escapeXml(audioUrl)}" length="${Math.max(1, Number(ep.sizeBytes) || 1)}" type="audio/mpeg" />
      <itunes:duration>${escapeXml(formatDuration(ep.durationSeconds))}</itunes:duration>
      <itunes:explicit>false</itunes:explicit>
      <itunes:image href="${escapeXml(coverUrl)}" />
    </item>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
  xmlns:atom="http://www.w3.org/2005/Atom"
  xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>${escapeXml(PODCAST_DEFAULTS.title)}</title>
    <link>${escapeXml(PODCAST_DEFAULTS.siteLink)}</link>
    <atom:link href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml" />
    <language>${escapeXml(PODCAST_DEFAULTS.language)}</language>
    <copyright>© ${new Date().getFullYear()} ${escapeXml(PODCAST_DEFAULTS.author)}</copyright>
    <description>${escapeXml(PODCAST_DEFAULTS.description)}</description>
    <lastBuildDate>${escapeXml(lastBuildDate)}</lastBuildDate>
    <itunes:author>${escapeXml(PODCAST_DEFAULTS.author)}</itunes:author>
    <itunes:summary>${escapeXml(PODCAST_DEFAULTS.description)}</itunes:summary>
    <itunes:type>episodic</itunes:type>
    <itunes:explicit>false</itunes:explicit>
    <itunes:owner>
      <itunes:name>${escapeXml(PODCAST_DEFAULTS.author)}</itunes:name>
      <itunes:email>${escapeXml(PODCAST_DEFAULTS.email)}</itunes:email>
    </itunes:owner>
    <itunes:image href="${escapeXml(coverUrl)}" />
    <image>
      <url>${escapeXml(coverUrl)}</url>
      <title>${escapeXml(PODCAST_DEFAULTS.title)}</title>
      <link>${escapeXml(PODCAST_DEFAULTS.siteLink)}</link>
    </image>
    <itunes:category text="Religion &amp; Spirituality">
      <itunes:category text="Christianity" />
    </itunes:category>
${itemsXml}
  </channel>
</rss>
`;
}
