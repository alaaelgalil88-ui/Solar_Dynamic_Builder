/* dpb-fs2.js — single-source layer for the grouped maps (default Ramming, Saddle, Bearing).
 * Load AFTER dpb-fs.js. Switch: localStorage dpb_fs2_mode = "on" (default off => does nothing).
 * Handles upsertMany / deleteMany / getGrid / getGridBatch / records pull for every MAP process (Ramming, Saddle, Bearing, Torque Tube, Modules...);
 * the list is learned from the app's own map catalog. Only the grouped ones (Ramming/Saddle/Bearing) are locked/cascaded together.
 * Everything else goes to the layer underneath (dpb-fs.js or Apps Script) untouched. */
(function () {
  'use strict';
  if (window.DPB_FS2) return;
  var prevFetch = window.fetch.bind(window), CORE = window.DPB_FS2_CORE;
  var LS = { mode: 'dpb_fs2_mode', procs: 'dpb_fs2_procs', cfg: 'dpb_fs_cfg', ns: 'dpb_fs_ns', auth: 'dpb_fs_auth' };
  var SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
  function loadSdk() {
    return import('./vendor/firebase-bundle.js').then(function (b) { return [b.app, b.firestore, b.auth]; }, function () {
      return Promise.all([import(SDK + 'firebase-app.js'), import(SDK + 'firebase-firestore.js'), import(SDK + 'firebase-auth.js')]);
    });
  }
  function ls(k, d) { try { var v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } }
  // switch from the address bar: ...index.html?fs2=on  /  ?fs2=off
  try { var m = /[?&]fs2=(on|off)/.exec(location.search); if (m) localStorage.setItem(LS.mode, m[1]); } catch (e) {}
  // local emulator: ?emu=on / ?emu=off in the address bar (only honoured on localhost / 127.0.0.1, so the live app can never be pointed at it)
  // real local development only (plain http on localhost). The Capacitor app is served from https://localhost and must use the REAL Firebase, never the emulator.
  var EMU_HOST = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && location.protocol === 'http:' && !window.Capacitor;
  try { var me = /[?&]emu=(on|off)/.exec(location.search); if (me && EMU_HOST) localStorage.setItem('dpb_fs2_emu', me[1]); } catch (e) {}
  function emu() { return EMU_HOST && ls('dpb_fs2_emu', 'on') === 'on'; }   // on localhost the emulator is the default
  // A device that was never switched by hand (no saved mode) follows the shipped dpb-config.js: when that file carries a Firebase project the
  // layer is ON, so a new phone / new browser works without anyone opening the admin card first. An explicit choice saved on the device
  // (the admin card toggle, ?fs2=off) always wins.
  // Apps Script اتلغى: طبقة Firestore هي الطبقة الوحيدة، فمفيش حاجة اسمها "مقفولة" (ولا مفتاح تشغيل/إيقاف).
  function on() { return true; }
  function procs() { return ls(LS.procs, '').split(',').map(function (s) { return s.trim(); }).filter(Boolean); }
  function mine(name) { var s = CORE.slug(name); return procs().some(function (p) { return CORE.slug(p) === s; }); }
  // a record belongs to this layer only if its process is a map process AND it points at a map cell; anything else (e.g. a tracker-level entry) goes down untouched
  function isCell(r) { return !!r && mine(r.process) && r.r1 != null && r.c1 != null; }
  // the app tells us which processes have a map (so a new project needs no change here)
  function setProcs(list) { try { var s = (list || []).map(function (x) { return String(x == null ? '' : x).trim(); }).filter(Boolean).join(','); if (s && s !== ls(LS.procs, '')) localStorage.setItem(LS.procs, s); } catch (e) {} }
  function nsName() { return String(ls(LS.ns, 'test')).replace(/[^A-Za-z0-9_\-]/g, '_'); }
  function jsonRes(o) { return new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } }); }
  function clean(o) { return JSON.parse(JSON.stringify(o)); }

  /* ---- v125 connection diagnostics: the last 60 events (slow / late ack / rejected / listener died / probe / network bounce), kept on the device
     so they survive a restart and can be read in Admin > sync card without any computer. Each kind is throttled so an Excel upload cannot flood it. ---- */
  var DLOG_KEY = 'dpb_fs2_diaglog', dlogBuf = [], dlogLast = {};
  try { dlogBuf = JSON.parse(localStorage.getItem(DLOG_KEY) || '[]') || []; if (!Array.isArray(dlogBuf)) dlogBuf = []; } catch (e) { dlogBuf = []; }
  function dlog(kind, text) {
    try {
      var n = Date.now(), l = dlogLast[kind];
      if (l && n - l.t < 5000 && l.x === String(text)) { l.c++; return; }
      dlogLast[kind] = { t: n, x: String(text), c: 0 };
      dlogBuf.push({ t: n, k: kind, x: String(text == null ? '' : text).slice(0, 220) });
      if (dlogBuf.length > 60) dlogBuf = dlogBuf.slice(-60);
      localStorage.setItem(DLOG_KEY, JSON.stringify(dlogBuf));
    } catch (e) {}
  }
  window.__dpbFs2Diag = function () { return dlogBuf.slice(); };
  // v157: Firestore's free plan allows 50,000 READS a day (writes: 20,000). Every document a device receives from the server costs one read, so the app now
  // counts, per device and per quota day (resets at midnight Pacific time), how many documents came from: listeners (live changes), single reads (kv/settings/users)
  // and full backup reads. The totals go into the diagnostics log, so the day the quota runs out the log says who used it.
  var RC = { d: '', listen: 0, get: 0, backup: 0 }, rcDirty = false, rcLogged = '';
  function rcDay() { var d = new Date(Date.now() - 7 * 3600000); return d.getUTCFullYear() + '-' + (d.getUTCMonth() + 1) + '-' + d.getUTCDate(); }
  function rcLoad() { var day = rcDay(); if (RC.d === day) return; var o = null; try { o = JSON.parse(ls('dpb_fs2_reads', 'null')); } catch (e) {} RC = (o && o.d === day) ? o : { d: day, listen: 0, get: 0, backup: 0 }; }
  function rc(kind, n) { rcLoad(); RC[kind] = (RC[kind] || 0) + (n || 0); rcDirty = true; }
  function rcToday() { rcLoad(); return { day: RC.d, listen: RC.listen, get: RC.get, backup: RC.backup, total: RC.listen + RC.get + RC.backup }; }
  window.DPB_FS2_reads = rcToday;
  setInterval(function () {
    if (rcDirty) { rcDirty = false; try { localStorage.setItem('dpb_fs2_reads', JSON.stringify(RC)); } catch (e) {} }
    var t = rcToday(), sig = Math.floor(t.total / 500);
    if (t.total && String(sig) !== rcLogged) { rcLogged = String(sig); dlog('reads', 'today on this device: ' + t.total + ' (live changes ' + t.listen + ', single reads ' + t.get + ', backup ' + t.backup + ') of the 50,000/day free quota (all devices together)'); }
  }, 15000);
  // v156: memory trail for the "force closed - ran out of memory" crashes. Every 30 s the JS heap is sampled; a line goes into the diagnostics log when it
  // moved by 25 MB or more (or every 10 min), so after the next crash the log shows how the heap grew and what the layer was doing just before.
  (function () {
    var lastMb = -999, lastAt = 0;
    function sample() {
      try {
        var m = performance && performance.memory; if (!m) return;
        var mb = Math.round(m.usedJSHeapSize / 1048576), lim = Math.round(m.jsHeapSizeLimit / 1048576), n = Date.now();
        if (Math.abs(mb - lastMb) >= 25 || n - lastAt > 600000) { lastMb = mb; lastAt = n; dlog('mem', mb + ' MB of ' + lim + ' MB' + (document.hidden ? ' (background)' : '')); }
      } catch (e) {}
    }
    setInterval(sample, 30000); setTimeout(sample, 5000);
  })();

  // Firestore's commit() only resolves when the SERVER acknowledges. This wrapper answers {acked:true} when the server confirmed within the wait,
  // and {acked:false, done} when it did not (offline, or no answer within 4 s): the write is saved on the device and queued by the SDK, so the screen can
  // go on, but the caller KNOWS it is not delivered yet; `done` settles when the server finally confirms (or rejects). Pure: tested in Node.
  function makeCommitter(deps) {
    deps = deps || {};
    var setT = deps.setTimeout || setTimeout, clearT = deps.clearTimeout || clearTimeout, now = deps.now || Date.now;
    var online = deps.online || function () { return typeof navigator === 'undefined' || navigator.onLine !== false; };
    var getW = deps.W || function () { return (window.__dpbFs2W = window.__dpbFs2W || { pending: 0, since: 0, refused: '', refusedAt: 0 }); };
    var onEvent = deps.onEvent || function () {};
    // v126: when the SDK's write channel stays silent while the phone IS online (reads work, writes never get an answer), the same batch is sent
    // through a plain HTTPS request (`rescue`, one explicit request with its own timeout and a real error code). First try after 12 s; once a rescue
    // worked on this device the next ones start after 1.5 s. A definite refusal (HTTP 400/403/429...) stops the retries and is shown with its real reason.
    var RESCUE_FIRST = deps.rescueFirst || 12000, RESCUE_FAST = deps.rescueFast || 1500, RESCUE_EVERY = deps.rescueEvery || 20000, RESCUE_MAX = deps.rescueMax || 6;
    return function commitOrQueue(cp, rescue, pidArg) {
      return new Promise(function (res, rej) {
        var done = false, t = null, rt = null, t0 = now(), doneRes, doneRej, W = getW(), counted = true, settled = false, tries = 0, P = String(pidArg || '');
        var dp = new Promise(function (a, b) { doneRes = a; doneRej = b; }); dp.catch(function () {});
        function fin(f, v) { if (done) return; done = true; clearT(t); f(v); }
        function release() { if (!counted) return; counted = false; W.pending = Math.max(0, W.pending - 1); if (W.pend) { W.pend[P] = Math.max(0, (W.pend[P] || 1) - 1); if (!W.pend[P]) { delete W.pend[P]; if (W.pendSince) delete W.pendSince[P]; } } if (!W.pending) { W.since = 0; W.refused = ''; W.refusedPid = ''; } }
        if (!W.pending) W.since = now(); W.pending++; W.pend = W.pend || {}; W.pendSince = W.pendSince || {}; W.pend[P] = (W.pend[P] || 0) + 1; if (W.pend[P] === 1) W.pendSince[P] = now();
        cp.then(function () {
          settled = true; clearT(rt); release();
          if (done) onEvent('ack-late', (now() - t0) + 'ms');
          fin(res, { acked: true }); doneRes();
        }, function (e) {
          settled = true; clearT(rt); release();
          var code = String(e && (e.code || e.message) || e);
          if (done) { W.refused = code; W.refusedPid = P; W.refusedAt = now(); onEvent('rejected', code); doneRej(e); }
          else fin(rej, e);
        });
        function armRescue(ms) {
          if (!rescue || settled || tries >= RESCUE_MAX) return;
          rt = setT(function () {
            if (settled) return;
            if (!online()) { armRescue(RESCUE_EVERY); return; }
            tries++; onEvent('rescue-start', 'try ' + tries + ' after ' + (now() - t0) + 'ms');
            var rp; try { rp = Promise.resolve(rescue()); } catch (e) { rp = Promise.reject(e); }
            rp.then(function () {
              if (settled) return; settled = true; release(); W.rescueOk = now(); W.rescued = (W.rescued || 0) + 1;
              onEvent('rescued', (now() - t0) + 'ms'); fin(res, { acked: true }); doneRes();
            }, function (e) {
              if (settled) return;
              var code = String(e && (e.code || e.message) || e); W.rescueErr = code; W.rescueErrAt = now(); onEvent('rescue-failed', code);
              if (e && e.definite) { W.refused = code; W.refusedPid = P; W.refusedAt = now(); return; }   // the server answered "no": retrying the same thing changes nothing
              armRescue(RESCUE_EVERY);
            });
          }, ms);
        }
        armRescue((W.rescueOk && now() - W.rescueOk < 300000) ? RESCUE_FAST : RESCUE_FIRST);
        t = setT(function () { onEvent('slow', 'no server answer after ' + (now() - t0) + 'ms (pending ' + W.pending + ')'); fin(res, { acked: false, done: dp }); }, online() ? 4000 : 300);
      });
    };
  }
  window.__dpbMakeCommitter = makeCommitter;

  /* ---- v126: plain-HTTPS twin of a write batch (Firestore REST `documents:commit`). Pure functions, tested in Node. ----
     op {t:'s', path, data}  -> whole document      (same as batch.set)
     op {t:'f', path, base, cells} -> only the listed cells of a row document (same as batch.set with mergeFields: base keys + cells.<col>)
     op {t:'d', path}        -> delete */
  function restVal(v) {
    if (v === null || v === undefined) return { nullValue: null };
    var t = typeof v;
    if (t === 'boolean') return { booleanValue: v };
    if (t === 'number') return (isFinite(v) && Math.floor(v) === v && Math.abs(v) <= 9007199254740991) ? { integerValue: String(v) } : { doubleValue: isFinite(v) ? v : 0 };
    if (t === 'string') return { stringValue: v };
    if (Array.isArray(v)) return { arrayValue: { values: v.map(restVal) } };
    if (t === 'object') return { mapValue: { fields: restFields(v) } };
    return { stringValue: String(v) };
  }
  function restFields(o) { var f = {}; Object.keys(o).forEach(function (k) { if (o[k] !== undefined) f[k] = restVal(o[k]); }); return f; }
  /*BKDEC-START*/
  // v158: Firestore REST value -> plain JS (twin of restVal), used by the paged backup read
  function restDec(v) {
    if (!v || typeof v !== 'object') return null;
    if ('stringValue' in v) return v.stringValue;
    if ('integerValue' in v) return Number(v.integerValue);
    if ('doubleValue' in v) return Number(v.doubleValue);
    if ('booleanValue' in v) return !!v.booleanValue;
    if ('timestampValue' in v) return v.timestampValue;
    if ('mapValue' in v) { var o = {}, f = (v.mapValue && v.mapValue.fields) || {}; Object.keys(f).forEach(function (k) { o[k] = restDec(f[k]); }); return o; }
    if ('arrayValue' in v) return ((v.arrayValue && v.arrayValue.values) || []).map(restDec);
    return null;
  }
  function restDocId(name) { var x = String(name || '').split('/').pop(); try { return decodeURIComponent(x); } catch (e) { return x; } }
  /*BKDEC-END*/
  function restFp(k) { return /^[A-Za-z_][A-Za-z_0-9]*$/.test(k) ? k : '`' + String(k).replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`'; }
  function restWrites(docsBase, ops) {
    return ops.map(function (o) {
      var name = docsBase + '/' + o.path;
      if (o.t === 's') return { update: { name: name, fields: restFields(JSON.parse(JSON.stringify(o.data))) } };
      if (o.t === 'f') {
        var cells = JSON.parse(JSON.stringify(o.cells)), base = JSON.parse(JSON.stringify(o.base || {})), f = restFields(base);
        f.cells = { mapValue: { fields: restFields(cells) } };
        return { update: { name: name, fields: f }, updateMask: { fieldPaths: Object.keys(base).map(restFp).concat(Object.keys(cells).map(function (k) { return 'cells.' + restFp(k); })) } };
      }
      return { delete: name };
    });
  }
  // HTTP failure -> Error with a readable code (e.g. "resource-exhausted") and `definite` = the server understood and refused (do not retry blindly)
  function restError(status, text) {
    var j = null; try { j = JSON.parse(text); if (Array.isArray(j)) j = j[0]; } catch (e) {}
    var st = String((j && j.error && j.error.status) || status).toLowerCase().replace(/_/g, '-'), msg = String((j && j.error && j.error.message) || text || '').slice(0, 140);
    var err = new Error('HTTP ' + status + ' ' + st + (msg ? ': ' + msg : '')); err.code = st; err.status = status;
    err.definite = status === 400 || status === 403 || status === 404 || status === 409 || status === 429;
    return err;
  }
  window.__dpbRestWrites = restWrites; window.__dpbRestError = restError;
  // The app filters its local records by the active project (r.projectId). Map-engine marks are sent without one, so stamp it:
  // on the way in (stored in Firestore) and on the way out (older docs that were stored without it).
  function pid() { try { return window.__dpbActiveProjectId || ''; } catch (e) { return ''; } }
  function stamp(r) { var p = pid(); return (p && r && !r.projectId) ? Object.assign({}, r, { projectId: p }) : r; }
  // Records pull that does not depend on the Apps Script side: when the script answers with an error / "unchanged" / nothing at all,
  // the app still has to receive the Firestore records. The reply carries (a) every Firestore record and (b) ONLY those local records
  // of the other processes that are exactly in sync already (same id and time as the app's synced map), so the app's own pull logic
  // neither deletes them nor marks a pending local edit as synced.
  function localInSync() {
    try {
      var raw = JSON.parse(localStorage.getItem('DPB_SHARED_PRODUCTION_V2') || '{}'), sy = JSON.parse(localStorage.getItem('DPB_CLOUD_SYNCED_TIMES_V1') || '{}');
      return (Array.isArray(raw.records) ? raw.records : []).filter(function (x) { return x && x.id && !isCell(x) && sy[x.id] !== undefined && String(sy[x.id]) === String(x.time || ''); });
    } catch (e) { return []; }
  }


  /* ---- v127: OUTBOX for map-cell writes (fixes "deleted cells come back" / "edits silently lost" between an online admin and an offline supervisor) ----
     Before: a cell write went to Firestore as a blind merge, so whichever write ARRIVED last won. An offline supervisor who still showed a cell that the admin
     had already deleted could mark it, and when the phone got its network back that write landed AFTER the delete and brought the cell back.
     Now every cell write is a server-side TRANSACTION: it reads the row from the server first and writes only the cells that are not older than what the
     server holds (times are ISO strings from the shared clock, so a plain string compare is the order). A write that cannot reach the server is kept in
     this outbox (saved in localStorage, survives closing the app) and is sent through the same check when the network returns. */
  var OB_KEY = 'dpb_fs2_outbox_v1', ob = {}, obWait = {}, OBF = { run: function () {} };
  try { ob = JSON.parse(ls(OB_KEY, '{}')) || {}; } catch (e) { ob = {}; }
  function obSave() { try { localStorage.setItem(OB_KEY, JSON.stringify(ob)); } catch (e) {} }
  function obN() { return Object.keys(ob).length; }
  window.__dpbFs2Outbox = function () { return obN(); };
  // pure: what a transaction does with one row. cur = the server's cells of that row, incoming = the cells this device wants to write.
  function planTx(cur, incoming) {
    var put = {}, skipped = [];
    Object.keys(incoming || {}).forEach(function (col) {
      var n = incoming[col], s0 = cur && cur[col];
      if (s0 && String(s0.time || '') > String(n && n.time || '')) skipped.push(s0); else put[col] = n;
    });
    return { put: put, skipped: skipped };
  }
  window.__dpbPlanTx = planTx;
  function obAdd(o) {
    var keys = [];
    Object.keys(o.cells).forEach(function (col) {
      var k = o.path + '|' + col, c = o.cells[col], cur = ob[k]; keys.push(k);
      if (!cur || String(cur.cell.time || '') <= String(c.time || '')) ob[k] = { path: o.path, base: o.base, col: col, cell: JSON.parse(JSON.stringify(c)) };
    });
    obSave(); return keys;
  }
  function obSettle(k, err) { (obWait[k] || []).forEach(function (w) { if (err) w.rej(err); else if (--w.left <= 0) w.res(); }); delete obWait[k]; }
  function obWaiter(keys) {
    var w = { left: keys.length }; w.p = new Promise(function (res, rej) { w.res = res; w.rej = rej; }); w.p.catch(function () {});
    keys.forEach(function (k) { (obWait[k] = obWait[k] || []).push(w); }); return w.p;
  }
  var obT = null, obBack = 0;
  // v129: every pending edit is tied to ITS OWN project (row path rows/<project>__..., base.projectId). It is never dropped and never sent anywhere else.
  // Edits of another project keep going to that project in the background; they are not counted in the warning bar of the open project,
  // and a failure on one project's edits never holds back the edits of the open project.
  function obPid(e) { return String((e && e.base && e.base.projectId) || '').replace(/[^A-Za-z0-9_\-]/g, '_'); }
  // v131: the SDK-level "not confirmed yet" counter is per project too. Only the OPEN project's writes drive the warning bar, the heal/bounce timers and the retries.
  function curPend() { var W = window.__dpbFs2W || {}, cur = pidS(), n = 0; Object.keys(W.pend || {}).forEach(function (k) { if (!k || !cur || k === cur) n += W.pend[k]; }); return n; }
  function curPendSince() { var W = window.__dpbFs2W || {}, cur = pidS(), t = 0; Object.keys(W.pendSince || {}).forEach(function (k) { if (!k || !cur || k === cur) { if (!t || W.pendSince[k] < t) t = W.pendSince[k]; } }); return t; }
  // a deleted project takes its own pending edits with it (a new project can never inherit them: ids are unique, and nothing is left under the old id)
  function forgetProject(id) {
    var p = String(id || '').replace(/[^A-Za-z0-9_\-]/g, '_'), n = 0; if (!p) return 0;
    Object.keys(ob).forEach(function (k) { if (obPid(ob[k]) === p) { try { obSettle(k); } catch (e) {} delete ob[k]; n++; } });
    obSave(); var W = window.__dpbFs2W; if (W && W.pend) { W.pending = Math.max(0, (W.pending || 0) - (W.pend[p] || 0)); delete W.pend[p]; if (W.pendSince) delete W.pendSince[p]; }
    try { dlog('forget-project', p + ' dropped ' + n); } catch (e) {} return n;
  }
  window.__dpbFs2Forget = forgetProject;
  function obNCur() { var cur = pidS(), n = 0; Object.keys(ob).forEach(function (k) { var p = obPid(ob[k]); if (!p || !cur || p === cur) n++; }); return n; }
  function obLater(ms) { if (obT) return; obT = setTimeout(function () { obT = null; OBF.run(); }, ms); }
  try {
    window.addEventListener('online', function () { obBack = 0; setTimeout(function () { OBF.run(); }, 800); });
    document.addEventListener('visibilitychange', function () { if (!document.hidden && obN()) OBF.run(); });
    setInterval(function () { if (obN() && !document.hidden) OBF.run(); }, 20000);
  } catch (e) {}
  var DEFINITE = /permission|unauth|resource-exhausted|quota|invalid-argument/i;

  function makeAdapter() {
    var conf; try { conf = JSON.parse(ls(LS.cfg, 'null')); } catch (e) { conf = null; }
    if (emu()) conf = { apiKey: 'demo', projectId: 'demo-no-project', appId: 'demo' };   // emulator needs no real config
    if (!conf || !conf.projectId) return Promise.reject(new Error('مفيش Firebase config'));
    // المكتبة جوه الـ APK/الموقع نفسه (vendor/firebase-bundle.js): بتفتح من الجهاز من غير نت. لو الملف مش موجود بنرجع للتحميل من الإنترنت زي الأول.
      return loadSdk().then(function (m) {
      var appM = m[0], fs = m[1], authM = m[2], db, app;
      if (emu()) {
        // own named app + own Firestore instance: dpb-fs.js already calls getFirestore() on the DEFAULT app (real config), and two layers
        // sharing one instance made initializeFirestore/connectFirestoreEmulator fail silently -> INTERNAL ASSERTION FAILED
        var EN = 'dpb-emu';
        var ex = appM.getApps().filter(function (a) { return a.name === EN; })[0];
        app = ex || appM.initializeApp(conf, EN);
        // memory cache only: the emulator wipes its data on stop, a disk cache would keep showing the old data
        if (window.__dpbEmuDb) db = window.__dpbEmuDb;   // already set up in this page: reuse, never initialize twice
        else {
          try { db = fs.initializeFirestore(app, { localCache: fs.memoryLocalCache() }); fs.connectFirestoreEmulator(db, '127.0.0.1', 8080); window.__dpbEmuDb = db; }
          catch (e) { console.error('dpb-fs2 emulator setup FAILED', e); throw e; }
        }
        console.info('dpb-fs2: connected to LOCAL Firestore emulator (127.0.0.1:8080)');
      } else {
        app = appM.getApps().length ? appM.getApp() : appM.initializeApp(conf);
        // experimentalForceLongPolling: some networks / WebViews throttle or buffer Firestore's streaming channel, so reads work but writes hang for minutes (the warning bar showed "read ok, write stuck").
        // Long polling uses plain request/response calls that such networks let through. Never combined with auto-detect (the SDK refuses both together).
        if (window.__dpbFs2Db) { db = window.__dpbFs2Db; } else try { var tr = ls('dpb_fs2_transport', 'lp'), st0 = { localCache: fs.persistentLocalCache({ tabManager: (window.Capacitor && fs.persistentSingleTabManager) ? fs.persistentSingleTabManager({ forceOwnership: true }) : fs.persistentMultipleTabManager() }) }; if (tr === 'lp') st0.experimentalForceLongPolling = true; else if (tr === 'auto') st0.experimentalAutoDetectLongPolling = true; dlog('transport', tr); db = fs.initializeFirestore(app, st0); window.__dpbFs2Db = db; } catch (e) { try { console.warn('[dpb-fs2] initializeFirestore failed, using default instance', e && e.message); } catch (x) {} db = fs.getFirestore(app); window.__dpbFs2Db = db; }
      }
      var auth = authM.getAuth(app), ac; window.__dpbFs2Tok = function (force) { try { return auth.currentUser ? auth.currentUser.getIdToken(!!force) : Promise.resolve(); } catch (e) { return Promise.reject(e); } }; try { ac = JSON.parse(ls(LS.auth, 'null')); } catch (e) { ac = null; }
      // Offline start: auth.currentUser is empty until the SDK has restored the saved user from the device, so wait for that FIRST.
      // Before this the code saw "no user", tried to sign in over the network, failed offline (auth/network-request-failed) and the whole layer
      // (maps, overlay) never started. Now a user saved on the device is reused with no network call; a sign-in that fails while a saved user
      // exists falls back to that user, so the persistent cache on the phone still serves the maps.
      var restored = (typeof auth.authStateReady === 'function') ? auth.authStateReady() : new Promise(function (res) { var u = authM.onAuthStateChanged(auth, function () { try { u(); } catch (e) {} res(); }); });
      var ready = emu() ? Promise.resolve() : Promise.resolve(restored).catch(function () {}).then(function () {
        var cu = auth.currentUser, want = !!(ac && ac.email && ac.password);
        if (cu && (!want || String(cu.email || '').toLowerCase() === String(ac.email).toLowerCase())) return;   // already signed in as the right user: no network needed
        var p = want ? authM.signInWithEmailAndPassword(auth, ac.email, ac.password) : (cu ? Promise.resolve() : authM.signInAnonymously(auth));
        return p.catch(function (e) { if (auth.currentUser) return; throw e; });
      });
      // Firestore's commit() only resolves when the SERVER acknowledges. Offline it stays pending forever, so the app never counted the cells as executed
      // until the data was switched on again. The write is already saved on the device (persistent cache) and queued: it is sent by itself when the
      // network returns and the local listener shows it at once. So offline (or no answer within 4 s) the write is treated as accepted; online the real
      // answer is still awaited, so a refused write (rules / quota) is still reported.
      var commitOrQueue = makeCommitter({ onEvent: function (k, x) { dlog(k, x); if (k === 'rejected') { try { window.__dpbFs2Warn && window.__dpbFs2Warn(); } catch (e) {} } } });
      function dref(p) { return fs.doc.apply(null, [db].concat(p.split('/'))); }
      // v126: one explicit HTTPS request (Firestore REST) with the signed-in user's token: used when the SDK write channel is silent, and by the connection test
      var DOCS = 'projects/' + conf.projectId + '/databases/(default)/documents';
      function restSend(writes) {
        if (!auth.currentUser) return Promise.reject(Object.assign(new Error('no signed-in user'), { code: 'no-auth' }));
        return auth.currentUser.getIdToken().then(function (tok) {
          var ctl = (typeof AbortController === 'function') ? new AbortController() : null, tm = setTimeout(function () { try { ctl && ctl.abort(); } catch (e) {} }, 20000);
          return prevFetch('https://firestore.googleapis.com/v1/' + DOCS + ':commit', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok }, body: JSON.stringify({ writes: writes }), signal: ctl ? ctl.signal : undefined })
            .then(function (r) { clearTimeout(tm); return r.text().then(function (t) { if (r.ok) return true; throw restError(r.status, t); }); },
              function (e) { clearTimeout(tm); throw Object.assign(new Error(String(e && e.name === 'AbortError' ? 'rest-timeout (20s)' : (e && e.message) || e)), { code: e && e.name === 'AbortError' ? 'rest-timeout' : 'rest-network' }); });
        });
      }
      function restCommit(chunk) { return restSend(restWrites(DOCS, chunk)); }
      function restProbe() {
        var dev = ls('dpb_fs2_dev', '') || 'dev';
        return restSend([{ update: { name: DOCS + '/dpb2/' + nsName() + '/kv/clock-' + dev, fields: {} }, updateMask: { fieldPaths: [] }, updateTransforms: [{ fieldPath: 't', setToServerValue: 'REQUEST_TIME' }] }]).then(function () { return 'ok'; }, function (e) { return String(e && (e.code || e.message) || e); });
      }

      /*BKLIST-START*/
      // v158: the backup used ONE big getDocsFromServer for ~1000 documents. On a weak phone connection the SDK stream gives up with the generic
      // "Failed to get documents from server" (code unavailable) and no backup is ever made. Fallback: plain HTTPS pages (200 docs each, 30 s, 2 retries per page)
      function restList(path) {
        var out = [], token = '';
        function pause(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
        function page(tries) {
          if (!auth.currentUser) return Promise.reject(Object.assign(new Error('no signed-in user'), { code: 'no-auth' }));
          return auth.currentUser.getIdToken().then(function (tok) {
            var ctl = (typeof AbortController === 'function') ? new AbortController() : null, tm = setTimeout(function () { try { ctl && ctl.abort(); } catch (e) {} }, 30000);
            var url = 'https://firestore.googleapis.com/v1/' + DOCS + '/' + path + '?pageSize=200' + (token ? '&pageToken=' + encodeURIComponent(token) : '');
            return prevFetch(url, { headers: { 'Authorization': 'Bearer ' + tok }, signal: ctl ? ctl.signal : undefined }).then(
              function (r) { clearTimeout(tm); return r.text().then(function (t) { if (!r.ok) throw restError(r.status, t); return JSON.parse(t); }); },
              function (e) { clearTimeout(tm); throw Object.assign(new Error(e && e.name === 'AbortError' ? 'rest-timeout (30s)' : String((e && e.message) || e)), { code: e && e.name === 'AbortError' ? 'rest-timeout' : 'rest-network' }); });
          }).catch(function (e) {
            if (tries > 0 && !(e && e.definite)) return pause(900).then(function () { return page(tries - 1); });
            throw e;
          }).then(function (j) {
            var docs = (j && j.documents) || [];
            docs.forEach(function (d) { var f = d.fields || {}, o = {}; Object.keys(f).forEach(function (k) { o[k] = restDec(f[k]); }); out.push({ id: restDocId(d.name), data: o }); });
            rc('backup', docs.length); token = (j && j.nextPageToken) || '';
            return token ? page(2) : out;
          });
        }
        return page(2);
      }
      function sdkList(path) { var col = fs.collection.apply(null, [db].concat(path.split('/'))); return (fs.getDocsFromServer ? fs.getDocsFromServer(col) : fs.getDocs(col)).then(function (q) { rc('backup', q.docs.length); return q.docs.map(function (d) { return { id: d.id, data: d.data() }; }); }); }
      function listAll(path) {
        return sdkList(path).catch(function (e) {
          var c = String((e && (e.code || e.message)) || e);
          if (/resource-exhausted|quota|permission|unauth/i.test(c)) throw e;   // the server answered: a second try cannot help
          return restList(path).catch(function (e2) { throw Object.assign(new Error('SDK: ' + c + ' | HTTPS: ' + String((e2 && e2.message) || e2)), { code: (e2 && e2.code) || 'backup-read' }); });
        });
      }
      /*BKLIST-END*/
      // ---- v127 cell writes: transaction (server compare) online, outbox otherwise ----
      function txChunk(chunk) {
        var skipped = [];
        return Promise.race([
          fs.runTransaction(db, function (tx) {
            skipped = [];
            return Promise.all(chunk.map(function (o) { return tx.get(dref(o.path)); })).then(function (snaps) {
              chunk.forEach(function (o, i) {
                var cur = snaps[i].exists() ? ((snaps[i].data() || {}).cells || {}) : {}, pl = planTx(cur, o.cells);
                skipped = skipped.concat(pl.skipped);
                var cols = Object.keys(pl.put); if (!cols.length) return;
                tx.set(dref(o.path), Object.assign({}, o.base, { cells: clean(pl.put) }), { mergeFields: Object.keys(o.base).concat(cols.map(function (k) { return 'cells.' + k; })) });
              });
            });
          }, { maxAttempts: 3 }),
          new Promise(function (_, rej) { setTimeout(function () { rej(Object.assign(new Error('tx-timeout'), { code: 'tx-timeout' })); }, 9000); })
        ]).then(function () { return skipped; });
      }
      function tellSkipped(sk) {
        if (!sk.length) return;
        try { api && api.onSkip && api.onSkip(sk); } catch (e) {}
        try { if (typeof window.showToast === 'function') window.showToast('⚠️ ' + sk.length + ' تعديل اتلغى: جهاز تاني عدّل أو حذف نفس الخلية بعده'); } catch (e) {}
        dlog('skipped-older', sk.length + ' cell(s) were older than the server copy');
      }
      function refuse(e) {
        var W = window.__dpbFs2W = window.__dpbFs2W || {}; W.refused = String(e && (e.code || e.message) || e); W.refusedAt = Date.now();
        try { window.__dpbFs2Warn && window.__dpbFs2Warn(); } catch (x) {}
      }
      function writeCells(fOps) {
        var chunks = cutOps(fOps), p = Promise.resolve(), keys = [], skippedAll = [], queueRest = (navigator.onLine === false);
        chunks.forEach(function (chunk) {
          p = p.then(function () {
            if (queueRest) { chunk.forEach(function (o) { keys = keys.concat(obAdd(o)); }); return; }
            return txChunk(chunk).then(function (sk) { skippedAll = skippedAll.concat(sk); }, function (e) {
              if (DEFINITE.test(String(e && (e.code || e.message) || e))) { refuse(e); throw e; }
              queueRest = true; chunk.forEach(function (o) { keys = keys.concat(obAdd(o)); });   // no answer from the server: keep it, send it later through the same check
            });
          });
        });
        return p.then(function () {
          tellSkipped(skippedAll);
          if (!keys.length) return { acked: true };
          var done = obWaiter(keys); obLater(3000); try { window.__dpbFs2Warn && window.__dpbFs2Warn(); } catch (e) {}
          return { acked: false, done: done };
        });
      }
      var draining = false;
      function obRun() {
        if (draining || !obN()) return;
        if (navigator.onLine === false) { obLater(15000); return; }
        draining = true;
        var by = {}, sent = {};
        Object.keys(ob).forEach(function (k) { var e = ob[k], o = by[e.path] || (by[e.path] = { t: 'f', path: e.path, base: e.base, cells: {} }); o.cells[e.col] = e.cell; sent[k] = e.cell.time; });
        var cur = pidS(), groups = {}, p = Promise.resolve(), failed = null, otherFail = null, skippedAll = [], okKeys = [];
        Object.keys(by).forEach(function (q) { var o = by[q], pj = obPid(o); (groups[pj] = groups[pj] || []).push(o); });
        Object.keys(groups).sort(function (a, b) { return (b === cur) - (a === cur); }).forEach(function (pj) {
          var bad = false;
          cutOps(groups[pj]).forEach(function (chunk) {
            p = p.then(function () {
              if (bad) return;
              return txChunk(chunk).then(function (sk) {
                skippedAll = skippedAll.concat(sk);
                chunk.forEach(function (o) { Object.keys(o.cells).forEach(function (col) { okKeys.push(o.path + '|' + col); }); });
              }, function (e) { bad = true; if (!pj || pj === cur) failed = failed || e; else otherFail = otherFail || e; });
            });
          });
        });
        p.then(function () {
          var refused = failed && DEFINITE.test(String(failed.code || failed.message || failed));
          okKeys.forEach(function (k) { if (ob[k] && ob[k].cell.time === sent[k]) { delete ob[k]; obSettle(k); } });
          obSave();
          tellSkipped(skippedAll);
          draining = false;
          if (refused) { refuse(failed); dlog('outbox-refused', String(failed.code || failed.message)); obLater(60000); }
          else if (failed || otherFail) { failed = failed || otherFail; obBack = Math.min(obBack + 1, 4); dlog('outbox-retry', String(failed.code || failed.message)); obLater([3000, 5000, 10000, 15000, 15000][obBack]); }
          else { obBack = 0; dlog('outbox-delivered', okKeys.length + ' cell(s)'); kickPush(); if (obN()) obLater(500); }
          try { window.__dpbFs2Warn && window.__dpbFs2Warn(); } catch (e) {}
        });
      }
      var api;
      return ready.then(function () {
        api = {
          // server clock: write a tiny doc with serverTimestamp and read it back from the server (dpb2/{ns}/kv is already allowed by the rules)
          serverNow: function () {
            var dev = ls('dpb_fs2_dev', ''); if (!dev) { dev = Math.random().toString(36).slice(2, 10); try { localStorage.setItem('dpb_fs2_dev', dev); } catch (e) {} }
            var r = dref('dpb2/' + nsName() + '/kv/clock-' + dev);
            return fs.setDoc(r, { t: fs.serverTimestamp() }).then(function () { return fs.getDocFromServer(r); }).then(function (x) { var v = x.data() && x.data().t; return v && v.toMillis ? v.toMillis() : Promise.reject(new Error('no server time')); });
          },
          // real server check used by the warning bar: can this device READ from the server, and can it WRITE (a tiny doc) - each bounded to 8 s, with the real error code
          probe: function () {
            var dev = ls('dpb_fs2_dev', '') || 'dev', r = dref('dpb2/' + nsName() + '/kv/clock-' + dev), out = {};
            function wait(p, ms) { return Promise.race([p.then(function () { return 'ok'; }, function (e) { return String(e && e.code || e && e.message || e); }), new Promise(function (res) { setTimeout(function () { res('timeout'); }, ms); })]); }
            return wait(fs.getDocFromServer(r), 8000).then(function (a) { out.read = a; return restProbe(); }).then(function (rr) { out.rest = rr; return wait(fs.setDoc(r, { t: fs.serverTimestamp() }), 8000); }).then(function (b) { out.write = b; return out; });
          },
          get: function (path) { return fs.getDoc(dref(path)).then(function (x) { try { if (!x.metadata.fromCache) rc('get', 1); } catch (e) {} return x.exists() ? x.data() : null; }); },
          listen: function (path, cb, opts) { var col = fs.collection.apply(null, [db].concat(path.split('/'))), q0 = (opts && opts.where) ? fs.query(col, fs.where(opts.where[0], opts.where[1], opts.where[2])) : col; return fs.onSnapshot(q0, function (q) { try { if (!q.metadata.fromCache) rc('listen', q.docChanges().length); } catch (e) {} cb(q.docChanges().map(function (c) { return c.type === 'removed' ? { id: c.doc.id, removed: true } : { id: c.doc.id, data: c.doc.data() }; }), null, true); }, function (e) { console.warn('dpb-fs2 listen', e); cb(null, e); }); },
          // every document of a collection, read from the SERVER (never the local cache), so a backup is exactly what Firestore holds
          list: function (path) { return listAll(path); },
          // v160: read what this phone already holds (no network, no quota). null = not supported / nothing there
          listCache: function (path) { if (!fs.getDocsFromCache) return Promise.resolve(null); var col = fs.collection.apply(null, [db].concat(path.split('/'))); return fs.getDocsFromCache(col).then(function (q) { return q.docs.map(function (d) { return { id: d.id, data: d.data() }; }); }, function () { return null; }); },
          // t:'s' = write a whole small doc (meta). t:'f' = write only the listed cells inside a row doc (mergeFields replaces exactly those cells, never the rest of the row)
          write: function (ops) {
            var fOps = ops.filter(function (o) { return o.t === 'f'; }), rest = ops.filter(function (o) { return o.t !== 'f'; });
            var pr = rest.length ? api.writeRaw(rest) : Promise.resolve({ acked: true });
            return pr.then(function (w0) {
              if (!fOps.length) return w0;
              return writeCells(fOps).then(function (w1) {
                var un = [w0, w1].filter(function (w) { return w && w.acked === false; });
                return un.length ? { acked: false, done: Promise.all(un.map(function (w) { return w.done; })).then(function () {}) } : { acked: true };
              });
            });
          },
          writeRaw: function (ops) {
            var p = Promise.resolve();
            // batches are cut by the NUMBER OF CELLS (every cell is a map with ~10 indexed sub-fields, so the index entries, not the JSON size, are what hit
            // Firestore's 10 MiB limit = "Transaction too big"), and also by size and by op count; order is kept (a pointer doc stays last)
            var chunks = cutOps(ops), ws = [];
            chunks.forEach(function (chunk) {
              p = p.then(function () {
                var b = fs.writeBatch(db);
                chunk.forEach(function (o) {
                  if (o.t === 's') b.set(dref(o.path), clean(o.data));
                  else if (o.t === 'f') { var cells = clean(o.cells); b.set(dref(o.path), Object.assign({}, o.base, { cells: cells }), { mergeFields: Object.keys(o.base).concat(Object.keys(cells).map(function (k) { return 'cells.' + k; })) }); }
                  else b.delete(dref(o.path));
                });
                var cpid = ''; for (var ci = 0; ci < chunk.length && !cpid; ci++) { var co = chunk[ci], cb = (co.base && co.base.projectId) || (co.data && co.data.projectId) || ((/\/rows\/([A-Za-z0-9_\-]+?)__/.exec(String(co.path || '')) || [])[1]); if (cb) cpid = String(cb).replace(/[^A-Za-z0-9_\-]/g, '_'); }
                if (!cpid) cpid = pidS();   // project-less batches (pointer docs) belong to the project that is open now
                return commitOrQueue(b.commit(), function () { return restCommit(chunk); }, cpid).then(function (w) { ws.push(w); });
              });
            });
            // {acked:true} = the server confirmed every batch; {acked:false, done} = at least one batch is only saved on the device so far
            return p.then(function () {
              var un = ws.filter(function (w) { return w && w.acked === false; });
              if (!un.length) return { acked: true };
              return { acked: false, done: Promise.all(un.map(function (w) { return w.done; })).then(function () {}) };
            });
          },
          // close and reopen the network channel of Firestore (queued writes and listeners are kept): the standard way to wake a dead stream after the phone switched networks
          bounce: function () { return fs.disableNetwork(db).then(function () { return new Promise(function (r) { setTimeout(r, 400); }); }).then(function () { return fs.enableNetwork(db); }); },
          pendingCells: function () { return Object.keys(ob).map(function (k) { return ob[k].cell; }); }
        };
        OBF.run = obRun; if (obN()) setTimeout(obRun, 1500);
        return api;
      });
    });
  }

  /* Shared time reference: the offset between this device's clock and the Firestore server clock is measured in the BACKGROUND (never awaited,
     so opening is not slowed down), saved on the device, and used for every stored time. Until the first measurement, or with no network,
     the last saved offset is used (0 on a device that never measured). Re-measured every 30 minutes while the app stays open. */
  function clockOff() { var v = parseInt(ls('dpb_fs2_clock_off', '0'), 10); return isFinite(v) ? v : 0; }
  var clockT = null;
  function syncClock(a) {
    if (!a || typeof a.serverNow !== 'function') return;
    var t0 = Date.now();
    Promise.race([a.serverNow(), new Promise(function (_, rej) { setTimeout(function () { rej(new Error('timeout')); }, 10000); })]).then(function (sv) {
      var t1 = Date.now(); if (t1 - t0 > 15000) return;
      var off = Math.round(sv - (t0 + t1) / 2); if (Math.abs(off) < 2000) off = 0;   // under 2 s is just network jitter
      try { localStorage.setItem('dpb_fs2_clock_off', String(off)); } catch (e) {}
    }).catch(function () {});
    if (!clockT) clockT = setInterval(function () { if (!document.hidden) syncClock(a); }, 30 * 60 * 1000);
  }
  var store = null, creating = null, failedAt = 0, lastErr = '', version = 0, notifyT = null, pullT = null, storePid = '', adapterP = null;
  // the id of the project that is open right now (empty until the project manager has opened one)
  function pidS() { return String(pid() || '').replace(/[^A-Za-z0-9_\-]/g, '_'); }
  // ONE connection for the whole app (login, users list, clock) - not tied to a project
  function getAdapter() {
    if (window.__DPB_FS2_ADAPTER) return Promise.resolve(window.__DPB_FS2_ADAPTER);
    if (!adapterP) adapterP = makeAdapter().catch(function (e) { adapterP = null; throw e; });
    return adapterP;
  }
  // the cell store belongs to ONE project; when another project is opened the old listener is stopped and a new one is started
  function dropStore() { try { if (store && store.destroy) store.destroy(); } catch (e) {} store = null; creating = null; storePid = ''; try { restCache = null; } catch (e) {} }
  function curStore() { if (store && storePid !== pidS()) dropStore(); return store; }
  function permHint(e) { var m = String(e && e.message || e || ''); return /permission|insufficient/i.test(m) ? m + ' — قواعد Firebase لازم تسمح بالمسار dpb2/**' : m; }
  // a full records pull (every cell of every process) is expensive on a phone: while changes keep arriving (an Excel upload = dozens of snapshots)
  // run at most ONE pull per 15 s, always with the latest state (the trailing pull still happens)
  var lastPullAt = 0, PULL_GAP = 15000, lastPullSig = '';   // v150: back to the v148 value (the v149 3 s gap multiplied full pulls during bursts)
  function schedPull(ms) {
    clearTimeout(pullT);
    var wait = Math.max(ms, lastPullAt + PULL_GAP - Date.now());
    pullT = setTimeout(function () { lastPullAt = Date.now(); try { if (window.DPB_CLOUD_PRODUCTION && window.DPB_CLOUD_PRODUCTION.cloudPull) window.DPB_CLOUD_PRODUCTION.cloudPull(); } catch (e) {} }, wait);
  }
  // v103: a short network failure (auth/network-request-failed, timeout) used to leave the layer "not connected" until the user did something;
  // now it is retried by itself (after the 30 s cool-down, then 60 s, 2, 4, 8, 15 min) and at once when the phone comes back online.
  // Permission/rules errors are never retried (they need a fix, not time).
  var retryT = null, retryN = 0;
  function scheduleRetry(e) {
    var m = String(e && (e.code || '') || '') + ' ' + String(e && e.message || e || '');
    if (!/network-request-failed|unavailable|timeout|انتهت مهلة|offline|network/i.test(m)) return;
    if (retryT) return;
    var wait = [5000, 10000, 20000, 30000][Math.min(retryN++, 3)];   // v131: never gives up; at most 30 s between tries
    retryT = setTimeout(function () { retryT = null; if (curStore() || !pidS()) return; getStore().then(function () { retryN = 0; }, function () {}); }, wait);
  }
  try { window.addEventListener('online', function () { retryN = 0; clearTimeout(retryT); retryT = null; if (!curStore() && pidS()) { failedAt = 0; getStore().catch(function () {}); } }); } catch (e) {}
  // rebuild after a dead listener: 5 s, 15 s, 45 s, 2 min, then every 5 min (also at once when the phone comes online / the app comes back to the screen)
  var rebT = null, rebN = 0;
  function rebuildLater() {
    if (rebT) return;
    var w = [5000, 15000, 30000][Math.min(rebN++, 2)];   // v131: at most 30 s between tries
    rebT = setTimeout(function () { rebT = null; if (curStore() || !pidS()) { rebN = 0; return; } failedAt = 0; getStore().then(function () { rebN = 0; warnNow(); }, function () { warnNow(); rebuildLater(); }); }, w);
  }
  function rebuildNow() { if (curStore() || !pidS() || creating) return; clearTimeout(rebT); rebT = null; failedAt = 0; getStore().then(function () { rebN = 0; warnNow(); }, function () { rebuildLater(); }); }
  try { window.addEventListener('online', function () { if (lastErr || failedAt) rebuildNow(); }); document.addEventListener('visibilitychange', function () { if (!document.hidden && lastErr && !curStore()) rebuildNow(); }); } catch (e) {}
  // small non-clickable notice, shown ONLY when something is wrong (nothing at all when healthy): this device is not receiving, or its edits did not reach the server
  var probeBusy = false, probeAt = 0;
  function runProbe() {
    if (probeBusy) return Promise.resolve(); probeBusy = true; probeAt = Date.now();
    var W = window.__dpbFs2W = window.__dpbFs2W || {};
    return getAdapter().then(function (a) { return a.probe ? a.probe() : null; }).then(function (r) { W.probe = r; W.probeAt = Date.now(); }, function (e) { W.probe = { read: String(e && (e.code || e.message) || e), write: '-' }; W.probeAt = Date.now(); }).then(function () { probeBusy = false; try { dlog('probe', 'read=' + (W.probe && W.probe.read) + ' write=' + (W.probe && W.probe.write)); } catch (e) {} warnNow(); });
  }
  function diag() {
    var W = window.__dpbFs2W || {}, p = W.probe; if (!p || Date.now() - (W.probeAt || 0) > 90 * 1000) return '';
    var s = String(p.read) + ' ' + String(p.write);
    if (/resource-exhausted|quota/i.test(s)) return ' — السبب: حصة Firebase اليومية خلصت';
    if (/permission|unauth/i.test(s)) return ' — السبب: قواعد Firebase أو الدخول رافضين';
    if (p.read === 'timeout') return ' — السبب: مفيش اتصال فعلي بسيرفر Firebase (الشبكة)';
    if (p.rest && p.rest !== 'ok' && /resource-exhausted|quota/i.test(String(p.rest))) return ' — السبب: حصة الكتابة اليومية في Firebase خلصت';
    if (p.rest && p.rest !== 'ok' && /permission|unauth|no-auth/i.test(String(p.rest))) return ' — السبب: قواعد Firebase أو تسجيل الدخول رافضين الكتابة (' + p.rest + ')';
    if (p.rest && p.rest !== 'ok' && /rest-network|rest-timeout/i.test(String(p.rest))) return ' — السبب: الكتابة مش عارفة توصل لسيرفر Firebase (' + p.rest + ')';
    if (p.rest && /network-request-failed/i.test(String(p.rest))) return ' — السبب: الجهاز مش قادر يجدد تصريح الدخول لسيرفر Firebase (شبكة مؤقتة) — بيحاول تاني لوحده';
    if (p.rest && p.rest !== 'ok') return ' — السبب: السيرفر رد على الكتابة بـ ' + p.rest;
    if (p.read === 'ok' && p.write === 'timeout' && p.rest === 'ok') return ' — قناة الكتابة العادية عالقة والسيرفر شغال، بابعت بالطريق التاني تلقائيًا';
    if (p.read === 'ok' && p.write === 'timeout') return ' — القراءة شغالة لكن الكتابة عالقة';
    if (p.read === 'ok' && p.write === 'ok') return ' — السيرفر ردّ دلوقتي؛ بعيد فتح قناة الاتصال تلقائيًا';
    return ' — (' + s + ')';
  }
  // v132: display rules only (nothing about sending changes). A NEW project (not built yet = still uploading Excel files) never shows pending-write
  // messages; a connection-lost message needs to last 20 s before it shows; the unconfirmed-writes message waits 45 s.
  var condSeen = {};
  function lasted(key, on, ms) { if (!on) { delete condSeen[key]; return false; } if (!condSeen[key]) condSeen[key] = Date.now(); return Date.now() - condSeen[key] >= ms; }
  function warnText() {
    var W = window.__dpbFs2W || {}, quota = /resource-exhausted|quota/i, newProj = window.__dpbProjBuilt === false;
    if (W.refused && Date.now() - (W.refusedAt || 0) < 10 * 60 * 1000 && (!W.refusedPid || !pidS() || W.refusedPid === pidS())) return quota.test(W.refused) ? '⚠️ حصة Firebase اليومية خلصت — تعديلاتك محفوظة عندك بس ومش وصلت للسيرفر' : '⚠️ السيرفر رفض حفظ تعديلاتك (' + W.refused + ') — محفوظة عندك بس';
    var conn = !!(pidS() && !curStore() && lastErr);
    // v132: the "مش بتستقبل تعديلات الأجهزة التانية — بحاول أتصل تاني" message is removed (the app reconnects by itself); only the quota case still warns.
    if (lasted('conn', conn && !newProj && quota.test(lastErr), 20000)) return '⚠️ حصة Firebase اليومية خلصت — مش بتستقبل تعديلات الأجهزة التانية';
    var obOnly = obNCur() > 0 && !curPend();
    if (lasted('ob', obOnly && !newProj, 20000)) return '⏳ ' + obNCur() + ' تعديل محفوظ على الجهاز ومستني الاتصال — هيتبعت لوحده بعد ما يتقارن بحالة السيرفر';
    if (curPend() && curPendSince() && Date.now() - curPendSince() > 20000 && navigator.onLine !== false) {
      if (!probeBusy && Date.now() - probeAt > 45000) runProbe();
      if (!newProj && Date.now() - curPendSince() > 45000) return '⚠️ ' + curPend() + ' كتابة لسه السيرفر ماأكدهاش (محفوظة على الجهاز)' + diag();
    }
    return '';
  }
  function warnNow() {
    try {
      var t = warnText(), el = document.getElementById('dpbFs2Warn');
      window.__dpbFs2WarnFull = t;
      if (!t) { if (el) el.remove(); return; }
      var big = /رفض حفظ|حصة Firebase/.test(t);
      var css = big
        ? 'position:fixed;left:8px;right:8px;bottom:70px;z-index:2147483000;background:rgba(120,60,0,.94);color:#fff;border:1px solid #ffb74d;border-radius:10px;padding:6px 10px;font-size:12px;text-align:center;pointer-events:none;direction:rtl'
        : 'position:fixed;left:4px;top:calc(env(safe-area-inset-top,0px) + 2px);z-index:2147483000;background:rgba(120,60,0,.85);color:#fff;border:1px solid #ffb74d;border-radius:999px;padding:1px 8px;font-size:10px;line-height:1.5;opacity:.9;pointer-events:none;direction:ltr';
      if (!el) { el = document.createElement('div'); el.id = 'dpbFs2Warn'; document.body.appendChild(el); }
      el.style.cssText = css;
      var n = (t.match(/\d+/) || [''])[0];
      el.textContent = big ? t : (t.slice(0, 2) + (n ? ' ' + n : ''));
      el.title = t;
    } catch (e) {}
  }
  window.__dpbFs2Warn = warnNow; setInterval(warnNow, 5000);
  // A write that stays unconfirmed (stream dead after the phone switched network / the app was in the background) is woken up by closing and reopening the
  // network channel of Firestore. Queued writes and listeners are kept by the SDK. At most once a minute.
  var lastBounce = 0, bounces = 0, bouncing = false;
  function bounceNow(why) {
    if (Date.now() - lastBounce < 60000 || bouncing || navigator.onLine === false || (window.__dpbFs2W && window.__dpbFs2W.asserts)) return Promise.resolve(false);
    lastBounce = Date.now(); bounces++; bouncing = true; dlog('bounce', why);
    return getAdapter().then(function (a) { var tk = null; try { tk = window.__dpbFs2Tok ? window.__dpbFs2Tok(true).catch(function () {}) : null; } catch (e) {} return Promise.resolve(tk).then(function () { return a.bounce ? a.bounce() : null; }); }).then(function () { bouncing = false; dlog('bounce-done', ''); return true; }, function (e) { bouncing = false; dlog('bounce-fail', e && (e.code || e.message)); return false; });
  }
  function healTick() {
    var W = window.__dpbFs2W || {};
    if (curPend() && curPendSince() && Date.now() - curPendSince() > 45000 && navigator.onLine !== false) bounceNow('pending ' + curPend() + ' for ' + Math.round((Date.now() - curPendSince()) / 1000) + 's');
  }
  setInterval(healTick, 15000);
  // v131: Firebase's own "INTERNAL ASSERTION FAILED" leaves the SDK in a broken state until the app restarts. Edits are safe (they sit in the device outbox),
  // so when it happens while something is unsent, or the connection is gone, the app restarts itself once (never more than once per 3 minutes).
  function onAssert(msg) {
    if (!/INTERNAL ASSERTION FAILED/i.test(String(msg || ''))) return;
    var W = window.__dpbFs2W = window.__dpbFs2W || {}; W.assertAt = Date.now(); W.asserts = (W.asserts || 0) + 1;
    try { dlog('assertion', String(msg).slice(0, 120)); } catch (e) {}
    if (!(obN() > 0 || curPend() > 0 || (pidS() && !curStore()))) return;
    var last = 0; try { last = +sessionStorage.getItem('dpb_fs2_assert_reload') || 0; } catch (e) {}
    if (Date.now() - last < 180000) return;
    try { sessionStorage.setItem('dpb_fs2_assert_reload', String(Date.now())); } catch (e) {}
    try { var d = document.createElement('div'); d.style.cssText = 'position:fixed;left:12px;right:12px;bottom:90px;z-index:2147483000;background:#0b3a66;color:#fff;border-radius:12px;padding:10px 14px;font:14px/1.5 sans-serif;text-align:center;direction:rtl'; d.textContent = 'بعيد تشغيل الاتصال تلقائيًا — تعديلاتك محفوظة ومش هتضيع'; document.body.appendChild(d); } catch (e) {}
    window.__dpbFs2AssertReloadAt = Date.now();
    var t0 = Date.now();
    (function calm() {
      var idle = true; try { var a = document.activeElement; if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) idle = false; if (document.querySelector('.me-sel')) idle = false; var ov = document.getElementById('dpbInPageAlertOverlay'); if (ov && getComputedStyle(ov).display !== 'none') idle = false; } catch (e) {}
      if (!idle && Date.now() - t0 < 60000) return setTimeout(calm, 2000);
      try { if (!window.__dpbFs2NoReload) location.reload(); } catch (e) {}
    })();
  }
  try { window.addEventListener('unhandledrejection', function (e) { var r = e && e.reason; onAssert(r && (r.message || r)); }); window.addEventListener('error', function (e) { onAssert(e && e.message); }); } catch (e) {}
  window.__dpbFs2OnAssert = onAssert;
  try {
    window.addEventListener('online', function () { dlog('online', ''); setTimeout(function () { var W = window.__dpbFs2W || {}; try { window.__dpbFs2Tok && window.__dpbFs2Tok(true).catch(function () {}); } catch (e2) {} if (curPend()) bounceNow('back online with ' + curPend() + ' pending'); }, 1500); });
    window.addEventListener('offline', function () { dlog('offline', ''); });
    document.addEventListener('visibilitychange', function () { if (!document.hidden) setTimeout(function () { var W = window.__dpbFs2W || {}; try { window.__dpbFs2Tok && window.__dpbFs2Tok(true).catch(function () {}); } catch (e2) {} if (curPend() && curPendSince() && Date.now() - curPendSince() > 10000) bounceNow('app back on screen with ' + curPend() + ' pending'); }, 1500); });
  } catch (e) {}
  window.__dpbFs2Net = function () { var W = window.__dpbFs2W || {}; return { pending: W.pending || 0, pendingCur: curPend(), pendByProject: JSON.parse(JSON.stringify(W.pend || {})), asserts: W.asserts || 0, sinceMs: W.since ? Date.now() - W.since : 0, probe: W.probe || null, probeAgeMs: W.probeAt ? Date.now() - W.probeAt : -1, bounces: bounces, rescued: W.rescued || 0, rescueErr: (W.rescueErr && Date.now() - (W.rescueErrAt || 0) < 600000) ? W.rescueErr : '', unacked: Object.keys(UN).length, connected: !!curStore(), err: String(lastErr || ''), online: navigator.onLine !== false, transport: ls('dpb_fs2_transport', 'lp') }; };
  window.__dpbFs2Bounce = function () { lastBounce = 0; return bounceNow('manual'); };
  // v124: true only when every write this device made has been ACKNOWLEDGED by the server (pending counter back to 0); false after ms if some are still waiting
  window.__dpbFs2Ack = function (ms) { return new Promise(function (res) { var t0 = Date.now(); (function chk() { var W = window.__dpbFs2W || {}; if (!W.pending) { res(true); return; } if (Date.now() - t0 >= ms) { res(false); return; } setTimeout(chk, 200); })(); }); };
  function startCreate() {
    if (creating) return creating;
    var forPid = pidS();
    if (!forPid) return Promise.reject(new Error('لسه مفيش مشروع مفتوح — الخرائط بتتربط بعد ما تفتح مشروع'));
    creating = getAdapter().then(function (a) {
      var s = CORE.create(a, { ns: nsName(), pid: forPid, offset: clockOff, onError: function (e) {
        // the live listener died (token refresh, quota, rules, network): this device would stop receiving other devices' edits silently. Drop the store and rebuild it.
        if (store !== s) return;
        lastErr = permHint(e); dlog('listener-dead', (e && e.code ? e.code + ' ' : '') + lastErr); dropStore(); failedAt = 0; paintState(); warnNow(); rebuildLater();
      } });
      s.onChange(function () { version++; clearTimeout(notifyT); notifyT = setTimeout(function () { try { if (typeof window.__dpbFetchLiveGrid === 'function') window.__dpbFetchLiveGrid(); } catch (e) {} paintState(); }, 300); schedPull(1500); });
      return s.ready.then(function () { if (forPid !== pidS()) { s.destroy(); creating = null; return startCreate(); } store = s; storePid = forPid; failedAt = 0; lastErr = ''; retryN = 0; dlog('store-up', forPid); s.ensureEpoch(); paintState(); syncClock(a); try { loadBase(s); } catch (e) {} return s; });
    }).catch(function (e) { creating = null; failedAt = Date.now(); lastErr = permHint(e); dlog('store-failed', (e && e.code ? e.code + ' ' : '') + lastErr); paintState(); scheduleRetry(e); throw e; });
    return creating;
  }
  // never waits forever: ready within 8s, or it fails fast (and is retried at most every 30s) so nothing else in the app hangs behind it
  function getStore() {
    var cs = curStore(); if (cs) return Promise.resolve(cs);
    if (failedAt && Date.now() - failedAt < 30000) return Promise.reject(new Error(lastErr || 'unavailable')); // cool-down: fail fast, a late success clears it
    var p = startCreate();
    return new Promise(function (res, rej) {
      var t = setTimeout(function () { failedAt = Date.now(); lastErr = lastErr || 'انتهت مهلة الاتصال بـ Firestore (8 ثواني)'; scheduleRetry(new Error(lastErr)); rej(new Error(lastErr)); }, 8000);
      p.then(function (s) { clearTimeout(t); res(s); }, function (e) { clearTimeout(t); rej(e); });
    });
  }
  function stagesOf(body) {
    // only the grouped processes (Ramming/Saddle/Bearing) are locked and filled together. Torque Tube / Modules are never part of it,
    // so when the request names no group we ask the app for it (never "every process this layer stores").
    var names = (body.groupedProcessNames || []).filter(Boolean), sc = body.stageCodes || {}, out = [];
    if (!names.length) { try { names = (typeof window.DPB_groupedProcessNames === 'function' ? window.DPB_groupedProcessNames() : []).filter(Boolean); } catch (e) { names = []; } }
    names.forEach(function (n, i) { var code = 0; Object.keys(sc).forEach(function (k) { if (CORE.slug(k) === CORE.slug(n)) code = Number(sc[k]) || 0; }); out.push({ name: n, code: code || (i + 1) }); });
    return out;
  }
  function withBody(init, body) { return Object.assign({}, init, { body: JSON.stringify(body) }); }
  function parse(res) { return res.json(); }
  function fail(e) { return jsonRes({ ok: false, error: 'Firestore2: ' + permHint(e) }); }


  /* ---- Map catalog / map shapes / original Excel files (kv keys mapcat, mapsnap_*, xlfile_*) live in Firestore under dpb2/{ns}/kv.
     Same request format the app already sends (kvGet / kvPatch), so the app code does not change. Values longer than 600k chars are split into parts. ---- */
  /* ---- delivery tracking (v125): record ids whose write is saved on the device but NOT yet confirmed by the server. The app is told about them
     (reply field `queued`) so it does not mark them "synced"; when the server confirms (or rejects) the app is nudged to push again. ---- */
  var UN = {}, REJ = {};
  function releaseIds(ids) { ids.forEach(function (i) { if (UN[i] > 1) UN[i]--; else delete UN[i]; }); }
  function kickPush() { try { if (window.DPB_CLOUD_PRODUCTION && window.DPB_CLOUD_PRODUCTION.cloudPush) window.DPB_CLOUD_PRODUCTION.cloudPush(); } catch (e) {} }
  function trackQueued(ids, w) {
    if (!w || w.acked !== false || !w.done) return;
    ids = ids.map(String).filter(Boolean); if (!ids.length) return;
    ids.forEach(function (i) { UN[i] = (UN[i] || 0) + 1; });
    w.done.then(function () { releaseIds(ids); dlog('delivered', ids.length + ' record(s)'); kickPush(); }, function (e) {
      releaseIds(ids); var code = String(e && (e.code || e.message) || e); ids.forEach(function (i) { REJ[i] = { t: Date.now(), e: code }; });
      dlog('rejected-late', ids.length + ' record(s): ' + code); kickPush();
    });
  }
  function queuedOf(ids) { return ids.map(String).filter(function (i) { return UN[i]; }); }
  window.__dpbFs2Unacked = function () { return Object.keys(UN); };
  var U_KEY = 'users';
  var P_KEY = 'projects';   // the list of projects (id + name + small facts): lets any signed-in device find the projects without typing an ID
  // pure helper (also used by the Node test): cut a list of write ops into batches that stay far below Firestore's limit
  function cutOps(ops) {
    var chunks = [], cur = [], bytes = 0, cells = 0;
    ops.forEach(function (o) {
      var n = 0; try { n = JSON.stringify(o.data || o.cells || {}).length; } catch (e) {}
      var w = o.cells ? Object.keys(o.cells).length : 1;
      if (cur.length && (cur.length >= 100 || cells + w > 500 || bytes + n > 1500000)) { chunks.push(cur); cur = []; bytes = 0; cells = 0; }
      cur.push(o); bytes += n; cells += w;
    });
    if (cur.length) chunks.push(cur);
    return chunks;
  }
  window.__dpbCutOps = cutOps;
  var KV_CHUNK = 600000;
  function kvMine(key) { return /^(mapcat|mapsnap_|xlfile_|msga_|msgs_|fcm_)/.test(String(key || '')) || String(key || '') === 'master'; }   // msga_/msgs_ = admin<->supervisor messages (one writer per doc)
  function kvDoc(key) {
    var k = String(key).replace(/[^A-Za-z0-9_\-]/g, '_');
    if (/^(msg[as]|fcm)_/.test(k)) return 'dpb2/' + nsName() + '/kv/' + k;   // messages follow the supervisor account, not the open project
    if (k === U_KEY || k === P_KEY || k === 'master') return 'dpb2/' + nsName() + '/kv/' + k;   // the users list and the projects list are shared by every project
    var pp = pidS(); if (!pp) throw new Error('لسه مفيش مشروع مفتوح');
    return 'dpb2/' + nsName() + '/kv/p_' + pp + '__' + k;                      // everything else (map catalog, shapes, Excel files, history...) belongs to the open project
  }
  function kvReadStr(a, key) {
    var p = kvDoc(key);
    return a.get(p).then(function (d) {
      if (!d) return '';
      if (!d.parts) return d.json || '';
      var ps = []; for (var i = 0; i < d.parts; i++) ps.push(a.get(p + '-p' + i));
      return Promise.all(ps).then(function (arr) { return arr.map(function (x) { return x ? x.d : ''; }).join(''); });
    });
  }
  function kvWriteStr(a, key, str) {
    var p = kvDoc(key), t = new Date().toISOString(), ops = [];
    if (str.length <= KV_CHUNK) ops.push({ t: 's', path: p, data: { json: str, time: t } });
    else {
      var n = Math.ceil(str.length / KV_CHUNK);
      for (var i = 0; i < n; i++) ops.push({ t: 's', path: p + '-p' + i, data: { d: str.slice(i * KV_CHUNK, (i + 1) * KV_CHUNK) } });
      ops.push({ t: 's', path: p, data: { parts: n, len: str.length, time: t } });   // pointer last, in the same batch
    }
    return a.write(ops);
  }
  // delete an OLD per-sheet Excel copy (xlfile_<sheet>) once the shared copy (xlfile_<hash>) is confirmed stored: nothing else may be deleted this way
  function kvDeleteLegacy(a, key, req) {
    if (!/^xlfile_/.test(String(key)) || !/^xlfile_/.test(String(req || '')) || key === req) return Promise.resolve(jsonRes({ ok: false, error: 'refused' }));
    var rp = kvDoc(req), lp = kvDoc(key);
    if (rp === lp) return Promise.resolve(jsonRes({ ok: false, error: 'refused' }));
    return Promise.all([a.get(rp), a.get(lp)]).then(function (r) {
      var keep = r[0], old = r[1];
      if (!keep) return jsonRes({ ok: false, error: 'shared copy missing' });
      if (!old) return jsonRes({ ok: true, deleted: 0 });
      var chk = []; for (var i = 0; keep.parts && i < keep.parts; i++) chk.push(a.get(rp + '-p' + i));
      return Promise.all(chk).then(function (ps) {
        if (ps.some(function (x) { return !x; })) return jsonRes({ ok: false, error: 'shared copy incomplete' });
        var ops = [{ t: 'd', path: lp }]; for (var j = 0; old.parts && j < old.parts; j++) ops.push({ t: 'd', path: lp + '-p' + j });   // pointer first, parts after
        return a.write(ops.slice(0, 1)).then(function () { return ops.length > 1 ? a.write(ops.slice(1)) : null; }).then(function () { return jsonRes({ ok: true, deleted: ops.length }); });
      });
    });
  }
  function kvHandle(body) {
    return getStore().then(function (s) {
      var a = s.adapter;
      if (body.action === 'kvDelete') return kvDeleteLegacy(a, body.key, body.requireKey);
      if (body.action === 'kvGet') return kvReadStr(a, body.key).then(function (str) { return jsonRes({ ok: true, json: str || '{}' }); });
      var done = function (obj) { return kvWriteStr(a, body.key, JSON.stringify(obj)).then(function () { return jsonRes({ ok: true }); }); };
      if (body.replace) return done(body.set || {});
      return kvReadStr(a, body.key).then(function (str) {
        var cur = {}; try { cur = JSON.parse(str || '{}') || {}; } catch (e) {}
        Object.keys(body.set || {}).forEach(function (k) { cur[k] = body.set[k]; });
        (body.del || []).forEach(function (k) { delete cur[k]; });
        return done(cur);
      });
    }).catch(fail);
  }
  // for the app: fetch one stored Excel file as an ArrayBuffer (null if it was never uploaded)
  function getXlFile(key) {
    return getStore().then(function (s) { return kvReadStr(s.adapter, 'xlfile_' + key); }).then(function (str) {
      if (!str) return null; var o = JSON.parse(str); if (!o || !o.d) return null;
      var raw = atob(o.d), u = new Uint8Array(raw.length); for (var i = 0; i < raw.length; i++) u[i] = raw.charCodeAt(i);
      return { name: o.name || key, h: o.h, buffer: u.buffer };
    });
  }


  /* ---- Users / login in Firestore (dpb2/{ns}/kv/users, same kv format as the rest). Passwords are stored ONLY as a hash (the admin never sees a PIN).
     Until the accounts are moved (admin card > "نقل المستخدمين") the doc does not exist and every login/users request goes to Apps Script exactly as before.
     If Firestore is unreachable the request also falls back to Apps Script, so a device with no Firebase login saved is never locked out.
     Kill switch: localStorage dpb_fs2_users = "off". ---- */
    function usersOn() { return ls('dpb_fs2_users', 'on') !== 'off'; }
  function sha256(str) {
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)).then(function (b) {
      return Array.prototype.map.call(new Uint8Array(b), function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    });
  }
  function pinHash(name, pin) { return sha256('dpbfs|' + String(name == null ? '' : name).trim().toLowerCase() + '|' + String(pin == null ? '' : pin).trim()); }
  function uName(u) { return String((u && (u.username || u.name || u.UserID || u.user)) || '').trim(); }
  function pubUser(u) { var c = clean(u); delete c.passHash; delete c.password; delete c.pin; return c; }
  function isActive(u) { var v = u.active; return !(v === false || String(v).toLowerCase() === 'false' || String(v).toLowerCase() === 'no'); }
  function usersLoad(a) {
    return kvReadStr(a, U_KEY).then(function (str) {
      if (!str) return null;
      try { var l = JSON.parse(str); return Array.isArray(l) ? l : null; } catch (e) { return null; }
    });
  }
  function usersSave(a, list) { return kvWriteStr(a, U_KEY, JSON.stringify(list)); }
  // resolves null when the accounts were not moved to Firestore yet (the caller then sends the request to Apps Script)
  function usersOp(a, body) {
    return usersLoad(a).then(function (list) {
      if (!list) {
        // no users list on Firebase yet (Apps Script is gone, so there is nothing to fall back to): the first Admin code is created from the app
        if (body.action === 'saveUser') list = [];
        else if (body.action === 'login') return { ok: false, setup: true };
        else if (body.action === 'getUsers') return { ok: true, users: [], pinsHidden: true };
        else return { ok: true };
      }
      var find = function (n) { n = String(n || '').trim().toLowerCase(); for (var i = 0; i < list.length; i++) if (uName(list[i]).toLowerCase() === n) return i; return -1; };
      switch (body.action) {
        case 'login':
          var i = find(body.username);
          if (i < 0) return String(body.username || '').trim().toLowerCase() === 'admin' ? { ok: false, setup: true } : { ok: false };   // no Admin yet -> the app offers to create it
          var u = list[i];
          return pinHash(uName(u), body.password).then(function (h) {
            if (!u.passHash || u.passHash !== h || !isActive(u)) return { ok: false };   // no "error" field: the app reads that as "wrong code", not as "server unreachable"
            return { ok: true, user: pubUser(u) };
          });
        case 'getUsers': return { ok: true, users: list.map(pubUser), pinsHidden: true };
        case 'renewToken': return { ok: true };
        case 'saveUser':
          var nu = clean(body.user || {}), nm = uName(nu); if (!nm) return { ok: false, error: 'no username' };
          var pw = nu.password != null ? nu.password : nu.pin; delete nu.password; delete nu.pin;
          var k = find(nm), old = k >= 0 ? list[k] : null;
          var hp = (pw != null && String(pw).trim() !== '') ? pinHash(nm, pw) : Promise.resolve(old ? old.passHash : '');
          return hp.then(function (h) {
            nu.passHash = h || '';
            if (k >= 0) list[k] = Object.assign({}, old, nu); else list.push(nu);
            return usersSave(a, list).then(function () { return { ok: true }; });
          });
        case 'deleteUser':
          var d = find(body.username); if (d >= 0) list.splice(d, 1);
          return usersSave(a, list).then(function () { return { ok: true }; });
      }
      return null;
    });
  }
  // v94: الدخول مبقاش بيستنى Firebase للأبد. لو الاتصال اتأخر أكتر من 10 ثواني أو فشل، الرد بيرجع فورًا بخطأ واضح
  // (error => التطبيق يعتبره "مفيش اتصال" ويجرّب الرقم/البصمة المحفوظة على الجهاز) بدل ما يعلّق، ومبقاش بيروح لعنوان dpb-firebase.local اللي مش موجود.
  function usersHandle(body, input, init) {
    var url = String(typeof input === 'string' ? input : (input && input.url) || '');
    var internal = url.indexOf('https://dpb-firebase.local/') === 0;
    var work = getAdapter().then(function (a) { return usersOp(a, body); });
    var timeout = new Promise(function (res) { setTimeout(function () { res({ __timeout: true }); }, 10000); });
    return Promise.race([work, timeout]).then(function (r) {
      if (r && r.__timeout) { work.catch(function () {}); return internal ? jsonRes({ ok: false, error: 'firebase-timeout' }) : prevFetch(input, init); }
      return r ? jsonRes(r) : prevFetch(input, init);
    }, function () { return internal ? jsonRes({ ok: false, error: 'firebase-unreachable' }) : prevFetch(input, init); });
  }
  var USER_ACTIONS = { login: 1, getUsers: 1, saveUser: 1, deleteUser: 1, renewToken: 1 };
  // one-time: copy the accounts from the Sheet's Users tab into Firestore (hashes only). Asks the script through the layer UNDER this one on purpose.
  function seedUsers() {
    var base = window.DPB_getScriptUrl && window.DPB_getScriptUrl(); if (!base) return Promise.reject(new Error('مفيش رابط مشروع'));
    var pin = ls('DPB_ADMIN_PIN_V1', ''); if (!pin) return Promise.reject(new Error('مفيش PIN أدمن محفوظ على الجهاز — سجّل دخول الأدمن الأول'));
    return prevFetch(base, { method: 'POST', body: JSON.stringify({ action: 'getUsers', auth: { username: 'Admin', password: pin } }) })
      .then(function (r) { return r.json(); }, function (e) { throw new Error('الاتصال بالشيت فشل: ' + (e && e.message || e)); })
      .then(function (res) {
        if (!res || !res.ok || !Array.isArray(res.users)) {
          var why = res && res.error ? String(res.error) : (res ? 'رد غير متوقع من السيرفر (ok=' + res.ok + ')' : 'رد فاضي');
          var rejected = /unauthori|locked|wrong|pin|auth/i.test(why) || ls('DPB_ADMIN_AUTH_BAD_V1', '') === '1';
          throw new Error('قراءة المستخدمين من الشيت فشلت: ' + why + (rejected ? ' — السيرفر رفض PIN الأدمن المحفوظ على الجهاز. اخرج من لوحة الأدمن وادخلها بالـ PIN الصح تاني (بيتحدّث المحفوظ)، وجرّب تاني.' : ''));
        }
        if (res.pinsHidden === true) throw new Error('السيرفر خبّى الباسوردات — سجّل دخول الأدمن بالـ PIN وجرّب تاني');
        return Promise.all(res.users.map(function (u) {
          var c = clean(u), pw = c.password != null ? c.password : c.pin; delete c.password; delete c.pin;
          return (pw != null && String(pw).trim() !== '' ? pinHash(uName(c), pw) : Promise.resolve('')).then(function (h) { c.passHash = h; return c; });
        })).then(function (list) { return getAdapter().then(function (a) { return usersSave(a, list); }).then(function () { return { ok: true, count: list.length }; }); });
      });
  }
  function usersCount() { return getAdapter().then(function (a) { return usersLoad(a); }).then(function (l) { return l ? l.length : 0; }); }
  // connection check for the admin card: forget a failed/old connection and connect again, return how long it took

  /* ---- Projects list in Firestore (dpb2/{ns}/kv/projects). Read by every signed-in device, written by the app when a project is created/deleted. ---- */
  function projectsGet() {
    return getAdapter().then(function (a) { return kvReadStr(a, P_KEY); }).then(function (str) {
      if (!str) return null;                       // never written yet
      var v = jparse(str, null); return Array.isArray(v) ? v : null;
    });
  }
  // read-modify-write: fn(currentListOrEmpty) returns the new list (or null = no change). Resolves with the list that is now stored.
  function projectsUpdate(fn) {
    return getAdapter().then(function (a) {
      return kvReadStr(a, P_KEY).then(function (str) {
        var cur = jparse(str, null); if (!Array.isArray(cur)) cur = [];
        var next = fn(clean(cur));
        if (!Array.isArray(next) || stable(next) === stable(cur)) return cur;
        return kvWriteStr(a, P_KEY, JSON.stringify(next)).then(function () { return next; });
      });
    });
  }

  function resetStore() { dropStore(); adapterP = null; failedAt = 0; lastErr = ''; }
  function testConn() { var t0 = Date.now(); resetStore(); return getAdapter().then(function () { return pidS() ? getStore() : null; }).then(function () { return { ms: Date.now() - t0, ns: nsName(), auth: (function () { try { var a = JSON.parse(ls(LS.auth, 'null')); return a && a.email ? 'email' : (emu() ? 'emulator' : 'anon'); } catch (e) { return 'anon'; } })() }; }); }

  function overlayGrid(s, name, g) {
    if (!g || g.ok === false) return g;
    var cells = s.all().filter(function (d) { return CORE.slug(d.process) === CORE.slug(name); });
    var rows = g.rows || 0, cols = g.cols || 0;
    cells.forEach(function (d) { rows = Math.max(rows, Number(d.r1) + 1); cols = Math.max(cols, Number(d.c1) + 1); });
    var v = []; for (var i = 0; i < rows; i++) { var row = new Array(cols); for (var j = 0; j < cols; j++) row[j] = ''; v.push(row); }
    cells.forEach(function (d) { v[d.r1][d.c1] = (d.done !== undefined && d.done !== null) ? (Number(d.done) || '') : (Number(d.code) || ''); }); // a progress cell (Modules) shows how many units are done, an execution cell shows its process code
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


  /* ---- Everything the Google Sheet script used to do besides the map cells now lives in Firestore too (kv docs under dpb2/{ns}/kv):
     - production records that are NOT map cells (no row/column): one kv doc per process, key rest_<process>, plus an index doc restidx
     - history / productivity log (ring buffer, written in batches), build result of the Plan (buildresult + buildmeta)
     - saveUnitMap: nothing reads it any more (it only served the Sheet's onEdit), so it is acknowledged and not stored.
     When Firestore is not reachable these answer ok:false, so the app keeps its own queue and retries; they never fall back to the Sheet. */
  function djb(s) { var h = 5381; s = String(s); for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(16); }
  function restKey(p) { var s = CORE.slug(p || 'none') || 'none'; return 'rest_' + s.replace(/[^a-z0-9\-]/g, '').slice(0, 24) + '_' + djb(s); }
  function jparse(str, d) { try { var v = JSON.parse(str); return v == null ? d : v; } catch (e) { return d; } }
  var restCache = null, restCacheAt = 0, REST_TTL = 30000;
  function restIndex(a) { return kvReadStr(a, 'restidx').then(function (s) { var l = jparse(s, []); return Array.isArray(l) ? l : []; }); }
  function restAll(a, fresh) {
    if (!fresh && restCache && Date.now() - restCacheAt < REST_TTL) return Promise.resolve(restCache);
    return restIndex(a).then(function (idx) {
      return Promise.all(idx.map(function (k) { return kvReadStr(a, k).then(function (s) { return jparse(s, {}); }); }));
    }).then(function (shards) {
      var out = []; shards.forEach(function (m) { Object.keys(m).forEach(function (id) { out.push(m[id]); }); });
      restCache = out; restCacheAt = Date.now(); return out;
    });
  }
  function tms(x) { var v = Date.parse(x); return isFinite(v) ? v : 0; }
  // returns the ids it refused because a newer copy is already stored (same meaning as "stale" in the old reply)
  function restPut(a, recs) {
    var by = {}; recs.forEach(function (r) { if (r && r.id != null) { var k = restKey(r.process); (by[k] = by[k] || []).push(r); } });
    var keys = Object.keys(by), stale = [];
    if (!keys.length) return Promise.resolve(stale);
    return restIndex(a).then(function (idx) {
      var newIdx = idx.slice(), idxChanged = false;
      return Promise.all(keys.map(function (k) {
        return kvReadStr(a, k).then(function (s) {
          var m = jparse(s, {}), changed = false;
          by[k].forEach(function (r) {
            var cur = m[String(r.id)];
            if (cur && tms(cur.time) > tms(r.time)) { stale.push({ id: String(r.id) }); return; }
            m[String(r.id)] = clean(r); changed = true;
          });
          if (newIdx.indexOf(k) < 0) { newIdx.push(k); idxChanged = true; }
          return changed ? kvWriteStr(a, k, JSON.stringify(m)) : null;
        });
      })).then(function () { return idxChanged ? kvWriteStr(a, 'restidx', JSON.stringify(newIdx)) : null; });
    }).then(function () { restCache = null; return stale; });
  }
  function restRemove(a, ids) {
    var want = {}; ids.forEach(function (x) { want[String(x)] = true; });
    return restIndex(a).then(function (idx) {
      var n = 0;
      return Promise.all(idx.map(function (k) {
        return kvReadStr(a, k).then(function (s) {
          var m = jparse(s, {}), ch = false;
          Object.keys(m).forEach(function (id) { if (want[id]) { delete m[id]; n++; ch = true; } });
          return ch ? kvWriteStr(a, k, JSON.stringify(m)) : null;
        });
      })).then(function () { restCache = null; return n; });
    });
  }
  // one-time per device: records this device already had as "synced" (they came from the Sheet) are copied into Firestore; after that
  // the pull no longer carries local copies, so a deletion made on another device really disappears here too
  function restAdopt(a, have) {
    var flag = 'dpb_fs2_rest_adopted_' + nsName() + '_' + pidS();
    if (ls(flag, '') === '1') return;
    var mine = localInSync().filter(function (x) { return !have[String(x.id)]; });
    var done = function () { try { localStorage.setItem(flag, '1'); } catch (e) {} };
    if (!mine.length) { done(); return; }
    restPut(a, mine).then(done, function () {});
  }
  var histBuf = [], histT = null;
  function histFlush() {
    clearTimeout(histT); histT = null;
    if (!histBuf.length) return Promise.resolve();
    var take = histBuf.splice(0, histBuf.length);
    return getStore().then(function (s) {
      return kvReadStr(s.adapter, 'history').then(function (str) {
        var l = jparse(str, []); if (!Array.isArray(l)) l = [];
        l = l.concat(take); if (l.length > 400) l = l.slice(l.length - 400);
        return kvWriteStr(s.adapter, 'history', JSON.stringify(l));
      });
    }).catch(function () { histBuf = take.concat(histBuf).slice(-400); histT = setTimeout(histFlush, 60000); });
  }
  function histAdd(e) { histBuf.push(e); if (!histT) histT = setTimeout(histFlush, 20000); }
  try { document.addEventListener('visibilitychange', function () { if (document.hidden) histFlush(); }); } catch (e) {}
  function nowIsoSrv() { return new Date(Date.now() + clockOff()).toISOString(); }
  // the app's logHistory call puts the event name in the SAME field as the command name (gsCall merges {action:"logHistory"} with {action:"login",...}),
  // so a history entry arrives as action = "login" / "production_save" / ... with user + details and no username/password: recognise it by shape
  function isHistory(b) { return b.action === 'logHistory' || (b.details !== undefined && b.user !== undefined && b.username === undefined && b.password === undefined && b.records === undefined); }
  function sheetlessAction(body) {
    if (isHistory(body)) { histAdd({ user: body.user || '', event: body.action === 'logHistory' ? '' : String(body.action || ''), details: body.details || '', time: body.time || nowIsoSrv() }); return Promise.resolve(jsonRes({ ok: true })); }
    switch (body.action) {
      case 'logProductivity': (body.entries || []).forEach(function (x) { histAdd({ action: 'productivity', entry: x, time: nowIsoSrv() }); }); return Promise.resolve(jsonRes({ ok: true }));
      case 'saveUnitMap': return Promise.resolve(jsonRes({ ok: true, skipped: 'not needed without the Sheet' }));
      case 'saveBuildResult':
        return getStore().then(function (s) {
          var t = nowIsoSrv();
          return kvWriteStr(s.adapter, 'buildresult', String(body.json || '')).then(function () { return kvWriteStr(s.adapter, 'buildmeta', JSON.stringify({ updated: t })); }).then(function () { return jsonRes({ ok: true, updated: t }); });
        }).catch(fail);
      case 'getBuildResult':
        return getStore().then(function (s) {
          return kvReadStr(s.adapter, 'buildmeta').then(function (ms) {
            var meta = jparse(ms, {}), up = meta.updated || '';
            if (!up) return jsonRes({ ok: true });
            if (body.metaOnly) return jsonRes({ ok: true, updated: up });
            return kvReadStr(s.adapter, 'buildresult').then(function (js) { return jsonRes(js ? { ok: true, json: js, updated: up } : { ok: true }); });
          });
        }).catch(fail);
    }
    return null;
  }

  window.fetch = function (input, init) {
    try {
      if (!on()) return prevFetch(input, init);
      var base = window.DPB_getScriptUrl && window.DPB_getScriptUrl();
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var firebaseRoute = url.indexOf('https://dpb-firebase.local/') === 0;
      if (!firebaseRoute && (!base || url.indexOf(base) !== 0)) return prevFetch(input, init);
      var method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase(), q = {}, qi = url.indexOf('?');
      if (qi >= 0) url.slice(qi + 1).split('&').forEach(function (kv) { var p = kv.split('='); q[decodeURIComponent(p[0])] = decodeURIComponent((p[1] || '').replace(/\+/g, ' ')); });
      if (method === 'POST') {
        var body = {}; try { body = JSON.parse((init && init.body) || '{}'); } catch (e) { return prevFetch(input, init); }
        if ((body.action === 'kvGet' || body.action === 'kvPatch' || body.action === 'kvDelete') && kvMine(body.key)) return kvHandle(body);
        if (body.action === 'upsertMany') {
          var recs = body.records || [], m = recs.filter(isCell), rest = recs.filter(function (r) { return !isCell(r); });
          var mIds = m.map(function (r) { return String(r.id); });
          // every record is still waiting for the server: do not write them again, just say so
          if (m.length && !rest.length && mIds.every(function (i) { return UN[i]; })) return Promise.resolve(jsonRes({ ok: true, stale: [], queued: mIds, serverTime: new Date().toISOString() }));
          // the server refused these a moment ago: say so instead of sending the same refused write again and again
          if (m.length && !rest.length && mIds.every(function (i) { return REJ[i] && Date.now() - REJ[i].t < 60000; })) return Promise.resolve(jsonRes({ ok: false, error: 'السيرفر رفض الحفظ: ' + REJ[mIds[0]].e }));
          return getStore().then(function (s) {
            var p1 = m.length ? s.put(m.map(stamp), stagesOf(body)) : Promise.resolve({ stale: [] });
            return p1.then(function (pr) {
              trackQueued(mIds, pr);
              mIds.forEach(function (i) { delete REJ[i]; });
              return (rest.length ? restPut(s.adapter, rest.map(stamp)) : Promise.resolve([])).then(function (st) {
                return jsonRes({ ok: true, stale: (pr.stale || []).concat(st), queued: queuedOf(mIds), serverTime: new Date().toISOString() });
              });
            });
          }).catch(fail);
        }
        if (body.action === 'deleteMany') {
          // ids that live in the cell store are removed there (with the lock rule); every other id is a non-cell production record
          return getStore().then(function (s) {
            var ids = (body.ids || []).map(String), known = {}; s.all().forEach(function (d) { known[String(d.id)] = true; known[s.id(d.process, d.r1, d.c1)] = true; });
            var mineIds = ids.filter(function (x) { return known[x]; }), otherIds = ids.filter(function (x) { return !known[x]; });
            var p1 = mineIds.length ? s.removeIds(mineIds, stagesOf(body)) : Promise.resolve({ ok: true, deleted: 0, blocked: [] });
            return p1.then(function (r) {
              trackQueued(mineIds, r);
              var bl = {}; (r.blocked || []).forEach(function (b) { bl[String(b.id)] = true; });
              var q = queuedOf(ids.filter(function (i) { return !bl[i]; }));   // ALL ids asked for: a retry finds the cells already deleted on the device, but still waiting for the server
              if (!otherIds.length) return jsonRes({ ok: r.ok !== false, deleted: r.deleted || 0, blocked: r.blocked || [], queued: q });
              return restRemove(s.adapter, otherIds).then(function (n) { return jsonRes({ ok: r.ok !== false, deleted: (r.deleted || 0) + n, blocked: r.blocked || [], queued: q }); });
            });
          }).catch(fail);
        }
        if (body.action === 'getGrid' && mine(body.process || body.sheet)) {
          var nm = body.process || body.sheet;
          return Promise.all([getStore(), prevFetch(input, init).then(parse)]).then(function (r) { return jsonRes(overlayGrid(r[0], nm, r[1])); }, fail);
        }
        if (body.action === 'getGridBatch') { return batchRes(input, init); }
        var sl = sheetlessAction(body); if (sl) return sl;
        if (USER_ACTIONS[body.action] === 1 && usersOn()) return usersHandle(body, input, init);
        return prevFetch(input, init);
      }
      if (q.action === 'getGrid' && mine(q.process || q.sheet)) { return Promise.all([getStore(), prevFetch(input, init).then(parse)]).then(function (r) { return jsonRes(overlayGrid(r[0], q.process || q.sheet, r[1])); }, fail); }
      if (q.action === 'getGridBatch') { return batchRes(input, init); }
      if (!q.action && !q.debug) { // records pull: map cells + the other production records, both from Firestore only (the Sheet is not asked any more)
        return getStore().then(function (s) {
          // the app keeps every record it pulls in the browser's localStorage (about 5 MB): send map cells without fields it never reads
          // (recordId duplicates id; source 'SheetImport' is only a note), so a full Excel baseline (~19,000 cells) still fits
          var mineRecs = function () { return s.all().map(function (d) { var o = stamp(Object.assign({}, d)); if (o.source === 'SheetImport') delete o.source; return o; }); };
          return restAll(s.adapter).then(function (rest) {
            var sig = version + '|' + baseVer + '|' + pidS() + '|' + djb(rest.map(function (x) { return String(x.id) + String(x.time || ''); }).join(','));
            if (sig === lastPullSig && ls('dpb_fs2_rest_adopted_' + nsName() + '_' + pidS(), '') === '1' && !window.__dpbStoreFull) return jsonRes({ ok: true, unchanged: true });
            lastPullSig = sig;
            var have = {}; rest.forEach(function (x) { have[String(x.id)] = true; });
            var adopting = ls('dpb_fs2_rest_adopted_' + nsName() + '_' + pidS(), '') !== '1';
            var extra = adopting ? localInSync().filter(function (x) { return !have[String(x.id)]; }) : [];
            if (adopting) restAdopt(s.adapter, have);
            return jsonRes({ ok: true, api: 99, data: extra.concat(rest, mineRecs()) }); // no rev on purpose: every pull is a full one
          });
        }, function () { return jsonRes({ ok: true, unchanged: true }); }); // layer unavailable: change nothing locally, do not hang
      }
      return prevFetch(input, init);
    } catch (e) { return prevFetch(input, init); }
  };
  // the record of one map cell exactly as Firestore holds it right now (null if the layer is off / not connected yet) - the map's Cell Details card reads this so it never waits for the next full pull
  function recordAt(process, r, c) {
    try { var st0 = curStore(); if (!st0) return null; var s = CORE.slug(process); var hit = st0.all().filter(function (d) { return CORE.slug(d.process) === s && Number(d.r1) === Number(r) && Number(d.c1) === Number(c); })[0]; return hit ? stamp(Object.assign({ recordId: hit.id }, hit)) : null; } catch (e) { return null; }
  }
  // Local read of one map process straight from the Firestore store (no Apps Script, no network).
  // owns(name): the layer is on and this process is one of its map processes. liveValues(name): Map "r|c" -> value (what the old getGrid reply held
  // after overlayGrid: done count for a progress cell, otherwise the process code), or null while the layer is not connected yet.
  function owns(name) { try { return on() && mine(name); } catch (e) { return false; } }
  function liveValues(name) {
    var st1 = curStore(); if (!owns(name) || !st1) return null;
    var sl = CORE.slug(name), m = new Map(), all = st1.all();
    all.forEach(function (d) {
      if (CORE.slug(d.process) !== sl) return;
      var v = (d.done !== undefined && d.done !== null) ? Number(d.done) : Number(d.code);
      if (v && isFinite(v)) m.set(Number(d.r1) + '|' + Number(d.c1), v);
    });
    // grouped processes (Ramming/Saddle/Bearing): a cell that a LATER stage already reached counts as done in the earlier stages too, the same
    // rule the cards use. Marks made in the app are back-filled when they are written, but the Excel baseline is not, so without this the
    // map showed an earlier stage empty while the card (and the later stage) said it was done. Computed on read only - nothing is stored.
    try {
      var codes = (typeof window.DPB_stageCodes === 'function') ? window.DPB_stageCodes() : null, grp = (typeof window.DPB_groupedProcessNames === 'function') ? window.DPB_groupedProcessNames() : [];
      var own = 0, later = [];
      if (codes) {
        grp.forEach(function (g) { var c = Number(codes[String(g).trim().toLowerCase()]) || 0; if (CORE.slug(g) === sl) own = c; });
        if (own > 0) grp.forEach(function (g) { var c = Number(codes[String(g).trim().toLowerCase()]) || 0; if (c > own) later.push({ slug: CORE.slug(g), code: c }); });
      }
      if (own > 0 && later.length) {
        all.forEach(function (d) {
          var ds = CORE.slug(d.process), L = null; for (var i = 0; i < later.length; i++) if (later[i].slug === ds) L = later[i];
          if (!L) return;
          var v = (d.done !== undefined && d.done !== null) ? Number(d.done) : Number(d.code);
          if (!(v >= L.code)) return;
          var k = Number(d.r1) + '|' + Number(d.c1), cur = m.get(k) || 0;
          if (cur < own) m.set(k, own);
        });
      }
    } catch (e) {}
    return m;
  }
  window.DPB_FS2 = { probe: runProbe, clockOffset: clockOff, owns: owns, liveValues: liveValues, getXlFile: getXlFile, on: on, recordAt: recordAt, setProcs: setProcs, setMode: function (v) { try { localStorage.setItem(LS.mode, v ? 'on' : 'off'); } catch (e) {} }, procs: procs, store: getStore, seedUsers: seedUsers, usersCount: usersCount, testConnection: testConn, projectsGet: projectsGet, projectsUpdate: projectsUpdate };

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
  // Excel baseline: the numbers already written in the uploaded Excel (the app reads them with the SAME map model that draws the map, so only real map cells count).
  // ADD-ONLY: a cell that already has a live value in Firestore is never changed or removed. Run once after uploading the Excel; the preview (apply=false) writes nothing.
  function importExcel(apply) {
    var src = typeof window.__dpbExcelUnitCells === 'function' ? window.__dpbExcelUnitCells() : [];
    if (!src.length) return Promise.reject(new Error('مفيش إكسل تنفيذ متطبّق على الجهاز ده (الإكسل بيتحمّل من Builder على جهاز الأدمن)'));
    return getStore().then(function (s) {
      var live = s.all();
      return Promise.all(src.map(function (x) {
        var have = live.filter(function (d) { return CORE.slug(d.process) === CORE.slug(x.name); }).map(function (d) { return { r: d.r1, c: d.c1, r2: d.r2, c2: d.c2, code: d.code }; });
        var seen = {}; have.forEach(function (h) { seen[h.r + '|' + h.c] = 1; });
        var fresh = x.cells.filter(function (c) { return !seen[c.r + '|' + c.c]; });
        return s.importProcess(x.name, have.concat(fresh), !apply).then(function (r) { return { name: x.name, units: x.units, excel: x.cells.length, existing: have.length, add: r.add, bad: x.bad.length }; });
      }));
    });
  }
  window.DPB_FS2.importExcel = importExcel;
  /* Excel baseline WITHOUT writing every cell: the executed cells of the uploaded Excel are published as ONE compact document (kv 'basecells'),
     every device reads it into memory (core.setBase) and only real changes made after that are stored as cell documents. Compact format per process:
     c = [r, c, code, r2, c2, r, c, code, r2, c2, ...]. */
  var baseVer = 0, baseLoadAt = 0;
  function baseList(o) {
    var list = []; ((o && o.procs) || []).forEach(function (p) { var a = p.c || []; for (var i = 0; i + 4 < a.length; i += 5) list.push({ process: p.name, r1: a[i], c1: a[i + 1], code: a[i + 2], r2: a[i + 3], c2: a[i + 4] }); });
    return list;
  }
  // v99: (1) "already in memory" بقت بتتحقق على نفس الـ store (قبل كده كانت على مستوى الملف، فلما الطبقة تتبني من جديد وقت فتح التطبيق وتحديد المشروع
  // الـ store الجديد كان بيفضل من غير بيانات الإكسل الأساسية). (2) نسخة محلية على الموبايل (localStorage) بتتحمّل فورًا، فالطبقة الملونة
  // بتفضل بعد قفل التطبيق وبدون نت. (3) الحالة ظاهرة بدل الفشل الصامت، وإعادة محاولة لو القراءة فشلت.
  var baseStat = { cells: 0, err: '', at: 0, tries: 0 }, baseRetryT = null, baseStoreRef = null;
  function baseLsKey() { return 'dpb_fs2_basecells_' + nsName() + '_' + pidS(); }
  function baseLsGet() { try { return jparse(localStorage.getItem(baseLsKey()), null); } catch (e) { return null; } }
  function baseLsPut(o) { try { localStorage.setItem(baseLsKey(), JSON.stringify(o)); } catch (e) {} }
  function applyBase(s, o, fromLocal) {
    var bl = baseList(o); baseTime = o.time || ''; baseStoreRef = s; baseStat.cells = bl.length; if (!fromLocal) baseStat.err = '';
    s.setBase(bl); baseVer++; return 1;
  }
  function loadBase(s) {
    baseLoadAt = Date.now(); baseStat.at = baseLoadAt;
    // 1) النسخة المحلية أولًا (فورية، بتشتغل أوفلاين)
    try { var lo = baseLsGet(); if (lo && Array.isArray(lo.procs) && baseStoreRef !== s) applyBase(s, lo, true); } catch (e) {}
    // 2) بعدين السيرفر. kvReadStr ممكن ترمي خطأ متزامن (مفيش مشروع) فبنلفها في Promise
    return new Promise(function (res) { res(kvReadStr(s.adapter, 'basecells')); }).then(function (str) {
      var o = jparse(str, null);
      if (!o || !Array.isArray(o.procs)) { if (!baseStat.cells) baseStat.err = 'no-doc'; scheduleBaseRetry(s); return 0; }
      baseStat.err = ''; baseLsPut(o);
      if (o.time && o.time === baseTime && baseStoreRef === s) return 0;   // already in THIS store
      return applyBase(s, o, false);
    }).catch(function (e) { if (!baseStat.cells) baseStat.err = String((e && (e.code || e.message)) || e || 'read-failed'); scheduleBaseRetry(s); return 0; });
  }
  function scheduleBaseRetry(s) {
    if (baseStat.cells > 0 || baseStat.tries >= 3) return;
    var wait = [5000, 15000, 40000][baseStat.tries++];
    clearTimeout(baseRetryT); baseRetryT = setTimeout(function () { try { var cs = curStore(); if (cs) loadBase(cs); } catch (e) {} }, wait);
  }
  var baseTime = '';
  function publishBaseline() {
    var src = typeof window.__dpbExcelUnitCells === 'function' ? window.__dpbExcelUnitCells() : [];
    if (!src.length) return Promise.reject(new Error('مفيش إكسل تنفيذ متطبّق على الجهاز ده'));
    return getStore().then(function (s) {
      var procs = src.map(function (x) { var a = []; x.cells.forEach(function (c) { a.push(c.r, c.c, c.code, c.r2 == null ? c.r : c.r2, c.c2 == null ? c.c : c.c2); }); return { name: x.name, c: a }; });
      var o = { v: 1, time: new Date().toISOString(), procs: procs };
      return kvWriteStr(s.adapter, 'basecells', JSON.stringify(o)).then(function () {
        baseLsPut(o); applyBase(s, o, false);
        return src.map(function (x) { return { name: x.name, units: x.units, excel: x.cells.length, existing: 0, add: x.cells.length, bad: x.bad.length }; });
      });
    });
  }
  window.DPB_FS2.publishBaseline = publishBaseline;
  window.DPB_FS2.reloadBase = function () { if (baseStat.cells > 0 && Date.now() - baseLoadAt < 60000) return Promise.resolve(0); return getStore().then(loadBase); };
  window.DPB_FS2.baseStatus = function () { return { cells: baseStat.cells, err: baseStat.err, at: baseStat.at, time: baseTime }; };
  try { document.addEventListener('visibilitychange', function () { if (!document.hidden && curStore()) window.DPB_FS2.reloadBase(); }); } catch (e) {}
  window.DPB_FS2.backup = bkExport; window.DPB_FS2.restore = bkRestore;

  /* ---- Backup / restore: one JSON file with everything the layer keeps in Firestore (dpb2/{ns}/rows = map cells, dpb2/{ns}/kv = map catalog, map shapes, original Excel files).
     Restore = make Firestore equal to the file: preview first, a safety copy of the CURRENT state is downloaded before anything is written, writes go in size-limited batches,
     Excel-file parts are written before their pointer and removed after it, so a reader never sees a half file. ---- */
  var BK_COLLS = ['rows', 'kv'], BK_FORMAT = 'dpb-fs2-backup', bkAutoRun = false, BK_SRV_GAP = 6 * 3600000;
  function bkP(c) { return 'dpb2/' + nsName() + '/' + c; }
  function bkStamp() { var d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; }; return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()); }
  function stable(v) { if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']'; if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + stable(v[k]); }).join(',') + '}'; return JSON.stringify(v); }
  function bytesOf(s) { try { return new TextEncoder().encode(s).length; } catch (e) { return s.length * 2; } }
  /*BKREAD-START*/
  // v160: the backup is made from the copy this phone already holds (Firestore local cache): zero reads from the daily quota, no network, and it does not
  // touch the server channel that kept dying in "read". Only if that copy is missing or visibly incomplete (fewer docs than the last full server read) does it
  // fall back to the server, one collection at a time.
  function bkReadCache(a) {
    if (!a.listCache) return Promise.resolve(null);
    var out = {}, tot = 0, p = Promise.resolve();
    BK_COLLS.forEach(function (c) {
      p = p.then(function () { return a.listCache(bkP(c)); }).then(function (r) {
        if (!r) throw new Error('no-cache');
        out[c] = {}; tot += r.length; r.forEach(function (d) { out[c][d.id] = clean(d.data); });
      });
    });
    return p.then(function () {
      var exp = parseInt(ls('dpb_fs2_bk_docs', '0'), 10) || 0;
      return (!tot || (exp && tot < exp * 0.95)) ? null : out;
    }, function () { return null; });
  }
  function bkRead() {
    return getAdapter().then(function (a) {   // v156: the backup reads the whole namespace, so it no longer needs a project to be open
      if (!a || !a.list) throw new Error('الاتصال الحالي مش بيدعم قراءة كل المستندات');
      bkStep('read-local');
      return bkReadCache(a).then(function (loc) {
        if (loc) { lsSet('dpb_fs2_bk_src', 'local'); return loc; }
        // v161: the automatic run never goes to the server more than once every BK_SRV_GAP (a server read costs one read per document); the manual button always may
        if (bkAutoRun && Date.now() - (Number(ls('dpb_fs2_bk_srv_last', '0')) || 0) < BK_SRV_GAP) throw Object.assign(new Error('bk-skip-server'), { code: 'bk-skip' });
        bkStep('read-server'); lsSet('dpb_fs2_bk_src', 'server'); lsSet('dpb_fs2_bk_srv_last', String(Date.now()));
        var out = {}, tot = 0, p = Promise.resolve();
        BK_COLLS.forEach(function (c) { p = p.then(function () { return a.list(bkP(c)); }).then(function (r) { out[c] = {}; tot += r.length; r.forEach(function (d) { out[c][d.id] = clean(d.data); }); }); });
        return p.then(function () { lsSet('dpb_fs2_bk_docs', String(tot)); return out; });
      });
    });
  }
  /*BKREAD-END*/
  function bkMake(cur) { return { format: BK_FORMAT, version: 1, ns: nsName(), savedAt: new Date().toISOString(), counts: { rows: Object.keys(cur.rows).length, kv: Object.keys(cur.kv).length }, rows: cur.rows, kv: cur.kv }; }
  function bkDownload(obj, name) {
    var blob = new Blob([JSON.stringify(obj)], { type: 'application/json' }), url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(url); }, 3000);
    return blob.size;
  }
  function bkExport(download) {
    return bkRead().then(function (cur) { var obj = bkMake(cur), size = 0; if (download !== false) size = bkDownload(obj, 'dpb-firebase-backup-' + nsName() + '-' + bkStamp() + '.json'); return { backup: obj, size: size }; });
  }
  function bkDiff(cur, bk) {
    var d = { add: {}, change: {}, remove: {}, n: { add: 0, change: 0, remove: 0 } };
    BK_COLLS.forEach(function (c) {
      var A = cur[c] || {}, B = bk[c] || {}; d.add[c] = []; d.change[c] = []; d.remove[c] = [];
      Object.keys(B).forEach(function (id) { if (!Object.prototype.hasOwnProperty.call(A, id)) d.add[c].push(id); else if (stable(A[id]) !== stable(B[id])) d.change[c].push(id); });
      Object.keys(A).forEach(function (id) { if (!Object.prototype.hasOwnProperty.call(B, id) && !(bk.slim && c === 'kv' && /^(xlfile_|mapsnap_)/.test(id))) d.remove[c].push(id); });   /* v167: a slim (Drive) copy has no Excel files by design, so restoring it must never delete them */
      d.n.add += d.add[c].length; d.n.change += d.change[c].length; d.n.remove += d.remove[c].length;
    });
    return d;
  }
  function bkStages(d, cur, bk) {
    var isPtr = function (x) { return !!x && x.parts != null; }, st = [[], [], [], [], [], []];
    var setOp = function (c, id) { return { t: 's', path: bkP(c) + '/' + id, data: bk[c][id] }; };
    ['add', 'change'].forEach(function (k) {
      d[k].kv.forEach(function (id) { (isPtr(bk.kv[id]) ? st[2] : st[0]).push(setOp('kv', id)); });   // file parts first, pointers after
      d[k].rows.forEach(function (id) { st[1].push(setOp('rows', id)); });
    });
    d.remove.kv.forEach(function (id) { (isPtr(cur.kv[id]) ? st[3] : st[4]).push({ t: 'd', path: bkP('kv') + '/' + id }); });   // pointers go first, their parts after
    d.remove.rows.forEach(function (id) { st[5].push({ t: 'd', path: bkP('rows') + '/' + id }); });
    return st;
  }
  function bkWrite(a, stages, progress) {
    var total = stages.reduce(function (n, s) { return n + s.length; }, 0), done = 0, p = Promise.resolve();
    stages.forEach(function (ops) {
      var groups = [], g = [], bytes = 0;
      ops.forEach(function (o) { var sz = (o.t === 's' ? bytesOf(JSON.stringify(o.data)) : 0) + 200; if (g.length && (bytes + sz > 3000000 || g.length >= 300)) { groups.push(g); g = []; bytes = 0; } g.push(o); bytes += sz; });
      if (g.length) groups.push(g);
      groups.forEach(function (grp) { p = p.then(function () { return a.write(grp); }).then(function () { done += grp.length; if (progress) progress(done, total); }); });
    });
    return p;
  }
  // ask(summary) -> true to continue. Returns { applied, diff, safety } (applied false = nothing written).
  function bkRestore(text, ask, progress) {
    if (typeof text === 'string' && text.indexOf('"dpbz"') > -1 && text.indexOf('"dpbz"') < 40) return bkUnpack(text).then(function (t) { return bkRestore(t, ask, progress); });   // v168: compressed Drive copy
    var bk; try { bk = JSON.parse(text); } catch (e) { return Promise.reject(new Error('الملف مش نسخة احتياطية صالحة (مش JSON)')); }
    if (!bk || bk.format !== BK_FORMAT || typeof bk.rows !== 'object' || typeof bk.kv !== 'object' || !bk.rows || !bk.kv) return Promise.reject(new Error('الملف ده مش نسخة احتياطية من الطبقة الجديدة'));
    var bad = BK_COLLS.some(function (c) { var m = bk[c]; return Array.isArray(m) || Object.keys(m).some(function (id) { var v = m[id]; return !id || /\//.test(id) || !v || typeof v !== 'object' || Array.isArray(v); }); });
    if (bad) return Promise.reject(new Error('الملف تالف: فيه مستند غير صالح (اسم فيه / أو محتوى مش كائن)'));
    return bkRead().then(function (cur) {
      var d = bkDiff(cur, bk);
      if (!d.n.add && !d.n.change && !d.n.remove) return { applied: false, same: true, diff: d };
      var sum = { diff: d, fileNs: bk.ns, fileTime: bk.savedAt, ns: nsName(), fileCounts: bk.counts || null };
      return Promise.resolve(ask ? ask(sum) : true).then(function (go) {
        if (!go) return { applied: false, diff: d };
        bkDownload(bkMake(cur), 'dpb-before-restore-' + nsName() + '-' + bkStamp() + '.json');   // safety copy of what is there right now
        return getStore().then(function (s) { return bkWrite(s.adapter, bkStages(d, cur, bk), progress); }).then(function () { return { applied: true, diff: d }; });
      });
    });
  }

  /* ---- Two copies only: "current" and "previous". Every new backup turns the old current into previous and drops the older previous.
     They are kept inside the app (IndexedDB) and, when a folder was chosen, as exactly two files there (…-current.json / …-previous.json, overwritten, never piling up). ---- */
  var BK_DB = 'DPB_FS2_BACKUP_V1', bkDbP = null, BK_FILE = { current: 'dpb-firebase-backup-current.json', previous: 'dpb-firebase-backup-previous.json' };
  function bkIdb() {
    if (bkDbP) return bkDbP;
    bkDbP = new Promise(function (res, rej) {
      if (!window.indexedDB) return rej(new Error('التخزين الداخلي مش متاح في المتصفح ده'));
      var rq = indexedDB.open(BK_DB, 1); rq.onupgradeneeded = function () { rq.result.createObjectStore('kv'); };
      rq.onsuccess = function () { res(rq.result); }; rq.onerror = function () { rej(rq.error); };
    }); bkDbP.catch(function () { bkDbP = null; }); return bkDbP;
  }
  function bkGet(k) {
    if (window.__DPB_FS2_BKSTORE) return Promise.resolve(window.__DPB_FS2_BKSTORE.get(k)).then(function (v) { return v == null ? null : v; });
    return bkIdb().then(function (db) { return new Promise(function (res, rej) { var r = db.transaction('kv').objectStore('kv').get(k); r.onsuccess = function () { res(r.result == null ? null : r.result); }; r.onerror = function () { rej(r.error); }; }); });
  }
  function bkPut(k, v) {
    if (window.__DPB_FS2_BKSTORE) return Promise.resolve(window.__DPB_FS2_BKSTORE.put(k, v));
    return bkIdb().then(function (db) { return new Promise(function (res, rej) { var t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = function () { res(); }; t.onerror = function () { rej(t.error); }; t.onabort = function () { rej(t.error || new Error('فشل الحفظ الداخلي')); }; }); });
  }
  function bkSame(a, b) { return !!a && !!b && stable(a.rows) === stable(b.rows) && stable(a.kv) === stable(b.kv); }
  // v156 (out-of-memory fix): the change check no longer builds giant strings of the whole backup (old + new, twice) and no longer keeps 4-5 copies alive.
  // Every document gets a small fingerprint; only the fingerprints are compared. The big copies are only touched when something really changed,
  // and the small \"meta\" records feed the status line so painting it never loads a whole backup again.
  function hashStr(t) { var h1 = 0x811c9dc5, h2 = 5381; for (var i = 0; i < t.length; i++) { var c = t.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619); h2 = (Math.imul(h2, 33) + c) | 0; } return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36) + t.length.toString(36); }
  function bkFp(cur) { var fp = {}; BK_COLLS.forEach(function (c) { fp[c] = {}; Object.keys(cur[c] || {}).forEach(function (id) { fp[c][id] = hashStr(stable(cur[c][id])); }); }); return fp; }
  function bkMeta(o) { return o ? { savedAt: o.savedAt, counts: o.counts } : null; }
  // reads Firebase; if nothing changed since the current copy, nothing rotates (so pressing it twice never wipes the real "previous").
  // Unchanged -> { changed:false, current:null } (callers load the copy themselves only if they need it).
  function bkStep(x) { lsSet('dpb_fs2_bk_step', x + '@' + new Date().toLocaleTimeString('ar-EG')); }
  function bkBackupNow() {
    return bkRead().then(function (cur) {
      bkStep('compare');
      var obj = bkMake(cur), fp = bkFp(cur); cur = null;
      function rotate(old) {
        bkStep('save-in-app');
        return Promise.resolve(old ? bkPut('previous', old).then(function () { return bkPut('previousmeta', bkMeta(old)); }) : null)
          .then(function () { return bkPut('current', obj); })
          .then(function () { return bkPut('currentmeta', bkMeta(obj)); })
          .then(function () { return bkPut('currentfp', fp); })
          .then(function () { return { changed: true, current: obj, previous: old || null }; });
      }
      return bkGet('currentfp').then(function (ofp) {
        if (ofp) {
          if (stable(ofp) === stable(fp)) { bkStep('done'); return { changed: false, current: null, previous: null }; }
          return bkGet('current').then(rotate);
        }
        // first run after the update: the old copy has no fingerprint yet, compare the old way once
        return bkGet('current').then(function (old) {
          if (old && bkSame(old, obj)) return bkPut('currentfp', fp).then(function () { return bkPut('currentmeta', bkMeta(old)); }).then(function () { bkStep('done'); return { changed: false, current: null, previous: null }; });
          return rotate(old);
        });
      });
    });
  }
  // external copy first, then the Drive upload - one after the other, so two huge strings never exist at the same time
  function bkPublish(r) {
    bkStep('phone-copy');
    return bkSaveExternal(r.current, r.previous, false).then(function (w) { bkNoteExt(w); return w; }, function () { return 'fail'; })
      .then(function (w) { bkStep('drive'); return bkDriveUpload(r.current).then(function (d) { bkStep('done'); return [w, d]; }); });
  }
  function bkPerm(h, ask) {
    return Promise.resolve().then(function () {
      if (!h || !h.queryPermission) return true;
      return h.queryPermission({ mode: 'readwrite' }).then(function (p) { if (p === 'granted') return true; return ask && h.requestPermission ? h.requestPermission({ mode: 'readwrite' }).then(function (q) { return q === 'granted'; }) : false; });
    }).catch(function () { return false; });
  }
  function bkWriteFolder(h, cur, prev) {
    function one(name, obj) { return h.getFileHandle(name, { create: true }).then(function (fh) { return fh.createWritable(); }).then(function (w) { return Promise.resolve(w.write(JSON.stringify(obj))).then(function () { return w.close(); }); }); }
    return one(BK_FILE.current, cur).then(function () { return prev ? one(BK_FILE.previous, prev) : null; });
  }
  function bkPickFolder() {
    var nb = window.DPB_NATIVE_BRIDGE;   // the APK (same contract the app's own backup already uses): chooseFolder / hasFolder / writeBackupFile(name, text) - the native side must OVERWRITE a file of the same name
    if (nb && nb.chooseFolder) return Promise.resolve(nb.chooseFolder()).then(function (n) { if (!n) { var e = new Error('اتلغى'); e.name = 'AbortError'; throw e; } return n; });
    if (!window.showDirectoryPicker) return Promise.reject(new Error('اختيار المجلد مش متاح هنا. هتحفظ من نافذة المشاركة.'));
    return window.showDirectoryPicker({ mode: 'readwrite' }).then(function (h) { return bkPut('dir', h).then(function () { return h; }); });
  }
  function capFs() { try { var C = window.Capacitor, P = C && C.Plugins; return (P && P.Filesystem && (!C.isNativePlatform || C.isNativePlatform())) ? P.Filesystem : null; } catch (e) { return null; } }
  /*BKNAT-START*/
  // v159: the phone-folder write (DpbFolder.write({name,text})) pushes the WHOLE backup as ONE string through the Capacitor bridge. With the real project that is
  // several MB, and the WebView itself dies (native "JniAndroid$UncaughtExceptionException" the moment Backup Now is pressed). A string above BK_BRIDGE_MAX is
  // never sent in one call; the caller falls through to the chunked Documents/DPB write (or none) and the in-app copy + Drive copy still happen.
  var BK_BRIDGE_MAX = 1000000, BK_CHUNK = 400000;
  function bkWriteNative(nb, cur, prev) {
    var a = JSON.stringify(cur), b = prev ? JSON.stringify(prev) : null;
    function one(n, t) { return Promise.resolve(nb.writeBackupFile(n, t)).then(function (ok) { if (ok === false) throw new Error('الكتابة في مكان الحفظ فشلت'); }); }
    if (a.length <= BK_BRIDGE_MAX && (!b || b.length <= BK_BRIDGE_MAX)) return one(BK_FILE.current, a).then(function () { return b ? one(BK_FILE.previous, b) : null; }).then(function () { return true; });
    // v167: too big for one bridge call. If the installed plugin can append, write the chosen folder in pieces (first piece overwrites, the rest append); otherwise not written here (Documents/DPB still gets it).
    return Promise.resolve(typeof nb.canAppend === 'function' ? nb.canAppend() : false).then(function (can) {
      if (!can) return false;
      function chunked(n, str) {
        var p = Promise.resolve();
        for (var i = 0; i < str.length || i === 0; i += BK_CHUNK) (function (piece, first) {
          p = p.then(function () { return Promise.resolve(nb.writeBackupFile(n, piece, !first)).then(function (ok) { if (ok === false) throw new Error('الكتابة في مكان الحفظ فشلت'); }); });
        })(str.slice(i, i + BK_CHUNK), i === 0);
        return p;
      }
      return chunked(BK_FILE.current, a).then(function () { return b ? chunked(BK_FILE.previous, b) : null; }).then(function () { return true; });
    });
  }
  // Capacitor Filesystem: first piece writeFile, the rest appendFile (400K chars each), so no single bridge call is big
  function bkWriteCap(F, cur, prev) {
    function one(n, o) {
      var str = JSON.stringify(o), path = 'DPB/' + n, p = Promise.resolve();
      for (var i = 0; i < str.length || i === 0; i += BK_CHUNK) (function (piece, first) {
        p = p.then(function () { var a = { path: path, data: piece, directory: 'DOCUMENTS', encoding: 'utf8' }; if (first) { a.recursive = true; return F.writeFile(a); } return F.appendFile(a); });
      })(str.slice(i, i + BK_CHUNK), i === 0);
      return p;
    }
    return one(BK_FILE.current, cur).then(function () { return prev ? one(BK_FILE.previous, prev) : null; });
  }
  /*BKNAT-END*/
  // interactive=false (auto / right after a backup): only places that need no tap - the APK's chosen folder, Documents/DPB, a chosen desktop folder.
  // interactive=true (a tap on "save outside the app"): the same, then the folder picker / share sheet / a download.
  // Returns 'native' | 'documents' | 'folder' | 'share' | 'download' | 'none'. A failed write rejects.
  function bkSaveExternal(cur, prev, interactive) {
    var nb = window.DPB_NATIVE_BRIDGE, cf = capFs();
    function viaNative() {
      if (!nb) return Promise.resolve(null);
      return Promise.resolve(nb.hasFolder ? nb.hasFolder() : false).catch(function () { return false; }).then(function (has) {
        var ready = has ? Promise.resolve(true) : (interactive && nb.chooseFolder ? Promise.resolve(nb.chooseFolder()).then(function (n) { if (!n) { var e = new Error('اتلغى'); e.name = 'AbortError'; throw e; } return true; }) : Promise.resolve(false));
        return ready.then(function (ok) { return ok ? bkWriteNative(nb, cur, prev).then(function (w) { return w === false ? null : 'native'; }) : null; });
      });
    }
    function viaDocs() { return cf ? bkWriteCap(cf, cur, prev).then(function () { return 'documents'; }) : Promise.resolve(null); }
    function viaFolder() {
      return bkGet('dir').catch(function () { return null; }).then(function (h) {
        var write = function (hh) { return bkPerm(hh, interactive).then(function (ok) { return ok ? bkWriteFolder(hh, cur, prev).then(function () { return 'folder'; }) : null; }); };
        var first = h ? write(h) : Promise.resolve(null);
        return first.then(function (r) {
          if (r || !interactive) return r;
          if (!h && window.showDirectoryPicker && !nb && !cf) return bkPickFolder().then(write).catch(function (e) { if (e && e.name === 'AbortError') throw e; return null; });
          return null;
        });
      });
    }
    function viaShare() {
      var files = [new File([JSON.stringify(cur)], BK_FILE.current, { type: 'application/json' })];
      if (prev) files.push(new File([JSON.stringify(prev)], BK_FILE.previous, { type: 'application/json' }));
      if (navigator.canShare && navigator.canShare({ files: files })) return navigator.share({ files: files, title: 'نسخة Firebase', text: 'DPB' }).then(function () { return 'share'; });
      bkDownload(cur, BK_FILE.current); if (prev) setTimeout(function () { bkDownload(prev, BK_FILE.previous); }, 400);
      return 'download';
    }
    return viaNative().then(function (r) { return r || viaDocs(); }).then(function (r) { return r || viaFolder(); }).then(function (r) { return r || (interactive ? viaShare() : 'none'); });
  }
  function bkLine(o) { return o ? new Date(o.savedAt).toLocaleString('ar-EG') + ' (' + o.counts.rows + ' خلية / ' + o.counts.kv + ' خريطة)' : 'مفيش'; }
  var BK_WHERE = { native: '📱 على الهاتف (المجلد المختار)', documents: '📱 على الهاتف (Documents/DPB)', folder: '📁 في المجلد المختار', share: '📤 من نافذة المشاركة', download: '⬇️ في التنزيلات', none: '' };
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function bkNoteExt(w) { if (w && w !== 'none') lsSet('dpb_fs2_bk_ext', JSON.stringify({ w: w, t: Date.now() })); }

  function drivePaint() {
    var el = document.getElementById('dpbFs2DriveInfo'); if (!el) return;
    el.textContent = '';
    if (!driveOn()) { el.textContent = '☁️ رفع Drive متوقف'; return; }
    var x = null; try { x = JSON.parse(ls('dpb_fs2_bk_drive', 'null')); } catch (e) {}
    if (!x) { el.textContent = '☁️ لسه ما اترفعتش نسخة على Drive'; return; }
    var when = new Date(x.t).toLocaleString('ar-EG');
    var l1 = document.createElement('div'); l1.style.cssText = 'font-weight:700;color:' + (x.ok ? '#3fbf6f' : '#ff7b7b');
    l1.textContent = x.ok ? '☁️ آخر رفع إلى Google Drive: تم بنجاح' : '☁️ آخر رفع إلى Google Drive: فشل — ' + x.error;
    el.appendChild(l1);
    var l2 = document.createElement('div'); l2.textContent = '🕒 ' + when; el.appendChild(l2);
    if (x.ok && x.url) { var l3 = document.createElement('div'), a = document.createElement('a'); a.href = x.url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = '🔗 اضغط هنا لفتح الملف مباشرة'; a.style.color = '#5aa9ff'; l3.appendChild(a); el.appendChild(l3); }
    var acc = x.sharedWith || driveEmail() || x.owner;
    if (x.ok && acc) { var l4 = document.createElement('div'); l4.textContent = 'الملف محفوظ في حساب: ' + acc; el.appendChild(l4); }
    if (x.ok && x.shareError) { var l5 = document.createElement('div'); l5.style.color = '#ffb347'; l5.textContent = '⚠ تعذّرت المشاركة: ' + x.shareError; el.appendChild(l5); }
    if (x.ok && !driveEmail()) { var l6 = document.createElement('div'); l6.style.color = '#ffb347'; l6.textContent = '⚠ اكتب إيميل Drive عشان النسخة تظهر عنده'; el.appendChild(l6); }
  }
  function bkPaint() {
    drivePaint();
    var el = document.getElementById('dpbFs2BkInfo'); if (!el) return Promise.resolve();
    var d = document.getElementById('dpbFs2Dir'); if (d) d.style.display = (window.showDirectoryPicker || window.DPB_NATIVE_BRIDGE) ? '' : 'none';
    return Promise.all([bkGet('currentmeta'), bkGet('previousmeta')]).then(function (r) {
      if (!r[0]) return Promise.all([bkGet('current'), bkGet('previous')]).then(function (f) { var m = [bkMeta(f[0]), bkMeta(f[1])]; if (m[0]) bkPut('currentmeta', m[0]); if (m[1]) bkPut('previousmeta', m[1]); return m; });
      return r;
    }).then(function (r) {
      var x = null; try { x = JSON.parse(ls('dpb_fs2_bk_ext', 'null')); } catch (e) {}
      var srcT = ls('dpb_fs2_bk_src', ''), srcL = srcT ? '\nمصدر آخر نسخة: ' + (srcT === 'local' ? 'نسخة الجهاز (من غير قراءات)' : 'السيرفر') : '', st = ls('dpb_fs2_bk_step', ''), cut = (st && !/^done@/.test(st)) ? '\n⚠ آخر نسخة اتقطعت عند الخطوة: ' + st : '';
      el.textContent = 'الحالية: ' + bkLine(r[0]) + '\nالسابقة: ' + bkLine(r[1]) + srcL + cut + (x && BK_WHERE[x.w] ? '\nآخر حفظ برّه التطبيق: ' + BK_WHERE[x.w] + ' ✔ ' + new Date(x.t).toLocaleTimeString('ar-EG') : '') + '';
    }).catch(function () {});
  }
  /* ---- Google Drive copy (Apps Script action saveBackup): two files per namespace (current + previous), rotated on the server.
     Switch DPB_BACKUP_DRIVE_V1 and the e-mail DPB_BACKUP_DRIVE_EMAIL_V1 are shared with the app's own backup screen. ---- */
  var LOCAL_HOST = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  function driveOn() { var v = ls('DPB_BACKUP_DRIVE_V1', null); return v === null ? !LOCAL_HOST : v !== 'off'; }   // off by default on localhost so emulator data never overwrites the real copy
  function driveEmail() { return String(ls('DPB_BACKUP_DRIVE_EMAIL_V1', '') || '').trim(); }
  function driveErr(res) {
    var raw = String((res && res.error) || '');
    if (/Unknown action/i.test(raw)) return 'Code.gs المنشور ما فيهوش النسخ الاحتياطي — انشر نسخة جديدة (Deploy > Manage deployments > Version: New version)';
    if (/unauthorized|401/i.test(raw) || (res && res.code === 401)) return 'سجّل دخول من جديد (التوكن غير صالح)';
    if (res && res.__reachable === false && res.__probe === 'get-ok') return 'الرابط شغال لكن رفع النسخة اتمنع — في Apps Script: شغّل دالة authorizeBackup مرة واحدة ووافق على الصلاحيات، وبعدها Deploy > Manage deployments > Version: New version';
    if (res && res.__reachable === false) return navigator.onLine === false ? 'لا يوجد اتصال بالإنترنت' : ((ls('DPB_BACKUP_URL_V1', '') ? 'تعذّر الاتصال بسكربت النسخ الاحتياطي — افتح الرابط في المتصفح: لازم يظهر ok:true، وتأكد Who has access = Anyone' : 'تعذّر الاتصال بـ Apps Script') + (res.__detail ? '\n[تفاصيل: ' + String(res.__probe || '') + ' | ' + String(res.__detail).slice(0, 200) + ']' : ''));   /* v166: the real reason, so it is no longer hidden */
    return raw || 'فشل الرفع';
  }
  // v167: the copy sent to Drive leaves out the original Excel files (kv xlfile_*): they are base64 and made the file ~12 MB, which never finished uploading on 4G
  // (AbortError). The map snapshots (mapsnap_*) are left out too. They stay in Firestore and in the phone/local backup file; the Drive copy keeps every cell, map and setting.
  function bkSlim(obj) {
    var kv = {}, n = 0; Object.keys((obj && obj.kv) || {}).forEach(function (k) { if (/^(xlfile_|mapsnap_)/.test(k)) n++; else kv[k] = obj.kv[k]; });
    var o = {}; Object.keys(obj).forEach(function (k) { o[k] = obj[k]; }); o.kv = kv; o.slim = { noExcelFiles: n };
    return o;
  }
  window.DPB_FS2.bkSlim = bkSlim;
  // v168: the Drive copy is compressed (gzip, then base64 inside a small JSON wrapper) before it is sent. The cells repeat the same field names thousands of times, so the file
  // is typically ~8-10x smaller: much less to push over 4G and much less memory in the page. The wrapper is still valid JSON, so the Apps Script needs no change.
  // bkUnpack() (used by the restore) turns the wrapper back into the normal backup text; a normal (uncompressed) backup passes through untouched.
  function bkB64(u8) { var s = '', i, n = u8.length; for (i = 0; i < n; i += 24576) s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(n, i + 24576))); return btoa(s); }
  function bkFromB64(b) { var s = atob(b), n = s.length, u = new Uint8Array(n), i; for (i = 0; i < n; i++) u[i] = s.charCodeAt(i); return u; }
  function bkStreamBytes(inputBytes, stream) {
    var w = stream.writable.getWriter(); w.write(inputBytes); w.close();
    return new Response(stream.readable).arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }
  function bkPack(text) {
    text = String(text);
    if (typeof CompressionStream !== 'function' || typeof Response !== 'function') return Promise.resolve(text);
    try {
      return bkStreamBytes(new TextEncoder().encode(text), new CompressionStream('gzip')).then(function (z) {
        var out = JSON.stringify({ dpbz: 'gz64', n: text.length, z: bkB64(z) });
        return out.length < text.length ? out : text;
      }, function () { return text; });
    } catch (e) { return Promise.resolve(text); }
  }
  function bkUnpack(text) {
    var w = null; try { var t = String(text); if (t.indexOf('"dpbz"') > -1 && t.indexOf('"dpbz"') < 40) w = JSON.parse(t); } catch (e) {}
    if (!w || w.dpbz !== 'gz64' || !w.z) return Promise.resolve(text);
    if (typeof DecompressionStream !== 'function') return Promise.reject(new Error('\u0627\u0644\u0645\u062a\u0635\u0641\u062d \u0645\u0634 \u0628\u064a\u062f\u0639\u0645 \u0641\u0643 \u0627\u0644\u0636\u063a\u0637 \u0644\u0646\u0633\u062e\u0629 Drive'));
    return bkStreamBytes(bkFromB64(w.z), new DecompressionStream('gzip')).then(function (u) { return new TextDecoder().decode(u); });
  }
  window.DPB_FS2.bkPack = bkPack; window.DPB_FS2.bkUnpack = bkUnpack;
  function bkDriveUpload(obj) {
    if (!driveOn()) return Promise.resolve({ skipped: true });
    obj = bkSlim(obj); var upT0 = Date.now(), upMB = '?', fullStr = JSON.stringify(obj);
    var wait = Promise.resolve(); for (var i = 0; i < 20 && typeof window.DPB_gsCall !== 'function'; i++) wait = wait.then(function () { return new Promise(function (r) { setTimeout(r, 100); }); });
    return wait.then(function () {
      if (typeof window.DPB_gsCall !== 'function') return { ok: false, error: 'الاتصال بالسحابة غير جاهز' };
      return bkPack(fullStr).then(function (packed) {
        fullStr = null; upMB = (bytesOf(packed) / 1048576).toFixed(2);
        return (typeof window.DPB_backupPost === 'function' ? window.DPB_backupPost({ kind: 'firebase', ns: nsName(), content: packed, shareWith: driveEmail(), createdAt: obj && obj.savedAt }, 120000) : window.DPB_gsCall('saveBackup', { kind: 'firebase', ns: nsName(), content: packed, shareWith: driveEmail(), createdAt: obj && obj.savedAt }, 120000));
      });
    }).then(function (res) {
      if (res && res.ok) { lsSet('dpb_fs2_bk_drive', JSON.stringify({ ok: true, mb: upMB, sec: Math.round((Date.now() - upT0) / 1000), t: Date.now(), url: res.url || '', owner: res.owner || '', sharedWith: res.sharedWith || '', shareError: res.shareError || '' })); try { localStorage.removeItem('dpb_fs2_bk_drive_pending'); } catch (e) {} return { ok: true }; }
      var err = driveErr(res); lsSet('dpb_fs2_bk_drive', JSON.stringify({ ok: false, mb: upMB, sec: Math.round((Date.now() - upT0) / 1000), t: Date.now(), error: err })); lsSet('dpb_fs2_bk_drive_pending', '1'); return { ok: false, error: err };
    }).catch(function (e) { var err = String((e && e.message) || e || 'فشل'); lsSet('dpb_fs2_bk_drive', JSON.stringify({ ok: false, mb: upMB, sec: Math.round((Date.now() - upT0) / 1000), t: Date.now(), error: err })); lsSet('dpb_fs2_bk_drive_pending', '1'); return { ok: false, error: err }; });
  }
  // v169: shows WHICH link the upload used (read from the link field, nothing is hard-coded here): its length and last characters, or that the field is empty
  function bkUrlNote() {
    var u = ''; try { u = String(localStorage.getItem('DPB_BACKUP_URL_V1') || ''); } catch (e) {}
    if (!u.trim()) return '\nرابط الرفع: الخانة فاضية (بيستخدم الرابط الافتراضي الداخلي)';
    var t = u.trim(), odd = (u !== t || /\s/.test(t)) ? ' ⚠ فيه مسافات' : '';
    return '\nرابط الرفع: ' + t.length + ' حرف، آخره ' + t.slice(-16) + odd;
  }
  function bkDriveLine() {
    var x = null; try { x = JSON.parse(ls('dpb_fs2_bk_drive', 'null')); } catch (e) {}
    if (!driveOn()) return '\nGoogle Drive: متوقف';
    if (!x) return '\nGoogle Drive: لسه ما اترفعش';
    var t = new Date(x.t).toLocaleTimeString('ar-EG');
    if (!x.ok) return '\nGoogle Drive: ✖ ' + x.error + ' (' + t + ')' + (x.mb ? '\nحجم المرفوع: ' + x.mb + ' MB بعد ' + x.sec + ' ث' : '') + bkUrlNote();
    return '\nGoogle Drive: ✔ نجح الساعة ' + t + (x.mb ? ' (' + x.mb + ' MB في ' + x.sec + ' ث)' : '') + (x.sharedWith ? ' — مشاركة مع ' + x.sharedWith + ' ✔' : (x.shareError ? ' — ⚠ تعذّرت المشاركة: ' + x.shareError : (driveEmail() ? '' : ' — اكتب إيميل Drive عشان النسخة تظهر عنده'))) + (x.owner ? '\nالملف محفوظ في حساب: ' + x.owner : '');
  }

  /* ---- automatic backup: every N minutes, only when the data changed since the last one (each run reads every document once, so it is meant for ONE device - the admin's) ---- */
  var bkBusy = false, bkLastVer = null;
  function bkAdminDev() { try { return localStorage.getItem('DPB_ADMIN_DEVICE_V1') === '1' || localStorage.getItem('dpb_fs2_bk_admin') === '1'; } catch (e) { return false; } }
  function bkAutoTick(force) {
    if (!on() || (!force && (ls('dpb_fs2_bk_auto', 'off') !== 'on' || !bkAdminDev())) || bkBusy) return Promise.resolve('skip');
    var min = Number(ls('dpb_fs2_bk_min', '30')) || 30, last = Number(ls('dpb_fs2_bk_last', '0')) || 0, since = Date.now() - last;
    if (!force) {
      // v161: the backup is made from the phone's own copy (no reads), so the gap is just the minutes the user chose. Only a fallback to the server is rate-limited (see bkRead).
      if (since < min * 60000) return Promise.resolve('skip');
      if (Date.now() < Number(ls('dpb_fs2_bk_quota_until', '0'))) return Promise.resolve('skip');
      // with a project open the listener tells us when something changed (own edits AND other devices' edits); with no project open nothing can tell,
      // so the namespace is looked at no more than once an hour (every look reads each document once)
      if (curStore()) { if (bkLastVer === version) return Promise.resolve('skip'); }
      else if (since < Math.max(min, 60) * 60000) return Promise.resolve('skip');
    }
    bkBusy = true; bkAutoRun = !force; var ver = version;
    return bkBackupNow().then(function (r) {
      bkLastVer = ver; lsSet('dpb_fs2_bk_last', String(Date.now()));
      if (!r.changed) {
        if (driveOn() && ls('dpb_fs2_bk_drive_pending', '')) return bkGet('current').then(function (c) { return c ? bkDriveUpload(c) : null; }).then(function () { return 'same'; });
        return 'same';
      }
      return bkPublish(r).then(function (x) { return 'saved:' + x[0]; });
    }).catch(function (e) {
      if (e && e.code === 'bk-skip') { bkLastVer = ver; lsSet('dpb_fs2_bk_last', String(Date.now())); return 'skip-server'; }   // v161: phone copy not usable and the server was read recently: wait for the next change / interval instead of retrying every minute
      if (/resource-exhausted|quota/i.test(String(e && (e.code || e.message || e)))) lsSet('dpb_fs2_bk_quota_until', String(Date.now() + 3 * 3600000)); return 'error';
    }).then(function (x) { bkBusy = false; bkAutoRun = false; bkPaint(); return x; });
  }
  if (typeof setInterval === 'function') setInterval(function () { bkAutoTick(false); }, 60000);
  // Android freezes the page's timers while the app is in the background: when the admin comes back, check right away instead of waiting for the next minute
  try { document.addEventListener('visibilitychange', function () { if (!document.hidden) setTimeout(function () { bkAutoTick(false); }, 4000); }); } catch (e) {}
  window.DPB_FS2.autoTick = bkAutoTick;
  window.DPB_FS2.status = function () { return { on: on(), ns: nsName(), connected: !!curStore(), failed: !!failedAt, err: String(lastErr || '') }; };
  window.DPB_FS2.backupNow = bkBackupNow; window.DPB_FS2.saveExternal = bkSaveExternal;

  /* ---- Admin card (Admin > sync tab): on/off, live status, counts, import ---- */
  function paintState() {
    var el = document.getElementById('dpbFs2State'); if (!el) return;
    if (!on()) { el.textContent = 'الحالة: متقفلة (النظام القديم شغّال)'; return; }
    var st2 = curStore();
    if (st2) { var c = st2.counts(), t = procs().map(function (n) { var k = Object.keys(c).filter(function (x) { return CORE.slug(x) === CORE.slug(n); })[0]; return n + ': ' + (k ? c[k] : 0); }).join(' | '); el.textContent = 'الحالة: شغّالة ومتصلة ✅ — منفّذ دلوقتي: ' + t; return; }
    el.textContent = failedAt ? ('الحالة: شغّالة لكن مش متصلة ❌ — ' + lastErr) : 'الحالة: بتتصل بـ Firestore…';
  }
  function mountCard() {
    var host = document.getElementById('dpbBackupScreenHost');
    if (!host || document.getElementById('dpbFs2Card')) return;
    var c = document.createElement('section'); c.className = 'dpbAdminCard'; c.id = 'dpbFs2Card';
    c.innerHTML = '<h3>🧩 الطبقة الجديدة (كل الخرائط)</h3>' +
      '<div class="hint">مصدر واحد للخلايا في Firestore. مفيش حاجة بتتغيّر إلا لما تشغّلها. بتتكتب في مكان جديد منفصل عن بياناتك القديمة، وإيقافها بيرجّعك للنظام القديم فورًا.</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px"><button type="button" class="dpbAdminBtn" id="dpbFs2Backup">💾 نسخة احتياطية الآن</button><button type="button" class="dpbAdminBtn" id="dpbFs2Ext">📤 حفظ برّه التطبيق</button><button type="button" class="dpbAdminBtn" id="dpbFs2Dir" style="display:none">📁 مكان الحفظ</button></div>' +
      '<label class="hint" style="display:flex;gap:8px;align-items:center;margin-top:8px"><input type="checkbox" id="dpbFs2Auto"> نسخة تلقائية كل <select id="dpbFs2AutoMin"><option value="5">5</option><option value="15">15</option><option value="30">30</option><option value="60">60</option><option value="120">120</option></select> دقيقة (لو في تغيير) — على جهاز الأدمن بس</label>' +
      '<label class="hint" style="display:flex;gap:8px;align-items:center;margin-top:8px"><input type="checkbox" id="dpbFs2Drive"> ☁️ رفع نسخة على Google Drive</label>' +
      '<input type="url" id="dpbFs2Url" autocomplete="off" placeholder="رابط سكربت النسخ الاحتياطي (ينتهي بـ /exec)" style="width:100%;box-sizing:border-box;margin-top:6px;padding:9px 10px;border-radius:8px;border:1px solid #567;background:#0d1b2e;color:#fff;direction:ltr;text-align:left">' +
      '<input type="email" id="dpbFs2Email" inputmode="email" autocomplete="off" placeholder="إيميل Google Drive اللي تترفع عليه النسخة" style="width:100%;box-sizing:border-box;margin-top:6px;padding:9px 10px;border-radius:8px;border:1px solid #567;background:#0d1b2e;color:#fff;direction:ltr;text-align:left">' +
      '<details style="margin-top:10px"><summary class="hint" style="cursor:pointer">⚙️ أدوات متقدمة (نادرًا ما تحتاجها)</summary>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px"><button type="button" class="dpbAdminBtn" id="dpbFs2ImportXl">📥 استيراد قيم الإكسل المرفوع (إضافة بس)</button><button type="button" class="dpbAdminBtn" id="dpbFs2CheckXl">🔎 فحص قيم الإكسل</button></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;align-items:center"><select id="dpbFs2RestoreSrc" class="dpbAdminBtn"><option value="current">استعادة من: الحالية</option><option value="previous">استعادة من: السابقة</option><option value="file">استعادة من: ملف</option></select><button type="button" class="dpbAdminBtn" id="dpbFs2Restore">♻️ استعادة</button><input type="file" id="dpbFs2RestoreFile" accept=".json,application/json" style="display:none"></div>' +
      '</details>' +
      '<div class="hint" id="dpbFs2DriveInfo" style="margin-top:8px;line-height:1.9"></div>' +
      '<div class="hint" id="dpbFs2BkInfo" style="margin-top:8px">النسخ: بيحتفظ بنسختين بس (حالية + سابقة).</div>' +
      '<div class="hint" id="dpbFs2State" style="margin-top:8px"></div>' +
      '<div class="hint" id="dpbFs2Net" style="margin-top:8px;line-height:1.9"></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px"><button type="button" class="dpbAdminBtn" id="dpbFs2NetTest">🩺 فحص الاتصال + إعادة فتح القناة</button><button type="button" class="dpbAdminBtn" id="dpbFs2NetCopy">📋 نسخ تقرير الاتصال</button></div>' +
      '<label class="hint" style="display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap">نوع الاتصال (بعد التغيير اقفل التطبيق وافتحه): <select id="dpbFs2Transport"><option value="lp">قنوات متقطعة (الحالي)</option><option value="auto">تلقائي</option><option value="ws">مباشر</option></select></label>' +
      '<pre id="dpbFs2NetLog" style="margin:8px 0 0;max-height:210px;overflow:auto;white-space:pre-wrap;direction:ltr;text-align:left;font-size:11px;line-height:1.5;background:#091827;border:1px solid #243b57;border-radius:10px;padding:8px"></pre>' +
      '<div class="hint" id="dpbFs2Msg" style="margin-top:6px"></div>';
    var old = document.getElementById('dpbFsCard');
    if (old && old.parentNode === host) host.insertBefore(c, old.nextSibling); else host.appendChild(c);
    function paint() { paintState(); if (on() && !store) getStore().catch(function () {}); }
    // ---- connection report (live) ----
    function hms(t) { var d = new Date(t); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2); }
    function netText() {
      var n = window.__dpbFs2Net ? window.__dpbFs2Net() : {}, pr = n.probe ? ('قراءة ' + n.probe.read + ' / كتابة-مباشرة ' + (n.probe.rest || '-') + ' / كتابة-عادية ' + n.probe.write + ' (من ' + Math.round(n.probeAgeMs / 1000) + ' ث)') : 'لسه ماتفحصش';
      return 'الاتصال: ' + (n.online ? 'النت شغّال' : 'النت مقطوع') + ' — الـlistener: ' + (n.connected ? 'شغّال ✅' : 'واقع ❌' + (n.err ? ' (' + n.err + ')' : '')) +
        '\nكتابات مستنية تأكيد السيرفر: ' + (n.pending || 0) + (n.sinceMs ? ' (من ' + Math.round(n.sinceMs / 1000) + ' ث)' : '') + ' — سجلات لسه مش مؤكدة: ' + (n.unacked || 0) +
        '\nآخر فحص: ' + pr + ' — مرات إعادة فتح القناة: ' + (n.bounces || 0) + ' — نوع الاتصال: ' + (n.transport || '') +
        '\nإرسال بالطريق التاني: نجح ' + (n.rescued || 0) + ' مرة' + (n.rescueErr ? ' — آخر فشل: ' + n.rescueErr : '');
    }
    function logText() {
      var L = window.__dpbFs2Diag ? window.__dpbFs2Diag() : [];
      return L.slice(-25).reverse().map(function (e) { return hms(e.t) + '  ' + e.k + '  ' + e.x; }).join('\n') || '(مفيش أحداث لسه)';
    }
    function paintNet() { var a = document.getElementById('dpbFs2Net'), b = document.getElementById('dpbFs2NetLog'); if (!a || !b) return; a.textContent = netText(); a.style.whiteSpace = 'pre-wrap'; b.textContent = logText(); }
    paintNet(); var netTimer = setInterval(function () { if (!document.getElementById('dpbFs2Net')) { clearInterval(netTimer); return; } paintNet(); }, 3000);
    var tsel = document.getElementById('dpbFs2Transport'); tsel.value = ls('dpb_fs2_transport', 'lp');
    tsel.addEventListener('change', function () { try { localStorage.setItem('dpb_fs2_transport', tsel.value); } catch (e) {} dlog('transport-set', tsel.value); document.getElementById('dpbFs2Msg').textContent = 'اتحفظ نوع الاتصال — اقفل التطبيق وافتحه تاني عشان يشتغل.'; paintNet(); });
    document.getElementById('dpbFs2NetTest').addEventListener('click', function () {
      var m = document.getElementById('dpbFs2Msg'); m.textContent = 'بفحص الاتصال…';
      var W = window.__dpbFs2W = window.__dpbFs2W || {}; probeAt = 0;
      (window.__dpbFs2Bounce ? window.__dpbFs2Bounce() : Promise.resolve()).then(function () { return runProbe(); }).then(function () { var p = W.probe || {}; m.textContent = 'نتيجة الفحص: قراءة ' + p.read + ' / كتابة ' + p.write; paintNet(); }, function (e) { m.textContent = 'فشل الفحص: ' + permHint(e); });
    });
    document.getElementById('dpbFs2NetCopy').addEventListener('click', function () {
      var txt = netText() + '\n\n' + logText(), m = document.getElementById('dpbFs2Msg');
      try { navigator.clipboard.writeText(txt).then(function () { m.textContent = 'اتنسخ التقرير ✅'; }, function () { m.textContent = 'مقدرتش أنسخ — صوّر الشاشة.'; }); } catch (e) { m.textContent = 'مقدرتش أنسخ — صوّر الشاشة.'; }
    });
    document.getElementById('dpbFs2CheckXl').addEventListener('click', function () {
      var msg = document.getElementById('dpbFs2Msg');
      var src = typeof window.__dpbExcelUnitCells === 'function' ? window.__dpbExcelUnitCells() : [];
      if (!src.length) { msg.textContent = 'مفيش إكسل تنفيذ متطبّق على الجهاز ده.'; return; }
      var enc = function (r, c) { try { return window.XLSX.utils.encode_cell({ r: r, c: c }); } catch (e) { return 'r' + r + 'c' + c; } };
      var lines = src.map(function (x) {
        var bad = x.bad.map(function (b) { return enc(b.r, b.c) + ' = "' + b.v + '"'; }).join('، ');
        return x.name + ': ' + x.cells.length + ' خلية منفّذة من ' + x.units + (x.bad.length ? ' — قيم غلط بتتجاهل (' + x.bad.length + '): ' + bad : ' — مفيش قيم غلط ✅');
      });
      msg.textContent = lines.join('\n'); msg.style.whiteSpace = 'pre-wrap';
      if (typeof alert === 'function') alert('فحص قيم الإكسل:\n\n' + lines.join('\n') + '\n\nلتصحيحها: امسح القيمة الغلط من الإكسل نفسه وارفعه تاني.');
    });
    document.getElementById('dpbFs2ImportXl').addEventListener('click', function () {
      var msg = document.getElementById('dpbFs2Msg');
      if (!on()) { msg.textContent = 'شغّل الطبقة الجديدة الأول.'; return; }
      msg.textContent = 'بقرا الإكسل…';
      importExcel(false).then(function (r) {
        var line = r.map(function (x) { return x.name + ': في الإكسل ' + x.excel + ' خلية منفّذة من ' + x.units + ' — موجود في Firestore ' + x.existing + '، هيتضاف ' + x.add + (x.bad ? '، خلايا قيمتها غلط (هتتجاهل) ' + x.bad : ''); }).join('\n');
        if (!confirm('استيراد قيم الإكسل المرفوع (بيضيف بس، مبيغيّرش ولا بيشيل أي حاجة موجودة):\n\n' + line + '\n\nنكمّل؟')) { msg.textContent = 'اتلغت.'; return; }
        msg.textContent = 'بكتب…';
        return importExcel(true).then(function () { msg.textContent = 'تم استيراد قيم الإكسل ✅'; paintState(); try { if (typeof window.__dpbFetchLiveGrid === 'function') window.__dpbFetchLiveGrid(); } catch (e) {} });
      }).catch(function (e) { msg.textContent = 'فشل: ' + permHint(e); });
    });
    var $ = function (i) { return document.getElementById(i); }, say = function (t) { $('dpbFs2Msg').textContent = t; };
    var paintBk = bkPaint, where = BK_WHERE;
    $('dpbFs2Dir').addEventListener('click', function () { if (!window.DPB_NATIVE_BRIDGE && !window.showDirectoryPicker && capFs()) { say('📁 على الموبايل النسخ بتتحفظ تلقائي في مجلد Documents/DPB (ملفين بس بيتكتبوا فوق بعض). اختيار مجلد تاني محتاج إضافة أندرويد مخصوصة — مش متركّبة في النسخة دي.'); return; } bkPickFolder().then(function () { say('📁 اتحدد مكان الحفظ. النسخ الجاية بتتكتب فيه ملفين بس.'); }).catch(function (e) { say(e && e.name === 'AbortError' ? 'اتلغى اختيار المكان.' : 'فشل: ' + permHint(e)); }); });
    var uu = $('dpbFs2Url'); uu.value = ls('DPB_BACKUP_URL_V1', '');
    uu.addEventListener('change', function () {
      var v = uu.value.trim();
      if (v && !/^https:\/\/script\.google\.com\/.+\/exec$/.test(v)) { say('⚠ الرابط لازم يبدأ بـ https://script.google.com وينتهي بـ /exec'); return; }
      lsSet('DPB_BACKUP_URL_V1', v); say(v ? '🔗 اتحفظ رابط سكربت النسخ الاحتياطي المنفصل.' : '🔗 اتمسح — هيرجع للسكربت القديم.'); paintBk();
    });
    var dv = $('dpbFs2Drive'), em = $('dpbFs2Email'); dv.checked = driveOn(); em.value = driveEmail();
    dv.addEventListener('change', function () { lsSet('DPB_BACKUP_DRIVE_V1', dv.checked ? 'on' : 'off'); say(dv.checked ? 'رفع Drive شغّال.' : 'رفع Drive متوقف.'); paintBk(); });
    em.addEventListener('change', function () {
      var v = em.value.trim().toLowerCase();
      if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { say('⚠ الإيميل غير صالح'); return; }
      lsSet('DPB_BACKUP_DRIVE_EMAIL_V1', v); em.value = v; say(v ? '📧 اتحفظ الإيميل — بشارك النسخة معاه…' : '📧 اتمسح الإيميل');
      bkGet('current').then(function (o) { return o && driveOn() ? bkDriveUpload(o) : null; }).then(function (d) { if (d) say(d.ok ? '📧 تم ☁️' : '⚠ Drive: ' + d.error); paintBk(); });
    });
    var au = $('dpbFs2Auto'), am = $('dpbFs2AutoMin'); au.checked = ls('dpb_fs2_bk_auto', 'off') === 'on'; am.value = ls('dpb_fs2_bk_min', '30');
    au.addEventListener('change', function () { lsSet('dpb_fs2_bk_auto', au.checked ? 'on' : 'off'); if (au.checked) lsSet('dpb_fs2_bk_admin', '1'); say(au.checked ? 'النسخ التلقائي شغّال: كل ' + am.value + ' دقيقة لو في تغيير.' : 'النسخ التلقائي اتقفل.'); });
    am.addEventListener('change', function () { lsSet('dpb_fs2_bk_min', am.value); });
    $('dpbFs2Backup').addEventListener('click', function () {
      if (!on()) { say('شغّل الطبقة الجديدة الأول.'); return; }
      say('بقرا البيانات من نسخة الجهاز…');
      bkBackupNow().then(function (r) {
        if (!r.changed) {
          if (driveOn() && ls('dpb_fs2_bk_drive_pending', '')) return bkGet('current').then(function (c) { return c ? bkDriveUpload(c) : { ok: false, error: 'مفيش نسخة' }; }).then(function (d) { say(d.ok ? 'مفيش تغيير، بس رفعت النسخة الحالية على Drive ☁️.' : '⚠ Drive: ' + d.error); paintBk(); });
          say('مفيش تغيير من آخر نسخة، فالحالية والسابقة زي ما هم.'); paintBk(); return;
        }
        return bkPublish(r).then(function (x) {
          var w = x[0], d = x[1];
          var ph = w === 'fail' ? ' ⚠ تعذّرت الكتابة في المجلد، دوس 📤.' : (w !== 'none' ? ' و' + where[w].replace(/^\S+ /, '') + '.' : '. دوس 📤 لو عاوز تحفظها برّه التطبيق.');
          var dr = d.skipped ? '' : (d.ok ? ' ☁️ ورُفعت على Google Drive.' : ' ⚠ Drive: ' + d.error);
          say('✅ اتحفظت النسخة جوّا التطبيق' + ph + dr); paintBk();
        });
      }).catch(function (e) { say('فشل: ' + permHint(e)); });
    });
    $('dpbFs2Ext').addEventListener('click', function () {
      Promise.all([bkGet('current'), bkGet('previous')]).then(function (r) {
        if (!r[0]) { say('مفيش نسخة لسه، دوس 💾 الأول.'); return; }
        return bkSaveExternal(r[0], r[1], true).then(function (w) { bkNoteExt(w); say('✅ اتحفظت ' + (where[w] || '') + '.'); paintBk(); });
      }).catch(function (e) { say(e && e.name === 'AbortError' ? 'اتلغى.' : 'فشل: ' + permHint(e)); });
    });
    function doRestore(text) {
      return bkRestore(text, function (s) {
        var n = s.diff.n, when = s.fileTime ? new Date(s.fileTime).toLocaleString('ar-EG') : '؟';
        return confirm('استعادة من نسخة ' + when + (s.fileNs && s.fileNs !== s.ns ? '\n⚠️ النسخة دي من مساحة "' + s.fileNs + '" والحالية "' + s.ns + '"' : '') +
          '\n\nFirebase هيبقى مطابق للنسخة بالظبط:\nهيتضاف ' + n.add + ' مستند، هيتعدّل ' + n.change + '، هيتشال ' + n.remove + ' (اللي اتسجّل بعد النسخة دي بيضيع).' +
          '\n\nقبل الكتابة هتنزّل نسخة أمان من الوضع الحالي.\n\nنكمّل؟');
      }, function (done, total) { say('بكتب… ' + done + ' / ' + total); }).then(function (r) {
        if (r.same) { say('النسخة مطابقة للي في Firebase، مفيش حاجة اتغيّرت.'); return; }
        if (!r.applied) { say('اتلغت (مفيش حاجة اتكتبت).'); return; }
        say('تمت الاستعادة ✅ (أضاف ' + r.diff.n.add + '، عدّل ' + r.diff.n.change + '، شال ' + r.diff.n.remove + ') — اقفل التطبيق وافتحه تاني.'); paintState();
        try { if (typeof window.__dpbFetchLiveGrid === 'function') window.__dpbFetchLiveGrid(); } catch (e) {}
      }).catch(function (e) { say('فشل: ' + permHint(e)); });
    }
    var rf = $('dpbFs2RestoreFile');
    $('dpbFs2Restore').addEventListener('click', function () {
      if (!on()) { say('شغّل الطبقة الجديدة الأول.'); return; }
      var src = $('dpbFs2RestoreSrc').value;
      if (src === 'file') { rf.value = ''; rf.click(); return; }
      bkGet(src).then(function (o) { if (!o) { say(src === 'current' ? 'مفيش نسخة حالية لسه.' : 'مفيش نسخة سابقة لسه (بتظهر بعد تاني نسخة).'); return; } return doRestore(JSON.stringify(o)); }).catch(function (e) { say('فشل: ' + permHint(e)); });
    });
    rf.addEventListener('change', function () {
      var f = rf.files && rf.files[0]; if (!f) return;
      say('بقرا الملف…'); f.text().then(doRestore).catch(function (e) { say('فشل: ' + permHint(e)); });
    });
    paintBk();
    paint();
  }
  function bootCard() { mountCard(); try { new MutationObserver(mountCard).observe(document.documentElement, { childList: true, subtree: true }); } catch (e) {} }
  if (typeof document !== 'undefined') { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootCard); else bootCard(); }
  // a different project was opened (or the first one finished opening): stop the old listener, start the new project's, and refresh the maps
  var watchPid = pidS();
  function onProjectChange() {
    var now = pidS(); if (now === watchPid) return; watchPid = now;
    dropStore(); try { paintState(); } catch (e) {}
    if (now && on()) getStore().then(function () { try { if (typeof window.__dpbFetchLiveGrid === 'function') window.__dpbFetchLiveGrid(); } catch (e) {} }).catch(function () {});
  }
  try { window.addEventListener('dpb-project-switched', onProjectChange); setInterval(onProjectChange, 1000); } catch (e) {}
  if (on()) setTimeout(function () { getStore().catch(function () {}); }, 1500); // connect early so a problem shows in the card instead of on the first tap
})();
