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
- **Semmilyen esemény nem törlődik, csak hozzáadás/frissítés történik** (2026-07-23 óta garantálva a kódban is, ld. lentebb) — explicit kérés volt, ne egyszerűsítsd vissza.
- **Csak "sup" vagy "evez" szótöredéket tartalmazó címek maradnak meg** — a szervezők gyakran posztolnak teljesen más témájú (futóverseny, party, stb.) eseményeket is, ezeket ki kell szűrni.
- **`ANDROID_APP_SPEC.md` szándékosan nincs verziózva** (git-történetben) — a felhasználó explicit kérte, hogy ne commitoljam. Csak helyi referencia-fájl, hagyd békén / ne add hozzá git-hez kérdés nélkül.

## Architektúra

```
data/organizers.json  → scripts/scrape.mjs  → data/raw-events.json → scripts/process.mjs → docs/events.json → docs/index.html
                                                                                          → docs/reports.json (kézzel karbantartva) ↗
```

- **`scripts/scrape.mjs`** — Playwright headless Chrome, bejelentkezés nélkül olvassa a szervezők FB "Események" fülét (`/upcoming_hosted_events`, ill. `profile.php?id=...&sk=upcoming_hosted_events` a `/p/Name-id/` típusú oldalaknál). Csak nyers adatot ment — **nem** parse-olja a dátumot, nem szűr, nem geokódol. Lassú (~5 perc 19 szervezőnél).
- **`scripts/process.mjs`** — a nyers adatból építi a `docs/events.json`-t: magyar dátum-parse, kulcsszó-szűrés, geokódolás (Nominatim, cache-elve `data/geocode-cache.json`-ban), időjárás (Open-Meteo, csak 7 napon belüli + ismert koordinátájú eseményekhez). **Gyors (~2 mp), nincs Facebook-hívás.**
  - **Esemény-megőrzés (2026-07-23-től):** a `byUrl` map a *teljes korábbi* `docs/events.json`-ból indul (nem csak a `source:"manual"` elemekből!), és a mai scrape csak hozzáad/frissít URL szerint. Egy esemény soha nem törlődik pusztán azért, mert egy adott napi futásból hiányzik (pl. mert a szervezője időközben "van közelgő eseménye" módba váltott a Facebookon, és a Korábbiak-lista már nem adja vissza). Ez egy valós hibából lett javítva — korábban a nem-kézi események simán eltűntek, ha a szervezőjük FB-állapota változott.
- **`docs/reports.json`** — teljesen kézzel karbantartott, **semmilyen script nem nyúl hozzá**. A "Túrabeszámolók" fül tartalma (blogszerű bejegyzések, saját túrákról). Séma és hozzáadás menete a README "Túrabeszámoló hozzáadása" szakaszában.
- **`npm run fetch`** = scrape + process egymás után (ezt hívja a GitHub Action).
- **`.github/workflows/update.yml`** — naponta 07:00 CEST-kor lefut, és ha van változás, commitolja `docs/events.json`, `data/geocode-cache.json`, `data/raw-events.json`. A `docs/reports.json`-hoz nem nyúl.

## Jelenlegi állapot

- **19 szervező** követve (lista: `data/organizers.json`)
- **72 esemény** a `docs/events.json`-ban, ebből **66-nak van koordinátája**, **31-nek időjárása** (a 7 napos ablaktól függően változik)
- **3 túrabeszámoló** a `docs/reports.json`-ban (Keszthely–Zala, Szekszárd–Sárvíz, Millstätter-tó/Ausztria), mindegyiknél legalább 1 fotó
- Weboldal funkciók:
  - **Túrák fül**: hónap szerint csoportosított lista, szervező-szűrő, szöveges keresés, "lezajlott túrák" toggle (alapból ki), térkép (Leaflet + OpenStreetMap) napi szűrővel és elrejthetőséggel, időjárás-badge a 7 napon belüli eseményeknél
  - **Túrabeszámolók fül**: blogszerű kártyák (cím, dátum, fotó-galéria, bekezdésekre tördelt szöveg). **Alapból rejtve** a látogatók elől — a `?reports=1` URL-paraméterrel kapcsolható be, ez localStorage-ban megjegyződik (`?reports=0` visszarejti). A szöveg `[label](url)` markdown-jelölést és nyers URL-eket is felismer, mindkettőt linkeli. A fotók kattintásra egy oldalon belüli **lightboxban** nyílnak (nem új lapon), több kép esetén nyíl-gombokkal/kurzorbillentyűkkel lapozható, Escape zár.

## Törékeny pontok / amire figyelni kell

1. **Facebook DOM-változás bármikor eltörheti a scrapelést.** A `scrape.mjs` szöveg-mintázat alapján dolgozik — ha FB átalakítja a felületet, ez az első hely, ahol nézni kell.
2. **GitHub Actions runner IP-je adatközponti** — a Facebook szigorúbban bánhat vele, mint egy helyi böngésző-sessionnel.
3. **Dátum év-becslés**: csak akkor tolja jövő évre az évszám nélküli dátumot, ha a "közelgő" (`upcoming_hosted_events`) listáról jött (`assumeUpcoming: true`); a "Korábbiak" tartalék listánál NEM. Ne egyszerűsítsd vissza naiv szabályra (SUP Arrabona bugból javítva, ld. git log).
4. **Helyszín-felismerés** (`findLocation` a scrape.mjs-ben) kizár: kategória-címkéket, a szervező saját nevét, GPS-koordinátákat, "Javasolt események" szekció tartalmát.
5. **Geokódolás `process.mjs`-ben**, több réteg:
   - `KNOWN_TOWNS` egy *match-string → kanonikus geokódolandó név* map (nem sima lista!), mert néhány helyet rövidebb/ragozott alakban emlegetnek, ami nem önmagában geokódolható (pl. "Káptalanfüred" → `Balatonfüred`-re esik vissza, mert Balatonkáptalanfüred nem önálló Nominatim-találat).
   - `FOREIGN_TOWNS` — külföldi helyek (Hallstatt, Bled, Málta), amiket a **title**-ben keres, és **felülírja** a `location` mezőt akkor is, ha az sikeresen geokódolható lenne (pl. egy szervező alapértelmezett budapesti címére), mert a cím gyakran csak a szervező székhelye, nem a tényleges (külföldi) helyszín.
   - Illesztés case/ékezet-normalizált (`includesTown`), ragozott alakokra is működik.
   - **Ismert korlát, amire figyelni kell:** egy sikertelen geokódolás `null`-ként öröké cache-elődik `data/geocode-cache.json`-ban, **soha nem próbálja újra** — pedig az OSM/Nominatim adatai idővel bővülnek (ld. "Beba Beach Bar" eset: napok óta `null` volt, pedig mára megtalálható). Ha egy helyszín gyanúsan sosem kap koordinátát, érdemes kézzel törölni a cache-bejegyzést és újrafuttatni a `process`-t.
   - "Szeg vízibázis" / "szegi" helyszín **még mindig nincs felvéve** — a felhasználó nem adta meg a pontos helyet, "Szeg" önmagában túl kockázatos substring lenne (false positive-ok).

## Nyitott/lezáratlan szálak

- **Android APK**: `ANDROID_APP_SPEC.md` tartalmaz egy kész tervet (Trusted Web Activity / Bubblewrap-alapú megközelítés, PWA-manifest előfeltétel, sideload vs. Play Store költség-különbség) — **de ez a fájl szándékosan nincs commitolva**, csak helyi. Ha a felhasználó rááll a megvalósításra, előbb 4 nyitott döntés kell tőle: csomagnév, app-név, ikon, terjesztési mód.
- **meteoblue API nincs bekötve** — Open-Meteo van helyette (ingyenes, kulcs nélküli). Ha valaha mégis meteoblue API-kulcsot ad, a `process.mjs` `fetchWeatherForLocation` függvényét kellene átírni rá.
- **GitHub Pages bekapcsolása**: érdemes ellenőrizni, ha az élő URL nem válaszolna (Settings → Pages → main /docs).
- **`KNOWN_TOWNS`/`FOREIGN_TOWNS` listák kézzel bővítendők**, ha új szervező új, eddig nem szereplő helyről posztol.
- **Túrabeszámolók**: a felhasználó folyamatosan bővíti, várhatóan lesz még több bejegyzés — a munkamenet mintája: ő ad linket/fotót/nyers leírást, én írok belőle szöveget, ő finomítja/újraírja a saját szavaival, azt véglegesítjük. **Ne generálj/találj ki fényképet soha** — ha nincs valódi fotó, kérdezz rá a forrására (fájl-elérési út ezen a gépen, vagy URL). Egy közvetlenül a chatbe beillesztett (nem fájlként elérhető) képet **nem lehet lementeni** — ezt is jelezni kell a felhasználónak, ha csak úgy küld egy képet.
- **HEIC-csapda**: telefonos exportnál előfordul, hogy egy fotó ténylegesen HEIC/HEVC-kódolású, csak `.jpg` kiterjesztéssel van elmentve. Az `ffmpeg` ilyenkor csak az első rács-csempét (grid tile) vágja ki tévesen (pl. 512×512-es kis részletet a teljes kép helyett) — ellenőrizd a fájl valódi formátumát (`ffprobe`), és ha HEIC, egy **elszigetelt, egyszer-használatos Python venv-ben** (`python -m venv ...` + `pip install pillow pillow-heif`) dekódold megfelelően, **soha ne** telepíts csomagot közvetlenül a megosztott/alap Anaconda-környezetbe — ez már egyszer Pillow-verzió-ütközést okozott más projektjeivel (moviepy, streamlit), amit vissza kellett állítani.

## Helyi futtatás gyors-referencia

```bash
cd supper
npm install
npx playwright install chromium
npm run scrape     # ~5 perc, Facebook-hozzáférés kell
npm run process    # ~2 mp, csak a data/raw-events.json-t dolgozza fel
```

Böngészős előnézethez: `.claude/launch.json` (a Playground 9 gyökérben, nem a supper mappában!) `supper-site` konfigurációval, `npx http-server docs -p 5173` fut mögötte. A Túrabeszámolók fül teszteléséhez `http://localhost:5173/?reports=1` kell.

Git identitás lokálisan be van állítva (`Pancza Judit` / `jpancza@clementine.hu`), a `.git/config`-ban, nem globálisan.
