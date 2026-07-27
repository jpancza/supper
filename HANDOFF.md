# Handoff — supper (SUP-túrák gyűjtőoldal)

Ez a fájl egy következő Claude Code sessionnek szól, hogy gyorsan vissza tudja venni a kontextust. A technikai "hogyan működik" leírás a [README.md](README.md)-ben van — ez a fájl inkább a *miért*-eket, a törékeny pontokat és a nyitott szálakat gyűjti össze.

## Mi ez és miért épült

A felhasználó (Judit) unta, hogy mindig lekésik vagy csak utólag hallanak érdekes magyar szervezésű SUP-túrákról, amiket a szervezők jellemzően csak Facebookon hirdetnek. A cél egy gyűjtőoldal, ami **tőle és ettől a Claude Code sessiontől is teljesen függetlenül** fut — GitHub Actions cron-alapú, nem AI-agent-alapú automatizálás.

Élő oldal: `https://supper.hu/` (saját domain + cPanel-es tárhely, 2026-07-24 óta — ld. lentebb). GitHub Pages (`https://jpancza.github.io/supper/`) is tovább él tartalékként, nem került kikapcsolásra.
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
- **`scripts/scrape-funrafting.mjs`** (2026-07-27-től) — külön modulban, nem a Facebook-scraper része. A funrafting.hu túranaptár-oldalát (`/tudatosturazo/sup-tura-magyarorszag`) olvassa — nem Facebook-forrás, sima szerveroldalt renderelt HTML. A naptárban SUP mellett Kenu/Kajak túrák is szerepelnek; ezeket nem itt szűri ki (ez a modul is "nyers adatot ment" elvű), hanem a lefelé irányuló `isSupRelated` cím-kulcsszó-szűrés dobja el természetesen, mert csak a SUP-túráknak van valódi cím-térképe (`titleByHref`, a funrafting saját "Aktív túrák" kártyáinak `img[alt]`-jából). A "Foglalás lezárult" (nem aktív) időpontokat a `process.mjs` dobja el (`raw.available === false`), nem a scraper. **Fontos csapda, amit már megoldottunk:** a funrafting egy visszatérő túratípushoz (pl. "Munka utáni SUP túra") mindig UGYANAZT az URL-t adja minden dátumra — a `process.mjs` `byUrl`-alapú "esemény-megőrzés" logikája emiatt összemosná a különböző időpontokat egyetlen eseménnyé. Megoldás: a scraper minden esemény URL-jéhez dátum-fragmentet fűz (`...#2026.08.23`), ez a böngészőben ártalmatlan (figyelmen kívül hagyja), de a `byUrl` map-nek külön kulcs.
- **`scripts/process.mjs`** — a nyers adatból építi a `docs/events.json`-t: magyar dátum-parse, kulcsszó-szűrés, geokódolás (Nominatim, cache-elve `data/geocode-cache.json`-ban), időjárás (Open-Meteo, csak 7 napon belüli + ismert koordinátájú eseményekhez). **Gyors (~2 mp), nincs Facebook-hívás.**
  - **Esemény-megőrzés (2026-07-23-től):** a `byUrl` map a *teljes korábbi* `docs/events.json`-ból indul (nem csak a `source:"manual"` elemekből!), és a mai scrape csak hozzáad/frissít URL szerint. Egy esemény soha nem törlődik pusztán azért, mert egy adott napi futásból hiányzik (pl. mert a szervezője időközben "van közelgő eseménye" módba váltott a Facebookon, és a Korábbiak-lista már nem adja vissza). Ez egy valós hibából lett javítva — korábban a nem-kézi események simán eltűntek, ha a szervezőjük FB-állapota változott.
- **`docs/reports.json`** — teljesen kézzel karbantartott, **semmilyen script nem nyúl hozzá**. A "Túrabeszámolók" fül tartalma (blogszerű bejegyzések, saját túrákról). Séma és hozzáadás menete a README "Túrabeszámoló hozzáadása" szakaszában.
- **`npm run fetch`** = scrape + process egymás után (ezt hívja a GitHub Action).
- **`.github/workflows/update.yml`** — naponta 07:00 CEST-kor lefut, és ha van változás, commitolja `docs/events.json`, `data/geocode-cache.json`, `data/raw-events.json`. A `docs/reports.json`-hoz nem nyúl.
- **`.github/workflows/deploy.yml`** (2026-07-24 óta) — FTP-vel felszinkronizálja a `docs/` mappát a saját tárhelyre (`SamKirkland/FTP-Deploy-Action`). GitHub repo secretek: `FTP_SERVER`, `FTP_USERNAME`, `FTP_PASSWORD`, `FTP_SERVER_DIR` — ezeket Judit állította be közvetlenül a GitHub felületén, én sosem láttam az értéküket. **Fontos:** ennek az actionnek nincs mozgó `v4` gyűjtő-taggje, csak konkrét semver verziók (`v4.4.0` jelenleg) — ha frissítesz rajta, előbb nézd meg a repo tags oldalát, különben "unable to resolve action" hibát kapsz.
  - **Két triggere van, tudatosan:** `push` (bármilyen `docs/**`-t érintő push-ra, pl. a te kézi commitjaidra — ez működik, visszaigazolva) **és** egy önálló `schedule` 07:15 CEST-kor. Az utóbbi azért kell külön, mert az `update.yml` napi automata commitja a beépített `GITHUB_TOKEN`-nel megy, és a GitHub szándékosan **nem indít el vele más workflow-t** (végtelen ciklus elleni védelem) — enélkül a bot napi adatfrissítése sosem jutna ki a saját tárhelyre, csak a te kézi push-jaid. Ha legközelebb valaki azt kérdezi "miért nem friss az élő oldal a napi scrape után", ez az első hely, ahol nézni kell.

## Jelenlegi állapot

- **20 szervező** követve (lista: `data/organizers.json`) — ebből 19 Facebook-forrás, 1 (`funrafting`) a funrafting.hu túranaptárát olvassa, nem Facebookot.
- **73 esemény** a `docs/events.json`-ban (a szám naponta változik)
- **3 túrabeszámoló** a `docs/reports.json`-ban (Keszthely–Zala, Szekszárd–Sárvíz, Millstätter-tó/Ausztria), mindegyiknél legalább 1 fotó
- Weboldal funkciók:
  - **Túrák fül**: hónap szerint csoportosított lista, szervező-szűrő, szöveges keresés, "lezajlott túrák" toggle (alapból ki), térkép (Leaflet + OpenStreetMap) napi szűrővel és elrejthetőséggel, időjárás-badge a 7 napon belüli eseményeknél
  - **Túrabeszámolók fül**: blogszerű kártyák (cím, dátum, fotó-galéria, bekezdésekre tördelt szöveg). **Alapból rejtve** a látogatók elől — a `?reports=1` URL-paraméterrel kapcsolható be, ez localStorage-ban megjegyződik (`?reports=0` visszarejti). A szöveg `[label](url)` markdown-jelölést és nyers URL-eket is felismer, mindkettőt linkeli. A fotók kattintásra egy oldalon belüli **lightboxban** nyílnak (nem új lapon), több kép esetén nyíl-gombokkal/kurzorbillentyűkkel lapozható, Escape zár.

**Arculat (2026-07-24 óta):** Judit adott egy kész logót (`E:\Kreatív\Blog\milltsatt\supper_logo.png` — pin-forma ikon lapáttal, "SUPTÚRÁK" wordmark, "TÚRÁK. VIZEK. KALANDOK." tagline). A logóból kivágott, átlátszó hátterű ikon `docs/images/logo.png`-ként van a repóban, a belőle mintavételezett türkiz (`#0c8fa0`/sötét módban `#2ed6df`) és sötétkék (`#0a3f68`/`#6fa8e0`) szín váltotta fel a korábbi türkiz/korall párost. Fejléc "Horizont"-stílusú (hullámsáv-motívum a logó alatt/mögött). Favicon (`docs/images/favicon-32.png`, `-64.png`) és OG-share-kép (`docs/images/og-image.png`, 1200×630, ugyanabból a logóból generálva) is a logóra épül. **Elutasított irányok, ne térj vissza rájuk:** kör-jelvény absztrakt lapátütés-ívvel ("gagyi"), emberalakos paddler-ikon ("szörnyű") — a logóban/ikonban maga a SUP-eszköz (deszka, lapát) legyen felismerhető, ne elvont forma és ne emberi alak.

**Lábléc:** disclaimer (nem hivatalos gyűjtőoldal, adatok automatikusan a szervezők FB-oldalairól, pontatlanság előfordulhat) + kapcsolat (`info@supper.hu`, mailto-link).

**Analitika:** cookie-mentes **GoatCounter** (`https://supper.goatcounter.com/count`), a `</body>` előtt beszúrva — tudatos döntés a Google Analytics helyett, mert cookie-mentes, nincs szükség consent-bannerre (a fizetős Plausible-t is emiatt vetettük el, ld. "nincs fizetős szolgáltatás" szabály).

**SEO (2026-07-24 óta):** `<link rel="canonical">`, Open Graph + Twitter Card meta-tagek (az OG-képpel), `docs/robots.txt`, `docs/sitemap.xml`, `docs/llms.txt` (AI-keresőbotoknak szóló rövid leírás), és kliensoldali JS-sel generált **schema.org/Event JSON-LD** a legfeljebb 20 legközelebbi, helyszínnel rendelkező túrához (`buildEventStructuredData`/`injectStructuredData` az `index.html`-ben) — csak azokhoz az eseményekhez, amiknek van `location` mezője, mert az `OfflineEventAttendanceMode` fizikai helyszínt vár el. Judit elkezdte a Google Search Console + Bing Webmaster Tools bejelentést, hogy gyorsabban induljon az indexelés — ld. nyitott szálaknál.

## Törékeny pontok / amire figyelni kell

1. **Facebook DOM-változás bármikor eltörheti a scrapelést.** A `scrape.mjs` szöveg-mintázat alapján dolgozik — ha FB átalakítja a felületet, ez az első hely, ahol nézni kell.
2. **GitHub Actions runner IP-je adatközponti** — a Facebook szigorúbban bánhat vele, mint egy helyi böngésző-sessionnel.
3. **Dátum év-becslés**: csak akkor tolja jövő évre az évszám nélküli dátumot, ha a "közelgő" (`upcoming_hosted_events`) listáról jött (`assumeUpcoming: true`); a "Korábbiak" tartalék listánál NEM. Ne egyszerűsítsd vissza naiv szabályra (SUP Arrabona bugból javítva, ld. git log). **2026-07-24-től kiegészítve:** többnapos események ("júl. 23. – júl. 26.") esetén a "már elmúlt-e" ellenőrzés a **záró** dátumot nézi, nem csak a kezdést — a `Hallstatt SUP Adventure 2026` bugból javítva, ahol egy tegnap kezdődött, még folyamatban lévő túra kezdőnapja (technikailag "már elmúlt") tévesen jövő évre tolta az egész eseményt. Ld. `parseHungarianEventDate` a `process.mjs`-ben.
4. **Helyszín-felismerés** (`findLocation` a scrape.mjs-ben) kizár: kategória-címkéket, a szervező saját nevét, GPS-koordinátákat, "Javasolt események" szekció tartalmát.
5. **Geokódolás `process.mjs`-ben**, több réteg:
   - `KNOWN_TOWNS` egy *match-string → kanonikus geokódolandó név* map (nem sima lista!), mert néhány helyet rövidebb/ragozott alakban emlegetnek, ami nem önmagában geokódolható (pl. "Káptalanfüred" → `Balatonfüred`-re esik vissza, mert Balatonkáptalanfüred nem önálló Nominatim-találat).
   - `FOREIGN_TOWNS` — külföldi helyek (Hallstatt, Bled, Málta), amiket a **title**-ben keres, és **felülírja** a `location` mezőt akkor is, ha az sikeresen geokódolható lenne (pl. egy szervező alapértelmezett budapesti címére), mert a cím gyakran csak a szervező székhelye, nem a tényleges (külföldi) helyszín.
   - Illesztés case/ékezet-normalizált (`includesTown`), ragozott alakokra is működik.
   - **Ismert korlát, amire figyelni kell:** egy sikertelen geokódolás `null`-ként öröké cache-elődik `data/geocode-cache.json`-ban, **soha nem próbálja újra** — pedig az OSM/Nominatim adatai idővel bővülnek (ld. "Beba Beach Bar" eset: napok óta `null` volt, pedig mára megtalálható). Ha egy helyszín gyanúsan sosem kap koordinátát, érdemes kézzel törölni a cache-bejegyzést és újrafuttatni a `process`-t.
   - "Szeg vízibázis" / "szegi" helyszín **még mindig nincs felvéve** — a felhasználó nem adta meg a pontos helyet, "Szeg" önmagában túl kockázatos substring lenne (false positive-ok).

## Nyitott/lezáratlan szálak

- **Saját domain/tárhely (supper.hu, cPanel + FTP)**: a domaint Judit 2026-07-23-án vette, ugyanannál a cégnél, ahol a tárhely is van. Az SSL (AutoSSL) elsőre "supper.hu is unmanaged" hibát adott — ez tipikusan az friss domain hitelesítés/DNS-propagálás miatt volt, Judit szerint pár óra alatt megoldódott, de **explicit nem volt visszaigazolva, hogy az AutoSSL végül lefutott** — ha legközelebb SSL-problémát jelez, ellenőrizd elsőként ezt. Az FTP-deploy (`deploy.yml`) működik, ezt már visszaigazolta ("siker, működik").
- **Google Search Console**: 2026-07-27-én megerősítve — **az oldal indexelve van** (Googlebot okostelefonra sikeresen feltérképezte 2026-07-24-én, feltérképezés és indexelés is engedélyezett, hiba nincs). Ez a szál lezárva. Fontos módszertani tanulság: sem a Claude websearch-eszköz, sem egy böngészőpanelből indított élő Google-keresés (`site:supper.hu`) nem megbízható ennek ellenőrzésére — előbbi nem feltétlenül a valódi Google-indexet kérdezi le, utóbbit a Google bot-védelme blokkolja. **Csak a Search Console adata számít mérvadónak.** Bing Webmaster Tools állapota továbbra sem ismert, ha szóba kerül, kérdezz rá.
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
