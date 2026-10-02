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

  // shard for a record: (process slug, row block) | other bucket
  function shardOf(rec) {
    if (hasCell(rec) && rec.process) return { col: 'rec_' + slug(rec.process), chunk: String(Math.floor(Number(rec.r1) / ROWS)), proc: slug(rec.process) };
    return { col: 'rec__other', chunk: String(hash(rec.id || rec.recordId || '') % OTHER_BUCKETS), proc: '_other' };
  }
  function recPath(sh) { return 'dpb/' + ns() + '/' + sh.col + '/' + sh.chunk; }
  function gridPath(procSlug, chunk) { return 'dpb/' + ns() + '/grid_' + procSlug + '/' + chunk; }
  function metaPath(n) { return 'dpb/' + ns() + '/meta/' + n; }

  /* --------------------------------------------------------------- adapters */
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
      var ready = auth.currentUser ? Promise.resolve() : authM.signInAnonymously(auth);
      function dref(path) { var p = path.split('/'); return fsM.doc.apply(null, [db].concat(p)); }
      function cref(path) { var p = path.split('/'); return fsM.collection.apply(null, [db].concat(p)); }
      return ready.then(function () {
        return {
          kind: 'firebase',
          get: function (path) { return fsM.getDoc(dref(path)).then(function (s) { return s.exists() ? s.data() : null; }); },
          set: function (path, data, merge) { return fsM.setDoc(dref(path), data, merge ? { merge: true } : {}); },
          list: function (path) { return fsM.getDocs(cref(path)).then(function (q) { return q.docs.map(function (d) { return { id: d.id, data: d.data() }; }); }); },
          listen: function (path, cb, onErr) {
            return fsM.onSnapshot(cref(path), function (q) { cb(q.docs.map(function (d) { return { id: d.id, data: d.data() }; }), q.metadata.hasPendingWrites); }, onErr);
          },
          runTx: function (fn) {
            return fsM.runTransaction(db, function (t) {
              return fn({
                get: function (path) { return t.get(dref(path)).then(function (s) { return s.exists() ? s.data() : null; }); },
                set: function (path, data, merge) { t.set(dref(path), data, merge ? { merge: true } : {}); }
              });
            });
          },
          batch: function (ops) { // ops: [{path,data,merge}] up to 450
            var b = fsM.writeBatch(db);
            ops.forEach(function (o) { b.set(dref(o.path), o.data, o.merge ? { merge: true } : {}); });
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
        }, function (err) { delete ready[key]; if (first) { first = false; reject(err); } });
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
      if (!p || String(p.sheet) !== String(cell.sheet) || Number(p.r1) !== Number(cell.r1) || Number(p.c1) !== Number(cell.c1)) return;
      if (String(p.process || '') !== String(cell.process || '')) return;
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
  function upsertMany(body) {
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
  function structFor(procName) {
    var sl = slug(procName), key = ns() + '|' + sl;
    structFor.mem = structFor.mem || {};
    if (structFor.mem[key]) return Promise.resolve(structFor.mem[key]);
    return getAdapter().then(function (a) {
      return a.get(metaPath('struct_' + sl)).then(function (d) {
        if (d && d.json) { var s = JSON.parse(d.json); structFor.mem[key] = s; return s; }
        // first time: copy the structure (merges / ranges / colors) from the existing Apps Script, read-only
        var base = window.DPB_getScriptUrl && window.DPB_getScriptUrl();
        if (!base) return null;
        return origFetch(base + '?action=getGrid&process=' + encodeURIComponent(procName) + '&t=' + Date.now())
          .then(function (r) { return r.json(); })
          .then(function (g) {
            if (!g || !g.ok) return null;
            var s = clone(g); delete s.values; delete s.liveColors;
            structFor.mem[key] = s;
            return a.set(metaPath('struct_' + sl), { json: JSON.stringify(s) }, false).then(function () { return s; }, function () { return s; });
          });
      });
    });
  }

  function buildGrid(procName, light) {
    var sl = slug(procName); noteProc(procName);
    return Promise.all([ensureGrid(sl), light ? Promise.resolve(null) : structFor(procName), ensureRecs('rec_' + sl)]).then(function (r) {
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

  // live Sheet colors (optional feature): fetched from Apps Script at most once a minute, read-only
  var colorMemo = {};
  function liveColorsFor(procName) {
    var m = colorMemo[procName];
    if (m && Date.now() - m.at < 60000) return Promise.resolve(m.v);
    var base = window.DPB_getScriptUrl && window.DPB_getScriptUrl();
    if (!base) return Promise.resolve(m ? m.v : null);
    return origFetch(base, { method: 'POST', body: JSON.stringify({ action: 'getGridBatch', processes: [procName], includeColors: true, light: true }) })
      .then(function (r) { return r.json(); })
      .then(function (j) { var g = j && j.grids && j.grids[procName]; var v = g && g.liveColors || null; colorMemo[procName] = { at: Date.now(), v: v }; return v; })
      .catch(function () { return m ? m.v : null; });
  }

  function getGrid(procName, includeColors, light) {
    return buildGrid(procName, light).then(function (g) {
      if (!includeColors) return g;
      return liveColorsFor(procName).then(function (c) { if (c) g.liveColors = c; return g; });
    });
  }
  function getGridBatch(names, includeColors, light) {
    var grids = {};
    return Promise.all((names || []).map(function (n) {
      n = String(n || '').trim(); if (!n) return null;
      return getGrid(n, includeColors, light).then(function (g) { grids[n] = g; }, function (e) { grids[n] = { ok: false, error: String(e && e.message || e) }; });
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

  /* ------------------------------------------------------------ fetch shim */
  function jsonRes(obj) { return new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json' } }); }
  function fail(e) { return jsonRes({ ok: false, error: 'Firestore: ' + String(e && e.message || e) }); }

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
          case 'upsertMany': return upsertMany(body).then(jsonRes, fail);
          case 'deleteMany': return deleteMany(body).then(jsonRes, fail);
          case 'getGrid': return getGrid(body.process || body.sheet, false, false).then(jsonRes, fail);
          case 'getGridBatch': return getGridBatch(body.processes, !!body.includeColors, !!body.light).then(jsonRes, fail);
          case 'logProductivity': case 'sync': return Promise.resolve(jsonRes({ ok: true, skipped: 'firestore-mode' }));
          default: return origFetch(input, init);
        }
      }
      if (q.action === 'getGrid') return getGrid(q.process || q.sheet, false, false).then(jsonRes, fail);
      if (q.action === 'getGridBatch') return getGridBatch(String(q.processes || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean), q.includeColors === '1' || q.includeColors === 'true', false).then(jsonRes, fail);
      if (!q.action && !q.debug) return getProduction(q.rev).then(jsonRes, fail);
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

  function seedFromDevice(onProgress) {
    var store = {}; try { store = JSON.parse(localStorage.getItem('DPB_SHARED_PRODUCTION_V2') || '{}'); } catch (e) {}
    var gn = []; try { gn = (window.DPB_groupedProcessNames && window.DPB_groupedProcessNames()) || []; } catch (e) {}
    var procs = []; try { procs = window.__dpbGetLiveGridProcessNames ? window.__dpbGetLiveGridProcessNames() : []; } catch (e) {}
    return seed(store.records || [], { onProgress: onProgress, grouped: gn, processes: procs });
  }

  function test() {
    return getAdapter().then(function (a) {
      var t0 = Date.now();
      return a.set(metaPath('ping'), { at: new Date().toISOString() }, true).then(function () { return a.get(metaPath('ping')); }).then(function () { return { ok: true, ms: Date.now() - t0, ns: ns() }; });
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
    b.textContent = '🔥 Firestore: ' + ns();
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
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">' +
      '<button type="button" class="dpbAdminBtn" id="dpbFsSave">حفظ الإعدادات</button>' +
      '<button type="button" class="dpbAdminBtn" id="dpbFsTest">اختبار الاتصال</button>' +
      '<button type="button" class="dpbAdminBtn" id="dpbFsSeed">رفع بيانات الجهاز لـ Firestore</button>' +
      '<button type="button" class="dpbAdminBtn" id="dpbFsToggle"></button></div>' +
      '<div class="hint" id="dpbFsMsg" style="margin-top:8px;white-space:pre-line"></div>';
    host.appendChild(c);
    var $ = function (id) { return document.getElementById(id); };
    function msg(t) { $('dpbFsMsg').textContent = t; }
    function refresh() { $('dpbFsToggle').textContent = mode() ? '⏹ إيقاف Firestore (رجوع للنظام القديم)' : '▶ تشغيل Firestore'; badge(); }
    function save() {
      var raw = $('dpbFsCfg').value.trim();
      if (raw) { try { var o = JSON.parse(raw); if (!o.projectId) throw new Error('projectId ناقص'); lsSet(LS_CFG, JSON.stringify(o)); adapter = null; adapterP = null; } catch (e) { msg('❌ الـ config مش JSON صحيح: ' + e.message); return false; } }
      lsSet(LS_NS, ($('dpbFsNs').value.trim() || 'test'));
      return true;
    }
    $('dpbFsSave').onclick = function () { if (save()) msg('✅ اتحفظ. المشروع: ' + ns()); };
    $('dpbFsTest').onclick = function () { if (!save()) return; msg('جاري الاختبار...'); test().then(function (r) { msg('✅ الاتصال شغال (' + r.ms + ' ms) على المشروع: ' + r.ns); }, function (e) { msg('❌ فشل: ' + (e && e.message || e)); }); };
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
    refresh();
  }
  function boot() {
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
    lastError: function () { return adapterErr; },
    seed: seed, seedFromDevice: seedFromDevice, test: test,
    _internals: { upsertMany: upsertMany, deleteMany: deleteMany, getGrid: getGrid, getProduction: getProduction, cellValue: cellValue, slug: slug, setAdapter: function (a) { adapter = a; adapterP = null; }, ROWS: ROWS }
  };
})();
