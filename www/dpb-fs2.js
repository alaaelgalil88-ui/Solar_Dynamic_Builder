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
  function ls(k, d) { try { var v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } }
  // switch from the address bar: ...index.html?fs2=on  /  ?fs2=off
  try { var m = /[?&]fs2=(on|off)/.exec(location.search); if (m) localStorage.setItem(LS.mode, m[1]); } catch (e) {}
  // local emulator: ?emu=on / ?emu=off in the address bar (only honoured on localhost / 127.0.0.1, so the live app can never be pointed at it)
  var EMU_HOST = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  try { var me = /[?&]emu=(on|off)/.exec(location.search); if (me && EMU_HOST) localStorage.setItem('dpb_fs2_emu', me[1]); } catch (e) {}
  function emu() { return EMU_HOST && ls('dpb_fs2_emu', 'on') === 'on'; }   // on localhost the emulator is the default
  // default: ON as soon as this device has a Firebase config + the app's Email/Password account saved (nothing to switch by hand).
  // An explicit "off" (the toggle in the card, or ?fs2=off) still wins as a kill switch.
  function hasCreds() { try { var c = JSON.parse(ls(LS.cfg, 'null')), a = JSON.parse(ls(LS.auth, 'null')); return !!(c && c.projectId && a && a.email && a.password); } catch (e) { return false; } }
  function on() { var m = ls(LS.mode, null); return m === 'on' || emu() || (m === null && hasCreds()); }
  function procs() { return ls(LS.procs, 'Ramming,Saddle,Bearing,Torque Tube,Modules').split(',').map(function (s) { return s.trim(); }).filter(Boolean); }
  function mine(name) { var s = CORE.slug(name); return procs().some(function (p) { return CORE.slug(p) === s; }); }
  // a record belongs to this layer only if its process is a map process AND it points at a map cell; anything else (e.g. a tracker-level entry) goes down untouched
  function isCell(r) { return !!r && mine(r.process) && r.r1 != null && r.c1 != null; }
  // the app tells us which processes have a map (so a new project needs no change here)
  function setProcs(list) { try { var s = (list || []).map(function (x) { return String(x == null ? '' : x).trim(); }).filter(Boolean).join(','); if (s && s !== ls(LS.procs, '')) localStorage.setItem(LS.procs, s); } catch (e) {} }
  function nsName() { return String(ls(LS.ns, 'test')).replace(/[^A-Za-z0-9_\-]/g, '_'); }
  function jsonRes(o) { return new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } }); }
  function clean(o) { return JSON.parse(JSON.stringify(o)); }
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

  function makeAdapter() {
    var conf; try { conf = JSON.parse(ls(LS.cfg, 'null')); } catch (e) { conf = null; }
    if (emu()) conf = { apiKey: 'demo', projectId: 'demo-no-project', appId: 'demo' };   // emulator needs no real config
    if (!conf || !conf.projectId) return Promise.reject(new Error('مفيش Firebase config'));
    return Promise.all([import(SDK + 'firebase-app.js'), import(SDK + 'firebase-firestore.js'), import(SDK + 'firebase-auth.js')]).then(function (m) {
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
        try { db = fs.initializeFirestore(app, { localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }) }); } catch (e) { db = fs.getFirestore(app); }
      }
      var auth = authM.getAuth(app), ac; try { ac = JSON.parse(ls(LS.auth, 'null')); } catch (e) { ac = null; }
      var ready = emu() ? Promise.resolve() : (ac && ac.email && ac.password) ? authM.signInWithEmailAndPassword(auth, ac.email, ac.password) : (auth.currentUser ? Promise.resolve() : authM.signInAnonymously(auth));
      function dref(p) { return fs.doc.apply(null, [db].concat(p.split('/'))); }
      return ready.then(function () {
        return {
          // server clock: write a tiny doc with serverTimestamp and read it back from the server (dpb2/{ns}/kv is already allowed by the rules)
          serverNow: function () {
            var dev = ls('dpb_fs2_dev', ''); if (!dev) { dev = Math.random().toString(36).slice(2, 10); try { localStorage.setItem('dpb_fs2_dev', dev); } catch (e) {} }
            var r = dref('dpb2/' + nsName() + '/kv/clock-' + dev);
            return fs.setDoc(r, { t: fs.serverTimestamp() }).then(function () { return fs.getDocFromServer(r); }).then(function (x) { var v = x.data() && x.data().t; return v && v.toMillis ? v.toMillis() : Promise.reject(new Error('no server time')); });
          },
          get: function (path) { return fs.getDoc(dref(path)).then(function (x) { return x.exists() ? x.data() : null; }); },
          listen: function (path, cb) { fs.onSnapshot(fs.collection.apply(null, [db].concat(path.split('/'))), function (q) { cb(q.docs.map(function (d) { return { id: d.id, data: d.data() }; })); }, function (e) { console.warn('dpb-fs2 listen', e); cb(null, e); }); },
          // every document of a collection, read from the SERVER (never the local cache), so a backup is exactly what Firestore holds
          list: function (path) { var col = fs.collection.apply(null, [db].concat(path.split('/'))); return (fs.getDocsFromServer ? fs.getDocsFromServer(col) : fs.getDocs(col)).then(function (q) { return q.docs.map(function (d) { return { id: d.id, data: d.data() }; }); }); },
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
  var store = null, creating = null, failedAt = 0, lastErr = '', version = 0, notifyT = null, pullT = null;
  function permHint(e) { var m = String(e && e.message || e || ''); return /permission|insufficient/i.test(m) ? m + ' — قواعد Firebase لازم تسمح بالمسار dpb2/**' : m; }
  function startCreate() {
    if (creating) return creating;
    creating = (window.__DPB_FS2_ADAPTER ? Promise.resolve(window.__DPB_FS2_ADAPTER) : makeAdapter()).then(function (a) {
      var s = CORE.create(a, { ns: nsName(), offset: clockOff });
      s.onChange(function () { version++; clearTimeout(notifyT); notifyT = setTimeout(function () { try { if (typeof window.__dpbFetchLiveGrid === 'function') window.__dpbFetchLiveGrid(); } catch (e) {} paintState(); }, 300); clearTimeout(pullT); pullT = setTimeout(function () { try { if (window.DPB_CLOUD_PRODUCTION && window.DPB_CLOUD_PRODUCTION.cloudPull) window.DPB_CLOUD_PRODUCTION.cloudPull(); } catch (e) {} }, 1500); });
      return s.ready.then(function () { store = s; failedAt = 0; lastErr = ''; s.ensureEpoch(); paintState(); syncClock(a); setTimeout(function () { autoImport(s); }, 0); return s; });
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
  var KV_CHUNK = 600000;
  function kvMine(key) { return /^(mapcat|mapsnap_|xlfile_)/.test(String(key || '')); }
  function kvDoc(key) { return 'dpb2/' + nsName() + '/kv/' + String(key).replace(/[^A-Za-z0-9_\-]/g, '_'); }
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
  var U_KEY = 'users';
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
      if (!list) return null;
      var find = function (n) { n = String(n || '').trim().toLowerCase(); for (var i = 0; i < list.length; i++) if (uName(list[i]).toLowerCase() === n) return i; return -1; };
      switch (body.action) {
        case 'login':
          var i = find(body.username); if (i < 0) return { ok: false, error: 'wrong' };
          var u = list[i];
          return pinHash(uName(u), body.password).then(function (h) {
            if (!u.passHash || u.passHash !== h || !isActive(u)) return { ok: false, error: 'wrong' };
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
  function usersHandle(body, input, init) {
    return getStore().then(function (s) { return usersOp(s.adapter, body); }).then(function (r) { return r ? jsonRes(r) : prevFetch(input, init); }, function () { return prevFetch(input, init); });
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
        })).then(function (list) { return getStore().then(function (s) { return usersSave(s.adapter, list); }).then(function () { return { ok: true, count: list.length }; }); });
      });
  }
  function usersCount() { return getStore().then(function (s) { return usersLoad(s.adapter); }).then(function (l) { return l ? l.length : 0; }); }
  // connection check for the admin card: forget a failed/old connection and connect again, return how long it took
  function resetStore() { store = null; creating = null; failedAt = 0; lastErr = ''; }
  function testConn() { var t0 = Date.now(); resetStore(); return getStore().then(function () { return { ms: Date.now() - t0, ns: nsName(), auth: (function () { try { var a = JSON.parse(ls(LS.auth, 'null')); return a && a.email ? 'email' : (emu() ? 'emulator' : 'anon'); } catch (e) { return 'anon'; } })() }; }); }

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
        if ((body.action === 'kvGet' || body.action === 'kvPatch' || body.action === 'kvDelete') && kvMine(body.key)) return kvHandle(body);
        if (body.action === 'upsertMany') {
          var recs = body.records || [], m = recs.filter(isCell);
          if (!m.length) return prevFetch(input, init);
          var rest = recs.filter(function (r) { return !isCell(r); });
          return getStore().then(function (s) { return s.put(m.map(stamp), stagesOf(body)); }).then(function (pr) {
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
        if (USER_ACTIONS[body.action] === 1 && usersOn()) return usersHandle(body, input, init);
        return prevFetch(input, init);
      }
      if (q.action === 'getGrid' && mine(q.process || q.sheet)) { return Promise.all([getStore(), prevFetch(input, init).then(parse)]).then(function (r) { return jsonRes(overlayGrid(r[0], q.process || q.sheet, r[1])); }, fail); }
      if (q.action === 'getGridBatch') { return batchRes(input, init); }
      if (!q.action && !q.debug) { // records pull: the grouped processes come only from Firestore; the rest from the layer underneath when it answers
        return getStore().then(function (s) {
          var mineRecs = function () { return s.all().map(function (d) { return stamp(Object.assign({ recordId: d.id }, d)); }); };
          return prevFetch(input, init).then(parse).catch(function () { return null; }).then(function (o) {
            if (o && o.ok !== false && !o.unchanged && Array.isArray(o.data)) {
              o.data = o.data.filter(function (x) { return !isCell(x); }).concat(mineRecs());
              o.rev = String(o.rev || '') + '|f2:' + version; return jsonRes(o);
            }
            if (o && /^unauthorized/i.test(String(o.error || ''))) { try { window.DPB_tokenRejected(); } catch (e) {} } // keep the app's login prompt for the other processes
            return jsonRes({ ok: true, api: 99, data: localInSync().concat(mineRecs()) }); // no rev on purpose: the next pull is a full one
          });
        }, function () { return jsonRes({ ok: true, unchanged: true }); }); // layer unavailable: change nothing locally, do not hang
      }
      return prevFetch(input, init);
    } catch (e) { return prevFetch(input, init); }
  };
  // the record of one map cell exactly as Firestore holds it right now (null if the layer is off / not connected yet) - the map's Cell Details card reads this so it never waits for the next full pull
  function recordAt(process, r, c) {
    try { if (!store) return null; var s = CORE.slug(process); var hit = store.all().filter(function (d) { return CORE.slug(d.process) === s && Number(d.r1) === Number(r) && Number(d.c1) === Number(c); })[0]; return hit ? stamp(Object.assign({ recordId: hit.id }, hit)) : null; } catch (e) { return null; }
  }
  // Local read of one map process straight from the Firestore store (no Apps Script, no network).
  // owns(name): the layer is on and this process is one of its map processes. liveValues(name): Map "r|c" -> value (what the old getGrid reply held
  // after overlayGrid: done count for a progress cell, otherwise the process code), or null while the layer is not connected yet.
  function owns(name) { try { return on() && mine(name); } catch (e) { return false; } }
  function liveValues(name) {
    if (!owns(name) || !store) return null;
    var sl = CORE.slug(name), m = new Map();
    store.all().forEach(function (d) {
      if (CORE.slug(d.process) !== sl) return;
      var v = (d.done !== undefined && d.done !== null) ? Number(d.done) : Number(d.code);
      if (v && isFinite(v)) m.set(Number(d.r1) + '|' + Number(d.c1), v);
    });
    return m;
  }
  window.DPB_FS2 = { clockOffset: clockOff, owns: owns, liveValues: liveValues, getXlFile: getXlFile, on: on, recordAt: recordAt, setProcs: setProcs, setMode: function (v) { try { localStorage.setItem(LS.mode, v ? 'on' : 'off'); } catch (e) {} }, procs: procs, store: getStore, seedUsers: seedUsers, usersCount: usersCount, testConnection: testConn };

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
  /* ---- First-run import, automatic: a map process that has NO cells in Firestore yet and was never imported is filled once from the sheet
     (the sheet is the truth at that moment). A marker (kv key fs2imported) records which processes were handled, so a process that is
     later emptied on purpose is never refilled from a stale sheet. A tab that cannot be read is skipped and retried on the next open. ---- */
  var AI_KEY = 'fs2imported', aiRunning = false, aiFailed = {};
  function autoImport(s) {
    if (aiRunning || ls('dpb_fs2_autoimp', 'on') === 'off') return Promise.resolve();
    aiRunning = true; var a = s.adapter;
    return kvReadStr(a, AI_KEY).then(function (str) {
      var done = {}; try { (JSON.parse(str || '[]') || []).forEach(function (x) { done[CORE.slug(x)] = 1; }); } catch (e) {}
      var have = {}; s.all().forEach(function (d) { have[CORE.slug(d.process)] = 1; });
      var todo = procs().filter(function (p) { var k = CORE.slug(p); return !done[k] && !have[k] && !aiFailed[k]; });
      var keep = Object.keys(done); procs().forEach(function (p) { var k = CORE.slug(p); if (have[k] && !done[k]) keep.push(k); });
      if (!todo.length) { return keep.length > Object.keys(done).length ? kvWriteStr(a, AI_KEY, JSON.stringify(keep)) : null; }
      return Promise.all(todo.map(function (p) {
        return readGrid(p).then(function (g) { return { p: p, cells: cellsOf(g) }; }, function (e) { aiFailed[CORE.slug(p)] = 1; console.warn('dpb-fs2 auto-import skipped', p, e && e.message); return null; });
      })).then(function (gs) {
        gs = gs.filter(Boolean); if (!gs.length) return null;
        return gs.reduce(function (pr, x) { return pr.then(function () { return s.importProcess(x.p, x.cells, false); }); }, Promise.resolve()).then(function () {
          return kvWriteStr(a, AI_KEY, JSON.stringify(keep.concat(gs.map(function (x) { return CORE.slug(x.p); }))));
        }).then(function () { try { if (typeof window.__dpbFetchLiveGrid === 'function') window.__dpbFetchLiveGrid(); } catch (e) {} paintState(); });
      });
    }).catch(function (e) { console.warn('dpb-fs2 auto-import failed', e); }).then(function () { aiRunning = false; });
  }
  window.DPB_FS2.autoImport = function () { return getStore().then(autoImport); };

  window.DPB_FS2.backup = bkExport; window.DPB_FS2.restore = bkRestore;

  /* ---- Backup / restore: one JSON file with everything the layer keeps in Firestore (dpb2/{ns}/rows = map cells, dpb2/{ns}/kv = map catalog, map shapes, original Excel files).
     Restore = make Firestore equal to the file: preview first, a safety copy of the CURRENT state is downloaded before anything is written, writes go in size-limited batches,
     Excel-file parts are written before their pointer and removed after it, so a reader never sees a half file. ---- */
  var BK_COLLS = ['rows', 'kv'], BK_FORMAT = 'dpb-fs2-backup';
  function bkP(c) { return 'dpb2/' + nsName() + '/' + c; }
  function bkStamp() { var d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; }; return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()); }
  function stable(v) { if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']'; if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + stable(v[k]); }).join(',') + '}'; return JSON.stringify(v); }
  function bytesOf(s) { try { return new TextEncoder().encode(s).length; } catch (e) { return s.length * 2; } }
  function bkRead() {
    return getStore().then(function (s) {
      var a = s.adapter; if (!a || !a.list) throw new Error('الاتصال الحالي مش بيدعم قراءة كل المستندات');
      return Promise.all(BK_COLLS.map(function (c) { return a.list(bkP(c)); })).then(function (r) {
        var out = {}; BK_COLLS.forEach(function (c, i) { out[c] = {}; r[i].forEach(function (d) { out[c][d.id] = clean(d.data); }); }); return out;
      });
    });
  }
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
      Object.keys(A).forEach(function (id) { if (!Object.prototype.hasOwnProperty.call(B, id)) d.remove[c].push(id); });
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
  // reads Firebase; if nothing changed since the current copy, nothing rotates (so pressing it twice never wipes the real "previous")
  function bkBackupNow() {
    return bkRead().then(function (cur) {
      var obj = bkMake(cur);
      return bkGet('current').then(function (old) {
        if (bkSame(old, obj)) return bkGet('previous').then(function (pv) { return { changed: false, current: old, previous: pv }; });
        return Promise.resolve(old ? bkPut('previous', old) : null).then(function () { return bkPut('current', obj); }).then(function () { return bkGet('previous'); }).then(function (pv) { return { changed: true, current: obj, previous: pv }; });
      });
    });
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
  function bkWriteNative(nb, cur, prev) {
    function one(n, o) { return Promise.resolve(nb.writeBackupFile(n, JSON.stringify(o))).then(function (ok) { if (ok === false) throw new Error('الكتابة في مكان الحفظ فشلت'); }); }
    return one(BK_FILE.current, cur).then(function () { return prev ? one(BK_FILE.previous, prev) : null; });
  }
  function bkWriteCap(F, cur, prev) { // Capacitor: Documents/DPB/<fixed name>, overwritten each time
    function one(n, o) { return F.writeFile({ path: 'DPB/' + n, data: JSON.stringify(o), directory: 'DOCUMENTS', encoding: 'utf8', recursive: true }); }
    return one(BK_FILE.current, cur).then(function () { return prev ? one(BK_FILE.previous, prev) : null; });
  }
  // interactive=false (auto / right after a backup): only places that need no tap - the APK's chosen folder, Documents/DPB, a chosen desktop folder.
  // interactive=true (a tap on "save outside the app"): the same, then the folder picker / share sheet / a download.
  // Returns 'native' | 'documents' | 'folder' | 'share' | 'download' | 'none'. A failed write rejects.
  function bkSaveExternal(cur, prev, interactive) {
    var nb = window.DPB_NATIVE_BRIDGE, cf = capFs();
    function viaNative() {
      if (!nb) return Promise.resolve(null);
      return Promise.resolve(nb.hasFolder ? nb.hasFolder() : false).catch(function () { return false; }).then(function (has) {
        var ready = has ? Promise.resolve(true) : (interactive && nb.chooseFolder ? Promise.resolve(nb.chooseFolder()).then(function (n) { if (!n) { var e = new Error('اتلغى'); e.name = 'AbortError'; throw e; } return true; }) : Promise.resolve(false));
        return ready.then(function (ok) { return ok ? bkWriteNative(nb, cur, prev).then(function () { return 'native'; }) : null; });
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
    return Promise.all([bkGet('current'), bkGet('previous')]).then(function (r) {
      var x = null; try { x = JSON.parse(ls('dpb_fs2_bk_ext', 'null')); } catch (e) {}
      el.textContent = 'الحالية: ' + bkLine(r[0]) + '\nالسابقة: ' + bkLine(r[1]) + (x && BK_WHERE[x.w] ? '\nآخر حفظ برّه التطبيق: ' + BK_WHERE[x.w] + ' ✔ ' + new Date(x.t).toLocaleTimeString('ar-EG') : '') + '';
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
    if (res && res.__reachable === false) return navigator.onLine === false ? 'لا يوجد اتصال بالإنترنت' : (ls('DPB_BACKUP_URL_V1', '') ? 'تعذّر الاتصال بسكربت النسخ الاحتياطي — افتح الرابط في المتصفح: لازم يظهر ok:true، وتأكد Who has access = Anyone' : 'تعذّر الاتصال بـ Apps Script');
    return raw || 'فشل الرفع';
  }
  function bkDriveUpload(obj) {
    if (!driveOn()) return Promise.resolve({ skipped: true });
    var wait = Promise.resolve(); for (var i = 0; i < 20 && typeof window.DPB_gsCall !== 'function'; i++) wait = wait.then(function () { return new Promise(function (r) { setTimeout(r, 100); }); });
    return wait.then(function () {
      if (typeof window.DPB_gsCall !== 'function') return { ok: false, error: 'الاتصال بالسحابة غير جاهز' };
      return (typeof window.DPB_backupPost === 'function' ? window.DPB_backupPost({ kind: 'firebase', ns: nsName(), content: JSON.stringify(obj), shareWith: driveEmail(), createdAt: obj && obj.savedAt }, 120000) : window.DPB_gsCall('saveBackup', { kind: 'firebase', ns: nsName(), content: JSON.stringify(obj), shareWith: driveEmail(), createdAt: obj && obj.savedAt }, 120000));
    }).then(function (res) {
      if (res && res.ok) { lsSet('dpb_fs2_bk_drive', JSON.stringify({ ok: true, t: Date.now(), url: res.url || '', owner: res.owner || '', sharedWith: res.sharedWith || '', shareError: res.shareError || '' })); try { localStorage.removeItem('dpb_fs2_bk_drive_pending'); } catch (e) {} return { ok: true }; }
      var err = driveErr(res); lsSet('dpb_fs2_bk_drive', JSON.stringify({ ok: false, t: Date.now(), error: err })); lsSet('dpb_fs2_bk_drive_pending', '1'); return { ok: false, error: err };
    }).catch(function (e) { var err = String((e && e.message) || e || 'فشل'); lsSet('dpb_fs2_bk_drive', JSON.stringify({ ok: false, t: Date.now(), error: err })); lsSet('dpb_fs2_bk_drive_pending', '1'); return { ok: false, error: err }; });
  }
  function bkDriveLine() {
    var x = null; try { x = JSON.parse(ls('dpb_fs2_bk_drive', 'null')); } catch (e) {}
    if (!driveOn()) return '\nGoogle Drive: متوقف';
    if (!x) return '\nGoogle Drive: لسه ما اترفعش';
    var t = new Date(x.t).toLocaleTimeString('ar-EG');
    if (!x.ok) return '\nGoogle Drive: ✖ ' + x.error + ' (' + t + ')';
    return '\nGoogle Drive: ✔ نجح الساعة ' + t + (x.sharedWith ? ' — مشاركة مع ' + x.sharedWith + ' ✔' : (x.shareError ? ' — ⚠ تعذّرت المشاركة: ' + x.shareError : (driveEmail() ? '' : ' — اكتب إيميل Drive عشان النسخة تظهر عنده'))) + (x.owner ? '\nالملف محفوظ في حساب: ' + x.owner : '');
  }

  /* ---- automatic backup: every N minutes, only when the data changed since the last one (each run reads every document once, so it is meant for ONE device - the admin's) ---- */
  var bkBusy = false, bkLastVer = null;
  function bkAutoTick(force) {
    if (!on() || !store || (!force && ls('dpb_fs2_bk_auto', 'off') !== 'on') || bkBusy) return Promise.resolve('skip');
    var min = Number(ls('dpb_fs2_bk_min', '30')) || 30, last = Number(ls('dpb_fs2_bk_last', '0')) || 0;
    if (!force && (Date.now() - last < min * 60000 || bkLastVer === version)) return Promise.resolve('skip');
    bkBusy = true; var ver = version;
    return bkBackupNow().then(function (r) {
      bkLastVer = ver; lsSet('dpb_fs2_bk_last', String(Date.now()));
      if (!r.changed) { if (driveOn() && ls('dpb_fs2_bk_drive_pending', '')) return bkDriveUpload(r.current).then(function () { return 'same'; }); return 'same'; }
      return Promise.all([
        bkSaveExternal(r.current, r.previous, false).then(function (w) { bkNoteExt(w); return w; }, function () { return 'none'; }),
        bkDriveUpload(r.current)
      ]).then(function (x) { return 'saved:' + x[0]; });
    }).catch(function () { return 'error'; }).then(function (x) { bkBusy = false; bkPaint(); return x; });
  }
  if (typeof setInterval === 'function') setInterval(function () { bkAutoTick(false); }, 60000);
  window.DPB_FS2.autoTick = bkAutoTick;
  window.DPB_FS2.backupNow = bkBackupNow; window.DPB_FS2.saveExternal = bkSaveExternal;

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
    c.innerHTML = '<h3>🧩 الطبقة الجديدة (كل الخرائط)</h3>' +
      '<div class="hint">مصدر واحد للخلايا في Firestore. مفيش حاجة بتتغيّر إلا لما تشغّلها. بتتكتب في مكان جديد منفصل عن بياناتك القديمة، وإيقافها بيرجّعك للنظام القديم فورًا.</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px"><button type="button" class="dpbAdminBtn" id="dpbFs2Backup">💾 نسخة احتياطية الآن</button><button type="button" class="dpbAdminBtn" id="dpbFs2Ext">📤 حفظ برّه التطبيق</button><button type="button" class="dpbAdminBtn" id="dpbFs2Dir" style="display:none">📁 مكان الحفظ</button></div>' +
      '<label class="hint" style="display:flex;gap:8px;align-items:center;margin-top:8px"><input type="checkbox" id="dpbFs2Auto"> نسخة تلقائية كل <select id="dpbFs2AutoMin"><option value="5">5</option><option value="15">15</option><option value="30">30</option><option value="60">60</option><option value="120">120</option></select> دقيقة (لو في تغيير) — على جهاز الأدمن بس</label>' +
      '<label class="hint" style="display:flex;gap:8px;align-items:center;margin-top:8px"><input type="checkbox" id="dpbFs2Drive"> ☁️ رفع نسخة على Google Drive</label>' +
      '<input type="url" id="dpbFs2Url" autocomplete="off" placeholder="رابط سكربت النسخ الاحتياطي (ينتهي بـ /exec)" style="width:100%;box-sizing:border-box;margin-top:6px;padding:9px 10px;border-radius:8px;border:1px solid #567;background:#0d1b2e;color:#fff;direction:ltr;text-align:left">' +
      '<input type="email" id="dpbFs2Email" inputmode="email" autocomplete="off" placeholder="إيميل Google Drive اللي تترفع عليه النسخة" style="width:100%;box-sizing:border-box;margin-top:6px;padding:9px 10px;border-radius:8px;border:1px solid #567;background:#0d1b2e;color:#fff;direction:ltr;text-align:left">' +
      '<details style="margin-top:10px"><summary class="hint" style="cursor:pointer">⚙️ أدوات متقدمة (نادرًا ما تحتاجها)</summary>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px"><button type="button" class="dpbAdminBtn" id="dpbFs2Toggle"></button><button type="button" class="dpbAdminBtn" id="dpbFs2Import">📥 مطابقة الخرائط على الشيت</button></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;align-items:center"><select id="dpbFs2RestoreSrc" class="dpbAdminBtn"><option value="current">استعادة من: الحالية</option><option value="previous">استعادة من: السابقة</option><option value="file">استعادة من: ملف</option></select><button type="button" class="dpbAdminBtn" id="dpbFs2Restore">♻️ استعادة</button><input type="file" id="dpbFs2RestoreFile" accept=".json,application/json" style="display:none"></div>' +
      '</details>' +
      '<div class="hint" id="dpbFs2DriveInfo" style="margin-top:8px;line-height:1.9"></div>' +
      '<div class="hint" id="dpbFs2BkInfo" style="margin-top:8px">النسخ: بيحتفظ بنسختين بس (حالية + سابقة).</div>' +
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
    var $ = function (i) { return document.getElementById(i); }, say = function (t) { $('dpbFs2Msg').textContent = t; };
    var paintBk = bkPaint, where = BK_WHERE;
    $('dpbFs2Dir').addEventListener('click', function () { bkPickFolder().then(function () { say('📁 اتحدد مكان الحفظ. النسخ الجاية بتتكتب فيه ملفين بس.'); }).catch(function (e) { say(e && e.name === 'AbortError' ? 'اتلغى اختيار المكان.' : 'فشل: ' + permHint(e)); }); });
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
    au.addEventListener('change', function () { lsSet('dpb_fs2_bk_auto', au.checked ? 'on' : 'off'); say(au.checked ? 'النسخ التلقائي شغّال: كل ' + am.value + ' دقيقة لو في تغيير.' : 'النسخ التلقائي اتقفل.'); });
    am.addEventListener('change', function () { lsSet('dpb_fs2_bk_min', am.value); });
    $('dpbFs2Backup').addEventListener('click', function () {
      if (!on()) { say('شغّل الطبقة الجديدة الأول.'); return; }
      say('بقرا كل البيانات من Firebase…');
      bkBackupNow().then(function (r) {
        if (!r.changed) {
          if (driveOn() && ls('dpb_fs2_bk_drive_pending', '')) return bkDriveUpload(r.current).then(function (d) { say(d.ok ? 'مفيش تغيير، بس رفعت النسخة الحالية على Drive ☁️.' : '⚠ Drive: ' + d.error); paintBk(); });
          say('مفيش تغيير من آخر نسخة، فالحالية والسابقة زي ما هم.'); paintBk(); return;
        }
        return Promise.all([
          bkSaveExternal(r.current, r.previous, false).then(function (w) { bkNoteExt(w); return w; }, function () { return 'fail'; }),
          bkDriveUpload(r.current)
        ]).then(function (x) {
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
  if (on()) setTimeout(function () { getStore().catch(function () {}); }, 1500); // connect early so a problem shows in the card instead of on the first tap
})();
