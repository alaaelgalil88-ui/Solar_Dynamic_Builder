/* dpb-fs2.js — single-source layer for the grouped maps (default Ramming, Saddle, Bearing).
 * Load AFTER dpb-fs.js. Switch: localStorage dpb_fs2_mode = "on" (default off => does nothing).
 * Handles upsertMany / deleteMany / getGrid / getGridBatch / records pull for the grouped processes only;
 * everything else goes to the layer underneath (dpb-fs.js or Apps Script) untouched. */
(function () {
  'use strict';
  if (window.DPB_FS2) return;
  var prevFetch = window.fetch.bind(window), CORE = window.DPB_FS2_CORE;
  var LS = { mode: 'dpb_fs2_mode', procs: 'dpb_fs2_procs', cfg: 'dpb_fs_cfg', ns: 'dpb_fs_ns', auth: 'dpb_fs_auth' };
  var SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
  function ls(k, d) { try { var v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } }
  // switch from the address bar: ...index.html?fs2=on  /  ?fs2=off
  try { var m = /[?&]fs2=(on|off)/.exec(location.search); if (m) localStorage.setItem(LS.mode, m[1]); } catch (e) {}
  function on() { return ls(LS.mode, 'off') === 'on'; }
  function procs() { return ls(LS.procs, 'Ramming,Saddle,Bearing').split(',').map(function (s) { return s.trim(); }).filter(Boolean); }
  function mine(name) { var s = CORE.slug(name); return procs().some(function (p) { return CORE.slug(p) === s; }); }
  function jsonRes(o) { return new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } }); }
  function clean(o) { return JSON.parse(JSON.stringify(o)); }

  function makeAdapter() {
    var conf; try { conf = JSON.parse(ls(LS.cfg, 'null')); } catch (e) { conf = null; }
    if (!conf || !conf.projectId) return Promise.reject(new Error('مفيش Firebase config'));
    return Promise.all([import(SDK + 'firebase-app.js'), import(SDK + 'firebase-firestore.js'), import(SDK + 'firebase-auth.js')]).then(function (m) {
      var appM = m[0], fs = m[1], authM = m[2], app = appM.getApps().length ? appM.getApp() : appM.initializeApp(conf), db;
      try { db = fs.initializeFirestore(app, { localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }) }); } catch (e) { db = fs.getFirestore(app); }
      var auth = authM.getAuth(app), ac; try { ac = JSON.parse(ls(LS.auth, 'null')); } catch (e) { ac = null; }
      var ready = (ac && ac.email && ac.password) ? authM.signInWithEmailAndPassword(auth, ac.email, ac.password) : (auth.currentUser ? Promise.resolve() : authM.signInAnonymously(auth));
      function dref(p) { return fs.doc.apply(null, [db].concat(p.split('/'))); }
      return ready.then(function () {
        return {
          listen: function (path, cb) { fs.onSnapshot(fs.collection.apply(null, [db].concat(path.split('/'))), function (q) { cb(q.docs.map(function (d) { return { id: d.id, data: d.data() }; })); }, function (e) { console.warn('dpb-fs2 listen', e); cb(null, e); }); },
          // t:'s' = write a whole small doc (meta). t:'f' = write only the listed cells inside a row doc (mergeFields replaces exactly those cells, never the rest of the row)
          write: function (ops) {
            var p = Promise.resolve();
            for (var i = 0; i < ops.length; i += 400) (function (chunk) {
              p = p.then(function () {
                var b = fs.writeBatch(db);
                chunk.forEach(function (o) {
                  if (o.t === 's') b.set(dref(o.path), clean(o.data));
                  else if (o.t === 'f') { var cells = clean(o.cells); b.set(dref(o.path), Object.assign({}, o.base, { cells: cells }), { mergeFields: ['process', 'r'].concat(Object.keys(cells).map(function (k) { return 'cells.' + k; })) }); }
                  else b.delete(dref(o.path));
                });
                return b.commit();
              });
            })(ops.slice(i, i + 400));
            return p;
          }
        };
      });
    });
  }

  var store = null, creating = null, failedAt = 0, lastErr = '', version = 0, notifyT = null;
  function permHint(e) { var m = String(e && e.message || e || ''); return /permission|insufficient/i.test(m) ? m + ' — قواعد Firebase لازم تسمح بالمسار dpb2/**' : m; }
  function startCreate() {
    if (creating) return creating;
    creating = (window.__DPB_FS2_ADAPTER ? Promise.resolve(window.__DPB_FS2_ADAPTER) : makeAdapter()).then(function (a) {
      var s = CORE.create(a, { ns: String(ls(LS.ns, 'test')).replace(/[^A-Za-z0-9_\-]/g, '_') });
      s.onChange(function () { version++; clearTimeout(notifyT); notifyT = setTimeout(function () { try { if (typeof window.__dpbFetchLiveGrid === 'function') window.__dpbFetchLiveGrid(); } catch (e) {} paintState(); }, 300); });
      return s.ready.then(function () { store = s; failedAt = 0; lastErr = ''; s.ensureEpoch(); paintState(); return s; });
    }).catch(function (e) { creating = null; failedAt = Date.now(); lastErr = permHint(e); paintState(); throw e; });
    return creating;
  }
  // never waits forever: ready within 8s, or it fails fast (and is retried at most every 30s) so nothing else in the app hangs behind it
  function getStore() {
    if (store) return Promise.resolve(store);
    if (failedAt && Date.now() - failedAt < 30000) return Promise.reject(new Error(lastErr || 'unavailable')); // cool-down: fail fast, a late success clears it
    var p = startCreate();
    return new Promise(function (res, rej) {
      var t = setTimeout(function () { failedAt = Date.now(); lastErr = lastErr || 'انتهت مهلة الاتصال بـ Firestore (8 ثواني)'; rej(new Error(lastErr)); }, 8000);
      p.then(function (s) { clearTimeout(t); res(s); }, function (e) { clearTimeout(t); rej(e); });
    });
  }
  function stagesOf(body) {
    var names = (body.groupedProcessNames || []).filter(Boolean), sc = body.stageCodes || {}, out = [];
    if (!names.length) names = procs();
    names.forEach(function (n, i) { var code = 0; Object.keys(sc).forEach(function (k) { if (CORE.slug(k) === CORE.slug(n)) code = Number(sc[k]) || 0; }); out.push({ name: n, code: code || (i + 1) }); });
    return out;
  }
  function withBody(init, body) { return Object.assign({}, init, { body: JSON.stringify(body) }); }
  function parse(res) { return res.json(); }
  function fail(e) { return jsonRes({ ok: false, error: 'Firestore2: ' + permHint(e) }); }

  function overlayGrid(s, name, g) {
    if (!g || g.ok === false) return g;
    var cells = s.all().filter(function (d) { return CORE.slug(d.process) === CORE.slug(name); });
    var rows = g.rows || 0, cols = g.cols || 0;
    cells.forEach(function (d) { rows = Math.max(rows, Number(d.r1) + 1); cols = Math.max(cols, Number(d.c1) + 1); });
    var v = []; for (var i = 0; i < rows; i++) { var row = new Array(cols); for (var j = 0; j < cols; j++) row[j] = ''; v.push(row); }
    cells.forEach(function (d) { v[d.r1][d.c1] = Number(d.code) || ''; });
    g.values = v; g.rows = rows; g.cols = cols; return g;
  }

  function batchRes(input, init) {
    return prevFetch(input, init).then(parse).then(function (o) {
      return getStore().then(function (s) {
        if (o && o.grids) Object.keys(o.grids).forEach(function (n) { if (mine(n)) overlayGrid(s, n, o.grids[n]); });
        return jsonRes(o);
      }, function () { if (o && o.grids) Object.keys(o.grids).forEach(function (n) { if (mine(n)) delete o.grids[n]; }); return jsonRes(o); });
    });
  }

  window.fetch = function (input, init) {
    try {
      if (!on()) return prevFetch(input, init);
      var base = window.DPB_getScriptUrl && window.DPB_getScriptUrl();
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      if (!base || url.indexOf(base) !== 0) return prevFetch(input, init);
      var method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase(), q = {}, qi = url.indexOf('?');
      if (qi >= 0) url.slice(qi + 1).split('&').forEach(function (kv) { var p = kv.split('='); q[decodeURIComponent(p[0])] = decodeURIComponent((p[1] || '').replace(/\+/g, ' ')); });
      if (method === 'POST') {
        var body = {}; try { body = JSON.parse((init && init.body) || '{}'); } catch (e) { return prevFetch(input, init); }
        if (body.action === 'upsertMany') {
          var recs = body.records || [], m = recs.filter(function (r) { return r && mine(r.process); });
          if (!m.length) return prevFetch(input, init);
          var rest = recs.filter(function (r) { return !(r && mine(r.process)); });
          return getStore().then(function (s) { return s.put(m, stagesOf(body)); }).then(function (pr) {
            return rest.length ? prevFetch(input, withBody(init, Object.assign({}, body, { records: rest }))) : jsonRes({ ok: true, stale: pr.stale || [], serverTime: new Date().toISOString() });
          }, fail);
        }
        if (body.action === 'deleteMany') {
          // only ids that really live in the new layer are handled here; everything else (Torque Tube, Modules, ...) goes down untouched
          return getStore().then(function (s) {
            var ids = (body.ids || []).map(String), known = {}; s.all().forEach(function (d) { known[String(d.id)] = true; known[s.id(d.process, d.r1, d.c1)] = true; });
            var mineIds = ids.filter(function (x) { return known[x]; }), otherIds = ids.filter(function (x) { return !known[x]; });
            if (!mineIds.length) return prevFetch(input, init);
            return s.removeIds(mineIds, stagesOf(body)).then(function (r) {
              if (!otherIds.length) return jsonRes(r);
              return prevFetch(input, withBody(init, Object.assign({}, body, { ids: otherIds }))).then(parse).then(function (o) { o.deleted = (o.deleted || 0) + r.deleted; o.blocked = (o.blocked || []).concat(r.blocked); return jsonRes(o); });
            });
          }, function () { return prevFetch(input, init); });
        }
        if (body.action === 'getGrid' && mine(body.process || body.sheet)) {
          var nm = body.process || body.sheet;
          return Promise.all([getStore(), prevFetch(input, init).then(parse)]).then(function (r) { return jsonRes(overlayGrid(r[0], nm, r[1])); }, fail);
        }
        if (body.action === 'getGridBatch') { return batchRes(input, init); }
        return prevFetch(input, init);
      }
      if (q.action === 'getGrid' && mine(q.process || q.sheet)) { return Promise.all([getStore(), prevFetch(input, init).then(parse)]).then(function (r) { return jsonRes(overlayGrid(r[0], q.process || q.sheet, r[1])); }, fail); }
      if (q.action === 'getGridBatch') { return batchRes(input, init); }
      if (!q.action && !q.debug) { // records pull: everything from below, except the grouped processes which come only from here
        return getStore().then(function (s) {
          return prevFetch(input, init).then(parse).then(function (o) {
            if (!o || o.ok === false || o.unchanged) return jsonRes(o);
            o.data = (o.data || []).filter(function (x) { return !mine(x && x.process); }).concat(s.all().map(function (d) { return Object.assign({ recordId: d.id }, d); }));
            o.rev = String(o.rev || '') + '|f2:' + version; return jsonRes(o);
          });
        }, function () { return jsonRes({ ok: true, unchanged: true }); }); // layer unavailable: change nothing locally, do not hang
      }
      return prevFetch(input, init);
    } catch (e) { return prevFetch(input, init); }
  };
  window.DPB_FS2 = { on: on, setMode: function (v) { try { localStorage.setItem(LS.mode, v ? 'on' : 'off'); } catch (e) {} }, procs: procs, store: getStore };

  /* ---- Import: make the new layer match what the layer underneath (the Google Sheet side) shows right now ---- */
  function readGrid(name) {
    var base = window.DPB_getScriptUrl && window.DPB_getScriptUrl();
    return prevFetch(base + '?action=getGrid&process=' + encodeURIComponent(name) + '&t=' + Date.now()).then(parse).then(function (g) {
      if (!g || g.ok === false || !Array.isArray(g.values)) throw new Error('تعذر قراءة تبويب ' + name + (g && g.error ? ' (' + g.error + ')' : ''));
      return g;
    });
  }
  function cellsOf(g) { // numeric > 0 cells right of the two label columns (A = row name, B = post number)
    var out = [], mg = {}; (g.merges || []).forEach(function (m) { mg[m.r1 + '|' + m.c1] = m; });
    g.values.forEach(function (row, r) { (row || []).forEach(function (v, c) {
      if (c < 2) return; var raw = String(v == null ? '' : v).trim(); if (raw === '') return; var n = Number(raw);
      if (!isFinite(n) || n <= 0) return; var m = mg[r + '|' + c];
      out.push({ r: r, c: c, code: n, r2: m ? m.r2 : r, c2: m ? m.c2 : c });
    }); });
    return out;
  }
  function importAll(apply) {
    return getStore().then(function (s) {
      return Promise.all(procs().map(function (n) { return readGrid(n).then(function (g) { return { n: n, cells: cellsOf(g) }; }); })).then(function (gs) {
        return Promise.all(gs.map(function (x) { return s.importProcess(x.n, x.cells, !apply).then(function (r) { r.name = x.n; r.sheet = x.cells.length; return r; }); }));
      });
    });
  }
  window.DPB_FS2.importAll = importAll;

  /* ---- Admin card (Admin > sync tab): on/off, live status, counts, import ---- */
  function paintState() {
    var el = document.getElementById('dpbFs2State'); if (!el) return;
    if (!on()) { el.textContent = 'الحالة: متقفلة (النظام القديم شغّال)'; return; }
    if (store) { var c = store.counts(), t = procs().map(function (n) { var k = Object.keys(c).filter(function (x) { return CORE.slug(x) === CORE.slug(n); })[0]; return n + ': ' + (k ? c[k] : 0); }).join(' | '); el.textContent = 'الحالة: شغّالة ومتصلة ✅ — منفّذ دلوقتي: ' + t; return; }
    el.textContent = failedAt ? ('الحالة: شغّالة لكن مش متصلة ❌ — ' + lastErr) : 'الحالة: بتتصل بـ Firestore…';
  }
  function mountCard() {
    var host = document.querySelector('.dpbAdminTabPanel[data-tab="sync"]');
    if (!host || document.getElementById('dpbFs2Card')) return;
    var c = document.createElement('section'); c.className = 'dpbAdminCard'; c.id = 'dpbFs2Card';
    c.innerHTML = '<h3>🧩 الطبقة الجديدة (Ramming / Saddle / Bearing)</h3>' +
      '<div class="hint">مصدر واحد للخلايا في Firestore. مفيش حاجة بتتغيّر إلا لما تشغّلها. بتتكتب في مكان جديد منفصل عن بياناتك القديمة، وإيقافها بيرجّعك للنظام القديم فورًا.</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px"><button type="button" class="dpbAdminBtn" id="dpbFs2Toggle"></button><button type="button" class="dpbAdminBtn" id="dpbFs2Import">📥 مطابقة الخرائط على الشيت</button></div>' +
      '<div class="hint" id="dpbFs2State" style="margin-top:8px"></div>' +
      '<div class="hint" id="dpbFs2Msg" style="margin-top:6px"></div>';
    var old = document.getElementById('dpbFsCard');
    if (old && old.parentNode === host) host.insertBefore(c, old.nextSibling); else host.appendChild(c);
    function paint() { document.getElementById('dpbFs2Toggle').textContent = on() ? '⏹ إيقاف الطبقة الجديدة' : '▶ تشغيل الطبقة الجديدة'; paintState(); if (on() && !store) getStore().catch(function () {}); }
    document.getElementById('dpbFs2Toggle').addEventListener('click', function () {
      window.DPB_FS2.setMode(!on()); paint();
      if (typeof alert === 'function') alert(on() ? 'اتشغّلت. اقفل التطبيق وافتحه تاني.' : 'اتقفلت. اقفل التطبيق وافتحه تاني.');
    });
    document.getElementById('dpbFs2Import').addEventListener('click', function () {
      var msg = document.getElementById('dpbFs2Msg');
      if (!on()) { msg.textContent = 'شغّل الطبقة الجديدة الأول.'; return; }
      msg.textContent = 'بقرا الشيت…';
      importAll(false).then(function (r) {
        var line = r.map(function (x) { return x.name + ': الشيت ' + x.sheet + ' — هيتضاف ' + x.add + '، هيتعدّل ' + x.change + '، هيتشال ' + x.remove; }).join('\n');
        if (!confirm('مطابقة الطبقة الجديدة على الشيت بالظبط (اللي مش في الشيت بيتشال):\n\n' + line + '\n\nنكمّل؟')) { msg.textContent = 'اتلغت.'; return; }
        msg.textContent = 'بكتب…';
        return importAll(true).then(function () { msg.textContent = 'تمت المطابقة ✅'; paintState(); try { if (typeof window.__dpbFetchLiveGrid === 'function') window.__dpbFetchLiveGrid(); } catch (e) {} });
      }).catch(function (e) { msg.textContent = 'فشل: ' + permHint(e); });
    });
    paint();
  }
  function bootCard() { mountCard(); try { new MutationObserver(mountCard).observe(document.documentElement, { childList: true, subtree: true }); } catch (e) {} }
  if (typeof document !== 'undefined') { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootCard); else bootCard(); }
  if (on()) setTimeout(function () { getStore().catch(function () {}); }, 1500); // connect early so a problem shows in the card instead of on the first tap
})();
