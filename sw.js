/**
 * SuperLijst Service Worker - Versie 14 (Agressieve Caching)
 * Geoptimaliseerd voor snelle activatie en betrouwbare offline toegang.
 */

const CACHE_NAME = 'superlijst-assets-v14';

// De bestanden die nodig zijn voor de "App Shell"
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

// --- INSTALLATIE ---
self.addEventListener('install', event => {
    console.log('[SW] Installeren van nieuwe versie...');
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            return cache.addAll(urlsToCache);
        })
    );
    // Dwing de nieuwe SW om direct de 'active' status aan te nemen
    self.skipWaiting();
});

// --- ACTIVATIE ---
self.addEventListener('activate', event => {
    console.log('[SW] Activeren en oude caches opruimen...');
    event.waitUntil(
        Promise.all([
            // Verwijder oude caches die niet overeenkomen met CACHE_NAME
            caches.keys().then(cacheNames => {
                return Promise.all(
                    cacheNames.map(cacheName => {
                        if (cacheName !== CACHE_NAME) {
                            return caches.delete(cacheName);
                        }
                    })
                );
            }),
            // Neem direct de controle over alle openstaande tabbladen/vensters
            self.clients.claim()
        ])
    );
});

// --- FETCH STRATEGIE ---
self.addEventListener('fetch', event => {
    // Alleen GET requests afhandelen (geen API calls voor de gateway)
    // We laten de OfflineManager/DataGateway zelf hun POST/PUT requests doen.
    if (event.request.method !== 'GET' || event.request.url.includes('/api/')) {
        return;
    }

    event.respondWith(
        // Probeer het netwerk, maar gebruik een timeout van 2 seconden
        fetchWithTimeout(event.request, 2000)
            .then(response => {
                // Succes op netwerk? Sla op in cache en geef terug
                const resClone = response.clone();
                caches.open(CACHE_NAME).then(cache => cache.put(event.request, resClone));
                return response;
            })
            .catch(() => {
                // Netwerk faalt of duurt te lang? Gebruik de cache
                return caches.match(event.request).then(cachedResponse => {
                    if (cachedResponse) return cachedResponse;
                    
                    // Indien echt niets gevonden (ook niet in cache), stuur lege response of offline pagina
                    return new Response("Offline content niet beschikbaar", { 
                        status: 503, 
                        statusText: "Service Unavailable" 
                    });
                });
            })
    );
});

/**
 * Hulpfunctie om een fetch te laten falen na een bepaalde tijd (timeout)
 */
function fetchWithTimeout(request, timeout = 2000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timeout')), timeout);
        fetch(request).then(
            response => {
                clearTimeout(timer);
                resolve(response);
            },
            err => {
                clearTimeout(timer);
                reject(err);
            }
        );
    });
}
