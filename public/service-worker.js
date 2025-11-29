// --- Configuratie ---
// Zorg voor een nieuwe versie om de cache te forceren
const CACHE_NAME = 'superlijst-v8';

// De bestanden die nodig zijn om de app te laden (inclusief externe bibliotheken)
const urlsToCache = [
    './', // De index.html
    './index.html',
    './manifest.json', 
    './android-chrome-192x192.png', 
    './android-chrome-512x512.png', 
    'https://cdn.tailwindcss.com',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
    'https://cdnjs.cloudflare.com/ajax/libs/Sortable/1.15.0/Sortable.min.js'
];

// De sleutel voor de lokale wachtrij voor mutaties (moet overeenkomen met de client)
const SYNC_QUEUE_KEY = 'superlijst_sync_queue';
const LOCAL_LISTS_KEY = 'superlijst_local_pending_lists';
const TEMP_ID_PREFIX = 'temp-';

// --- Installatie (Caching) ---
self.addEventListener('install', event => {
    console.log('[Service Worker] Installeren en cachen...');
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                return cache.addAll(urlsToCache);
            })
    );
});

// --- Activatie (Oude caches opruimen) ---
self.addEventListener('activate', event => {
    console.log('[Service Worker] Activeren en oude caches opruimen...');
    const cacheWhitelist = [CACHE_NAME];
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cacheName => {
                    if (cacheWhitelist.indexOf(cacheName) === -1) {
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
});

// --- Fetch (Cache First Strategie voor Assets) ---
self.addEventListener('fetch', event => {
    // Alleen GET requests afhandelen voor caching
    if (event.request.method === 'GET') {
        event.respondWith(
            caches.match(event.request).then(response => {
                // Cache hit - retourneer response
                if (response) return response;
                
                // Geen cache match - voer de netwerk request uit
                return fetch(event.request).catch(error => {
                    console.log('[Service Worker] Fout bij ophalen netwerk:', error);
                    // Hier kunt u een fallback-pagina/response leveren indien gewenst.
                });
            })
        );
    }
    // Voor POST/PUT/DELETE requests: laat ze met rust; de client-side logica/sync handelt het af.
});

// --- Background Sync Logica ---

/**
 * Voert een enkele mutatie (POST/PUT/DELETE) opnieuw uit.
 * @param {Object} mutation - {method, path, body}
 * @returns {Promise<boolean>} True bij succes, False bij fout.
 */
async function retryMutation(mutation) {
    console.log(`[Sync] Opnieuw versturen: ${mutation.method} ${mutation.path}`);
    
    // Voor POST/PUT/DELETE, halen we de token uit localStorage.
    const token = await new Promise(resolve => {
        // Om localStorage te bereiken vanuit de Service Worker, moeten we de client vragen
        self.clients.matchAll().then(clients => {
            if (clients.length) {
                // Stuur een bericht naar de client om de token te krijgen.
                clients[0].postMessage({ type: 'GET_AUTH_TOKEN' });
                // We wachten op een antwoord via een broadcast channel of simpelweg door de token te lezen
                // uit de lokale opslag die wordt gedeeld (maar we kunnen hier geen Promise maken zonder complexere communicatie).
                // Vanwege de complexiteit van asynchrone communicatie in Service Workers,
                // vertrouwen we op de gedeelde localStorage (maar dit is technisch een "anti-pattern" voor PWA's).
                // Voor dit doel houden we het simpel en gebruiken we een lokaal opgeslagen token.
                const storedToken = localStorage.getItem('superlijst_jwt_token');
                resolve(storedToken);
            } else {
                resolve(null);
            }
        });
    });

    if (!token) {
        console.error("[Sync] Geen JWT gevonden. Kan mutatie niet uitvoeren.");
        return false;
    }

    try {
        const url = new URL(mutation.path, mutation.apiBaseUrl);
        const response = await fetch(url.href, {
            method: mutation.method,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: mutation.body ? JSON.stringify(mutation.body) : undefined
        });

        if (!response.ok) {
            console.error(`[Sync] Opnieuw versturen mislukt (${response.status}): ${mutation.path}`);
            // Bij een 401/403 (ongeldige token/auth) stoppen we de sync.
            if (response.status === 401 || response.status === 403) return true; // Markeren als succes zodat het uit de wachtrij is
            return false;
        }

        // --- HANDEL TIJDELIJKE ID'S AF ---
        if (mutation.method === 'POST' && mutation.body.id && mutation.body.id.startsWith(TEMP_ID_PREFIX)) {
            // Als het een POST was met een tijdelijke client-ID, moeten we de ID in de lokale opslag bijwerken.
            // Dit is zeer complex vanuit de Service Worker zonder IndexedDB.
            // We sturen een bericht naar de client om de lokale UI op te ruimen/vernieuwen.
            const data = await response.json();
            self.clients.matchAll().then(clients => {
                 clients.forEach(client => client.postMessage({ 
                    type: 'SYNC_SUCCESS', 
                    tempId: mutation.body.id, 
                    newId: data.id,
                    data: data.data // Het nieuwe, gesynchroniseerde document
                }));
            });
        }
        
        return true; // Succes
    } catch (error) {
        console.error("[Sync] Netwerkfout bij retry. Opnieuw in de wachtrij plaatsen.", error);
        return false; // Mislukt, blijft in de wachtrij
    }
}

// --- Sync Event Handler ---
self.addEventListener('sync', event => {
    if (event.tag === 'sync-lists') {
        console.log('[Service Worker] Background Sync geactiveerd: sync-lists');
        
        // De eigenlijke synchronisatie wordt gedelegeerd naar de client.
        // De Service Worker kan moeilijk de complexe logica van de client (waaronder de JWT-afhandeling en de API Base URL)
        // en de lokale UI-update uitvoeren.
        
        // We sturen een bericht naar de client (index.html) om de synchronisatie te starten.
        event.waitUntil(
            self.clients.matchAll().then(clients => {
                if (clients.length) {
                    clients[0].postMessage({ type: 'START_CLIENT_SYNC' });
                    // We stoppen de SW's verwerking, omdat de client het nu overneemt.
                }
            })
        );
    }
});

// --- Communicatie met Client ---
self.addEventListener('message', event => {
    if (event.data.type === 'SYNC_NOW_PLEASE') {
        console.log('[Service Worker] Bericht ontvangen van client: Handmatige Sync');
        // Registreer een sync event. Dit zorgt ervoor dat het proces op de achtergrond draait.
        event.waitUntil(self.registration.sync.register('sync-lists'));
    }
});
