// Offline shell only. API responses (sessions, results, diffs) are never cached: they are private and must be live.
const SHELL = 'singularity-remote-shell-v1';
const FILES = ['/', '/app.js', '/style.css', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', event => {
	event.waitUntil(caches.open(SHELL).then(cache => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
	event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== SHELL).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
	const url = new URL(event.request.url);
	if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) { return; }
	event.respondWith(fetch(event.request).then(response => {
		const copy = response.clone();
		if (response.ok) { caches.open(SHELL).then(cache => cache.put(event.request, copy)); }
		return response;
	}).catch(() => caches.match(event.request)));
});
