// Scrapes RAW event data from funrafting.hu's SUP tour calendar
// (https://funrafting.hu/tudatosturazo/sup-tura-magyarorszag). Unlike the
// Facebook scraper, this is a plain server-rendered page — no login wall,
// no rate limiting concerns — so it's kept as its own module rather than
// folded into scrape.mjs's Facebook-specific logic.
//
// The page lists every bookable date (not just SUP) under "Minden SUP túra
// időpont", grouped by month, inside `.container-lista` blocks. Each entry
// is an <a> with `.datum` (date), `.nap` (weekday), `.tura` (activity type:
// "SUP túra" / "Kenutúra" / "Kajaktúra"), `.helyszin` (location), and one or
// more `.stock` badges ("stock unavailable" = "Foglalás lezárult", anything
// else = still bookable). Non-SUP activity types are intentionally NOT
// filtered out here — this module stays raw/unfiltered like scrape.mjs's
// other sources; process.mjs's isSupRelated() keyword filter on the title
// drops them, since only SUP entries get a real "SUP túra ..." title below.

const TITLE_SELECTOR = 'a[href^="/tudatosturazo/"] img[alt]';
const ENTRY_SELECTOR = '.container-lista a';

export async function scrapeFunraftingCalendar(page, organizer, source) {
  const events = [];
  try {
    await page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);

    // Funrafting's own featured-tour tiles give each SUP trip a proper
    // descriptive title (via the tile image's alt text), keyed by the same
    // href the calendar entries link to. Non-SUP trip types have no tile on
    // this SUP-focused page, so they simply won't be in this map.
    const titleByHref = await page.$$eval(TITLE_SELECTOR, (imgs) => {
      const map = {};
      for (const img of imgs) {
        const a = img.closest('a');
        const href = a?.getAttribute('href');
        if (href && img.alt && !map[href]) map[href] = img.alt;
      }
      return map;
    });

    const entries = await page.$$eval(ENTRY_SELECTOR, (links) =>
      links.map((a) => {
        const datum = a.querySelector('.datum')?.textContent.trim() || null;
        const nap = a.querySelector('.nap')?.textContent.trim() || '';
        const tura = a.querySelector('.tura')?.textContent.trim() || null;
        const helyszin = a.querySelector('.helyszin')?.textContent.trim() || null;
        const firstStock = a.querySelector('.stock');
        const available = firstStock ? !firstStock.className.includes('unavailable') : null;
        return { href: a.getAttribute('href'), datum, nap, tura, helyszin, available };
      })
    );

    for (const entry of entries) {
      if (!entry.href || !entry.datum) continue;
      const slug = entry.href.replace(/^\/tudatosturazo\//, '').replace(/\/$/, '');
      const title = titleByHref[entry.href] || `${entry.tura || 'Túra'} – ${entry.helyszin || ''}`.trim();

      // Recurring trip types ("Munka utáni SUP túra") reuse the SAME page
      // for every date they run — unlike Facebook's one-URL-per-occurrence
      // events, so process.mjs's byUrl merge (which treats URL as the
      // per-event identity) would collapse every future date of the same
      // trip into a single entry. A date fragment keeps the link fully
      // usable (browsers ignore unknown fragments) while giving each
      // occurrence its own identity.
      events.push({
        id: `funrafting-${slug}-${entry.datum.replace(/\./g, '-')}`,
        title,
        organizerId: organizer.id,
        organizerName: organizer.name,
        organizerUrl: source.url,
        rawWhen: `${entry.datum} ${entry.nap}`.trim(),
        location: entry.helyszin,
        available: entry.available,
        url: `https://funrafting.hu${entry.href}#${entry.datum}`,
        source: 'funrafting',
      });
    }
    console.log(`  + ${events.length} esemeny talalva (funrafting naptar)`);
  } catch (err) {
    console.warn(`  ! funrafting hiba (${source.url}): ${err.message}`);
  }
  return events;
}
