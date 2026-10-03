/* dpb-fs.js — Firestore backend layer for DPB Map (Phase 1)
 *
 * What it does
 *  - Sits in front of window.fetch. While the switch is ON it answers these
 *    Apps-Script calls from Firestore, with the SAME rules as Code.gs:
 *      upsertMany (cascade + progress + stale check), deleteMany (lock rule +
 *      cell recompute -> 0), getGrid / getGridBatch, and the Production pull.
 *  - Everything else (login, users, KV, build result ...) still goes to Apps Script.
 *  - Switch OFF (default) => this file does nothing at all; the old system runs.
 *
 * Data layout (namespace = a "project"; default "test"):
 *   dpb/{ns}/grid_{Proc}/{chunk}   cells: { "r_c": value }        (rows per chunk = ROWS)
 *   dpb/{ns}/rec_{Proc}/{chunk}    recs:  { id: record }
 *   dpb/{ns}/rec__other/{bucket}   records that have no map cell
 *   dpb/{ns}/meta/{rev|config|dims|struct_{Proc}}
 *
 * Switch:  localStorage dpb_fs_mode = "on" | "off"   (default off)
 * Project: localStorage dpb_fs_ns   (default "test")
 * Config:  localStorage dpb_fs_cfg  = firebaseConfig JSON
 */
(function () {
  'use strict';
  if (window.DPB_FS) return;

  var LS_MODE = 'dpb_fs_mode', LS_NS = 'dpb_fs_ns', LS_CFG = 'dpb_fs_cfg';
  var ROWS = 12;                 // rows per chunk (grid + records)
  var OTHER_BUCKETS = 16;
  var SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
  var origFetch = window.fetch.bind(window);

  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function mode() { return lsGet(LS_MODE, 'off') === 'on'; }
  function ns() { return String(lsGet(LS_NS, 'test') || 'test').replace(/[^A-Za-z0-9_\-]/g, '_'); }
  function cfg() { try { return JSON.parse(lsGet(LS_CFG, '') || 'null'); } catch (e) { return null; } }

  /* ---------------------------------------------------------------- helpers */
  function slug(name) {
    var s = String(name || '').trim().replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
    if (!s) return 'Unknown';
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  }
  function low(x) { return String(x == null ? '' : x).trim().toLowerCase(); }
  function hasCell(r) { return r && r.sheet !== undefined && r.r1 !== undefined && r.c1 !== undefined && r.r1 !== null && r.c1 !== null && isFinite(Number(r.r1)) && isFinite(Number(r.c1)); }
  function hash(s) { var h = 0; s = String(s); for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }
  function isoOf(v) { return v ? String(v) : ''; }
  function progDone(r) { return r && r.done !== undefined && r.done !== null && r.done !== '' && isFinite(Number(r.done)); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  // Firestore rejects `undefined` anywhere in a document; a JSON round-trip drops those keys
  function clean(o) { return o === undefined ? o : JSON.parse(JSON.stringify(o)); }

  // shard for a record: (process slug, row block) | other bucket
  function shardOf(rec) {
    if (hasCell(rec) && rec.process) return { col: 'rec_' + slug(rec.process), chunk: String(Math.floor(Number(rec.r1) / ROWS)), proc: slug(rec.process) };
    return { col: 'rec__other', chunk: String(hash(rec.id || rec.recordId || '') % OTHER_BUCKETS), proc: '_other' };
  }
  function recPath(sh) { return 'dpb/' + ns() + '/' + sh.col + '/' + sh.chunk; }
  function gridPath(procSlug, chunk) { return 'dpb/' + ns() + '/grid_' + procSlug + '/' + chunk; }
  function metaPath(n) { return 'dpb/' + ns() + '/meta/' + n; }

  /* --------------------------------------------------------------- adapters */
  var LS_AUTH = 'dpb_fs_auth';
  function authCfg() { try { var o = JSON.parse(lsGet(LS_AUTH, '') || 'null'); return o && o.email && o.password ? o : null; } catch (e) { return null; } }
  var adapter = null, adapterP = null, adapterErr = null;

  function firebaseAdapter(conf) {
    var S = {};
    return Promise.all([
      import(SDK + 'firebase-app.js'), import(SDK + 'firebase-firestore.js'), import(SDK + 'firebase-auth.js')
    ]).then(function (m) {
      var appM = m[0], fsM = m[1], authM = m[2];
      var app = appM.getApps().length ? appM.getApp() : appM.initializeApp(conf);
      var db = fsM.getFirestore(app);
      var auth = authM.getAuth(app);
      var ac = authCfg();
      var ready;
      if (ac) {
        // Email/Password: if the current session is another account (e.g. the old anonymous one), sign in again with the saved one
        ready = (auth.currentUser && !auth.currentUser.isAnonymous && String(auth.currentUser.email || '').toLowerCase() === ac.email.toLowerCase())
          ? Promise.resolve() : authM.signInWithEmailAndPassword(auth, ac.email, ac.password);
      } else {
        ready = auth.currentUser ? Promise.resolve() : authM.signInAnonymously(auth);
      }
      function dref(path) { var p = path.split('/'); return fsM.doc.apply(null, [db].concat(p)); }
      function cref(path) { var p = path.split('/'); return fsM.collection.apply(null, [db].concat(p)); }
      return ready.then(function () {
        return {
          kind: 'firebase',
          get: function (path) { return fsM.getDoc(dref(path)).then(function (s) { return s.exists() ? s.data() : null; }); },
          del: function (path) { return fsM.deleteDoc(dref(path)); },
          set: function (path, data, merge) { return fsM.setDoc(dref(path), clean(data), merge ? { merge: true } : {}); },
          list: function (path) { return fsM.getDocs(cref(path)).then(function (q) { return q.docs.map(function (d) { return { id: d.id, data: d.data() }; }); }); },
          listen: function (path, cb, onErr) {
            return fsM.onSnapshot(cref(path), function (q) { cb(q.docs.map(function (d) { return { id: d.id, data: d.data() }; }), q.metadata.hasPendingWrites); }, onErr);
          },
          listenDoc: function (path, cb, onErr) {
            return fsM.onSnapshot(dref(path), function (snap) { cb(snap.exists() ? snap.data() : null); }, onErr);
          },
          runTx: function (fn) {
            return fsM.runTransaction(db, function (t) {
              return fn({
                get: function (path) { return t.get(dref(path)).then(function (s) { return s.exists() ? s.data() : null; }); },
                set: function (path, data, merge) { t.set(dref(path), clean(data), merge ? { merge: true } : {}); }
              });
            });
          },
          batch: function (ops) { // ops: [{path,data,merge}] up to 450
            var b = fsM.writeBatch(db);
            ops.forEach(function (o) { b.set(dref(o.path), clean(o.data), o.merge ? { merge: true } : {}); });
            return b.commit();
          }
        };
      });
    });
  }

  function getAdapter() {
    if (adapter) return Promise.resolve(adapter);
    if (adapterP) return adapterP;
    var c = cfg();
    if (!c || !c.projectId) { adapterErr = 'مفيش Firebase config محفوظ'; return Promise.reject(new Error(adapterErr)); }
    adapterP = firebaseAdapter(c).then(function (a) { adapter = a; adapterErr = null; return a; })
      .catch(function (e) { adapterP = null; adapterErr = String(e && e.message || e); throw e; });
    return adapterP;
  }

  /* ---------------------------------------------------------------- caches
   * Live listeners keep an in-memory copy, so the 8s map poll and the 25s
   * records pull cost ZERO Firestore reads after the first load. */
  var gridCache = {}, recCache = {}, listeners = {}, ready = {}, recVersion = 0, notifyT = null;

  function listenCol(kind, col, onDocs) {
    var key = ns() + '/' + col;
    if (ready[key]) return ready[key];
    ready[key] = getAdapter().then(function (a) {
      return new Promise(function (resolve, reject) {
        var first = true;
        listeners[key] = a.listen('dpb/' + ns() + '/' + col, function (docs, pending) {
          onDocs(docs);
          if (first) { first = false; resolve(); } else if (!pending) scheduleNotify();
        }, function (err) { noteErr('listen ' + col, err); delete ready[key]; if (first) { first = false; reject(err); } });
      });
    });
    ready[key].catch(function () { delete ready[key]; });
    return ready[key];
  }
  function scheduleNotify() {
    recVersion++;
    clearTimeout(notifyT);
    notifyT = setTimeout(function () {
      try { if (typeof window.__dpbFetchLiveGrid === 'function') window.__dpbFetchLiveGrid(); } catch (e) {}
    }, 500);
  }
  function ensureGrid(procSlug) {
    gridCache[ns()] = gridCache[ns()] || {};
    var gc = gridCache[ns()];
    return listenCol('grid', 'grid_' + procSlug, function (docs) {
      var m = {}; docs.forEach(function (d) { m[d.id] = (d.data && d.data.cells) || {}; }); gc[procSlug] = m;
    });
  }
  function ensureRecs(col) {
    recCache[ns()] = recCache[ns()] || {};
    var rc = recCache[ns()];
    return listenCol('rec', col, function (docs) {
      var m = {}; docs.forEach(function (d) { m[d.id] = (d.data && d.data.recs) || {}; }); rc[col] = m;
    });
  }
  // learn which process collections exist (names come from the app + from what we saw)
  var knownProcs = {};
  function noteProc(name) { if (name) knownProcs[slug(name)] = String(name); }
  function allProcNames() {
    var out = {};
    try { (window.__dpbGetLiveGridProcessNames && window.__dpbGetLiveGridProcessNames() || []).forEach(noteProc); } catch (e) {}
    Object.keys(knownProcs).forEach(function (k) { out[k] = knownProcs[k]; });
    return out;
  }
  function allRecordsFromCache() {
    var rc = (recCache[ns()] || {}), out = [];
    Object.keys(rc).forEach(function (col) { Object.keys(rc[col]).forEach(function (ch) { var m = rc[col][ch]; Object.keys(m).forEach(function (id) { out.push(m[id]); }); }); });
    return out;
  }

  /* ------------------------------------------------------ cell value rules */
  // Port of revertExecutionCells_: highest code of the records on the cell;
  // progress (done) records: the latest record by time wins.
  function cellValue(recs, cell) {
    var maxCode = 0, progAny = false, latest = null;
    Object.keys(recs).forEach(function (id) {
      var p = recs[id];
      // a cell is identified by (process, row, col). Name case and the 'sheet' text are NOT part of the identity
      // (the app's own lock check ignores them too), otherwise a record can exist without counting on the map.
      if (!p || Number(p.r1) !== Number(cell.r1) || Number(p.c1) !== Number(cell.c1)) return;
      if (low(p.process) !== low(cell.process)) return;
      var ptab = p.processTab ? String(p.processTab) : '';
      if (cell.processTab && ptab && ptab !== String(cell.processTab)) return;
      var code = Number(p.code) || 0, dn = null;
      if (progDone(p)) { dn = Math.max(0, Number(p.done)); if (isFinite(Number(p.total)) && Number(p.total) > 0) dn = Math.min(dn, Number(p.total)); }
      var val = dn !== null ? dn : code, time = String(p.time || p.updatedAt || '');
      if (code > maxCode) maxCode = code;
      if (dn !== null) progAny = true;
      if (!latest || time >= latest.time) latest = { val: val, time: time };
    });
    if (progAny && latest) maxCode = latest.val;
    return maxCode;
  }

  /* ------------------------------------------------------ transaction core
   * plan(S) receives the shards it asked for and edits them in place:
   *   S.rec(col,chunk) -> recs map   (loaded lazily BEFORE any write)
   * We do it in two phases inside runTx: (1) discover+read, (2) write. */
  function runPlan(wanted, mutate) {
    // wanted: array of {col,chunk}; mutate(shards) -> {cells:[{process,sheet,r1,c1,r2,c2,processTab}], result}
    var applied = null;
    return getAdapter().then(function (a) {
      return a.runTx(function (tx) {
        applied = null;
        var shards = {}, order = [];
        var reads = wanted.map(function (w) {
          var k = w.col + '/' + w.chunk;
          if (shards[k]) return Promise.resolve();
          shards[k] = { col: w.col, chunk: w.chunk, recs: null, dirty: false };
          order.push(k);
          return tx.get('dpb/' + ns() + '/' + k).then(function (d) { shards[k].recs = (d && d.recs) ? clone(d.recs) : {}; });
        });
        return Promise.all(reads.concat([tx.get(metaPath('rev'))])).then(function (rs) {
          var rev = rs[rs.length - 1];
          var api = {
            recs: function (col, chunk) { var k = col + '/' + chunk; if (!shards[k]) throw new Error('shard not loaded ' + k); return shards[k]; },
            has: function (col, chunk) { return !!shards[col + '/' + chunk]; }
          };
          var out = mutate(api) || {};
          // recompute affected cells, write grid chunks
          var gridWrites = {};
          (out.cells || []).forEach(function (c) {
            if (!c.process) return;
            var ps = slug(c.process), ch = String(Math.floor(Number(c.r1) / ROWS));
            var sh = api.recs('rec_' + ps, ch);
            var v = cellValue(sh.recs, c);
            var gk = ps + '/' + ch;
            (gridWrites[gk] = gridWrites[gk] || { ps: ps, ch: ch, cells: {} }).cells[Number(c.r1) + '_' + Number(c.c1)] = v;
          });
          order.forEach(function (k) {
            var s = shards[k];
            if (s.dirty) tx.set('dpb/' + ns() + '/' + k, { recs: s.recs }, false);
          });
          Object.keys(gridWrites).forEach(function (k) {
            var g = gridWrites[k];
            tx.set(gridPath(g.ps, g.ch), { cells: g.cells }, true);
          });
          var n = ((rev && rev.n) || 0) + 1;
          tx.set(metaPath('rev'), { n: n, at: new Date().toISOString() }, false);
          applied = { shards: order.filter(function (k) { return shards[k].dirty; }).map(function (k) { return shards[k]; }), grid: Object.keys(gridWrites).map(function (k) { return gridWrites[k]; }) };
          return out.result;
        });
      }).then(function (r) { applyLocal(applied); return r; });
    });
  }
  // make our own committed write visible to reads immediately (the listener confirms it a moment later)
  function applyLocal(ap) {
    if (!ap) return;
    var rc = (recCache[ns()] = recCache[ns()] || {}), gc = (gridCache[ns()] = gridCache[ns()] || {});
    ap.shards.forEach(function (s) { (rc[s.col] = rc[s.col] || {})[s.chunk] = s.recs; });
    ap.grid.forEach(function (g) { var m = (gc[g.ps] = gc[g.ps] || {}); m[g.ch] = Object.assign({}, m[g.ch] || {}, g.cells); });
    recVersion++;
  }

  function grouped(namesFromBody) {
    var names = Array.isArray(namesFromBody) ? namesFromBody.filter(Boolean).map(String) : [];
    if (names.length) { lsSet('dpb_fs_grouped_' + ns(), JSON.stringify(names)); return names; }
    try { return JSON.parse(lsGet('dpb_fs_grouped_' + ns(), '[]')) || []; } catch (e) { return []; }
  }

  /* ----------------------------------------------------------- upsertMany */
  function upsertCore(body) {
    var incoming = Array.isArray(body.records) ? body.records.map(clone) : [];
    if (!incoming.length) return Promise.resolve({ ok: true });
    var order = body.noCascade ? [] : grouped(body.groupedProcessNames); // client sends them in process order
    var cascade = [];
    incoming.forEach(function (rec) {
      if (!rec || !rec.process || !(Number(rec.code) > 0) || !hasCell(rec)) return;
      var idx = -1;
      for (var i = 0; i < order.length; i++) if (low(order[i]) === low(rec.process)) { idx = i; break; }
      if (idx <= 0) return;
      for (var k = 0; k < idx; k++) {
        cascade.push({
          id: 'cascade_' + low(order[k]) + '_' + rec.sheet + '_' + rec.r1 + '_' + rec.c1,
          time: rec.time || rec.updatedAt || new Date().toISOString(),
          user: rec.user || 'System', owner: rec.owner || rec.user || 'System', source: 'Cascade',
          process: order[k], code: k + 1, tracker: rec.tracker, row: rec.row, unit: rec.unit,
          sheet: rec.sheet, r1: rec.r1, c1: rec.c1, r2: rec.r2, c2: rec.c2
        });
      }
    });
    cascade = cascade.map(clean);
    var progRecs = incoming.filter(function (r) { return progDone(r) && hasCell(r); });
    var all = incoming.concat(cascade);
    all.forEach(function (r) { if (r.process) noteProc(r.process); });

    // which shards are needed: every incoming record's own shard (+ shard that already holds the same id)
    var wanted = [], seen = {};
    function want(col, chunk) { var k = col + '/' + chunk; if (!seen[k]) { seen[k] = 1; wanted.push({ col: col, chunk: chunk }); } }
    var idIdx = idIndex();
    all.forEach(function (r) {
      var id = String(r.id || r.recordId || ''); if (!id) return;
      var sh = shardOf(r); want(sh.col, sh.chunk);
      if (idIdx[id]) want(idIdx[id].col, idIdx[id].chunk);
    });
    // progress records also clear other records on the same cell+process: same shard as incoming => already wanted

    var stale = [];
    return runPlan(wanted, function (api) {
      var cells = {}; stale.length = 0;
      // removeOtherRecordsForCells_
      if (progRecs.length) {
        var keepIds = {}, cellKeys = {};
        progRecs.forEach(function (r) {
          if (r.id !== undefined) keepIds[String(r.id)] = true;
          cellKeys[String(r.sheet) + '|' + r.r1 + '|' + r.c1 + '|' + String(r.process || '') + '|' + String(r.processTab || '')] = true;
        });
        progRecs.forEach(function (r) {
          var sh = api.recs('rec_' + slug(r.process), String(Math.floor(Number(r.r1) / ROWS)));
          Object.keys(sh.recs).forEach(function (id) {
            if (keepIds[id]) return;
            var p = sh.recs[id], ptab = String(p.processTab || '');
            var ck = String(p.sheet) + '|' + p.r1 + '|' + p.c1 + '|' + String(p.process || '') + '|' + ptab;
            var lk = String(p.sheet) + '|' + p.r1 + '|' + p.c1 + '|' + String(p.process || '') + '|';
            if (cellKeys[ck] || (ptab === '' && cellKeys[lk])) { delete sh.recs[id]; sh.dirty = true; }
          });
        });
      }
      all.forEach(function (rec) {
        var id = String(rec.id || rec.recordId || ''); if (!id) return;
        var updatedAt = String(rec.time || rec.updatedAt || rec.editedAt || new Date().toISOString());
        var target = shardOf(rec), tsh = api.recs(target.col, target.chunk);
        var oldSh = null, old = null;
        if (tsh.recs[id]) { oldSh = tsh; old = tsh.recs[id]; }
        else if (idIdx[id] && api.has(idIdx[id].col, idIdx[id].chunk)) { var s2 = api.recs(idIdx[id].col, idIdx[id].chunk); if (s2.recs[id]) { oldSh = s2; old = s2.recs[id]; } }
        var oldT = old ? isoOf(old.time) : '';
        if (old && oldT >= updatedAt) { if (oldT > updatedAt) stale.push({ id: id, serverTime: oldT }); return; }
        if (oldSh && oldSh !== tsh) { delete oldSh.recs[id]; oldSh.dirty = true; }
        var stored = Object.assign({}, rec); stored.id = id; stored.time = updatedAt;
        if (!stored.editedBy && stored.user) stored.editedBy = stored.user;
        tsh.recs[id] = stored; tsh.dirty = true;
      });
      all.forEach(function (rec) {
        if (hasCell(rec) && rec.process) cells[String(rec.sheet) + '|' + rec.r1 + '|' + rec.c1 + '|' + String(rec.process)] = { sheet: rec.sheet, r1: Number(rec.r1), c1: Number(rec.c1), r2: Number(rec.r2), c2: Number(rec.c2), process: rec.process, processTab: rec.processTab };
      });
      return { cells: Object.keys(cells).map(function (k) { return cells[k]; }) };
    }).then(function () {
      return { ok: true, stale: stale, serverTime: new Date().toISOString() };
    });
  }

var upsertQ = Promise.resolve();
  // The app pushes EVERY unsynced record in one call. One Firestore transaction can't take that (10 MB / 500 writes),
  // so a big push is cut into small transactions: records already stored (same or newer time) are skipped, the rest go
  // in a few shards at a time, one after another. Pushes never overlap.
  function upsertMany(body) {
    var incoming = Array.isArray(body.records) ? body.records : [];
    if (incoming.length <= 40) return upsertCore(body);
    var run = upsertQ.catch(function () {}).then(function () {
      return prepareCaches().catch(function () {}).then(function () {
        var rc = recCache[ns()] || {}, idx = idIndex(), stale = [], groups = {}, order = [];
        incoming.forEach(function (r) {
          var id = String((r && (r.id || r.recordId)) || ''); if (!id) return;
          var t = String(r.time || r.updatedAt || r.editedAt || '');
          var l = idx[id], old = l && rc[l.col] && rc[l.col][l.chunk] && rc[l.col][l.chunk][id];
          if (old && t) { var ot = isoOf(old.time); if (ot >= t) { if (ot > t) stale.push({ id: id, serverTime: ot }); return; } }
          var sh = shardOf(r), k = sh.col + '/' + sh.chunk;
          if (!groups[k]) { groups[k] = []; order.push(k); }
          groups[k].push(r);
        });
        var batches = [], cur = [], curG = 0;
        order.forEach(function (k) {
          if (curG >= 3 || cur.length >= 200) { batches.push(cur); cur = []; curG = 0; }
          cur = cur.concat(groups[k]); curG++;
        });
        if (cur.length) batches.push(cur);
        var p = Promise.resolve();
        batches.forEach(function (b) {
          p = p.then(function () {
            return upsertCore({ records: b, groupedProcessNames: body.groupedProcessNames, noCascade: body.noCascade }).then(function (r) { (r.stale || []).forEach(function (x) { stale.push(x); }); });
          });
        });
        return p.then(function () { return { ok: true, stale: stale, serverTime: new Date().toISOString() }; });
      });
    });
    upsertQ = run;
    return run;
  }

  function idIndex() {
    var rc = recCache[ns()] || {}, out = {};
    Object.keys(rc).forEach(function (col) { Object.keys(rc[col]).forEach(function (ch) { Object.keys(rc[col][ch]).forEach(function (id) { out[id] = { col: col, chunk: ch }; }); }); });
    return out;
  }

  /* ----------------------------------------------------------- deleteMany */
  function deleteMany(body) {
    var ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    if (!ids.length) return Promise.resolve({ ok: true, deleted: 0 });
    var res = { deleted: 0, blocked: [] };
    var siblings = Array.isArray(body.siblings) ? body.siblings : [];
    var pre = siblings.length ? upsertMany({ records: siblings, noCascade: true }) : Promise.resolve();
    return pre.then(function () { return prepareCaches(); }).then(function () {
      var gset = {}; grouped(body.groupedProcessNames).forEach(function (n) { gset[low(n)] = true; });
      var idx = idIndex(), idsSet = {}; ids.forEach(function (x) { idsSet[x] = true; });
      var wanted = [], seen = {}, blocks = {};
      function want(col, chunk) { var k = col + '/' + chunk; if (!seen[k]) { seen[k] = 1; wanted.push({ col: col, chunk: chunk }); } }
      ids.forEach(function (id) { var l = idx[id]; if (!l) return; want(l.col, l.chunk); if (l.col !== 'rec__other') blocks[l.chunk] = true; });
      var known = allProcNames();
      Object.keys(known).forEach(function (sl) { if (gset[low(known[sl])]) Object.keys(blocks).forEach(function (b) { want('rec_' + sl, b); }); });
      if (!wanted.length) return;
      return runPlan(wanted, function (api) {
        var recsG = [];
        wanted.forEach(function (w) {
          if (w.col === 'rec__other') return;
          var sh = api.recs(w.col, w.chunk);
          Object.keys(sh.recs).forEach(function (id) {
            var p = sh.recs[id]; if (!p || p.r1 === undefined || p.c1 === undefined) return;
            if (!gset[low(p.process)]) return;
            recsG.push({ id: id, p: p, code: Number(p.code) || 0, key: Number(p.r1) + '|' + Number(p.c1) });
          });
        });
        var maxRemaining = {}, blocked = {};
        recsG.forEach(function (r) { if (idsSet[r.id]) return; var cur = maxRemaining[r.key]; if (!cur || r.code > cur.code) maxRemaining[r.key] = { code: r.code, name: String(r.p.process || '') }; });
        recsG.forEach(function (r) { if (!idsSet[r.id]) return; var m = maxRemaining[r.key]; if (m && m.code > r.code) blocked[r.id] = { id: r.id, process: String(r.p.process || ''), r1: Number(r.p.r1), c1: Number(r.p.c1), lockedBy: m.name }; });
        var cells = {}; res.deleted = 0;
        wanted.forEach(function (w) {
          var sh = api.recs(w.col, w.chunk);
          ids.forEach(function (id) {
            if (!sh.recs[id] || blocked[id]) return;
            var p = sh.recs[id];
            delete sh.recs[id]; sh.dirty = true; res.deleted++;
            if (p.r1 !== undefined && p.c1 !== undefined && p.process) cells[String(p.sheet || '') + '|' + p.r1 + '|' + p.c1 + '|' + String(p.process)] = { sheet: p.sheet || '', r1: Number(p.r1), c1: Number(p.c1), r2: Number(p.r2), c2: Number(p.c2), process: p.process };
          });
        });
        res.blocked = Object.keys(blocked).map(function (k) { return blocked[k]; });
        return { cells: Object.keys(cells).map(function (k) { return cells[k]; }) };
      });
    }).then(function () { return { ok: true, deleted: res.deleted, blocked: res.blocked }; });
  }

  // make sure the record caches (needed for id -> shard lookups) are loaded
  function prepareCaches() {
    var names = allProcNames(), jobs = [ensureRecs('rec__other')];
    Object.keys(names).forEach(function (sl) { jobs.push(ensureRecs('rec_' + sl)); });
    return Promise.all(jobs);
  }

  /* ---------------------------------------------------------------- reads */
  function bigGet(name) {
    return kvGetStr(name).then(function (str) {
      if (str) return JSON.parse(str);
      return getAdapter().then(function (a) { return a.get(metaPath(name)); }).then(function (d) { return d && d.json ? JSON.parse(d.json) : null; });
    });
  }
  function bigSet(name, obj) { return kvSetStr(name, JSON.stringify(obj)); }
  // light layout (sheet name, size, merges) - all the app needs to draw trackers from a grid read
  function liteOf(st) { return { sheet: st.sheet, rows: st.rows, cols: st.cols, merges: st.merges || [] }; }
  function liteFor(procName) {
    var sl = slug(procName), key = ns() + '|' + sl;
    liteFor.mem = liteFor.mem || {};
    if (liteFor.mem[key]) return Promise.resolve(liteFor.mem[key]);
    return bigGet('lite_' + sl).then(function (l) {
      if (l) { liteFor.mem[key] = l; return l; }
      return structFor(procName).then(function (st) {
        if (!st) return {};
        var l2 = liteOf(st); liteFor.mem[key] = l2;
        bigSet('lite_' + sl, l2).catch(function (e) { noteErr('save lite ' + sl, e); });
        return l2;
      });
    });
  }
  function structFor(procName) {
    var sl = slug(procName), key = ns() + '|' + sl;
    structFor.mem = structFor.mem || {};
    if (structFor.mem[key]) return Promise.resolve(structFor.mem[key]);
    return getAdapter().then(function (a) {
      return bigGet('struct_' + sl).then(function (d) {
        if (d) { structFor.mem[key] = d; return d; }
        // first time: copy the structure (merges / ranges / colors) from the existing Apps Script, read-only
        var base = window.DPB_getScriptUrl && window.DPB_getScriptUrl();
        if (!base) return null;
        return origFetch(base + '?action=getGrid&process=' + encodeURIComponent(procName) + '&t=' + Date.now())
          .then(function (r) { return r.json(); })
          .then(function (g) {
            if (!g || !g.ok) return null;
            var s = clone(g); delete s.values; delete s.liveColors;
            structFor.mem[key] = s;
            return bigSet('struct_' + sl, s).then(function () { return s; }, function (e) { noteErr('save struct ' + sl, e); return s; });
          });
      });
    });
  }

  function buildGrid(procName, light, slim) {
    var sl = slug(procName); noteProc(procName);
    return Promise.all([ensureGrid(sl), light ? Promise.resolve(null) : (slim ? liteFor(procName) : structFor(procName))]).then(function (r) {
      var st = r[1] || {};
      var gc = ((gridCache[ns()] || {})[sl]) || {};
      var rows = st.rows || 0, cols = st.cols || 0;
      Object.keys(gc).forEach(function (ch) { Object.keys(gc[ch]).forEach(function (k) { var p = k.split('_'); rows = Math.max(rows, Number(p[0]) + 1); cols = Math.max(cols, Number(p[1]) + 1); }); });
      var dims = lastDims[sl]; if (dims) { rows = Math.max(rows, dims.rows); cols = Math.max(cols, dims.cols); }
      lastDims[sl] = { rows: rows, cols: cols };
      var values = [];
      for (var i = 0; i < rows; i++) { var row = new Array(cols); for (var j = 0; j < cols; j++) row[j] = ''; values.push(row); }
      Object.keys(gc).forEach(function (ch) { var m = gc[ch]; Object.keys(m).forEach(function (k) { var p = k.split('_'); if (values[p[0]]) values[p[0]][p[1]] = m[k]; }); });
      var out = Object.assign({}, st, { ok: true, sheet: st.sheet || procName, values: values, rows: rows, cols: cols });
      if (light) { delete out.merges; delete out.namedRanges; delete out.backgrounds; delete out.excelMerges; out.merges = []; }
      return out;
    });
  }
  var lastDims = {};

  // live cell colors: kept in Firestore (copied from the Sheet by "تحديث شكل الشيت"); Apps Script only as a first-time fallback
  var colorMemo = {};
  // Colours are re-read from Firestore ONLY when the admin pulled new ones. A tiny document (meta/colors_ver)
  // is watched with a live listener: zero reads while nothing changes, one small read per change per device.
  var colorWatch = null, colorWatchNs = null, colorWatchOk = false, colorWatchUnsub = null, colorVerSeen = null, colorRefreshT = null;
  function colorsVerBump() {
    return getAdapter().then(function (a) {
      return a.set(metaPath('colors_ver'), { v: Date.now() + '-' + Math.random().toString(36).slice(2, 6), at: new Date().toISOString() }, false);
    });
  }
  function scheduleColorRefresh() {
    clearTimeout(colorRefreshT);
    colorRefreshT = setTimeout(function () {
      try { if (typeof window.__dpbForcePoll === 'function') window.__dpbForcePoll(); else if (typeof window.__dpbFetchLiveGrid === 'function') window.__dpbFetchLiveGrid(); } catch (e) {}
    }, 400);
  }
  function ensureColorWatch() {
    if (colorWatch && colorWatchNs === ns()) return colorWatch;
    if (colorWatchUnsub) { try { colorWatchUnsub(); } catch (e) {} colorWatchUnsub = null; }
    colorWatchNs = ns(); colorWatchOk = false; colorVerSeen = null; colorMemo = {};
    colorWatch = getAdapter().then(function (a) {
      if (!a.listenDoc) return;
      return new Promise(function (resolve) {
        var first = true;
        try {
          colorWatchUnsub = a.listenDoc(metaPath('colors_ver'), function (d) {
            var v = d && d.v ? String(d.v) : '';
            colorWatchOk = true;
            if (first) { first = false; colorVerSeen = v; resolve(); return; }
            if (v !== colorVerSeen) { colorVerSeen = v; colorMemo = {}; scheduleColorRefresh(); }
          }, function (err) { colorWatchOk = false; noteErr('colors watch', err); colorWatch = null; if (first) { first = false; resolve(); } });
        } catch (e) { colorWatchOk = false; colorWatch = null; resolve(); }
      });
    }).catch(function () { colorWatch = null; });
    return colorWatch;
  }
  function liveColorsFor(procName) {
    return ensureColorWatch().then(function () {
      var m = colorMemo[procName];
      // with a working watcher a stored colour set stays valid until the version changes; otherwise 20 s like before
      if (m && (m.v && colorWatchOk || Date.now() - m.at < 20000)) return m.v;
      return getAdapter().then(function (a) {
        return bigGet('colors_' + slug(procName)).then(function (v) {
          if (v) { colorMemo[procName] = { at: Date.now(), v: v }; return v; }
          return null;
        });
      }).then(function (v) {
        if (v) return v;
        var base = window.DPB_getScriptUrl && window.DPB_getScriptUrl();
        if (!base) return m ? m.v : null;
        return origFetch(base, { method: 'POST', body: JSON.stringify({ action: 'getGridBatch', processes: [procName], includeColors: true, light: true }) })
          .then(function (r) { return r.json(); })
          .then(function (j) { var g = j && j.grids && j.grids[procName]; var c = g && g.liveColors || null; colorMemo[procName] = { at: Date.now(), v: c }; return c; });
      }).catch(function () { return m ? m.v : null; });
    });
  }

  /* ------------------------------------------- KV store (map catalog / snapshots) in Firestore */
  var KV_PART = 200000;
  function toB64(u8) { var out = '', CH = 0x8000; for (var i = 0; i < u8.length; i += CH) out += String.fromCharCode.apply(null, u8.subarray(i, i + CH)); return btoa(out); }
  function fromB64(b) { var t = atob(b), u = new Uint8Array(t.length); for (var i = 0; i < t.length; i++) u[i] = t.charCodeAt(i); return u; }
  function gz(str) {
    if (str.length < 100000 || typeof CompressionStream === 'undefined') return Promise.resolve(str);
    var cs = new CompressionStream('gzip'), w = cs.writable.getWriter();
    w.write(new TextEncoder().encode(str)); w.close();
    return new Response(cs.readable).arrayBuffer().then(function (b) { return 'gz1:' + toB64(new Uint8Array(b)); }, function () { return str; });
  }
  function gunz(str) {
    if (str == null || String(str).slice(0, 4) !== 'gz1:') return Promise.resolve(str);
    var ds = new DecompressionStream('gzip'), w = ds.writable.getWriter();
    w.write(fromB64(str.slice(4))); w.close();
    return new Response(ds.readable).text();
  }
  function kvGetStr(key) {
    var k = 'kv_' + slug(key);
    return getAdapter().then(function (a) {
      return a.get(metaPath(k)).then(function (h) {
        if (!h) return null;
        var n = Number(h.n) || 0; if (!n) return h.json != null ? String(h.json) : null;
        var base = k + '_' + (h.g ? h.g + '_' : '');
        var jobs = []; for (var i = 0; i < n; i++) jobs.push(a.get(metaPath(base + i)));
        return Promise.all(jobs).then(function (parts) {
          return gunz(parts.map(function (x) { return (x && x.t) || ''; }).join(''));
        }).catch(function (e) { noteErr('kv decode ' + key, e); return null; });
      });
    });
  }
  function kvSetStr(key, str) {
    var k = 'kv_' + slug(key), g = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    return Promise.all([getAdapter(), gz(str)]).then(function (ar) {
      var a = ar[0], packed = ar[1], parts = []; for (var i = 0; i < packed.length; i += KV_PART) parts.push(packed.slice(i, i + KV_PART));
      if (!parts.length) parts.push('');
      return a.get(metaPath(k)).catch(function () { return null; }).then(function (prev) {
        // parts of this write live under their own generation id; the header flips to it only when ALL parts are in,
        // so a reader (or a second writer) can never glue pieces of two different writes together
        var chain = Promise.resolve();
        parts.forEach(function (t, i) { chain = chain.then(function () { return a.set(metaPath(k + '_' + g + '_' + i), { t: t }, false); }); });
        return chain.then(function () { return a.set(metaPath(k), { n: parts.length, len: str.length, g: g, at: new Date().toISOString() }, false); }).then(function () {
          if (prev && Number(prev.n) > 0 && a.del) {   // best-effort: drop the previous version's parts
            var old = k + '_' + (prev.g ? prev.g + '_' : ''), c2 = Promise.resolve();
            for (var x = 0; x < Number(prev.n); x++) (function (x) { c2 = c2.then(function () { return a.del(metaPath(old + x)); }).catch(function () {}); })(x);
          }
        });
      });
    });
  }
  var kvCopying = {};
  function kvGetOp(body) {
    return kvGetStr(body.key).then(function (str) {
      if (str != null) return { ok: true, json: str };
      // first read in Firestore mode: copy once from the old Apps Script KV
      var base = window.DPB_getScriptUrl && window.DPB_getScriptUrl();
      if (!base) return { ok: true, json: '{}' };
      return origFetch(base, { method: 'POST', body: JSON.stringify({ action: 'kvGet', key: body.key }) })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (j && j.ok && j.json && j.json !== '{}') {
            if (!kvCopying[body.key]) {
              kvCopying[body.key] = kvSetStr(body.key, String(j.json)).catch(function (e) { noteErr('kv copy ' + body.key, e); }).then(function () { delete kvCopying[body.key]; });
            }
            return { ok: true, json: String(j.json) };
          }
          return { ok: true, json: '{}' };
        }, function () { return { ok: true, json: '{}' }; });
    });
  }
  function kvPatchOp(body) {
    var set = body.set || {};
    if (body.replace) return kvSetStr(body.key, JSON.stringify(set)).then(function () { return { ok: true }; });
    return kvGetStr(body.key).then(function (str) {
      var cur = {}; try { cur = JSON.parse(str || '{}') || {}; } catch (e) { cur = {}; }
      Object.keys(set).forEach(function (k) { cur[k] = set[k]; });
      (body.unset || body.remove || []).forEach(function (k) { delete cur[k]; });
      return kvSetStr(body.key, JSON.stringify(cur));
    }).then(function () { return { ok: true }; });
  }

  function getGrid(procName, includeColors, light, slim) {
    return buildGrid(procName, light, slim).then(function (g) {
      if (!includeColors) return g;
      return liveColorsFor(procName).then(function (c) { if (c) g.liveColors = c; return g; });
    });
  }
  function getGridBatch(names, includeColors, light) {
    var grids = {};
    return Promise.all((names || []).map(function (n) {
      n = String(n || '').trim(); if (!n) return null;
      return getGrid(n, includeColors, light).then(function (g) { grids[n] = g; }, function (e) { noteErr('grid ' + n, e); grids[n] = { ok: false, error: String(e && e.message || e) }; });
    })).then(function () { return { ok: true, grids: grids }; });
  }

  function getProduction(clientRev) {
    return prepareCaches().then(function () {
      var rev = ns() + ':' + recVersion;
      if (clientRev && String(clientRev) === rev) return { ok: true, unchanged: true, rev: rev, api: 2 };
      var data = allRecordsFromCache().map(function (p) {
        var r = Object.assign({}, p); r.recordId = r.recordId || r.id; return r;
      });
      return { ok: true, data: data, rev: rev, api: 2, serverTime: new Date().toISOString() };
    });
  }


  /* ------------------------- users / login / build result / history in Firestore */
  function sha256(str) {
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)).then(function (b) {
      return Array.prototype.map.call(new Uint8Array(b), function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    });
  }
  function pinHash(name, pin) { return sha256('dpbfs|' + String(name || '').trim().toLowerCase() + '|' + String(pin == null ? '' : pin).trim()); }
  function uName(u) { return String((u && (u.username || u.name || u.UserID || u.user)) || '').trim(); }
  function usersLoad() {
    return getAdapter().then(function (a) { return a.get(metaPath('users')).then(function (d) { return d && d.json ? JSON.parse(d.json) : null; }); });
  }
  function usersSave(list) {
    return getAdapter().then(function (a) { return a.set(metaPath('users'), { json: JSON.stringify(list), at: new Date().toISOString() }, false); });
  }
  function pubUser(u) { var c = clone(u); delete c.passHash; delete c.password; delete c.pin; return c; }
  function isActive(u) { var v = u.active; return !(v === false || String(v).toLowerCase() === 'false' || String(v).toLowerCase() === 'no'); }
  // returns null when users were not moved to Firestore yet (the request then goes to Apps Script as before)
  function usersOp(body) {
    return usersLoad().then(function (list) {
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
          var nu = clone(body.user || {}), nm = uName(nu); if (!nm) return { ok: false, error: 'no username' };
          var pw = nu.password != null ? nu.password : nu.pin; delete nu.password; delete nu.pin;
          var k = find(nm), old = k >= 0 ? list[k] : null;
          var hp = (pw != null && String(pw).trim() !== '') ? pinHash(nm, pw) : Promise.resolve(old ? old.passHash : '');
          return hp.then(function (h) {
            nu.passHash = h || '';
            if (k >= 0) list[k] = Object.assign({}, old, nu); else list.push(nu);
            return usersSave(list).then(function () { return { ok: true }; });
          });
        case 'deleteUser':
          var d = find(body.username); if (d >= 0) list.splice(d, 1);
          return usersSave(list).then(function () { return { ok: true }; });
      }
      return null;
    });
  }
  // one-time: copy the accounts from the Sheet's Users tab into Firestore (passwords stored only as hashes)
  function seedUsers() {
    var base = sheetBase(); if (!base) return Promise.reject(new Error('مفيش رابط مشروع'));
    var pin = lsGet('DPB_ADMIN_PIN_V1', ''); if (!pin) return Promise.reject(new Error('مفيش PIN أدمن محفوظ على الجهاز — سجّل دخول الأدمن الأول'));
    return origFetch(base, { method: 'POST', body: JSON.stringify({ action: 'getUsers', auth: { username: 'Admin', password: pin } }) })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (!res || !res.ok || !Array.isArray(res.users)) throw new Error('قراءة المستخدمين من الشيت فشلت' + (res && res.error ? ': ' + res.error : ''));
        if (res.pinsHidden === true) throw new Error('السيرفر خبّى الباسوردات — سجّل دخول الأدمن بالـ PIN وجرّب تاني');
        return Promise.all(res.users.map(function (u) {
          var c = clone(u), pw = c.password != null ? c.password : c.pin; delete c.password; delete c.pin;
          return (pw != null && String(pw).trim() !== '' ? pinHash(uName(c), pw) : Promise.resolve('')).then(function (h) { c.passHash = h; return c; });
        })).then(function (list) { return usersSave(list).then(function () { return { ok: true, count: list.length }; }); });
      });
  }
  function histOp(body) {
    return getAdapter().then(function (a) {
      var e = clone(body); delete e.action;
      return a.set('dpb/' + ns() + '/hist/' + Date.now() + '_' + Math.random().toString(36).slice(2, 7), e, false).then(function () { return { ok: true }; });
    });
  }
  function copyFromScript(body, key) {
    var base = window.DPB_getScriptUrl && window.DPB_getScriptUrl(); if (!base) return Promise.resolve(null);
    return origFetch(base, { method: 'POST', body: JSON.stringify(body) }).then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.ok !== false && j.json) { return kvSetStr(key, JSON.stringify({ json: j.json, updated: j.updated || new Date().toISOString() })).then(function () { return { json: j.json, updated: j.updated || '' }; }); }
      return null;
    }, function () { return null; });
  }
  var buildCopy = null;
  function buildGetOp(body) {
    return kvGetStr('buildresult').then(function (str) {
      var o = null; try { o = str ? JSON.parse(str) : null; } catch (e) { o = null; }
      if (o) return o;
      if (!buildCopy) buildCopy = copyFromScript({ action: 'getBuildResult' }, 'buildresult').then(function (r) { buildCopy = null; return r; }, function (e) { buildCopy = null; throw e; });
      return buildCopy;
    }).then(function (o) {
      if (!o) return { ok: true, json: '', updated: '' };
      return body.metaOnly ? { ok: true, updated: o.updated || '' } : { ok: true, json: o.json, updated: o.updated || '' };
    });
  }
  function buildSetOp(body) { return kvSetStr('buildresult', JSON.stringify({ json: String(body.json || ''), updated: new Date().toISOString() })).then(function () { return { ok: true }; }); }
  function unitMapSetOp(body) { return kvSetStr('unitmap', JSON.stringify(body.rows || [])).then(function () { return { ok: true }; }); }

  /* ------------------------------------------------------------ fetch shim */
  var lastErr = '';
  function noteErr(where, e) {
    lastErr = where + ': ' + String((e && (e.code || e.name)) || '') + ' ' + String((e && e.message) || e || '');
    try { console.warn('[DPB_FS]', lastErr, e); } catch (x) {}
    try { badge(); } catch (x) {}
  }
  function jsonRes(obj) { return new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json' } }); }
  function failFor(name) { return function (e) { return fail(e, name); }; }
  function fail(e, name) { noteErr(name || 'request', e); return jsonRes({ ok: false, error: 'Firestore: ' + String(e && e.message || e) }); }

  window.fetch = function (input, init) {
    try {
      if (!mode()) return origFetch(input, init);
      var base = window.DPB_getScriptUrl && window.DPB_getScriptUrl();
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      if (!base || url.indexOf(base) !== 0) return origFetch(input, init);
      var method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      var q = {}; var qi = url.indexOf('?');
      if (qi >= 0) url.slice(qi + 1).split('&').forEach(function (kv) { var p = kv.split('='); q[decodeURIComponent(p[0])] = decodeURIComponent((p[1] || '').replace(/\+/g, ' ')); });
      if (method === 'POST') {
        var body = {}; try { body = JSON.parse((init && init.body) || '{}'); } catch (e) { body = {}; }
        switch (body.action) {
          case 'upsertMany': return upsertMany(body).then(jsonRes, failFor(body.action));
          case 'deleteMany': return deleteMany(body).then(jsonRes, failFor(body.action));
          case 'getGrid': return getGrid(body.process || body.sheet, false, false).then(jsonRes, failFor(body.action));
          case 'getGridBatch': return getGridBatch(body.processes, !!body.includeColors, !!body.light).then(jsonRes, failFor(body.action));
          case 'login': case 'getUsers': case 'saveUser': case 'deleteUser': case 'renewToken':
            return usersOp(body).then(function (r) { return r ? jsonRes(r) : origFetch(input, init); }, function () { return origFetch(input, init); });
          case 'logHistory': return histOp(body).then(jsonRes, failFor(body.action));
          case 'getBuildResult': return buildGetOp(body).then(jsonRes, failFor(body.action));
          case 'saveBuildResult': return buildSetOp(body).then(jsonRes, failFor(body.action));
          case 'saveUnitMap': return unitMapSetOp(body).then(jsonRes, failFor(body.action));
          case 'kvGet': return kvGetOp(body).then(jsonRes, failFor(body.action));
          case 'kvPatch': return kvPatchOp(body).then(jsonRes, failFor(body.action));
          case 'logProductivity': case 'sync': return Promise.resolve(jsonRes({ ok: true, skipped: 'firestore-mode' }));
          default: return origFetch(input, init);
        }
      }
      if (q.action === 'getGrid') return getGrid(q.process || q.sheet, false, false, true).then(jsonRes, failFor(q.action || 'pull'));
      if (q.action === 'getGridBatch') return getGridBatch(String(q.processes || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean), q.includeColors === '1' || q.includeColors === 'true', false).then(jsonRes, failFor(q.action || 'pull'));
      if (!q.action && !q.debug) return getProduction(q.rev).then(jsonRes, failFor(q.action || 'pull'));
      return origFetch(input, init);
    } catch (e) { return origFetch(input, init); }
  };

  /* ------------------------------------------------------- seed / helpers */
  // Upload a set of production records (e.g. the ones already on this device) into the
  // CURRENT Firestore project (namespace). Rebuilds every grid cell from the records.
  function seed(records, opts) {
    opts = opts || {};
    var onP = opts.onProgress || function () {};
    var groupedNames = opts.grouped || [];
    return getAdapter().then(function (a) {
      var recs = (records || []).filter(function (r) { return r && (r.id || r.recordId); }).map(function (r) { var c = clone(r); c.id = String(c.id || c.recordId); return c; });
      var byShard = {}, cells = {};
      recs.forEach(function (r) {
        var sh = shardOf(r), k = sh.col + '/' + sh.chunk;
        (byShard[k] = byShard[k] || { sh: sh, recs: {} }).recs[r.id] = r;
        if (hasCell(r) && r.process) { noteProc(r.process); cells[sh.proc + '|' + sh.chunk + '|' + r.sheet + '|' + r.r1 + '|' + r.c1 + '|' + r.process] = { sh: sh, cell: { sheet: r.sheet, r1: Number(r.r1), c1: Number(r.c1), process: r.process, processTab: r.processTab } }; }
      });
      var ops = [], grid = {};
      Object.keys(byShard).forEach(function (k) { ops.push({ path: 'dpb/' + ns() + '/' + k, data: { recs: byShard[k].recs }, merge: false }); });
      Object.keys(cells).forEach(function (k) {
        var c = cells[k], sh = byShard[c.sh.col + '/' + c.sh.chunk];
        var gk = c.sh.proc + '/' + c.sh.chunk;
        (grid[gk] = grid[gk] || { ps: c.sh.proc, ch: c.sh.chunk, cells: {} }).cells[c.cell.r1 + '_' + c.cell.c1] = cellValue(sh.recs, c.cell);
      });
      Object.keys(grid).forEach(function (k) { ops.push({ path: gridPath(grid[k].ps, grid[k].ch), data: { cells: grid[k].cells }, merge: false }); });
      ops.push({ path: metaPath('config'), data: { grouped: groupedNames, rowsPerChunk: ROWS, seededAt: new Date().toISOString(), seededCount: recs.length }, merge: true });
      ops.push({ path: metaPath('rev'), data: { n: Date.now() % 100000000, at: new Date().toISOString() }, merge: false });
      if (groupedNames.length) lsSet('dpb_fs_grouped_' + ns(), JSON.stringify(groupedNames));
      var total = ops.length, done = 0, i = 0;
      function next() {
        if (i >= ops.length) return Promise.resolve({ ok: true, records: recs.length, docs: total });
        var chunk = ops.slice(i, i + 20); i += 20;
        return a.batch(chunk).then(function () { done += chunk.length; onP(done, total); return next(); });
      }
      var structJobs = Promise.resolve();
      (opts.processes || []).forEach(function (p) { structJobs = structJobs.then(function () { return structFor(p).catch(function () {}); }); });
      return structJobs.then(next);
    });
  }


  /* --------------- phase 3: one-time migration of the REAL data from the Sheet into the current namespace */
  function fetchSheetProduction() {
    var base = sheetBase(); if (!base) return Promise.reject(new Error('مفيش رابط مشروع'));
    return origFetch(base + '?t=' + Date.now()).then(function (r) { return r.json(); }).then(function (j) {
      if (!j || j.ok === false || !Array.isArray(j.data)) throw new Error('قراءة الإنتاج من الشيت فشلت' + (j && j.error ? ': ' + j.error : ''));
      return j.data;
    });
  }
  function migrateAll(onMsg) {
    onMsg = onMsg || function () {};
    var out = { ns: ns() };
    onMsg('1/4 بقرا سجلات الإنتاج من الشيت...');
    return fetchSheetProduction().then(function (rows) {
      out.sheetRecords = rows.length;
      var gn = []; try { gn = (window.DPB_groupedProcessNames && window.DPB_groupedProcessNames()) || []; } catch (e) {}
      var procs = []; try { procs = window.__dpbGetLiveGridProcessNames ? window.__dpbGetLiveGridProcessNames() : []; } catch (e) {}
      onMsg('2/4 برفع ' + rows.length + ' سجل على Firestore (' + ns() + ')...');
      return seed(rows, { grouped: gn, processes: procs, onProgress: function (d, t) { onMsg('2/4 رفع السجلات... ' + d + ' / ' + t); } });
    }).then(function (r) {
      out.seeded = r.records; out.docs = r.docs;
      onMsg('3/4 بنسخ شكل الشيت وألوانه...');
      return refreshStructure(function (d, t, n) { onMsg('3/4 شكل الشيت... ' + d + ' / ' + t + ' (' + n + ')'); }).then(function (x) { out.structs = x.count; }, function (e) { out.structErr = String(e && e.message || e); });
    }).then(function () {
      onMsg('4/4 بنقل المستخدمين...');
      return seedUsers().then(function (x) { out.users = x.count; }, function (e) { out.usersErr = String(e && e.message || e); });
    }).then(function () { return out; });
  }

  function seedFromDevice(onProgress) {
    var store = {}; try { store = JSON.parse(localStorage.getItem('DPB_SHARED_PRODUCTION_V2') || '{}'); } catch (e) {}
    var gn = []; try { gn = (window.DPB_groupedProcessNames && window.DPB_groupedProcessNames()) || []; } catch (e) {}
    var procs = []; try { procs = window.__dpbGetLiveGridProcessNames ? window.__dpbGetLiveGridProcessNames() : []; } catch (e) {}
    return seed(store.records || [], { onProgress: onProgress, grouped: gn, processes: procs });
  }

  function test() {
    return getAdapter().then(function (a) {
      var t0 = Date.now();
      return a.set(metaPath('ping'), { at: new Date().toISOString() }, true).then(function () { return a.get(metaPath('ping')); }).then(function () { return { ok: true, ms: Date.now() - t0, ns: ns(), auth: authCfg() ? 'email' : 'anonymous' }; });
    });
  }



  /* ------------------------------------------- admin tools (Phase 1b) */
  function sheetBase() { return window.DPB_getScriptUrl && window.DPB_getScriptUrl(); }
  function liveNames() {
    var out = [], seen = {};
    try { (window.__dpbGetLiveGridProcessNames && window.__dpbGetLiveGridProcessNames() || []).forEach(function (n) { n = String(n || '').trim(); if (n && !seen[low(n)]) { seen[low(n)] = 1; out.push(n); } }); } catch (e) {}
    return out;
  }
  function seq(list, fn) { var p = Promise.resolve(), res = []; list.forEach(function (x, i) { p = p.then(function () { return fn(x, i); }).then(function (r) { res.push(r); }); }); return p.then(function () { return res; }); }
  function fetchSheetGrid(name, withColors) {
    var base = sheetBase(); if (!base) return Promise.reject(new Error('مفيش رابط مشروع'));
    return origFetch(base, { method: 'POST', body: JSON.stringify({ action: 'getGridBatch', processes: [name], includeColors: !!withColors, light: false }) })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var g = j && j.grids && j.grids[name];
        if (!g || g.ok === false || !Array.isArray(g.values)) throw new Error('قراءة ' + name + ' من الشيت فشلت');
        return g;
      });
  }

  // re-read the layout (merges / ranges / colors / size) of every live tab from the Sheet and overwrite the saved copy
  function refreshStructure(onP) {
    var names = liveNames(); if (!names.length) names = Object.keys(allProcNames()).map(function (k) { return knownProcs[k]; });
    if (!names.length) return Promise.reject(new Error('مفيش عمليات معروفة'));
    return getAdapter().then(function (a) {
      var done = 0;
      return seq(names, function (n) {
        return fetchSheetGrid(n, true).then(function (g) {
          var st = clone(g); delete st.values; var lc = st.liveColors; delete st.liveColors;
          var saveColors = lc ? bigSet('colors_' + slug(n), lc) : Promise.resolve();
          return saveColors.then(function () { return bigSet('struct_' + slug(n), st); }).then(function () { return bigSet('lite_' + slug(n), liteOf(st)); }).then(function () {
            delete colorMemo[n]; if (liteFor.mem) delete liteFor.mem[ns() + '|' + slug(n)];
            if (structFor.mem) delete structFor.mem[ns() + '|' + slug(n)];
            delete lastDims[slug(n)]; done++; if (onP) onP(done, names.length, n);
          });
        });
      }).then(function () { try { if (window.__dpbFetchLiveGrid) window.__dpbFetchLiveGrid(); } catch (e) {} return { ok: true, count: done, names: names }; });
    });
  }

  // compare the Sheet with Firestore and list what an import would change (nothing is written here)
  function importPreview(opts, onP) {
    opts = opts || {};
    var only = (opts.only || []).map(low).filter(Boolean);
    var names = liveNames().filter(function (n) { return !only.length || only.indexOf(low(n)) >= 0; });
    if (!names.length) return Promise.reject(new Error('مفيش عمليات للاستيراد'));
    var gcount = grouped([]).length || 3, items = [];
    return seq(names, function (n, i) {
      noteProc(n);
      return fetchSheetGrid(n).then(function (g) {
        return buildGrid(n, true).then(function (fsg) {
          var maxCode = grouped([]).some(function (x) { return low(x) === low(n); }) ? gcount : 9;
          var sets = [], clears = [], skipped = 0;
          g.values.forEach(function (row, r) {
            (row || []).forEach(function (v, c) {
              var raw = String(v == null ? '' : v).trim();
              var num = raw === '' ? 0 : Number(raw);
              if (!isFinite(num)) return;
              var cur = Number((fsg.values[r] || [])[c]) || 0;
              if (num > 0) {
                if (num !== Math.floor(num) || num > maxCode) { skipped++; return; }
                if (num !== cur) sets.push([r, c, num, cur]);
              } else if (cur > 0) clears.push([r, c, cur]);
            });
          });
          items.push({ proc: n, sheet: g.sheet || n, sets: sets, clears: clears, skipped: skipped });
          if (onP) onP(i + 1, names.length, n);
        });
      });
    }).then(function () {
      var tot = { sets: 0, clears: 0, skipped: 0 };
      items.forEach(function (it) { tot.sets += it.sets.length; tot.clears += it.clears.length; tot.skipped += it.skipped; });
      return { items: items, totals: tot };
    });
  }

  /* ------------------------------------------- pull from the Sheet (admin only): colours + numbers in one step */
  function isWhite(h) { h = String(h == null ? '' : h).trim().toLowerCase(); return !h || h === '#fff' || h === '#ffffff'; }
  function colorDiffCount(cur, nw) {
    var n = 0, R = Math.max((cur || []).length, (nw || []).length);
    for (var r = 0; r < R; r++) {
      var a = (cur && cur[r]) || [], b = (nw && nw[r]) || [], C = Math.max(a.length, b.length);
      for (var c = 0; c < C; c++) {
        var x = isWhite(a[c]) ? '' : String(a[c]).trim().toLowerCase(), y = isWhite(b[c]) ? '' : String(b[c]).trim().toLowerCase();
        if (x !== y) n++;
      }
    }
    return n;
  }
  // same rules as importPreview, but on a grid that was already read (so the Sheet is asked once per tab)
  function numbersDiff(n, g, fsg, gcount) {
    var maxCode = grouped([]).some(function (x) { return low(x) === low(n); }) ? gcount : 9;
    var sets = [], clears = [], skipped = 0;
    g.values.forEach(function (row, r) {
      (row || []).forEach(function (v, c) {
        var raw = String(v == null ? '' : v).trim();
        var num = raw === '' ? 0 : Number(raw);
        if (!isFinite(num)) return;
        var cur = Number((fsg.values[r] || [])[c]) || 0;
        if (num > 0) {
          if (num !== Math.floor(num) || num > maxCode) { skipped++; return; }
          if (num !== cur) sets.push([r, c, num, cur]);
        } else if (cur > 0) clears.push([r, c, cur]);
      });
    });
    return { proc: n, sheet: g.sheet || n, sets: sets, clears: clears, skipped: skipped };
  }
  // reads the Sheet and lists what would change in Firestore (nothing is written here)
  function pullPreview(opts, onP) {
    opts = opts || {};
    var withNums = opts.numbers !== false;
    var only = (opts.only || []).map(low).filter(Boolean);
    var names = liveNames().filter(function (n) { return !only.length || only.indexOf(low(n)) >= 0; });
    if (!names.length) return Promise.reject(new Error('مفيش عمليات للسحب'));
    var gcount = grouped([]).length || 3, items = [], colorItems = [];
    return seq(names, function (n, i) {
      noteProc(n);
      return fetchSheetGrid(n, true).then(function (g) {
        var lc = g.liveColors || null;
        return Promise.all([
          withNums ? buildGrid(n, true) : null,
          lc ? bigGet('colors_' + slug(n)).catch(function () { return null; }) : null
        ]).then(function (r) {
          if (lc) colorItems.push({ proc: n, lc: lc, changed: colorDiffCount(r[1], lc) });
          if (withNums) items.push(numbersDiff(n, g, r[0], gcount));
          if (onP) onP(i + 1, names.length, n);
        });
      });
    }).then(function () {
      var tot = { sets: 0, clears: 0, skipped: 0, colors: 0 };
      items.forEach(function (it) { tot.sets += it.sets.length; tot.clears += it.clears.length; tot.skipped += it.skipped; });
      colorItems.forEach(function (c) { tot.colors += c.changed; });
      return { items: items, colorItems: colorItems, totals: tot };
    });
  }
  // writes only the differences: changed colour sets (+ bumps the version so every device reloads them) and changed numbers
  function pullApply(plan, onP) {
    var ch = (plan.colorItems || []).filter(function (c) { return c.changed > 0; });
    var p = Promise.resolve();
    ch.forEach(function (c) { p = p.then(function () { return bigSet('colors_' + slug(c.proc), c.lc); }).then(function () { delete colorMemo[c.proc]; }); });
    return p.then(function () { return ch.length ? colorsVerBump() : null; }).then(function () {
      var tot = plan.totals || {};
      return (tot.sets || tot.clears) ? importApply(plan, onP) : { ok: true, sets: 0, clears: 0 };
    }).then(function (r) {
      try { if (window.__dpbFetchLiveGrid) window.__dpbFetchLiveGrid(); } catch (e) {}
      return { ok: true, colorSets: ch.length, colorCells: (plan.totals || {}).colors || 0, sets: r.sets, clears: r.clears };
    });
  }
  // automatic colours-only pull on THIS device while the admin screen is open (numbers are never pulled automatically)
  var LS_AUTO = 'dpb_fs_autopull', autoT = null, autoBusy = false, autoNote = '';
  function autoPullTick() {
    if (autoBusy || document.hidden || !mode()) return;
    var card = document.getElementById('dpbFsCard'); if (!card || !card.offsetParent) return;
    autoBusy = true;
    pullPreview({ numbers: false }).then(function (plan) { return pullApply(plan); }).then(function (r) {
      autoNote = new Date().toLocaleTimeString() + (r.colorSets ? ' — اتسحب ' + r.colorCells + ' خلية متغيّرة' : ' — مفيش تغيير');
    }, function (e) { autoNote = new Date().toLocaleTimeString() + ' — فشل: ' + (e && e.message || e); }).then(function () {
      autoBusy = false; var el = document.getElementById('dpbFsAutoMsg'); if (el) el.textContent = autoNote;
    });
  }
  function autoPullSet(on) {
    lsSet(LS_AUTO, on ? '1' : '0'); clearInterval(autoT); autoT = on ? setInterval(autoPullTick, 120000) : null;
  }

  // write the previewed changes. Each changed cell becomes ONE record (source SheetImport) so it follows the normal
  // rules afterwards (delete, lock, recompute). No cascade is added: the Sheet is taken as it is.
  function importApply(plan, onP) {
    var jobs = [], nSet = 0, nClear = 0;
    plan.items.forEach(function (it) {
      var by = {};
      it.sets.forEach(function (x) { var ch = String(Math.floor(x[0] / ROWS)); (by[ch] = by[ch] || { sets: [], clears: [] }).sets.push(x); });
      it.clears.forEach(function (x) { var ch = String(Math.floor(x[0] / ROWS)); (by[ch] = by[ch] || { sets: [], clears: [] }).clears.push(x); });
      Object.keys(by).forEach(function (ch) { jobs.push({ it: it, ch: ch, g: by[ch] }); });
    });
    var i = 0;
    function next() {
      if (i >= jobs.length) return Promise.resolve({ ok: true, sets: nSet, clears: nClear });
      var j = jobs[i++], col = 'rec_' + slug(j.it.proc), now = new Date().toISOString();
      return runPlan([{ col: col, chunk: j.ch }], function (api) {
        var sh = api.recs(col, j.ch), cells = [];
        function dropAt(r, c) {
          Object.keys(sh.recs).forEach(function (id) {
            var p = sh.recs[id];
            if (p && Number(p.r1) === r && Number(p.c1) === c && low(p.process) === low(j.it.proc)) { delete sh.recs[id]; sh.dirty = true; }
          });
        }
        j.g.sets.forEach(function (x) {
          var r = x[0], c = x[1];
          dropAt(r, c);
          var id = 'import_' + slug(j.it.proc) + '_' + r + '_' + c;
          sh.recs[id] = { id: id, time: now, user: 'Import', owner: 'Import', editedBy: 'Import', source: 'SheetImport', process: j.it.proc, code: x[2], sheet: j.it.sheet, r1: r, c1: c, r2: r, c2: c };
          sh.dirty = true; nSet++;
          cells.push({ process: j.it.proc, sheet: j.it.sheet, r1: r, c1: c, r2: r, c2: c });
        });
        j.g.clears.forEach(function (x) { dropAt(x[0], x[1]); nClear++; cells.push({ process: j.it.proc, sheet: j.it.sheet, r1: x[0], c1: x[1], r2: x[0], c2: x[1] }); });
        return { cells: cells };
      }).then(function () { if (onP) onP(i, jobs.length); return next(); });
    }
    return prepareCaches().then(next);
  }


  // records that exist but are not reflected on the map (cell value 0 / record sits outside its process shard)
  function findOrphans() {
    return prepareCaches().then(function () {
      var rc = recCache[ns()] || {}, list = [], slugs = {};
      Object.keys(rc).forEach(function (col) { Object.keys(rc[col]).forEach(function (ch) { Object.keys(rc[col][ch]).forEach(function (id) {
        var p = rc[col][ch][id]; if (!p || !p.process || !isFinite(Number(p.r1)) || !isFinite(Number(p.c1))) return;
        var v = progDone(p) ? Number(p.done) : Number(p.code);
        if (!(v > 0)) return;
        slugs[slug(p.process)] = 1; list.push({ id: id, col: col, chunk: ch, p: p });
      }); }); });
      return Promise.all(Object.keys(slugs).map(ensureGrid)).then(function () {
        var gc = gridCache[ns()] || {}, out = [];
        list.forEach(function (x) {
          var sl = slug(x.p.process), chunk = String(Math.floor(Number(x.p.r1) / ROWS));
          var cell = ((gc[sl] || {})[chunk] || {})[Number(x.p.r1) + '_' + Number(x.p.c1)];
          var misplaced = x.col === 'rec__other';
          if (!(Number(cell) > 0) || misplaced) out.push({ id: x.id, col: x.col, chunk: x.chunk, process: String(x.p.process), r1: Number(x.p.r1), c1: Number(x.p.c1), code: Number(x.p.code) || 0, sheet: String(x.p.sheet === undefined ? '(مفيش)' : x.p.sheet), why: misplaced ? 'برا مكانه' : 'مش ظاهر على الخريطة' });
        });
        return out;
      });
    });
  }
  function cleanOrphans(onP) {
    return findOrphans().then(function (orph) {
      var by = {}; orph.forEach(function (o) { var k = o.col + '/' + o.chunk; (by[k] = by[k] || { col: o.col, chunk: o.chunk, ids: [] }).ids.push(o.id); });
      var jobs = Object.keys(by).map(function (k) { return by[k]; }), i = 0;
      function next() {
        if (i >= jobs.length) return Promise.resolve({ ok: true, removed: orph.length });
        var j = jobs[i++];
        return runPlan([{ col: j.col, chunk: j.chunk }], function (api) {
          var sh = api.recs(j.col, j.chunk);
          j.ids.forEach(function (id) { if (sh.recs[id]) { delete sh.recs[id]; sh.dirty = true; } });
          return { cells: [] };
        }).then(function () { if (onP) onP(i, jobs.length); return next(); });
      }
      return next();
    });
  }


  // recompute EVERY cell value from the records (fixes cells whose saved value disagrees with their records)
  function rebuildGrid(onP) {
    return prepareCaches().then(function () {
      var rc = recCache[ns()] || {}, byCell = {}, slugs = {};
      Object.keys(rc).forEach(function (col) { Object.keys(rc[col]).forEach(function (ch) { Object.keys(rc[col][ch]).forEach(function (id) {
        var p = rc[col][ch][id]; if (!p || !p.process || !isFinite(Number(p.r1)) || !isFinite(Number(p.c1))) return;
        var sl = slug(p.process), k = sl + '|' + Number(p.r1) + '|' + Number(p.c1);
        slugs[sl] = 1; (byCell[k] = byCell[k] || { sl: sl, r: Number(p.r1), c: Number(p.c1), process: String(p.process), recs: {} }).recs[id] = p;
      }); }); });
      return Promise.all(Object.keys(slugs).map(ensureGrid)).then(function () {
        var gc = gridCache[ns()] || {}, docs = {};
        function doc(sl, ch) { var k = sl + '/' + ch; return docs[k] || (docs[k] = { sl: sl, ch: ch, cells: {} }); }
        Object.keys(gc).forEach(function (sl) { Object.keys(gc[sl]).forEach(function (ch) { Object.keys(gc[sl][ch]).forEach(function (ck) { doc(sl, ch).cells[ck] = 0; }); }); });
        var changed = 0;
        Object.keys(byCell).forEach(function (k) {
          var b = byCell[k], ch = String(Math.floor(b.r / ROWS)), ck = b.r + '_' + b.c;
          var v = cellValue(b.recs, { process: b.process, r1: b.r, c1: b.c });
          var old = (((gc[b.sl] || {})[ch] || {})[ck]);
          if (Number(old) !== v) changed++;
          doc(b.sl, ch).cells[ck] = v;
        });
        Object.keys(gc).forEach(function (sl) { Object.keys(gc[sl]).forEach(function (ch) { Object.keys(gc[sl][ch]).forEach(function (ck) { var o = gc[sl][ch][ck]; if (Number(o) > 0 && doc(sl, ch).cells[ck] === 0 && !byCell[sl + '|' + ck.replace('_', '|')]) changed++; }); }); });
        var list = Object.keys(docs).map(function (k) { return docs[k]; });
        return getAdapter().then(function (a) {
          var i = 0;
          function next() {
            if (i >= list.length) return Promise.resolve({ ok: true, docs: list.length, changed: changed });
            var part = list.slice(i, i + 20); i += 20;
            return a.batch(part.map(function (d) { return { path: gridPath(d.sl, d.ch), data: { cells: d.cells }, merge: false }; })).then(function () {
              part.forEach(function (d) { var m = (gridCache[ns()] = gridCache[ns()] || {}); (m[d.sl] = m[d.sl] || {})[d.ch] = d.cells; });
              if (onP) onP(Math.min(i, list.length), list.length); return next();
            });
          }
          return next().then(function (r) { recVersion++; return r; });
        });
      });
    });
  }

  // quick health check of what Firestore holds: counts per process + cells with more than one record of the same stage
  function inspect() {
    return prepareCaches().then(function () {
      var recs = allRecordsFromCache(), per = {}, seen = {}, dups = [];
      recs.forEach(function (r) {
        var p = String(r.process || '(بدون عملية)'); per[p] = (per[p] || 0) + 1;
        if (hasCell(r) && r.process) { var k = low(r.process) + '|' + r.r1 + '|' + r.c1; (seen[k] = seen[k] || []).push(r.id); }
      });
      Object.keys(seen).forEach(function (k) { if (seen[k].length > 1) dups.push({ cell: k, ids: seen[k] }); });
      return findOrphans().then(function (orph) { return { total: recs.length, per: per, dups: dups, orphans: orph }; });
    });
  }

  /* ------------------------------------------------------------- admin UI */
  function esc(t) { return String(t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function badge() {
    var b = document.getElementById('dpbFsBadge');
    if (!mode()) { if (b) b.remove(); return; }
    if (!b) {
      b = document.createElement('div'); b.id = 'dpbFsBadge';
      b.style.cssText = 'position:fixed;left:6px;top:calc(env(safe-area-inset-top,0px) + 4px);z-index:2147483000;padding:2px 8px;border-radius:999px;font:700 10px system-ui;background:#b3261e;color:#fff;opacity:.92;pointer-events:none';
      (document.body || document.documentElement).appendChild(b);
    }
    b.textContent = '🔥 Firestore: ' + ns() + (lastErr ? '  ⚠️ ' + lastErr.slice(0, 90) : '');
    b.style.background = lastErr ? '#8a1c14' : '#b3261e';
  }
  function mountPanel() {
    var host = document.querySelector('.dpbAdminTabPanel[data-tab="sync"]');
    if (!host || document.getElementById('dpbFsCard')) return;
    var c = document.createElement('section'); c.className = 'dpbAdminCard'; c.id = 'dpbFsCard';
    c.innerHTML =
      '<h3>🔥 Firestore (المرحلة 1 - تجريبي)</h3>' +
      '<div class="hint">النظام القديم (Google Sheet) هو الافتراضي. التفعيل هنا بيحوّل الحفظ والحذف وسحب الخريطة والسجلات لـ Firestore على مشروع تجريبي منفصل، ومبيلمسش بياناتك الحقيقية.</div>' +
      '<label class="hint" style="display:block;margin-top:8px">اسم المشروع التجريبي (namespace)</label>' +
      '<input id="dpbFsNs" style="width:100%;box-sizing:border-box;padding:8px;border-radius:8px" value="' + esc(ns()) + '">' +
      '<label class="hint" style="display:block;margin-top:8px">Firebase config (JSON: apiKey, authDomain, projectId, appId ...)</label>' +
      '<textarea id="dpbFsCfg" rows="4" style="width:100%;box-sizing:border-box;padding:8px;border-radius:8px;direction:ltr;font:12px monospace" placeholder="{&quot;apiKey&quot;:&quot;...&quot;,&quot;projectId&quot;:&quot;...&quot;}">' + esc(lsGet(LS_CFG, '')) + '</textarea>' +
      '<label class=\"hint\" style=\"display:block;margin-top:8px\">حساب Firebase (Email/Password) — سيبه فاضي = دخول مجهول (للتجربة بس)</label>' +
      '<input id=\"dpbFsEmail\" type=\"email\" autocomplete=\"off\" style=\"width:100%;box-sizing:border-box;padding:8px;border-radius:8px;direction:ltr\" placeholder=\"app@yourdomain.com\" value=\"' + esc((authCfg() || {}).email || '') + '\">' +
      '<input id=\"dpbFsPass\" type=\"password\" autocomplete=\"off\" style=\"width:100%;box-sizing:border-box;padding:8px;border-radius:8px;margin-top:6px;direction:ltr\" placeholder=\"' + (authCfg() ? '•••••• (محفوظ — اكتب باسورد جديد لتغييره)' : 'password') + '\">' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">' +
      '<button type="button" class="dpbAdminBtn" id="dpbFsSave">حفظ الإعدادات</button>' +
      '<button type="button" class="dpbAdminBtn" id="dpbFsTest">اختبار الاتصال</button>' +
      '<button type="button" class="dpbAdminBtn" id="dpbFsSeed">رفع بيانات الجهاز لـ Firestore</button>' +
      '<button type="button" class="dpbAdminBtn" id="dpbFsToggle"></button></div>' +
      '<div style="margin-top:12px;border-top:1px solid rgba(128,128,128,.3);padding-top:10px">' +
      '<div class="hint">أدوات الأدمن</div>' +
      '<label class="hint" style="display:block;margin-top:6px">استيراد من الشيت لمراحل معينة (سيبه فاضي = كل المراحل، أو اكتب الأسماء بفاصلة)</label>' +
      '<input id="dpbFsOnly" style="width:100%;box-sizing:border-box;padding:8px;border-radius:8px" placeholder="Ramming, Saddle, Bearing">' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">' +
      '<button type="button" class="dpbAdminBtn" id="dpbFsImpPrev">📥 استيراد من الشيت (معاينة)</button>' +
      '<button type="button" class="dpbAdminBtn" id="dpbFsImpGo" style="display:none">✅ تأكيد الاستيراد</button>' +
      '<button type="button" class="dpbAdminBtn" id="dpbFsStruct">🔄 تحديث شكل الشيت</button>' +
      '<button type="button" class="dpbAdminBtn" id="dpbFsPullPrev">⬇️ سحب من الشيت (ألوان + أرقام) — معاينة</button>' +
      '<button type="button" class="dpbAdminBtn" id="dpbFsPullGo" style="display:none">✅ تأكيد السحب</button>' +
      '<button type="button" class="dpbAdminBtn" id="dpbFsMigrate">🚀 نقل كل بيانات الشيت الحقيقية (مرة واحدة)</button>' +
      '<button type="button" class="dpbAdminBtn" id="dpbFsUsers">👤 نقل المستخدمين لـ Firestore</button>' +
      '<button type="button" class="dpbAdminBtn" id="dpbFsInspect">🔎 فحص السجلات</button>' +
      '<button type="button" class="dpbAdminBtn" id="dpbFsRebuild">🔧 إعادة حساب الخريطة من السجلات</button>' +
      '<button type="button" class="dpbAdminBtn" id="dpbFsClean" style="display:none">🧹 حذف السجلات اللي مش ظاهرة على الخريطة</button></div></div>' +
      '<label class="hint" style="display:flex;gap:6px;align-items:center;margin-top:8px"><input type="checkbox" id="dpbFsPullColorsOnly"> السحب بالزرار: ألوان فقط (بدون أرقام)</label>' +
      '<label class="hint" style="display:flex;gap:6px;align-items:center;margin-top:4px"><input type="checkbox" id="dpbFsAuto"> سحب الألوان تلقائياً كل دقيقتين (على الجهاز ده بس، طول ما الشاشة دي مفتوحة)</label>' +
      '<div class="hint" id="dpbFsAutoMsg" style="margin-top:2px"></div>' +
      '<div class="hint" id="dpbFsMsg" style="margin-top:8px;white-space:pre-line"></div>';
    host.appendChild(c);
    var $ = function (id) { return document.getElementById(id); };
    function msg(t) { $('dpbFsMsg').textContent = t; }
    function refresh() { $('dpbFsToggle').textContent = mode() ? '⏹ إيقاف Firestore (رجوع للنظام القديم)' : '▶ تشغيل Firestore'; badge(); }
    function save() {
      var raw = $('dpbFsCfg').value.trim();
      if (raw) { try { var o = JSON.parse(raw); if (!o.projectId) throw new Error('projectId ناقص'); lsSet(LS_CFG, JSON.stringify(o)); adapter = null; adapterP = null; } catch (e) { msg('❌ الـ config مش JSON صحيح: ' + e.message); return false; } }
      lsSet(LS_NS, ($('dpbFsNs').value.trim() || 'test'));
      var em = $('dpbFsEmail').value.trim(), pw = $('dpbFsPass').value;
      if (!em) { try { localStorage.removeItem(LS_AUTH); } catch (e) {} adapter = null; adapterP = null; }
      else {
        var prev = authCfg();
        if (!pw && prev && prev.email.toLowerCase() === em.toLowerCase()) pw = prev.password;
        if (!pw) { msg('❌ اكتب باسورد حساب Firebase'); return false; }
        lsSet(LS_AUTH, JSON.stringify({ email: em, password: pw })); $('dpbFsPass').value = ''; adapter = null; adapterP = null;
      }
      return true;
    }
    $('dpbFsSave').onclick = function () { if (save()) msg('✅ اتحفظ. المشروع: ' + ns()); };
    $('dpbFsTest').onclick = function () { if (!save()) return; msg('جاري الاختبار...'); test().then(function (r) { msg('✅ الاتصال شغال (' + r.ms + ' ms) على المشروع: ' + r.ns + ' — الدخول: ' + (r.auth === 'email' ? 'Email/Password 🔒' : 'مجهول (مش آمن)')); }, function (e) { msg('❌ فشل: ' + (e && e.message || e)); }); };
    $('dpbFsSeed').onclick = function () {
      if (!save()) return;
      if (!confirm('هيترفع كل سجلات الإنتاج الموجودة على الجهاز ده لـ Firestore (المشروع: ' + ns() + ') وتتبني الخلايا منها. متأكد؟')) return;
      msg('جاري الرفع...');
      seedFromDevice(function (d, t) { msg('جاري الرفع... ' + d + ' / ' + t); }).then(function (r) { msg('✅ اترفع ' + r.records + ' سجل (' + r.docs + ' وثيقة).'); }, function (e) { msg('❌ فشل الرفع: ' + (e && e.message || e)); });
    };
    $('dpbFsToggle').onclick = function () {
      if (!mode()) {
        if (!save()) return;
        if (!window.DPB_FS.hasConfig()) { msg('❌ ضيف Firebase config الأول.'); return; }
        test().then(function () { lsSet(LS_MODE, 'on'); refresh(); msg('✅ شغّال على Firestore (' + ns() + '). اقفل واحتح الخريطة.'); }, function (e) { msg('❌ مش هشغّل: الاتصال فشل - ' + (e && e.message || e)); });
      } else { lsSet(LS_MODE, 'off'); refresh(); msg('رجعنا للنظام القديم (Google Sheet).'); }
    };
    var lastPlan = null;
    function needOn() { if (!mode()) { msg('❌ شغّل Firestore الأول.'); return false; } if (!save()) return false; return true; }
    $('dpbFsMigrate').onclick = function () {
      if (!needOn()) return;
      if (!window.confirm('هينقل كل سجلات الإنتاج من الشيت إلى Firestore في الـ namespace: ' + ns() + '\nلو فيه بيانات هناك هتتكتب فوقها. ينفع نكمل؟')) return;
      migrateAll(msg).then(function (o) {
        msg('✅ خلص النقل في (' + o.ns + ')\nسجلات الشيت: ' + o.sheetRecords + ' ← اترفع: ' + o.seeded + ' سجل في ' + o.docs + ' وثيقة' +
          '\nشكل وألوان الشيت: ' + (o.structs != null ? o.structs + ' مرحلة' : '❌ ' + o.structErr) +
          '\nالمستخدمين: ' + (o.users != null ? o.users : '❌ ' + o.usersErr) +
          (o.seeded !== o.sheetRecords ? '\n⚠️ العدد مختلف — شغّل 🔎 فحص السجلات' : '\nاضغط 🔎 فحص السجلات للتأكد، واقفل الخريطة وافتحها.'));
      }, function (e) { msg('❌ ' + (e && e.message || e)); });
    };
    $('dpbFsUsers').onclick = function () {
      if (!needOn()) return; msg('جاري نقل المستخدمين...');
      seedUsers().then(function (r) { msg('✅ اتنقل ' + r.count + ' مستخدم. الباسوردات متخزنة كبصمة بس، والدخول بقى من Firestore.'); }, function (e) { msg('❌ ' + (e && e.message || e)); });
    };
    $('dpbFsStruct').onclick = function () {
      if (!needOn()) return; msg('جاري قراءة شكل الشيت...');
      refreshStructure(function (d, t, n) { msg('جاري التحديث... ' + d + ' / ' + t + ' (' + n + ')'); }).then(function (r) { msg('✅ اتحدّث شكل ' + r.count + ' مرحلة: ' + r.names.join('، ') + '\nاقفل الخريطة وافتحها تاني.'); }, function (e) { msg('❌ فشل: ' + (e && e.message || e)); });
    };
    $('dpbFsImpPrev').onclick = function () {
      if (!needOn()) return; $('dpbFsImpGo').style.display = 'none'; lastPlan = null; msg('جاري المقارنة بين الشيت و Firestore...');
      var only = $('dpbFsOnly').value.split(/[,،]/).map(function (x) { return x.trim(); }).filter(Boolean);
      importPreview({ only: only }, function (d, t, n) { msg('بيقرا ' + d + ' / ' + t + ' (' + n + ')...'); }).then(function (p) {
        lastPlan = p;
        var lines = p.items.map(function (it) { return '• ' + it.proc + ': هيضيف/يغيّر ' + it.sets.length + ' خلية، وهيفضّي ' + it.clears.length + (it.skipped ? ' (اتجاهل ' + it.skipped + ' رقم برا النطاق)' : ''); });
        if (!p.totals.sets && !p.totals.clears) { msg('✅ مفيش فرق بين الشيت و Firestore.\n' + lines.join('\n')); return; }
        msg('المعاينة (لسه ما اتكتبش حاجة):\n' + lines.join('\n') + '\n\nالإجمالي: ' + p.totals.sets + ' إضافة/تغيير، ' + p.totals.clears + ' تفضية.\nلو ماشي اضغط "تأكيد الاستيراد".');
        $('dpbFsImpGo').style.display = '';
      }, function (e) { msg('❌ فشلت المعاينة: ' + (e && e.message || e)); });
    };
    $('dpbFsImpGo').onclick = function () {
      if (!lastPlan) return;
      if (!confirm('هيتكتب في Firestore (المشروع: ' + ns() + '): ' + lastPlan.totals.sets + ' إضافة/تغيير و' + lastPlan.totals.clears + ' تفضية. الشيت نفسه مش هيتغيّر. متأكد؟')) return;
      var plan = lastPlan; lastPlan = null; $('dpbFsImpGo').style.display = 'none'; msg('جاري الاستيراد...');
      importApply(plan, function (d, t) { msg('جاري الاستيراد... ' + d + ' / ' + t); }).then(function (r) { msg('✅ تم الاستيراد: ' + r.sets + ' إضافة/تغيير، ' + r.clears + ' تفضية.'); try { if (window.__dpbFetchLiveGrid) window.__dpbFetchLiveGrid(); } catch (e) {} }, function (e) { msg('❌ فشل الاستيراد: ' + (e && e.message || e)); });
    };
    var lastPull = null;
    $('dpbFsPullPrev').onclick = function () {
      if (!needOn()) return; $('dpbFsPullGo').style.display = 'none'; lastPull = null; msg('جاري قراءة الشيت (ألوان وأرقام)... ممكن ياخد وقت');
      var only = $('dpbFsOnly').value.split(/[,،]/).map(function (x) { return x.trim(); }).filter(Boolean);
      var colorsOnly = $('dpbFsPullColorsOnly').checked;
      pullPreview({ only: only, numbers: !colorsOnly }, function (d, t, n) { msg('بيقرا ' + d + ' / ' + t + ' (' + n + ')...'); }).then(function (p) {
        lastPull = p;
        var lines = p.colorItems.map(function (c) { return '• ' + c.proc + ': ' + c.changed + ' خلية لون متغيّرة'; });
        p.items.forEach(function (it) { lines.push('• ' + it.proc + ' أرقام: هيضيف/يغيّر ' + it.sets.length + '، وهيفضّي ' + it.clears.length + (it.skipped ? ' (اتجاهل ' + it.skipped + ' برا النطاق)' : '')); });
        var t = p.totals;
        if (!t.colors && !t.sets && !t.clears) { msg('✅ مفيش فرق بين الشيت و Firestore.\n' + lines.join('\n')); return; }
        msg('المعاينة (لسه ما اتكتبش حاجة):\n' + lines.join('\n') + '\n\nالإجمالي: ' + t.colors + ' لون، ' + t.sets + ' رقم إضافة/تغيير، ' + t.clears + ' تفضية.' +
          (t.clears ? '\n⚠️ التفضية = خلية فيها رقم في Firestore ومفيهاش رقم في الشيت (ممكن تكون شغل مشرفين لسه ما اتسجلش في الشيت). لو مش عايزها اختار \"ألوان فقط\".' : '') + '\nلو ماشي اضغط \"تأكيد السحب\".');
        $('dpbFsPullGo').style.display = '';
      }, function (e) { msg('❌ فشلت القراءة: ' + (e && e.message || e)); });
    };
    $('dpbFsPullGo').onclick = function () {
      if (!lastPull) return; var plan = lastPull, t = plan.totals;
      if (!confirm('هيتكتب في Firestore (' + ns() + '): ' + t.colors + ' لون، ' + t.sets + ' رقم، و' + t.clears + ' تفضية. الشيت نفسه مش هيتغيّر. متأكد؟')) return;
      lastPull = null; $('dpbFsPullGo').style.display = 'none'; msg('جاري الكتابة...');
      pullApply(plan, function (d, tt) { msg('جاري الكتابة... ' + d + ' / ' + tt); }).then(function (r) { msg('✅ تم السحب: ' + r.colorCells + ' لون (' + r.colorSets + ' مرحلة)، ' + r.sets + ' رقم، ' + r.clears + ' تفضية.\nالمشرفين هيشوفوا التغيير لحظياً.'); }, function (e) { msg('❌ فشل: ' + (e && e.message || e)); });
    };
    $('dpbFsAuto').checked = lsGet(LS_AUTO, '0') === '1';
    $('dpbFsAuto').onchange = function () {
      if (this.checked && !needOn()) { this.checked = false; return; }
      autoPullSet(this.checked); $('dpbFsAutoMsg').textContent = this.checked ? 'شغّال — أول سحب بعد دقيقتين' : 'متوقف';
    };
    if (autoNote) $('dpbFsAutoMsg').textContent = autoNote;
    $('dpbFsInspect').onclick = function () {
      if (!needOn()) return; msg('جاري الفحص...');
      inspect().then(function (r) {
        var lines = Object.keys(r.per).sort().map(function (k) { return '• ' + k + ': ' + r.per[k]; });
        var d = r.dups.slice(0, 12).map(function (x) { return '  - ' + x.cell + ' → ' + x.ids.join(' , '); });
        var o = r.orphans.slice(0, 15).map(function (x) { return '  - ' + x.process + ' صف' + x.r1 + ' عمود' + x.c1 + ' كود' + x.code + ' (' + x.why + ') id=' + x.id; });
        $('dpbFsClean').style.display = r.orphans.length ? '' : 'none';
        msg('إجمالي السجلات: ' + r.total + '\n' + lines.join('\n') + '\n\nخلايا فيها أكتر من سجل لنفس المرحلة: ' + r.dups.length + (d.length ? '\n' + d.join('\n') : '') + '\n\nسجلات موجودة بس مش ظاهرة على الخريطة: ' + r.orphans.length + (o.length ? '\n' + o.join('\n') : ''));
      }, function (e) { msg('❌ فشل الفحص: ' + (e && e.message || e)); });
    };
    $('dpbFsRebuild').onclick = function () {
      if (!needOn()) return;
      if (!confirm('هيتحسب قيمة كل خلية من السجلات الموجودة في Firestore (المشروع: ' + ns() + '). السجلات نفسها مش هتتغيّر. متأكد؟')) return;
      msg('جاري إعادة الحساب...');
      rebuildGrid(function (d, t) { msg('جاري إعادة الحساب... ' + d + ' / ' + t); }).then(function (r) { msg('✅ اتحسبت الخريطة من جديد (' + r.docs + ' وثيقة)، وفيه ' + r.changed + ' خلية قيمتها اتغيّرت.\nاقفل الخريطة وافتحها تاني.'); try { if (window.__dpbFetchLiveGrid) window.__dpbFetchLiveGrid(); } catch (e) {} }, function (e) { msg('❌ فشل: ' + (e && e.message || e)); });
    };
    $('dpbFsClean').onclick = function () {
      if (!needOn()) return;
      if (!confirm('هيتمسح من Firestore (المشروع: ' + ns() + ') كل سجل موجود بس مش ظاهر على الخريطة. متأكد؟')) return;
      msg('جاري التنظيف...');
      cleanOrphans(function (d, t) { msg('جاري التنظيف... ' + d + ' / ' + t); }).then(function (r) { $('dpbFsClean').style.display = 'none'; msg('✅ اتمسح ' + r.removed + ' سجل.'); try { if (window.__dpbFetchLiveGrid) window.__dpbFetchLiveGrid(); } catch (e) {} }, function (e) { msg('❌ فشل: ' + (e && e.message || e)); });
    };
    refresh();
  }
  function boot() {
    if (lsGet(LS_AUTO, '0') === '1' && !autoT) autoPullSet(true);
    badge();
    mountPanel();
    try { new MutationObserver(function () { mountPanel(); }).observe(document.documentElement, { childList: true, subtree: true }); } catch (e) {}
  }
  if (typeof document !== 'undefined') { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot(); }

  window.DPB_FS = {
    mode: mode, ns: ns,
    setMode: function (on) { lsSet(LS_MODE, on ? 'on' : 'off'); },
    setNs: function (n) { lsSet(LS_NS, String(n || 'test')); },
    setConfig: function (c) { lsSet(LS_CFG, typeof c === 'string' ? c : JSON.stringify(c)); adapter = null; adapterP = null; },
    hasConfig: function () { var c = cfg(); return !!(c && c.projectId); },
    lastError: function () { return lastErr || adapterErr; },
    seed: seed, seedFromDevice: seedFromDevice, test: test, findOrphans: findOrphans, rebuildGrid: rebuildGrid, cleanOrphans: cleanOrphans, refreshStructure: refreshStructure, seedUsers: seedUsers, migrateAll: migrateAll, importPreview: importPreview, importApply: importApply, pullPreview: pullPreview, pullApply: pullApply, inspect: inspect,
    _internals: { upsertMany: upsertMany, deleteMany: deleteMany, getGrid: getGrid, getProduction: getProduction, cellValue: cellValue, slug: slug, setAdapter: function (a) { adapter = a; adapterP = null; }, ROWS: ROWS }
  };
})();
