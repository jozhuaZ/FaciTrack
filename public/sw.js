// Bump these whenever sw.js changes so the activate handler clears stale caches.
const CACHE_NAME = 'facitrack-v8';

/**
 * Rendered pages live apart from static assets, because they are the only
 * cached thing that belongs to one person. Signing out drops this whole cache
 * in one call; the CSS and images are nobody's secret and stay put.
 */
const PAGE_CACHE = 'facitrack-pages-v7';

// Where the signed-in session was last seen. Kept in PAGE_CACHE so that
// clearing the pages clears the pointer to them too.
const HOME_KEY = '/__facitrack-home';

// Reached by opening the app: neither is worth restoring, and both are proof
// of a signed-out session when the server answers them with a page.
const SIGNED_OUT_PATHS = ['/', '/login'];

const HOME_PATH = /^\/(student|instructor|dean|admin)\/dashboard\/?$/;

async function rememberHome(path) {
    const cache = await caches.open(PAGE_CACHE);
    await cache.put(HOME_KEY, new Response(path, { headers: { 'Content-Type': 'text/plain' } }));
}

async function readHome() {
    const cache = await caches.open(PAGE_CACHE);
    const stored = await cache.match(HOME_KEY);
    return stored ? (await stored.text()).trim() : null;
}

/**
 * Pages, network-first.
 *
 * Offline, opening the app asks for "/" — and what is cached under "/" is the
 * landing page, saved the last time it was visited signed out. Falling back to
 * it made a working session look like a logged-out one. So an offline "/" is
 * sent to whichever dashboard the session was last on instead, as a redirect
 * rather than a swap, so the address and every relative link on the page stay
 * consistent with what is being shown.
 *
 * Being "signed in" offline is only ever a view of the last page fetched. The
 * data is as old as the last time the device had a connection, and anything
 * the page tries to do will fail until it is back.
 */
async function handleNavigation(request) {
    const url = new URL(request.url);
    const signedOutPath = SIGNED_OUT_PATHS.includes(url.pathname);

    try {
        const response = await fetch(request);

        // Everything here is bookkeeping for the next visit. It must never be
        // able to fail the response the reader is waiting on: a rejected
        // promise handed to respondWith() is shown as a network error, so a
        // storage problem would present as "this site can't be reached" on a
        // page the server answered perfectly well.
        if (response.ok) {
            try {
                // A rendered page for "/" or "/login" is the server saying
                // nobody is signed in — the redirect for a live session never
                // arrives here with ok set. Whatever the previous session left
                // behind goes now, so the next person to open this device
                // offline cannot read it.
                if (signedOutPath) await caches.delete(PAGE_CACHE);
                else if (HOME_PATH.test(url.pathname)) await rememberHome(url.pathname);

                // Navigations reaching here are GET (the fetch handler sends
                // form POSTs straight to the network), so this is always
                // cacheable — the guard stays as a cheap assertion of that.
                if (request.method === 'GET') {
                    const cache = await caches.open(PAGE_CACHE);
                    await cache.put(request, response.clone());
                }
            } catch (err) {
                console.warn('[SW] Could not cache', url.pathname, err.message);
            }
        }
        return response;
    } catch (err) {
        if (signedOutPath) {
            const home = await readHome();
            if (home && await caches.match(home)) {
                return Response.redirect(new URL(home, self.location.origin).toString(), 302);
            }
        }

        const cached = await caches.match(request);
        if (cached) return cached;
        throw err;
    }
}

// Assets to pre-cache on install
const PRECACHE_ASSETS = [
    '/css/style.css',
    '/css/header.css',
    '/css/footer.css',

    '/css/student/dashboard.css',
    '/css/student/profile.css',
    '/css/instructor/dashboard.css',

    '/js/main.js',
    '/js/instructor-dashboard.js',

    '/images/FaciTrack-logo.png',
    '/images/icon-192.png',
    '/images/icon-maskable-192.png',
    '/manifest.json'
];

/** Remove cached copies of the same file stamped with another ?v= version. */
async function dropOtherVersions(cache, url) {
    const keys = await cache.keys();
    await Promise.all(keys
        .filter((key) => {
            const k = new URL(key.url);
            return k.pathname === url.pathname && k.search !== url.search;
        })
        .map((key) => cache.delete(key)));
}

// Install: pre-cache static assets
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_ASSETS))
    );
    self.skipWaiting();
});

// Activate: clean up old caches
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys.filter((key) => key !== CACHE_NAME && key !== PAGE_CACHE)
                    .map((key) => caches.delete(key))
            )
        )
    );
    self.clients.claim();
});

// Fetch: network-first for navigation/API, cache-first for static assets
self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = new URL(request.url);

    // Only handle same-origin requests
    if (url.origin !== location.origin) return;

    // Stylesheets and scripts. A tag stamped ?v=<deploy> names one exact
    // build of the file, so the cached copy is right for as long as that URL
    // is asked for; when a deploy changes the stamp, the old copy is dropped.
    // An unstamped file has no such promise and goes to the network first,
    // falling back to the cache offline.
    if (request.destination === 'script' || request.destination === 'style') {
        if (url.searchParams.has('v')) {
            event.respondWith(
                caches.match(request).then((cached) => cached || fetch(request).then((response) => {
                    if (response.ok) {
                        const clone = response.clone();
                        caches.open(CACHE_NAME).then(async (cache) => {
                            await dropOtherVersions(cache, url);
                            await cache.put(request, clone);
                        });
                    }
                    return response;
                }))
            );
        } else {
            event.respondWith(
                fetch(request)
                    .then((response) => {
                        if (response.ok) {
                            const clone = response.clone();
                            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
                        }
                        return response;
                    })
                    .catch(() => caches.match(request))
            );
        }
        return;
    }

    // Images and fonts — cache first
    if (request.destination === 'image' || request.destination === 'font') {
        event.respondWith(
            caches.match(request).then((cached) => {
                if (cached) return cached;
                return fetch(request).then((response) => {
                    if (response.ok) {
                        const clone = response.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
                    }
                    return response;
                });
            })
        );
        return;
    }

    // Navigation requests (HTML pages) — GET only.
    //
    // A form submit is a navigation too, but letting the worker handle a POST
    // means it fetches the POST and, when the server answers with a redirect
    // (the OTP step redirects to the dashboard on success), the redirect is
    // resolved inside the worker rather than by the browser. That surfaced as a
    // stray POST to the redirect target, which has no POST route, and a 404.
    // Non-GET navigations go straight to the network, where the browser follows
    // the 302 as a GET the way it always has.
    if (request.mode === 'navigate' && request.method === 'GET') {
        event.respondWith(handleNavigation(request));
        return;
    }
});

// ── Web Push: show a device notification ──
// Fires even when FaciTrack is closed — the browser wakes the service worker.
self.addEventListener('push', (event) => {
    let data = {};
    try {
        data = event.data ? event.data.json() : {};
    } catch (_) {
        data = { title: 'FaciTrack', body: event.data ? event.data.text() : '' };
    }

    event.waitUntil(
        self.registration.showNotification(data.title || 'FaciTrack', {
            body: data.body || '',
            // A notification icon renders small — the 844 KB source was being
            // downloaded in full to fill a 48px badge.
            icon: '/images/icon-192.png',
            badge: '/images/icon-maskable-192.png',
            // Same tag replaces an older notification for the same appointment
            // rather than stacking duplicates.
            tag: data.tag || 'facitrack',
            renotify: true,
            data: { url: data.url || '/' }
        })
    );
});

// ── Tapping the notification opens (or focuses) the right page ──
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const target = (event.notification.data && event.notification.data.url) || '/';

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
            // Reuse an already-open FaciTrack tab instead of opening another one
            for (const client of windowClients) {
                if (client.url.includes(self.location.origin) && 'focus' in client) {
                    client.navigate(target);
                    return client.focus();
                }
            }
            if (clients.openWindow) return clients.openWindow(target);
        })
    );
});
