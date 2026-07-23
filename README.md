# Supper — magyar SUP-túrák gyűjtőoldala

Automatikusan összegyűjti a szervezők Facebook-oldalain és RSS-forrásain meghirdetett SUP-túrákat, és megjeleníti őket egy weboldalon.

## Hogyan működik

Két lépésre van szétválasztva, hogy a feldolgozási logika (dátum-parse, szűrés, geokódolás, időjárás) módosítása után ne kelljen újra a lassú Facebook-scrapelést lefuttatni:

- `data/organizers.json` — a követett szervezők listája, mindegyikhez egy vagy több forrás (`facebook` vagy `rss`).
- `scripts/scrape.mjs` (**1. lépés — `npm run scrape`**) — headless böngészővel (Playwright) beolvassa a Facebook-oldalak nyilvános "Események" fülét, ill. az RSS-forrásokat, és a nyers, feldolgozatlan találatokat elmenti ide: `data/raw-events.json`. Ez a lassú, Facebook-függő lépés.
- `scripts/process.mjs` (**2. lépés — `npm run process`**) — a `data/raw-events.json`-t alakítja a végleges `docs/events.json`-ná: magyar dátumok értelmezése, SUP/evezés-szűrés, kézi események beillesztése, geokódolás (OpenStreetMap Nominatim), időjárás (Open-Meteo). Nincs hozzá Facebook-hozzáférés — bátran újrafuttatható, ha csak ezen a logikán változtatunk.
- `npm run fetch` — a fenti kettő egymás után (ezt hívja a GitHub Action).
- `docs/index.html` — a weboldal, ami a `docs/events.json`-t jeleníti meg. Ezt szolgálja ki a GitHub Pages.
- `.github/workflows/update.yml` — naponta egyszer (07:00 CEST) automatikusan lefuttatja a fenti két lépést, és ha talál új eseményt, be is committolja. Ez GitHub szerverén fut, semmilyen külső szolgáltatáshoz vagy AI-hoz nincs kötve.

## Szervező hozzáadása

Szerkeszd a `data/organizers.json`-t:

```json
{
  "id": "egyedi-nev",
  "name": "Megjelenítendő név",
  "sources": [
    { "type": "facebook", "url": "https://www.facebook.com/oldalneve" }
  ]
}
```

Ha egy szervezőnek van saját honlapja RSS-feeddel, azt `"type": "rss"` forrásként add hozzá.

## Esemény kézi hozzáadása

Ha egy esemény nem fogható be automatikusan (pl. zárt Facebook-csoportban hirdetik), írd bele kézzel a `docs/events.json` `events` tömbjébe egy `"source": "manual"` mezővel ellátott objektumként — ezeket az automatikus frissítés megtartja, nem írja felül.

## Túrabeszámoló hozzáadása

A "Túrabeszámolók" fül tartalma a `docs/reports.json`-ban van, ezt teljesen kézzel karbantartod (semmilyen script nem nyúl hozzá). Egy bejegyzés:

```json
{
  "id": "egyedi-nev",
  "title": "Naplementés túra Siófokon",
  "dateISO": "2026-07-20",
  "text": "Első bekezdés.\n\nMásodik bekezdés.",
  "images": ["images/reports/siofok-1.jpg", "images/reports/siofok-2.jpg"]
}
```

A `text` mezőben üres sorral válaszd el a bekezdéseket. A képeket másold be a `docs/images/reports/` mappába, és a `images` tömbben a `docs/`-hoz képesti relatív útvonalukat add meg. Legújabb dátum kerül legfelülre.

## GitHub Pages bekapcsolása (egyszeri lépés)

A repó Settings → Pages menüjében állítsd be:
- Source: **Deploy from a branch**
- Branch: **main**, mappa: **/docs**

Ezután pár percen belül élesedik az oldal a `https://jpancza.github.io/supper/` címen.

## Helyi futtatás

```bash
npm install
npx playwright install chromium
npm run fetch          # scrape + process egyben
# vagy külön, ha csak a feldolgozó logikán változtattál:
npm run process
```
