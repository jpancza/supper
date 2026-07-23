// Turns data/raw-events.json (written by scripts/scrape.mjs) into
// docs/events.json: parses Hungarian dates, filters to SUP/evezés-related
// titles, merges into every event ever seen (nothing is ever removed, only
// added/refreshed by URL), geocodes locations, and attaches a 7-day weather
// forecast. No Facebook access needed — safe to re-run any time the
// parsing/filtering/geocoding logic changes, without re-scraping.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RAW_EVENTS_PATH = path.join(ROOT, 'data', 'raw-events.json');
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
// and only genuinely new locations trigger a network call on later runs. A
// failed lookup is cached as null and never retried automatically — OSM data
// grows over time, so a location that fails today may resolve months later;
// delete its line from geocode-cache.json manually to force a retry.
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

// Known Hungarian SUP/watersport towns — used as a last-resort geocoding
// query when the scraped "location" is missing or too mangled to geocode
// (e.g. a description paragraph), but the town name shows up in the title
// anyway ("Naplementés SUP túra Balatonszemesen").
// Maps a substring that shows up in scraped text to the canonical name to
// geocode — usually identical, but a few towns get referenced by a shorter
// or colloquial form that isn't itself a resolvable Nominatim query (e.g.
// "Káptalanfüred" without its "Balaton" prefix).
const KNOWN_TOWNS = {
  Balatonszemes: 'Balatonszemes', Balatonföldvár: 'Balatonföldvár', Balatonfüred: 'Balatonfüred',
  Balatonalmádi: 'Balatonalmádi', Balatonvilágos: 'Balatonvilágos', Balatonlelle: 'Balatonlelle',
  Balatonboglár: 'Balatonboglár', Balatonakarattya: 'Balatonakarattya', Alsóörs: 'Alsóörs',
  Csopak: 'Csopak', Zamárdi: 'Zamárdi', Siófok: 'Siófok', Keszthely: 'Keszthely',
  Fonyód: 'Fonyód', Badacsony: 'Badacsony', Révfülöp: 'Révfülöp', Tihany: 'Tihany',
  Poroszló: 'Poroszló', Tiszafüred: 'Tiszafüred', Szarvas: 'Szarvas', Visegrád: 'Visegrád',
  Dunaharaszti: 'Dunaharaszti', Szentendre: 'Szentendre', Vác: 'Vác', Göd: 'Göd',
  Dunakiliti: 'Dunakiliti', Esztergom: 'Esztergom', Győr: 'Győr', Szolnok: 'Szolnok',
  Gemenc: 'Gemenc', Szeged: 'Szeged', Tata: 'Tata', Dunaújváros: 'Dunaújváros',
  // Balatonkáptalanfüred isn't its own entry in Nominatim (it's a district of
  // Balatonfüred, not a separate settlement) — fall back to the parent town.
  Balatonkáptalanfüred: 'Balatonfüred', Káptalanfüred: 'Balatonfüred',
  Margitsziget: 'Margitsziget',
  // Rivers/lakes named directly in the title when the scraped "location" is
  // just the event description (no real address was found on the page).
  Bodrog: 'Bodrog', 'Tisza-tó': 'Tisza-tó', 'Tisza-tavon': 'Tisza-tó',
};

// Towns outside Hungary that still show up in Hungarian-organized event
// titles/descriptions — mapped to the full geocode query (not just ", Magyarország")
// since a bare town name would otherwise geocode ambiguously or to the wrong country.
const FOREIGN_TOWNS = {
  Hallstatt: 'Hallstatt, Ausztria',
  Bled: 'Bled, Szlovénia',
  Málta: 'Málta',
};

// Case/inflection-insensitive substring match — Hungarian titles reference towns
// in inflected forms ("Fonyódi", "Balatonkáptalanfüredi"), and the raw scraped
// text's capitalization isn't guaranteed to match the canonical town name's.
function includesTown(text, town) {
  return text.toLowerCase().includes(town.toLowerCase());
}

function findKnownTown(text) {
  if (!text) return null;
  const match = Object.keys(KNOWN_TOWNS).find((town) => includesTown(text, town));
  return match ? KNOWN_TOWNS[match] : null;
}

function findForeignTown(text) {
  if (!text) return null;
  return Object.keys(FOREIGN_TOWNS).find((town) => includesTown(text, town)) || null;
}

async function geocodeEvents(events) {
  const cache = await loadGeocodeCache();
  let newLookups = 0;

  for (const e of events) {
    // A foreign town named in the title (Hallstatt, Bled, ...) is trusted over
    // e.location even when the latter already geocodes fine — organizers often
    // post trips abroad under their home-club's default address.
    const foreignTown = findForeignTown(e.title);
    if (foreignTown) {
      const query = FOREIGN_TOWNS[foreignTown];
      const isNew = !(query in cache);
      const coords = await geocode(query, cache);
      if (isNew) newLookups += 1;
      if (coords) {
        e.lat = coords.lat;
        e.lon = coords.lon;
        continue;
      }
    }

    if (!e.location) continue;
    const isNew = !(e.location in cache);
    const coords = await geocode(e.location, cache);
    if (isNew) newLookups += 1;
    if (coords) {
      e.lat = coords.lat;
      e.lon = coords.lon;
    }
  }

  let fallbackResolved = 0;
  for (const e of events) {
    if (e.lat != null) continue;
    const town = findKnownTown(e.title) || findKnownTown(e.location);
    if (!town) continue;
    const query = `${town}, Magyarország`;
    const isNew = !(query in cache);
    const coords = await geocode(query, cache);
    if (isNew) newLookups += 1;
    if (coords) {
      e.lat = coords.lat;
      e.lon = coords.lon;
      if (!e.location) e.location = town;
      fallbackResolved += 1;
    }
  }

  await writeFile(GEOCODE_CACHE_PATH, JSON.stringify(cache, null, 2));
  return { newLookups, fallbackResolved };
}

// Open-Meteo — free, no API key. One call per unique location covers all 7
// forecast days at once, so events sharing a venue don't multiply requests.
async function fetchWeatherForLocation(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,windspeed_10m_max,winddirection_10m_dominant` +
    `&timezone=Europe%2FBudapest&forecast_days=7`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const byDate = {};
  data.daily.time.forEach((date, i) => {
    byDate[date] = {
      tempMax: data.daily.temperature_2m_max[i],
      tempMin: data.daily.temperature_2m_min[i],
      precipProbability: data.daily.precipitation_probability_max[i],
      windSpeed: data.daily.windspeed_10m_max[i],
      windDirection: data.daily.winddirection_10m_dominant[i],
    };
  });
  return byDate;
}

async function addWeather(events) {
  const todayISO = new Date().toISOString().slice(0, 10);
  const weekAheadISO = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const upcoming = events.filter(
    (e) => e.lat != null && e.lon != null && e.dateISO >= todayISO && e.dateISO <= weekAheadISO
  );

  const locationKey = (e) => `${e.lat.toFixed(3)},${e.lon.toFixed(3)}`;
  const uniqueLocations = [...new Map(upcoming.map((e) => [locationKey(e), { lat: e.lat, lon: e.lon }])).values()];

  const forecastsByLocation = {};
  for (const loc of uniqueLocations) {
    try {
      forecastsByLocation[`${loc.lat.toFixed(3)},${loc.lon.toFixed(3)}`] = await fetchWeatherForLocation(loc.lat, loc.lon);
    } catch (err) {
      console.warn(`  ! idojaras lekerdezes sikertelen (${loc.lat}, ${loc.lon}): ${err.message}`);
    }
  }

  let attached = 0;
  for (const e of upcoming) {
    const forecast = forecastsByLocation[locationKey(e)];
    if (forecast && forecast[e.dateISO]) {
      e.weather = forecast[e.dateISO];
      attached += 1;
    }
  }
  return attached;
}

function toProcessedEvent(raw) {
  if (raw.source === 'rss') {
    const dateISO = raw.rawWhen ? new Date(raw.rawWhen).toISOString().slice(0, 10) : null;
    return {
      id: raw.id,
      title: raw.title,
      organizerId: raw.organizerId,
      organizerName: raw.organizerName,
      dateISO,
      timeText: null,
      rawWhen: raw.rawWhen,
      location: raw.location,
      url: raw.url,
      source: 'rss',
    };
  }

  const dateInfo = parseHungarianEventDate(raw.rawWhen, { assumeUpcoming: raw.assumeUpcoming });
  if (!dateInfo) return null;

  return {
    id: raw.id,
    title: raw.title,
    organizerId: raw.organizerId,
    organizerName: raw.organizerName,
    dateISO: dateInfo.dateISO,
    timeText: dateInfo.timeText,
    rawWhen: raw.rawWhen,
    location: raw.location,
    url: raw.url,
    source: 'facebook',
  };
}

async function main() {
  const raw = JSON.parse(await readFile(RAW_EVENTS_PATH, 'utf-8'));
  const existing = await loadExisting();

  let scraped = raw.events.map(toProcessedEvent).filter(Boolean);
  const droppedByDate = raw.events.length - scraped.length;

  const beforeKeywordFilter = scraped.length;
  scraped = scraped.filter((e) => isSupRelated(e.title));
  const droppedByKeyword = beforeKeywordFilter - scraped.length;

  // Every event ever seen (kezi/manual or scraped) stays forever, keyed by
  // URL — a URL missing from today's scrape (event already happened and its
  // organizer moved on to "upcoming_hosted_events" mode, Facebook rate-limited
  // the runner, ...) must never delete it. Today's scrape only adds brand-new
  // URLs or refreshes ones it still sees; nothing is ever dropped just for
  // being absent from one run.
  const byUrl = new Map(existing.map((e) => [e.url, e]));
  for (const e of scraped) {
    byUrl.set(e.url, e);
  }

  const merged = [...byUrl.values()].sort((a, b) => (a.dateISO || '9999').localeCompare(b.dateISO || '9999'));
  const newUrls = scraped.filter((e) => !existing.some((old) => old.url === e.url)).length;

  const { newLookups, fallbackResolved } = await geocodeEvents(merged);
  const withWeather = await addWeather(merged);

  await mkdir(path.dirname(EVENTS_PATH), { recursive: true });
  await writeFile(
    EVENTS_PATH,
    JSON.stringify({ lastUpdated: new Date().toISOString(), events: merged }, null, 2)
  );

  console.log(
    `Kesz: ${merged.length} esemeny (${existing.length} korabban ismert, ${newUrls} uj a mai scrapelesbol, ` +
    `${droppedByDate} kihagyva datum hianyaban, ${droppedByKeyword} kiszurve mert nem SUP/evezes, ` +
    `${newLookups} uj geokodolas, ${fallbackResolved} telepules-nev alapjan, ${withWeather} idojaras-adat).`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
