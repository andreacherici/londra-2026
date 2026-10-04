/* Service worker "Londra 2026": serve a far aprire l'app anche senza connessione.
   Qui dentro NON ci sono dati del viaggio (quelli stanno nelle pagine cifrate) e nessuna password.

   Come lavora:
   - pagine HTML: prima la rete (attesa massima 4 secondi), altrimenti la copia salvata sul telefono;
   - tasselli della mappa (tile): copia salvata per prima, la rete solo se manca. Si salvano solo risposte
     "CORS" normali: quelle "opache" pesano circa 7 MB l'una nella quota del telefono e non si salvano;
   - font di Google: si usa subito la copia salvata e intanto la si aggiorna;
   - sincronizzazione (*.firebasedatabase.app) e ricerca luoghi (nominatim, photon): mai in cache, il service worker non
     interviene (solo rete);
   - tutto e' in try/catch: se qualcosa va storto il service worker si fa da parte e la pagina funziona lo stesso.

   La riga VERSIONE qui sotto viene riscritta da pubblica.ps1 a ogni pubblicazione (data e ora): cosi' il
   telefono si accorge che c'e' una versione nuova e cambia le copie salvate. */
'use strict';

const VERSIONE = '20261004-213244';
const CACHE_APP = 'londra-app-' + VERSIONE;   // pagine e icone: cambia a ogni pubblicazione
const CACHE_TILE = 'londra-tile-v1';          // tasselli della mappa: resta tra una versione e l'altra
const CACHE_FONT = 'londra-font-v1';          // font di Google
const PREFISSO = 'londra-';                   // tocchiamo solo le cache nostre (l'indirizzo e' condiviso con altri siti)

const PRECACHE = [
  './',
  'index.html',
  'programma.html',                            // solo un rinvio a ./#programma (il Programma sta dentro la mappa): serve alle vecchie schermate Home e ai vecchi link
  'manifest.webmanifest',
  'icone/icona-180.png',
  'icone/icona-192.png',
  'icone/icona-512.png',
  'icone/icona-512-maskable.png'
];

const MAX_TILE = 2500;                        // oltre questo numero si eliminano i tasselli piu' vecchi
const MAX_FONT = 40;
const ATTESA_RETE_MS = 4000;

const HOST_TILE = ['tile.openstreetmap.org', 'server.arcgisonline.com', 'tile.openstreetmap.de'];
const HOST_FONT = ['fonts.googleapis.com', 'fonts.gstatic.com'];
// Servizi "vivi": sincronizzazione (Firebase) e ricerca luoghi. Le risposte non si salvano MAI (sarebbero dati vecchi o, nel caso
// della sincronizzazione, dati condivisi cifrati in una cache che nessuno controlla) e il service worker non interviene proprio:
// la richiesta va sempre in rete, e senza rete fallisce subito come deve (l'app lo sa gestire).
const HOST_SOLO_RETE = ['firebasedatabase.app', 'nominatim.openstreetmap.org', 'photon.komoot.io'];

let tileSalvati = 0;

try {
  self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
      try {
        const cache = await caches.open(CACHE_APP);
        await Promise.all(PRECACHE.map(async (indirizzo) => {
          try {
            // cache: 'reload' = si scarica davvero dalla rete, non dalla copia temporanea del browser
            const richiesta = new Request(indirizzo, { cache: 'reload' });
            const risposta = await fetch(richiesta);
            if (risposta && risposta.ok && !risposta.redirected) await cache.put(richiesta, risposta);
          } catch (e) { /* un file che non si scarica non deve bloccare l'installazione */ }
        }));
      } catch (e) { /* niente cache: si andra' sempre in rete */ }
      try { await self.skipWaiting(); } catch (e) { /* ignora */ }
    })());
  });

  self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
      try {
        const nomi = await caches.keys();
        await Promise.all(
          nomi
            .filter((n) => n.indexOf(PREFISSO) === 0 && n !== CACHE_APP && n !== CACHE_TILE && n !== CACHE_FONT)
            .map((n) => caches.delete(n))
        );
      } catch (e) { /* ignora */ }
      try { await self.clients.claim(); } catch (e) { /* ignora */ }
    })());
  });

  self.addEventListener('fetch', (event) => {
    try {
      const richiesta = event.request;
      if (richiesta.method !== 'GET') return;
      const url = new URL(richiesta.url);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return;
      if (isHost(url.hostname, HOST_SOLO_RETE)) return;      // solo rete: nessun respondWith, nessuna cache

      if (url.origin === self.location.origin) {
        const accept = richiesta.headers.get('accept') || '';
        if (richiesta.mode === 'navigate' || accept.indexOf('text/html') >= 0) {
          rispondi(event, retePrima);
        } else {
          rispondi(event, copiaPrima);
        }
      } else if (isHost(url.hostname, HOST_TILE)) {
        rispondi(event, tassello);
      } else if (isHost(url.hostname, HOST_FONT)) {
        rispondi(event, fontSwr);
      }
      // qualunque altra richiesta: nessun intervento, la gestisce il browser
    } catch (e) { /* mai rompere la pagina */ }
  });
} catch (e) { /* mai rompere la pagina */ }

/* ------------------------------------------------------------------ */

function isHost(host, elenco) {
  for (let i = 0; i < elenco.length; i++) {
    if (host === elenco[i] || host.endsWith('.' + elenco[i])) return true;
  }
  return false;
}

// Se la strategia fallisce in modo imprevisto si ripiega sulla rete normale.
function rispondi(event, strategia) {
  event.respondWith((async () => {
    try {
      return await strategia(event.request, event);
    } catch (e) {
      return fetch(event.request);
    }
  })());
}

function estendi(event, promessa) {
  try { event.waitUntil(promessa.catch(() => {})); } catch (e) { /* ignora */ }
}

// Cerca in cache ignorando l'eventuale ?parametro (per le pagine) e l'intestazione Vary.
async function trova(cache, richiesta, ignoraQuery) {
  return cache.match(richiesta, { ignoreSearch: !!ignoraQuery, ignoreVary: true });
}

// Scarica una pagina chiedendo SEMPRE conferma al server. GitHub Pages dice al browser di tenere le pagine per
// 10 minuti ("max-age=600"): senza "no-cache" un aggiornamento appena pubblicato resterebbe invisibile per 10 minuti.
// Di solito il server risponde "non e' cambiato" (304), che e' leggerissimo.
// redirect: 'manual' = se l'indirizzo viene girato (es. .../londra-2026 diventa .../londra-2026/) e' il browser a seguire
// il redirect, cosi' l'indirizzo finale e i percorsi relativi (sw.js, icone...) restano corretti.
function paginaAggiornata(richiesta) {
  return fetch(richiesta.url, { cache: 'no-cache', credentials: 'same-origin', redirect: 'manual' });
}

/* Pagine: rete per prima (max 4 s), poi copia salvata. Online la pagina si aggiorna da sola. */
async function retePrima(richiesta, event) {
  const cache = await caches.open(CACHE_APP);

  const rete = paginaAggiornata(richiesta).then(async (risposta) => {
    try {
      if (risposta && risposta.ok && risposta.type === 'basic') {
        await cache.put(richiesta, risposta.clone());
      }
    } catch (e) { /* ignora */ }
    return risposta;
  });
  rete.catch(() => {});   // evita l'errore "non gestito" se la rete cade dopo che abbiamo usato la copia

  const scaduto = new Promise((risolvi) => setTimeout(() => risolvi(null), ATTESA_RETE_MS));

  try {
    const risposta = await Promise.race([rete, scaduto]);
    if (risposta) return risposta;
  } catch (e) { /* rete non disponibile: si usa la copia */ }

  let copia = await trova(cache, richiesta, true);
  if (!copia) {
    // pagina non salvata: per l'indirizzo principale si ripiega sull'altra forma (./ oppure index.html)
    const url = new URL(richiesta.url);
    if (/\/$|\/index\.html$/.test(url.pathname)) {
      copia = await trova(cache, new Request(/\/$/.test(url.pathname) ? 'index.html' : './'), true);
    }
  }
  if (copia) {
    estendi(event, rete);   // la rete lenta continua in sottofondo e aggiorna la copia
    return copia;
  }
  return rete;              // niente copia: non resta che aspettare la rete
}

/* File dell'app (icone, manifest...): copia salvata per prima, poi rete. */
async function copiaPrima(richiesta) {
  const cache = await caches.open(CACHE_APP);
  const copia = await trova(cache, richiesta, false);
  if (copia) return copia;
  const risposta = await fetch(richiesta);
  try {
    if (risposta && risposta.ok && risposta.type === 'basic') await cache.put(richiesta, risposta.clone());
  } catch (e) { /* ignora */ }
  return risposta;
}

/* Tasselli della mappa: copia salvata per prima; si salva solo se la risposta NON e' opaca. */
async function tassello(richiesta, event) {
  const cache = await caches.open(CACHE_TILE);
  const copia = await trova(cache, richiesta, false);
  if (copia) return copia;
  const risposta = await fetch(richiesta);
  try {
    if (risposta && risposta.ok && risposta.type !== 'opaque' && risposta.type !== 'opaqueredirect') {
      await cache.put(richiesta, risposta.clone());
      tileSalvati++;
      if (tileSalvati % 25 === 0) estendi(event, limita(CACHE_TILE, MAX_TILE));
    }
  } catch (e) { /* ignora */ }
  return risposta;
}

/* Font di Google: si risponde subito con la copia salvata e intanto la si rinfresca. */
async function fontSwr(richiesta, event) {
  const cache = await caches.open(CACHE_FONT);
  let copia = await trova(cache, richiesta, false);
  // una copia opaca non si puo' dare a una richiesta CORS (sarebbe un errore di rete)
  if (copia && copia.type === 'opaque' && richiesta.mode !== 'no-cors') copia = undefined;

  const rete = fetch(richiesta).then(async (risposta) => {
    try {
      // il foglio di stile dei font (fonts.googleapis.com) arriva per forza come risposta opaca: e' un file
      // solo per indirizzo, quindi pochi e leggeri
      if (risposta && (risposta.ok || risposta.type === 'opaque')) {
        await cache.put(richiesta, risposta.clone());
        estendi(event, limita(CACHE_FONT, MAX_FONT));
      }
    } catch (e) { /* ignora */ }
    return risposta;
  });
  rete.catch(() => {});

  if (copia) {
    estendi(event, rete);
    return copia;
  }
  return rete;
}

/* Tiene al massimo `massimo` voci: elimina le piu' vecchie (l'ordine di keys() e' quello di inserimento). */
async function limita(nomeCache, massimo) {
  try {
    const cache = await caches.open(nomeCache);
    const chiavi = await cache.keys();
    const troppe = chiavi.length - massimo;
    for (let i = 0; i < troppe; i++) await cache.delete(chiavi[i]);
  } catch (e) { /* ignora */ }
}
