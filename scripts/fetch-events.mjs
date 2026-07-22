// Fetches upcoming SUP tour events from organizer Facebook pages and RSS feeds,
// merges with any manually-added events, and writes docs/events.json.
//
// Facebook has no public API for reading someone else's page/events, so this
// drives a real headless browser to the page's public "events" tab (no login)
// and parses the rendered text. Facebook can change its markup or rate-limit
// datacenter IPs (like GitHub Actions runners) at any time — if a page starts
// coming back empty, check scripts/fetch-events.mjs first.

import { chromium } from 'playwright';
import Parser from 'rss-parser';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ORGANIZERS_PATH = path.join(ROOT, 'data', 'organizers.json');
const EVENTS_PATH = path.join(ROOT, 'docs', 'events.json');

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, maj: 4, jun: 5,
  jul: 6, aug: 7, sze: 8, okt: 9, nov: 10, dec: 11,
};

const ACCENT_MAP = {
  á: 'a', é: 'e', í: 'i', ó: 'o', ö: 'o', ő: 'o', ú: 'u', ü: 'u', ű: 'u',
  Á: 'a', É: 'e', Í: 'i', Ó: 'o', Ö: 'o', Ő: 'o', Ú: 'u', Ü: 'u', Ű: 'u',
};

function stripAccents(s) {
  return s.replace(/[áéíóöőúüűÁÉÍÓÖŐÚÜŰ]/g, (c) => ACCENT_MAP[c] || c);
}

function parseHungarianEventDate(line, now = new Date()) {
  if (!line) return null;
  const yearMatch = line.match(/(\d{4})\./);
  const monthDayMatch = line.match(/([A-Za-zÁÉÍÓÖŐÚÜŰáéíóöőúüű]+)\.?\s*(\d{1,2})\./);
  const timeMatch = line.match(/(\d{1,2}):(\d{2})/);
  if (!monthDayMatch) return null;

  const monthWord = stripAccents(monthDayMatch[1].toLowerCase()).slice(0, 3);
  const monthIndex = MONTHS[monthWord];
  if (monthIndex === undefined) return null;
  const day = parseInt(monthDayMatch[2], 10);

  let year = yearMatch ? parseInt(yearMatch[1], 10) : now.getFullYear();
  if (!yearMatch) {
    const candidate = new Date(year, monthIndex, day);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (candidate < today) year += 1;
  }

  const hh = timeMatch ? parseInt(timeMatch[1], 10) : 0;
  const mm = timeMatch ? parseInt(timeMatch[2], 10) : 0;
  const pad = (n) => String(n).padStart(2, '0');
  const dateISO = `${year}-${pad(monthIndex + 1)}-${pad(day)}`;
  const timeText = timeMatch ? `${pad(hh)}:${pad(mm)}` : null;
  return { dateISO, timeText };
}

function isSupRelated(title) {
  const t = (title || '').toLowerCase();
  return t.includes('sup') || t.includes('evez');
}

const NON_LOCATION_LINES = new Set([
  'Jegyek', 'Jegyek keresése', 'Meghívás', 'Részletek', 'Nyilvános', 'Beszélgetés', 'Névjegy',
]);

function looksLikeCoordinates(s) {
  return /^-?\d{1,3}[.,]\d+,\s*-?\d{1,3}[.,]\d+$/.test(s);
}

function findLocation(allLines, szervezoIdx) {
  if (szervezoIdx <= 0) return null;
  for (let i = szervezoIdx - 1; i >= Math.max(0, szervezoIdx - 5); i--) {
    const candidate = allLines[i];
    if (!NON_LOCATION_LINES.has(candidate) && !looksLikeCoordinates(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function tryEventIdsAt(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  const bodyText = await page.innerText('body');
  // Facebook falls back to a generic "events near me" discovery page for
  // profile-style ("/p/Name-id/") pages that don't expose an events tab at
  // the guessed URL — its event links belong to random unrelated pages, so
  // treat it as "no events found" rather than trusting the hrefs.
  if (bodyText.includes('Események felfedezése') || bodyText.includes('Események a közelemben')) {
    return [];
  }

  const hrefs = await page.$$eval('a[href*="/events/"]', (as) =>
    as.map((a) => a.getAttribute('href')).filter(Boolean)
  );
  return [...new Set(
    hrefs
      .map((h) => h.match(/\/events\/(\d+)/))
      .filter(Boolean)
      .map((m) => m[1])
  )];
}

async function scrapeFacebookOrganizer(page, organizer, source) {
  const base = source.url.replace(/\/$/, '');
  const events = [];

  // "profile.php?id=..." pages take the events tab as a &sk= query param,
  // not a path suffix — appending "/events" to them would break the URL.
  const profileIdMatch = base.match(/profile\.php\?id=(\d+)/);
  const pSlugIdMatch = base.match(/\/p\/[^/]+-(\d+)$/);
  const numericId = profileIdMatch?.[1] || pSlugIdMatch?.[1];

  const candidateUrls = numericId
    ? [`https://www.facebook.com/profile.php?id=${numericId}&sk=upcoming_hosted_events`]
    : [`${base}/upcoming_hosted_events`, `${base}/events`];

  let eventIds = [];
  for (const url of candidateUrls) {
    eventIds = await tryEventIdsAt(page, url);
    if (eventIds.length > 0) break;
  }

  if (eventIds.length === 0) {
    console.warn(`  ! nem talaltam esemenyeket: ${base} (login-fal, ures lista, vagy nem talalt url-mintat?)`);
    return events;
  }

  for (const eventId of eventIds.slice(0, 25)) {
    const url = `https://www.facebook.com/events/${eventId}/`;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(1500);
      const bodyText = await page.innerText('body');
      const allLines = bodyText.split('\n').map((l) => l.trim()).filter(Boolean);

      // Everything from "Javasolt események" onward is unrelated suggested
      // content (other organizers' events) — search only above that boundary,
      // otherwise an event with no clean date/time on its own page (e.g. a
      // long-running recurring series like "jún. 6.-szept. 4.") can make the
      // date search spill into the suggestions and pick up a random event.
      const szervezoIdx = allLines.findIndex((l) => l === 'Szervezők' || l === 'Szervező');
      const suggestedIdx = allLines.findIndex((l) => l === 'Javasolt események');
      const boundary = [szervezoIdx, suggestedIdx].filter((i) => i > 0).sort((a, b) => a - b)[0];
      const lines = boundary ? allLines.slice(0, boundary) : allLines;

      const dateLineIdx = lines.findIndex((l) => l.includes('CEST') || l.includes('CET'));
      if (dateLineIdx === -1) {
        console.warn(`  ! nincs egyertelmu datum (kihagyva): ${url}`);
        continue;
      }

      const dateInfo = parseHungarianEventDate(lines[dateLineIdx]);
      if (!dateInfo) continue;

      const title = lines[dateLineIdx + 1] || '(cim nelkul)';
      const location = findLocation(allLines, szervezoIdx) || lines[dateLineIdx + 2] || null;

      events.push({
        id: `fb-${eventId}`,
        title,
        organizerId: organizer.id,
        organizerName: organizer.name,
        dateISO: dateInfo.dateISO,
        timeText: dateInfo.timeText,
        rawWhen: lines[dateLineIdx],
        location,
        url,
        source: 'facebook',
      });
      console.log(`  + ${dateInfo.dateISO} ${title}`);
    } catch (err) {
      console.warn(`  ! hiba az esemenynel (${url}): ${err.message}`);
    }
  }

  return events;
}

async function scrapeRssOrganizer(organizer, source) {
  const parser = new Parser();
  const events = [];
  try {
    const feed = await parser.parseURL(source.url);
    for (const item of feed.items.slice(0, 25)) {
      const pubDate = item.pubDate || item.isoDate;
      const dateISO = pubDate ? new Date(pubDate).toISOString().slice(0, 10) : null;
      events.push({
        id: `rss-${Buffer.from(item.link || item.title).toString('base64').slice(0, 16)}`,
        title: item.title || '(cim nelkul)',
        organizerId: organizer.id,
        organizerName: organizer.name,
        dateISO,
        timeText: null,
        rawWhen: pubDate || null,
        location: null,
        url: item.link || source.url,
        source: 'rss',
      });
    }
  } catch (err) {
    console.warn(`  ! RSS hiba (${source.url}): ${err.message}`);
  }
  return events;
}

async function loadExisting() {
  try {
    const raw = await readFile(EVENTS_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.events) ? parsed.events : [];
  } catch {
    return [];
  }
}

async function main() {
  const organizers = JSON.parse(await readFile(ORGANIZERS_PATH, 'utf-8'));
  const existing = await loadExisting();
  const manualEvents = existing.filter((e) => e.source === 'manual');

  const browser = await chromium.launch();
  const page = await browser.newPage({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'hu-HU',
  });

  let scraped = [];
  for (const organizer of organizers) {
    console.log(`\n${organizer.name}:`);
    for (const source of organizer.sources) {
      if (source.type === 'facebook') {
        scraped.push(...(await scrapeFacebookOrganizer(page, organizer, source)));
      } else if (source.type === 'rss') {
        scraped.push(...(await scrapeRssOrganizer(organizer, source)));
      }
    }
  }

  await browser.close();

  const beforeKeywordFilter = scraped.length;
  scraped = scraped.filter((e) => isSupRelated(e.title));
  const droppedByKeyword = beforeKeywordFilter - scraped.length;

  const byUrl = new Map();
  for (const e of [...manualEvents, ...scraped]) {
    byUrl.set(e.url, e);
  }

  // Past events are kept (not re-scraped, but not deleted either) so the site
  // can offer a "show past events" toggle — they're just sorted to the front.
  const merged = [...byUrl.values()].sort((a, b) => (a.dateISO || '9999').localeCompare(b.dateISO || '9999'));

  await mkdir(path.dirname(EVENTS_PATH), { recursive: true });
  await writeFile(
    EVENTS_PATH,
    JSON.stringify({ lastUpdated: new Date().toISOString(), events: merged }, null, 2)
  );

  console.log(
    `\nKesz: ${merged.length} esemeny (${manualEvents.length} kezi + ${scraped.length} automatikus talalat, ${droppedByKeyword} kiszurve mert nem SUP/evezes).`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
