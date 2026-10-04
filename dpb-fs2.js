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
          listen: function (path, cb) { fs.onSnapshot(fs.collection.apply(null, [db].concat(path.split('/'))), function (q) { cb(q.docs.map(function (d) { return { id: d.id, data: d.data() }; })); }, function (e) { console.warn('dpb-fs2 listen', e); }); },
          write: function (ops) {
            var p = Promise.resolve();
            for (var i = 0; i < ops.length; i += 400) (function (chunk) {
              p = p.then(function () { var b = fs.writeBatch(db); chunk.forEach(function (o) { if (o.t === 's') b.set(dref(o.path), clean(o.data)); else b.delete(dref(o.path)); }); return b.commit(); });
            })(ops.slice(i, i + 400));
            return p;
          }
        };
      });
    });
  }

  var store = null, storeP = null, version = 0, notifyT = null;
  function getStore() {
    if (store) return Promise.resolve(store);
    if (storeP) return storeP;
    storeP = (window.__DPB_FS2_ADAPTER ? Promise.resolve(window.__DPB_FS2_ADAPTER) : makeAdapter()).then(function (a) {
      var s = CORE.create(a, { ns: String(ls(LS.ns, 'test')).replace(/[^A-Za-z0-9_\-]/g, '_') });
      s.onChange(function () { version++; clearTimeout(notifyT); notifyT = setTimeout(function () { try { if (typeof window.__dpbFetchLiveGrid === 'function') window.__dpbFetchLiveGrid(); } catch (e) {} }, 300); });
      return s.ready.then(function () { store = s; return s; });
    }).catch(function (e) { storeP = null; throw e; });
    return storeP;
  }
  function stagesOf(body) {
    var names = (body.groupedProcessNames || []).filter(Boolean), sc = body.stageCodes || {}, out = [];
    if (!names.length) names = procs();
    names.forEach(function (n, i) { var code = 0; Object.keys(sc).forEach(function (k) { if (CORE.slug(k) === CORE.slug(n)) code = Number(sc[k]) || 0; }); out.push({ name: n, code: code || (i + 1) }); });
    return out;
  }
  function withBody(init, body) { return Object.assign({}, init, { body: JSON.stringify(body) }); }
  function parse(res) { return res.json(); }
  function fail(e) { return jsonRes({ ok: false, error: 'Firestore2: ' + String(e && e.message || e) }); }

  function overlayGrid(s, name, g) {
    if (!g || g.ok === false) return g;
    var cells = s.all().filter(function (d) { return CORE.slug(d.process) === CORE.slug(name); });
    var rows = g.rows || 0, cols = g.cols || 0;
    cells.forEach(function (d) { rows = Math.max(rows, Number(d.r1) + 1); cols = Math.max(cols, Number(d.c1) + 1); });
    var v = []; for (var i = 0; i < rows; i++) { var row = new Array(cols); for (var j = 0; j < cols; j++) row[j] = ''; v.push(row); }
    cells.forEach(function (d) { v[d.r1][d.c1] = Number(d.code) || ''; });
    g.values = v; g.rows = rows; g.cols = cols; return g;
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
          return getStore().then(function (s) {
            var ids = (body.ids || []).map(String), known = {}; s.all().forEach(function (d) { known[String(d.id)] = true; });
            var mineIds = ids.filter(function (x) { return known[x]; }), otherIds = ids.filter(function (x) { return !known[x]; });
            return s.removeIds(mineIds, stagesOf(body)).then(function (r) {
              if (!otherIds.length) return jsonRes(r);
              return prevFetch(input, withBody(init, Object.assign({}, body, { ids: otherIds, siblings: [] }))).then(parse).then(function (o) { o.deleted = (o.deleted || 0) + r.deleted; o.blocked = (o.blocked || []).concat(r.blocked); return jsonRes(o); });
            });
          }, fail);
        }
        if (body.action === 'getGrid' && mine(body.process || body.sheet)) {
          var nm = body.process || body.sheet;
          return Promise.all([getStore(), prevFetch(input, init).then(parse)]).then(function (r) { return jsonRes(overlayGrid(r[0], nm, r[1])); }, fail);
        }
        if (body.action === 'getGridBatch') {
          return Promise.all([getStore(), prevFetch(input, init).then(parse)]).then(function (r) {
            var o = r[1]; if (o && o.grids) Object.keys(o.grids).forEach(function (n) { if (mine(n)) overlayGrid(r[0], n, o.grids[n]); }); return jsonRes(o);
          }, fail);
        }
        return prevFetch(input, init);
      }
      if (q.action === 'getGrid' && mine(q.process || q.sheet)) { return Promise.all([getStore(), prevFetch(input, init).then(parse)]).then(function (r) { return jsonRes(overlayGrid(r[0], q.process || q.sheet, r[1])); }, fail); }
      if (q.action === 'getGridBatch') {
        return Promise.all([getStore(), prevFetch(input, init).then(parse)]).then(function (r) { var o = r[1]; if (o && o.grids) Object.keys(o.grids).forEach(function (n) { if (mine(n)) overlayGrid(r[0], n, o.grids[n]); }); return jsonRes(o); }, fail);
      }
      if (!q.action && !q.debug) { // records pull: everything from below, except the grouped processes which come only from here
        return Promise.all([getStore(), prevFetch(input, init).then(parse)]).then(function (r) {
          var o = r[1]; if (!o || o.ok === false || o.unchanged) return jsonRes(o);
          o.data = (o.data || []).filter(function (x) { return !mine(x && x.process); }).concat(r[0].all().map(function (d) { return Object.assign({ recordId: d.id }, d); }));
          o.rev = String(o.rev || '') + '|f2:' + version; return jsonRes(o);
        }, fail);
      }
      return prevFetch(input, init);
    } catch (e) { return prevFetch(input, init); }
  };
  window.DPB_FS2 = { on: on, setMode: function (v) { try { localStorage.setItem(LS.mode, v ? 'on' : 'off'); } catch (e) {} }, procs: procs, store: getStore };

  /* ---- Admin button (Admin > sync tab): turns the new layer on/off, no URL needed (works in the APK too) ---- */
  function mountCard() {
    var host = document.querySelector('.dpbAdminTabPanel[data-tab="sync"]');
    if (!host || document.getElementById('dpbFs2Card')) return;
    var c = document.createElement('section'); c.className = 'dpbAdminCard'; c.id = 'dpbFs2Card';
    c.innerHTML = '<h3>🧩 الطبقة الجديدة (Ramming / Saddle / Bearing)</h3>' +
      '<div class="hint">مصدر واحد للخلايا في Firestore. مفيش حاجة بتتغيّر إلا لما تشغّلها. بتتكتب في مكان جديد منفصل عن بياناتك القديمة، وإيقافها بيرجّعك للنظام القديم فورًا.</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px"><button type="button" class="dpbAdminBtn" id="dpbFs2Toggle"></button></div>' +
      '<div class="hint" id="dpbFs2State" style="margin-top:8px"></div>';
    var old = document.getElementById('dpbFsCard');
    if (old && old.parentNode === host) host.insertBefore(c, old.nextSibling); else host.appendChild(c);
    function paint() {
      document.getElementById('dpbFs2Toggle').textContent = on() ? '⏹ إيقاف الطبقة الجديدة' : '▶ تشغيل الطبقة الجديدة';
      document.getElementById('dpbFs2State').textContent = on() ? 'الحالة: شغّالة ✅ (بتحتاج إعدادات Firebase المحفوظة في الكارت اللي فوق)' : 'الحالة: متقفلة (النظام القديم شغّال)';
    }
    document.getElementById('dpbFs2Toggle').addEventListener('click', function () {
      window.DPB_FS2.setMode(!on()); paint();
      if (typeof alert === 'function') alert(on() ? 'اتشغّلت. اقفل التطبيق وافتحه تاني.' : 'اتقفلت. اقفل التطبيق وافتحه تاني.');
    });
    paint();
  }
  function bootCard() { mountCard(); try { new MutationObserver(mountCard).observe(document.documentElement, { childList: true, subtree: true }); } catch (e) {} }
  if (typeof document !== 'undefined') { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootCard); else bootCard(); }
})();
