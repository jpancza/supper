# Handoff — supper (SUP-túrák gyűjtőoldal)

Ez a fájl egy következő Claude Code sessionnek szól, hogy gyorsan vissza tudja venni a kontextust. A technikai "hogyan működik" leírás a [README.md](README.md)-ben van — ez a fájl inkább a *miért*-eket, a törékeny pontokat és a nyitott szálakat gyűjti össze.

## Mi ez és miért épült

A felhasználó (Judit) unta, hogy mindig lekésik vagy csak utólag hallanak érdekes magyar szervezésű SUP-túrákról, amiket a szervezők jellemzően csak Facebookon hirdetnek. A cél egy gyűjtőoldal, ami **tőle és ettől a Claude Code sessiontől is teljesen függetlenül** fut — GitHub Actions cron-alapú, nem AI-agent-alapú automatizálás.

Élő oldal: `https://jpancza.github.io/supper/` (GitHub Pages, `/docs` mappából)
Repo: `https://github.com/jpancza/supper`

## Fontos döntések, amiket a felhasználó hozott (ne írd felül kérdés nélkül)

- **Nincs fizetős szolgáltatás.** Explicit elutasította az RSS.app-ot (~$8/hó a Facebook-feedekért) és a meteoblue API-t (regisztráció kellene, amit én nem tudok elvégezni helyette). Minden forrás ingyenes, kulcs/regisztráció nélküli: Nominatim (geokódolás), Open-Meteo (időjárás).
- **Facebook-scraping headless böngészővel, nem fizetős API-val.** Fragile, de ingyenes és a felhasználó ezt tudatosan vállalta.
- **Push előtt mindig engedélyt kell kérni** — eddig minden commit/push előtt megkérdeztem, és ezt is várja. Ne push-olj automatikusan.
- **Múltbeli események megmaradnak az adatban**, csak a weboldalon vannak alapból elrejtve (checkbox-szal elővehetők) — ez explicit kérés volt, ne szűrd ki őket a feldolgozásból.
- **Csak "sup" vagy "evez" szótöredéket tartalmazó címek maradnak meg** — a szervezők gyakran posztolnak teljesen más témájú (futóverseny, party, stb.) eseményeket is, ezeket ki kell szűrni.

## Architektúra (2026-07-22 óta két lépésre bontva)

```
data/organizers.json  → scripts/scrape.mjs  → data/raw-events.json → scripts/process.mjs → docs/events.json → docs/index.html
```

- **`scripts/scrape.mjs`** — Playwright headless Chrome, bejelentkezés nélkül olvassa a szervezők FB "Események" fülét (`/upcoming_hosted_events`, ill. `profile.php?id=...&sk=upcoming_hosted_events` a `/p/Name-id/` típusú oldalaknál). Csak nyers adatot ment (cím, nyers dátum-szöveg, nyers helyszín-szöveg) — **nem** parse-olja a dátumot, nem szűr, nem geokódol. Lassú (~5 perc 19 szervezőnél), mert minden egyes esemény saját aloldalát is meglátogatja.
- **`scripts/process.mjs`** — a nyers adatból építi a `docs/events.json`-t: magyar dátum-parse, kulcsszó-szűrés, kézi (`source: "manual"`) események megtartása, geokódolás (Nominatim, cache-elve `data/geocode-cache.json`-ban), időjárás (Open-Meteo, csak 7 napon belüli + ismert koordinátájú eseményekhez). **Gyors (~2 mp), nincs Facebook-hívás** — ezt futtasd újra, ha a feldolgozási logikán változtatsz, NE a scrape-et.
- **`npm run fetch`** = scrape + process egymás után (ezt hívja a GitHub Action).
- **`.github/workflows/update.yml`** — naponta 07:00 CEST-kor lefut, és ha van változás, commitolja `docs/events.json`, `data/geocode-cache.json`, `data/raw-events.json`.

## Jelenlegi állapot (ezen a session-en lezárva)

- **19 szervező** követve (lista: `data/organizers.json`)
- **~70 esemény** a `docs/events.json`-ban, ebből **~56-nak van koordinátája**, **~20-30-nak időjárása** (a 7 napos ablaktól függően változik)
- Weboldal funkciók: hónap szerint csoportosított lista, szervező-szűrő, szöveges keresés, "lezajlott túrák" toggle (alapból ki), térkép (Leaflet + OpenStreetMap) napi szűrővel és elrejthetőséggel, időjárás-badge a 7 napon belüli eseményeknél

## Törékeny pontok / amire figyelni kell

1. **Facebook DOM-változás bármikor eltörheti a scrapelést.** A `scrape.mjs` szöveg-mintázat alapján dolgozik (pl. "Szervező", "Javasolt események", "CEST" keresése a dátumsorban) — ha FB átalakítja a felületet, ez az első hely, ahol nézni kell.
2. **GitHub Actions runner IP-je adatközponti** — a Facebook szigorúbban bánhat vele, mint az én böngésző-sessionömmel. Ha a napi automatikus futás rendszeresen kevesebb eseményt talál, mint a helyi futtatás, ez lehet az ok.
3. **Dátum év-becslés**: ha FB nem ír ki évszámot (gyakori közeli eseményeknél), a kód csak akkor tolja jövő évre a dátumot, ha a "közelgő" (`upcoming_hosted_events`) listáról jött az adat (`assumeUpcoming: true`). Ha a tartalék "Korábbiak" listáról jön (mert nincs közelgő esemény), NEM tolja jövőre — ez egy valós bugból lett javítva (SUP Arrabona esete, ld. git log). Ne egyszerűsítsd vissza egy naiv "mindig idei/jövő év" szabályra.
4. **Helyszín-felismerés** (`findLocation` a scrape.mjs-ben) kizárja: kategória-címkéket (pl. "Sport", "Wellness" — egyszavas jelölők), a szervező saját nevét (ami néha megismétlődik a "Szervező" felirat felett), GPS-koordinátákat, és a "Javasolt események" szekció tartalmát (ami korábban véletlenül átszivárgott, ld. a SUP Dunakanyar "Nyitott Kertek" bug a git logban).
5. **Geokódolás háromlépcsős tartalék**: (1) teljes cím → (2) cím eleji utca/házszám levágva → (3) ha még mindig nincs cím vagy nem sikerült, ismert magyar település-nevek keresése a címben/címben (`KNOWN_TOWNS` lista a `process.mjs`-ben, bővíthető). Emellett van egy Európa/Mediterráneum bounding-box szűrő is, ami eldobja a nyilvánvalóan rossz (más kontinensre eső) találatokat.

## Nyitott/lezáratlan szálak

- A felhasználó adott 17 nevet szervezőknek egy körben; ebből **15-öt sikerült azonosítani**, 2-t (eredetileg "Sunset Sup" és "Surprise") a felhasználó utólag pontosított — ezek most `Sunset Sup` (facebook.com/Sunsetsup2018) és `SUPrise` (facebook.com/DUNA420, a valódi oldalneve "SUPrise", nem "Surprise") néven szerepelnek. Utólag jött még egy 19. (`SUP Arrabona`) is, amit a felhasználó közvetlenül a GitHub webes felületén adott hozzá.
- **meteoblue API nincs bekötve** — a felhasználó előbb ezt akarta, de regisztráció kellett volna hozzá (amit én nem tudok elvégezni), végül belement az Open-Meteóba. Ha valaha mégis meteoblue API-kulcsot ad, a `process.mjs` `fetchWeatherForLocation` függvényét kellene átírni rá.
- **GitHub Pages bekapcsolása**: a README szerint kézzel kell bekapcsolni (Settings → Pages → main /docs) — nem tudom biztosan, hogy ez megtörtént-e, érdemes rákérdezni/ellenőrizni, ha az élő URL nem válaszol.
- A `KNOWN_TOWNS` lista kézzel bővített, nem teljes — ha új szervező új, eddig nem szereplő településről posztol, érdemes felvenni a listára.

## Helyi futtatás gyors-referencia

```bash
cd supper
npm install
npx playwright install chromium
npm run scrape     # ~5 perc, Facebook-hozzáférés kell
npm run process    # ~2 mp, csak a data/raw-events.json-t dolgozza fel
```

Böngészős előnézethez: `.claude/launch.json` (a Playground 9 gyökérben, nem a supper mappában!) `supper-site` konfigurációval, `npx http-server docs -p 5173` fut mögötte.

Git identitás lokálisan be van állítva (`Pancza Judit` / `jpancza@clementine.hu`), a `.git/config`-ban, nem globálisan.
