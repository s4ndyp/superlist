const CACHE_NAME = 'superlijst-v1';

// De bestanden die nodig zijn om de app te laden (inclusief externe bibliotheken)
const ASSETS_TO_CACHE = [
    './',
    './index.html',
    'https://cdn.tailwindcss.com',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
    'https://cdnjs.cloudflare.com/ajax/libs/Sortable/1.15.0/Sortable.min.js'
];

// 1. INSTALLATIE: Cache de bestanden
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            console.log('[ServiceWorker] Caching app shell');
            return cache.addAll(ASSETS_TO_CACHE);
        })
    );
});

// 2. ACTIVEREN: Ruim oude caches op (als we een nieuwe versie maken)
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keyList) => {
            return Promise.all(keyList.map((key) => {
                if (key !== CACHE_NAME) {
                    console.log('[ServiceWorker] Removing old cache', key);
                    return caches.delete(key);
                }
            }));
        })
    );
    return self.clients.claim();
});

// 3. FETCH: Onderschep netwerkverzoeken
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // A. API Calls: Probeer ALTIJD netwerk eerst.
    // Als netwerk faalt, geven we een error terug (de frontend schakelt dan over op localStorage)
    if (url.pathname.startsWith('/api/')) {
        event.respondWith(
            fetch(event.request).catch(() => {
                // Return een JSON error zodat de frontend weet dat het mislukte
                return new Response(JSON.stringify({ error: 'Offline' }), {
                    headers: { 'Content-Type': 'application/json' }
                });
            })
        );
        return;
    }

    // B. Statische bestanden (HTML, CSS, JS): Probeer CACHE eerst, dan netwerk
    event.respondWith(
        caches.match(event.request).then((response) => {
            // Gevonden in cache? Serveer direct!
            if (response) {
                return response;
            }
            // Niet in cache? Haal van internet
            return fetch(event.request);
        })
    );
});
