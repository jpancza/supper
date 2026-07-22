# Supper — magyar SUP-túrák gyűjtőoldala

Automatikusan összegyűjti a szervezők Facebook-oldalain és RSS-forrásain meghirdetett SUP-túrákat, és megjeleníti őket egy weboldalon.

## Hogyan működik

- `data/organizers.json` — a követett szervezők listája, mindegyikhez egy vagy több forrás (`facebook` vagy `rss`).
- `scripts/fetch-events.mjs` — headless böngészővel (Playwright) beolvassa a Facebook-oldalak nyilvános "Események" fülét, ill. az RSS-forrásokat, és frissíti a `docs/events.json`-t.
- `docs/index.html` — a weboldal, ami a `docs/events.json`-t jeleníti meg. Ezt szolgálja ki a GitHub Pages.
- `.github/workflows/update.yml` — naponta egyszer (07:00 CEST) automatikusan lefuttatja a fenti scriptet, és ha talál új eseményt, be is committolja. Ez GitHub szerverén fut, semmilyen külső szolgáltatáshoz vagy AI-hoz nincs kötve.

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

## GitHub Pages bekapcsolása (egyszeri lépés)

A repó Settings → Pages menüjében állítsd be:
- Source: **Deploy from a branch**
- Branch: **main**, mappa: **/docs**

Ezután pár percen belül élesedik az oldal a `https://jpancza.github.io/supper/` címen.

## Helyi futtatás

```bash
npm install
npx playwright install chromium
npm run fetch
```
