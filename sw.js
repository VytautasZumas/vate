/* Before the Blockchain — VATE 2026
   Offline service worker.
   Strategy:
     - HTML document  -> network first, fall back to cache (so re-uploads appear)
     - everything else -> cache first (audio, icons, manifest)
     - Range requests  -> served from the full cached response (needed by Safari)
*/

var CACHE = 'vate-v1';
var SHELL = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', function (e) {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      // Individual adds so one missing file cannot fail the whole install.
      return Promise.all(SHELL.map(function (u) {
        return c.add(u).catch(function () { return null; });
      }));
    })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return (k === CACHE) ? null : caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

/* Build a 206 Partial Content response out of a full cached response.
   Safari requests audio with a Range header and rejects a plain 200. */
function rangeFrom(res, range) {
  return res.arrayBuffer().then(function (buf) {
    var total = buf.byteLength;
    var m = /bytes=(\d*)-(\d*)/.exec(range || '');
    var start = m && m[1] ? parseInt(m[1], 10) : 0;
    var end = m && m[2] ? parseInt(m[2], 10) : total - 1;
    if (isNaN(start) || start < 0) start = 0;
    if (isNaN(end) || end >= total) end = total - 1;
    if (start > end) { start = 0; end = total - 1; }
    var slice = buf.slice(start, end + 1);
    var h = new Headers();
    h.set('Content-Type', res.headers.get('Content-Type') || 'audio/mpeg');
    h.set('Content-Length', String(slice.byteLength));
    h.set('Content-Range', 'bytes ' + start + '-' + end + '/' + total);
    h.set('Accept-Ranges', 'bytes');
    return new Response(slice, { status: 206, statusText: 'Partial Content', headers: h });
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  var range = req.headers.get('range');
  var isDoc = req.mode === 'navigate' ||
              req.destination === 'document' ||
              /\.html?$/i.test(url.pathname) ||
              url.pathname.endsWith('/');

  if (isDoc) {
    // Network first: a fresh upload wins, but offline still works.
    e.respondWith(
      fetch(req).then(function (res) {
        if (res && res.ok) {
          var cp = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, cp); });
        }
        return res;
      }).catch(function () {
        return caches.match(req).then(function (r) {
          return r || caches.match('./index.html') || caches.match('./');
        });
      })
    );
    return;
  }

  // Cache first for audio, icons, manifest.
  e.respondWith(
    caches.open(CACHE).then(function (c) {
      return c.match(req, { ignoreVary: true }).then(function (hit) {
        if (hit) return range ? rangeFrom(hit.clone(), range) : hit;
        // Not cached: fetch a full copy, store it, then answer.
        return fetch(new Request(req.url, { mode: 'cors', credentials: 'omit' }))
          .then(function (res) {
            if (res && res.ok && res.status === 200) {
              c.put(req.url, res.clone());
              return range ? rangeFrom(res.clone(), range) : res;
            }
            return fetch(req);
          })
          .catch(function () { return fetch(req); });
      });
    })
  );
});

/* The page asks for all audio to be pulled down in one go. */
self.addEventListener('message', function (e) {
  var d = e.data || {};
  if (d.cmd !== 'cacheAudio') return;
  var urls = d.urls || [];
  var done = 0, ok = 0;
  var client = e.source;
  caches.open(CACHE).then(function (c) {
    var next = function (i) {
      if (i >= urls.length) {
        if (client) client.postMessage({ evt: 'audioDone', ok: ok, total: urls.length });
        return;
      }
      c.match(urls[i], { ignoreVary: true }).then(function (hit) {
        if (hit) { ok++; done++; report(); return next(i + 1); }
        return fetch(urls[i]).then(function (res) {
          if (res && res.ok && res.status === 200) { ok++; return c.put(urls[i], res.clone()); }
        }).catch(function () {}).then(function () {
          done++; report(); next(i + 1);
        });
      });
      function report() {
        if (client) client.postMessage({ evt: 'audioProgress', done: done, ok: ok, total: urls.length });
      }
    };
    next(0);
  });
});
