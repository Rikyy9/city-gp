# City GP

Gioco di corse nel browser: scegli una città, il gioco disegna un circuito cittadino sulle strade
vere (OpenStreetMap) e ricostruisce edifici, monumenti e rilievi in 3D con le immagini satellitari.

## Provarlo sul computer

Serve [Node.js](https://nodejs.org) 20 o più recente.

```bash
npm install
npm run dev
```

Poi apri http://localhost:8765.

## Creare la versione da pubblicare

```bash
npm run build
```

La cartella `dist/` contiene il gioco completo (circa 300 KB compressi più i caratteri): si può
caricare così com'è su qualsiasi hosting statico. I percorsi sono relativi, quindi funziona anche
in una sottocartella.

Per vederla prima di pubblicarla: `npm run preview` (http://localhost:8766).

## Dove pubblicarlo

- **itch.io** — `npm run zip` crea `city-gp-web.zip`. Su itch.io: *Create new project* → *Kind of
  project: HTML* → carica lo zip → spunta *This file will be played in the browser*, dimensione
  consigliata 1280×720 con *Fullscreen button* attivo.
- **GitHub Pages** — carica il progetto in un repository GitHub, poi *Settings → Pages → Source:
  GitHub Actions*. Il file `.github/workflows/deploy.yml` pubblica il gioco a ogni push su `main`.
- **Netlify** — collega il repository (oppure trascina la cartella `dist/` su app.netlify.com/drop).
  `netlify.toml` contiene già comando di build e intestazioni di cache.

Dopo aver scelto l'indirizzo definitivo, metti l'URL assoluto dell'immagine in `index.html`
(`og:image`), così le anteprime sui social funzionano.

## Prima di un lancio pubblico

Il gioco usa solo servizi gratuiti, senza chiavi. Vanno benissimo per un progetto personale e per
un pubblico piccolo, ma hanno regole d'uso da rispettare se i giocatori diventano tanti. Tutti gli
indirizzi sono in `js/config.js`, così si possono cambiare in un punto solo.

| Servizio | Uso nel gioco | Cosa controllare |
| --- | --- | --- |
| Overpass API (OpenStreetMap) | strade, edifici, monumenti | server comunitari con limiti di carico; per molto traffico usare un'istanza propria o a pagamento |
| Nominatim | ricerca delle città | massimo 1 richiesta al secondo, niente ricerca mentre si digita (già così) |
| tile.openstreetmap.org | mappa e minimappa | la [tile policy](https://operations.osmfoundation.org/policies/tiles/) vieta l'uso intensivo: per un lancio grande passare a un fornitore di tile |
| Esri World Imagery | immagini satellitari | verificare i [termini Esri](https://www.esri.com/en-us/legal/terms/full-master-agreement) per l'uso pubblico; alternativa: MapTiler Satellite (chiave gratuita) |
| AWS Terrain Tiles | elevazione | open data, nessun limite particolare |

Le attribuzioni richieste sono già nel gioco (pannello laterale e *Info, crediti e privacy*).

## Cosa contiene

- `index.html`, `css/style.css` — interfaccia
- `js/` — gioco (three.js per il 3D, Leaflet per la mappa)
  - `main.js` flusso del gioco, HUD, gara · `physics.js` guida, danni · `ai.js` avversari
  - `trackgen.js` / `track.js` circuiti e traiettoria ideale · `world.js` / `buildings.js` mondo 3D
  - `weather.js` pioggia e nuvole · `radio.js` radio e telecronaca · `records.js` classifiche personali
  - `config.js` indirizzi dei servizi esterni
- `public/` — icone, manifest e service worker (il gioco si può installare come app e si apre anche offline)

Record, impostazioni e circuiti salvati restano nel browser del giocatore (localStorage); non ci sono
server, account né statistiche.
