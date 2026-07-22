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
const GEOCODE_CACHE_PATH = path.join(ROOT, 'data', 'geocode-cache.json');

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

function parseHungarianEventDate(line, { now = new Date(), assumeUpcoming = true } = {}) {
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
  if (!yearMatch && assumeUpcoming) {
    // Only roll a year-less date into next year when we know we're reading
    // the "upcoming" tab — a date that looks like it's already passed there
    // must mean it hasn't happened yet, i.e. it's next year's occurrence.
    // On a fallback/past listing the same date-less line is far more likely
    // to just be this year's (already-happened) event, so leave it as-is.
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

function looksLikeCategoryTag(s) {
  // FB shows a one-word event category (e.g. "Sport", "Wellness", "Zene")
  // right above "Szervező" on some pages — a real venue/address is never a
  // single bare word, so treat this shape as "not a location" too.
  return !/[\s,]/.test(s) && !/\d/.test(s);
}

function findLocation(allLines, szervezoIdx, organizerName) {
  if (szervezoIdx <= 0) return null;
  for (let i = szervezoIdx - 1; i >= Math.max(0, szervezoIdx - 5); i--) {
    const candidate = allLines[i];
    // The organizer's own name sometimes repeats right above "Szervező"
    // (a caption on the event tile) — it's not a venue, don't geocode it.
    if (candidate === organizerName) continue;
    if (!NON_LOCATION_LINES.has(candidate) && !looksLikeCoordinates(candidate) && !looksLikeCategoryTag(candidate)) {
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

  const candidates = numericId
    ? [{ url: `https://www.facebook.com/profile.php?id=${numericId}&sk=upcoming_hosted_events`, assumeUpcoming: true }]
    : [
        { url: `${base}/upcoming_hosted_events`, assumeUpcoming: true },
        // Falling back to the plain "/events" tab only happens when the
        // organizer has nothing upcoming — Facebook then shows "Korábbiak"
        // (past events) instead, so dates found here are NOT known-upcoming.
        { url: `${base}/events`, assumeUpcoming: false },
      ];

  let eventIds = [];
  let assumeUpcoming = true;
  for (const candidate of candidates) {
    eventIds = await tryEventIdsAt(page, candidate.url);
    if (eventIds.length > 0) {
      assumeUpcoming = candidate.assumeUpcoming;
      break;
    }
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

      const dateInfo = parseHungarianEventDate(lines[dateLineIdx], { assumeUpcoming });
      if (!dateInfo) continue;

      const title = lines[dateLineIdx + 1] || '(cim nelkul)';
      const location = findLocation(allLines, szervezoIdx, organizer.name) || lines[dateLineIdx + 2] || null;

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

async function loadGeocodeCache() {
  try {
    return JSON.parse(await readFile(GEOCODE_CACHE_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

// Nominatim's free-text search is picky about full Hungarian street
// addresses ("Petőfi Sándor utca 19, Szarvas 5540, Magyarország" finds
// nothing) but handles the town-level remainder fine. Build a list of
// progressively shorter fallback queries by dropping the leading (usually
// street-level) segment, without ever falling back to just the country name.
function buildGeocodeQueries(location) {
  const parts = location.split(',').map((s) => s.trim()).filter(Boolean);
  const queries = [location];
  for (let i = 1; i < parts.length - 1; i++) {
    queries.push(parts.slice(i).join(', '));
  }
  return [...new Set(queries)];
}

async function nominatimSearch(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'supper-sup-tura-oldal/1.0 (https://github.com/jpancza/supper)' },
  });
  const results = await res.json();
  await new Promise((r) => setTimeout(r, 1100)); // Nominatim's usage policy caps requests at 1/sec
  return results[0] ? { lat: parseFloat(results[0].lat), lon: parseFloat(results[0].lon) } : null;
}

// Free geocoding via OpenStreetMap Nominatim — no API key, but its usage
// policy caps requests at 1/sec, so results are cached to data/geocode-cache.json
// and only genuinely new locations trigger a network call on later runs.
async function geocode(location, cache) {
  if (!location || location in cache) return cache[location] ?? null;
  let coords = null;
  try {
    for (const query of buildGeocodeQueries(location)) {
      coords = await nominatimSearch(query);
      if (coords) break;
    }
    // A misidentified "location" string (a category tag, an organizer name,
    // ...) can still match *something* on Nominatim, just on another
    // continent — sanity-bound to Europe/Mediterranean and drop the rest
    // rather than plot a SUP tour in South Carolina.
    if (coords && (coords.lat < 33 || coords.lat > 72 || coords.lon < -12 || coords.lon > 45)) {
      console.warn(`  ! geokodolas eldobva, tul messze (${location}): ${coords.lat}, ${coords.lon}`);
      coords = null;
    }
  } catch (err) {
    console.warn(`  ! geokodolas sikertelen (${location}): ${err.message}`);
  }
  cache[location] = coords;
  return coords;
}

async function geocodeEvents(events) {
  const cache = await loadGeocodeCache();
  let newLookups = 0;
  for (const e of events) {
    if (!e.location) continue;
    const isNew = !(e.location in cache);
    const coords = await geocode(e.location, cache);
    if (isNew) newLookups += 1;
    if (coords) {
      e.lat = coords.lat;
      e.lon = coords.lon;
    }
  }
  await writeFile(GEOCODE_CACHE_PATH, JSON.stringify(cache, null, 2));
  return newLookups;
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

  const newLookups = await geocodeEvents(merged);

  await mkdir(path.dirname(EVENTS_PATH), { recursive: true });
  await writeFile(
    EVENTS_PATH,
    JSON.stringify({ lastUpdated: new Date().toISOString(), events: merged }, null, 2)
  );

  console.log(
    `\nKesz: ${merged.length} esemeny (${manualEvents.length} kezi + ${scraped.length} automatikus talalat, ${droppedByKeyword} kiszurve mert nem SUP/evezes, ${newLookups} uj geokodolas).`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
