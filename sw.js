/**
 * SuperLijst Service Worker - Versie 11 (Geoptimaliseerd voor Dexie & OfflineManager)
 * Alleen bedoeld voor het cachen van de App Shell (assets).
 */

const CACHE_NAME = 'superlijst-assets-v11';

// Bestanden die we offline beschikbaar willen hebben
const urlsToCache = [
    './',
    './index.html',
    './manifest.json',
    './offline_manager.js',
    './datagateway.js',
    './android-chrome-192x192.png',
    './android-chrome-512x512.png',
    'https://cdn.tailwindcss.com',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
    'https://cdnjs.cloudflare.com/ajax/libs/Sortable/1.15.0/Sortable.min.js',
    'https://unpkg.com/dexie/dist/dexie.js'
];

// Installatie: Sla alle bestanden op in de cache
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            console.log('[SW] Bestanden cachen');
            return cache.addAll(urlsToCache);
        })
    );
    self.skipWaiting();
});

// Activatie: Verwijder oude caches
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cacheName => {
                    if (cacheName !== CACHE_NAME) {
                        console.log('[SW] Oude cache verwijderen:', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
    self.clients.claim();
});

// Fetch: Network-first, fallback naar cache (zo heb je altijd de nieuwste versie als je online bent)
self.addEventListener('fetch', event => {
    // Alleen GET requests cachen (geen API calls)
    if (event.request.method !== 'GET' || event.request.url.includes('/api/')) {
        return;
    }

    event.respondWith(
        fetch(event.request)
            .then(response => {
                // Als het netwerk werkt, kopieer de response naar de cache
                const resClone = response.clone();
                caches.open(CACHE_NAME).then(cache => cache.put(event.request, resClone));
                return response;
            })
            .catch(() => {
                // Als het netwerk faalt, gebruik de cache
                return caches.match(event.request);
            })
    );
});
