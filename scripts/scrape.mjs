// Scrapes RAW event data from organizer Facebook pages and RSS feeds and
// writes data/raw-events.json — unprocessed: no date parsing, no SUP/evezés
// filtering, no geocoding, no weather. Run `npm run process` afterwards to
// turn this into docs/events.json; that step needs no network access to
// Facebook, so tweaking parsing/filtering/geocoding logic never requires
// re-running this (slow, Facebook-dependent) script.
//
// Facebook has no public API for reading someone else's page/events, so this
// drives a real headless browser to the page's public "events" tab (no login)
// and parses the rendered text. Facebook can change its markup or rate-limit
// datacenter IPs (like GitHub Actions runners) at any time — if a page starts
// coming back empty, check this file first.

import { chromium } from 'playwright';
import Parser from 'rss-parser';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ORGANIZERS_PATH = path.join(ROOT, 'data', 'organizers.json');
const RAW_EVENTS_PATH = path.join(ROOT, 'data', 'raw-events.json');

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

      const title = lines[dateLineIdx + 1] || '(cim nelkul)';
      const location = findLocation(allLines, szervezoIdx, organizer.name) || lines[dateLineIdx + 2] || null;

      events.push({
        id: `fb-${eventId}`,
        title,
        organizerId: organizer.id,
        organizerName: organizer.name,
        rawWhen: lines[dateLineIdx],
        assumeUpcoming,
        location,
        url,
        source: 'facebook',
      });
      console.log(`  + ${lines[dateLineIdx]} — ${title}`);
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
      const pubDate = item.pubDate || item.isoDate || null;
      events.push({
        id: `rss-${Buffer.from(item.link || item.title).toString('base64').slice(0, 16)}`,
        title: item.title || '(cim nelkul)',
        organizerId: organizer.id,
        organizerName: organizer.name,
        rawWhen: pubDate,
        assumeUpcoming: true,
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

async function main() {
  const organizers = JSON.parse(await readFile(ORGANIZERS_PATH, 'utf-8'));

  const browser = await chromium.launch();
  const page = await browser.newPage({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'hu-HU',
  });

  const scraped = [];
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

  await mkdir(path.dirname(RAW_EVENTS_PATH), { recursive: true });
  await writeFile(
    RAW_EVENTS_PATH,
    JSON.stringify({ scrapedAt: new Date().toISOString(), events: scraped }, null, 2)
  );

  console.log(`\nKesz: ${scraped.length} nyers esemeny elmentve ide: ${path.relative(ROOT, RAW_EVENTS_PATH)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
