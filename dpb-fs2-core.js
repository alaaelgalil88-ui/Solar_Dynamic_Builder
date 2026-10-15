/* DPB single-source cell layer (v2.1). One doc per (process,row) = the single truth; each cell is one field inside its row doc
   (dpb2/{ns}/rows/{process}_{row} -> cells.{col}). Two devices writing different cells of the same row never overwrite each other.
   No queue, no cascade_ ids, no local copies. Deleted cell = tombstone field (del:true + time).
   Meta docs have ids starting with "__" (e.g. __epoch__) and never show up as cells. */
(function (root) {
  function slug(s) { return String(s == null ? '' : s).trim().toLowerCase().replace(/[^a-z0-9\u0600-\u06ff]+/g, '-'); }
  var EPOCH_MARGIN_MS = 10 * 60 * 1000; // records older than (epoch - 10 min) are leftovers from the old system, never written
  function create(adapter, o) {
    o = o || {};
    var ns = o.ns || 'test', cache = {}, subs = [], broken = null;
    // project scope: every row doc belongs to ONE project (id prefix + projectId field), the listener only sees that project's docs,
    // so two projects that use the same process names can never read or overwrite each other's cells
    var base = {}, byDoc = {};   // base = executed cells of the published Excel, held in memory only (never written to Firestore cell by cell)
    function get(k) { var d = cache[k]; return d !== undefined ? d : base[k]; }   // a stored cell/tombstone always wins over the Excel baseline
    function keys() { var ks = Object.keys(cache); for (var k in base) if (!(k in cache)) ks.push(k); return ks; }
    var BASE_T = '1970-01-01T00:00:00.000Z';
    function setBase(list) {
      var b = {}; (list || []).forEach(function (x) { if (!x || x.process == null || x.r1 == null || x.c1 == null || !(Number(x.code) > 0)) return; var k = id(x.process, x.r1, x.c1); b[k] = { id: 'sheet_' + k, process: x.process, sheet: x.process, r1: x.r1, c1: x.c1, r2: x.r2 == null ? x.r1 : x.r2, c2: x.c2 == null ? x.c1 : x.c2, code: Number(x.code), time: BASE_T, source: 'SheetImport' }; });
      base = b; emit();
    }
   // row-doc id -> cache keys that doc contributed (so a changed doc replaces only its own cells)
    var P = o.pid ? String(o.pid).replace(/[^A-Za-z0-9_\-]/g, '_') : '', unsub = null, dead = false;
    // offset (ms) between this device's clock and the Firestore server clock; every stored time is device time + offset, so all devices agree
    function off() { try { var v = o.offset ? Number(o.offset()) : 0; return isFinite(v) ? v : 0; } catch (e) { return 0; } }
    function nowMs() { return Date.now() + off(); }
    function nowIso() { return new Date(nowMs()).toISOString(); }
    function id(p, r, c) { return slug(p) + '_' + Number(r) + '_' + Number(c); }
    var COL = 'dpb2/' + ns + '/rows';
    function rowId(p, r) { return (P ? P + '__' : '') + slug(p) + '_' + Number(r); }
    var EPOCH_ID = 'meta-epoch' + (P ? '-' + P : '');
    // one cell write = {p,r,c,data}; pack() folds all cell writes of the same row into ONE adapter op (= one Firestore write)
    function cw(p, r, c, data) { return { p: p, r: Number(r), c: Number(c), data: data }; }
    function pack(list) {
      var by = {}, order = [];
      list.forEach(function (x) {
        if (x.t) { order.push(x); return; }                       // meta op passes through untouched
        var k = rowId(x.p, x.r), o = by[k];
        if (!o) { o = by[k] = { t: 'f', path: COL + '/' + k, base: P ? { process: x.p, r: x.r, projectId: P } : { process: x.p, r: x.r }, cells: {} }; order.push(o); }
        o.cells[x.c] = x.data;                                      // later write of the same cell wins
      });
      return order;
    }
    function isMeta(k) { k = String(k); return k.slice(0, 2) === '__' || k.slice(0, 5) === 'meta-'; } // Firestore refuses doc ids like __x__, so the stored one is meta-epoch
    function norm(stages) { return (stages || []).map(function (s, i) { return { name: s.name, code: Number(s.code) || (i + 1) }; }).sort(function (a, b) { return a.code - b.code; }); }
    function stageOf(st, p) { for (var i = 0; i < st.length; i++) if (slug(st[i].name) === slug(p)) return st[i]; return null; }
    function emit() { subs.forEach(function (f) { try { f(); } catch (e) {} }); }
    var ready = new Promise(function (res, rej) {
      var done = false;
      unsub = adapter.listen(COL, function (docs, err, delta) {
        if (dead) return;
        if (err) {   // listener failed (rules / network / quota): before ready -> reject; AFTER ready the listener is dead for good, so tell the owner (it rebuilds the store)
          if (!done) { done = true; rej(err); } else { broken = err; try { if (o.onError) o.onError(err); } catch (e) {} }
          return;
        }
        // delta=true: docs holds ONLY the documents that changed (first snapshot = all of them once); each one replaces just its own cells.
        // delta falsy (old adapters / tests): docs is the whole collection and the cache is rebuilt from it, exactly as before.
        var m = delta ? cache : {};
        if (!delta) byDoc = {};
        docs.forEach(function (d) {
          var old = byDoc[d.id]; if (old) { for (var i = 0; i < old.length; i++) delete m[old[i]]; delete byDoc[d.id]; }
          if (d.removed || !d.data) return;
          var ks = [];
          if (isMeta(d.id)) { var mk = d.id === EPOCH_ID ? '__epoch__' : d.id; m[mk] = d.data; ks.push(mk); }
          else {
            var cells = (d.data && d.data.cells) || {};
            Object.keys(cells).forEach(function (col) {
              var cell = cells[col]; if (!cell) return;
              var k = id(cell.process != null ? cell.process : d.data.process, cell.r1 != null ? cell.r1 : d.data.r, cell.c1 != null ? cell.c1 : col);
              m[k] = cell; ks.push(k);
            });
          }
          byDoc[d.id] = ks;
        });
        cache = m;
        if (!done) { done = true; res(); } if (!delta || docs.length) emit();
      }, P ? { where: ['projectId', '==', P] } : null);
    });
    function live(d) { return d && !d.del && d.process != null && d.r1 != null; }
    function value(p, r, c) { var d = get(id(p, r, c)); return live(d) ? Number(d.code) || 0 : 0; }
    function epochMs() { var e = cache['__epoch__']; return e && e.time ? Date.parse(e.time) || 0 : 0; }
    // first device that opens the layer stamps the start time; older leftovers from the old system are ignored afterwards
    function ensureEpoch() {
      if (cache['__epoch__']) return Promise.resolve();
      var d = { time: nowIso(), meta: true }; if (P) d.projectId = P; cache['__epoch__'] = d;
      return adapter.write([{ t: 's', path: COL + '/' + EPOCH_ID, data: d }]).catch(function () { delete cache['__epoch__']; });
    }
    function lockOf(stages, p, r, c, skipIds) {
      var st = norm(stages), me = stageOf(st, p); if (!me) return null;
      for (var i = st.length - 1; i >= 0; i--) {
        var l = st[i]; if (l.code <= me.code) continue;
        var d = get(id(l.name, r, c));
        if (live(d) && Number(d.code) >= l.code && !(skipIds && skipIds[d.id])) return { process: p, r1: r, c1: c, lockedBy: l.name, value: Number(d.code), id: (get(id(p, r, c)) || {}).id, message: 'الخلية (صف ' + r + '، عمود ' + c + ') اتنفذت في ' + l.name + ' (قيمة ' + Number(d.code) + ') — احذفها من هناك الأول' };
      }
      return null;
    }
    // write ops; on failure put the local cache back exactly as it was so the map never shows a mark that was not saved
    function commit(ops, before) {
      return adapter.write(pack(ops)).catch(function (e) {
        Object.keys(before).forEach(function (k) { if (before[k] === undefined) delete cache[k]; else cache[k] = before[k]; });
        emit(); throw e;
      });
    }
    function put(records, stages) {
      var st = norm(stages), now = nowIso(), ops = [], pending = {}, before = {}, stale = [], ignored = 0, bumped = 0, ep = epochMs();
      records.forEach(function (rec) {
        if (!rec || !rec.process || rec.r1 == null || rec.c1 == null) return;
        var code = Number(rec.code) || 0, me = stageOf(st, rec.process), key = id(rec.process, rec.r1, rec.c1);
        var rawT = rec.time || rec.updatedAt, t = rawT ? String(rawT) : now, cur = pending[key] || get(key);
        var fresh = !rawT || Math.abs((Date.parse(t) || 0) - Date.now()) < 2 * 60 * 1000;   // judged on the device's own clock, as the app stamped it
        if (rawT && off() && Date.parse(t)) t = new Date(Date.parse(t) + off()).toISOString();   // then moved onto the server clock
        if (ep && rec.source !== 'SheetImport' && (Date.parse(t) || 0) < ep - EPOCH_MARGIN_MS) { ignored++; return; } // old-system leftover
        if (cur && String(cur.time || '') >= t) {
          // A fresh, deliberate user action (made within the last 2 minutes by this device) must never be dropped silently just because the
          // stored time looks newer: that happens when the stored record/tombstone came from a device whose clock runs ahead (or is in the
          // future for this device). The user is looking at the cell as it is now, so the action wins: its time is moved just past the stored one.
          var ct = Date.parse(cur.time) || 0;
          if (fresh && (cur.del || ct > nowMs()) && rec.source !== 'SheetImport' && rec.source !== 'Cascade') {
            t = new Date(ct + 1).toISOString(); bumped++;
          } else {
            if (live(cur) && String(cur.id) !== String(rec.id) && String(cur.time) > t) stale.push({ id: String(rec.id) });
            return;
          }
        }
        var d = Object.assign({}, rec, { id: String(rec.id || rec.recordId || key), code: code, time: t });
        if (!(key in before)) before[key] = cache[key];
        pending[key] = d;
        ops.push(cw(rec.process, rec.r1, rec.c1, d));
        if (me && code >= me.code && rec.source !== 'Cascade') st.forEach(function (e) {
          if (e.code >= me.code) return;
          var k = id(e.name, rec.r1, rec.c1), c2 = pending[k] || get(k);
          if (live(c2) && Number(c2.code) >= e.code) return;
          if (c2 && c2.del && String(c2.time) >= t) return;
          var c = Object.assign({}, rec, { id: k, process: e.name, code: e.code, source: 'Cascade', time: t });
          if (!(k in before)) before[k] = cache[k];
          pending[k] = c; ops.push(cw(e.name, rec.r1, rec.c1, c));
        });
      });
      Object.keys(pending).forEach(function (k) { cache[k] = pending[k]; });
      if (ops.length) emit();
      if (!ops.length) return Promise.resolve({ ok: true, written: 0, stale: stale, ignored: ignored, bumped: bumped });
      return commit(ops, before).then(function () { return { ok: true, written: ops.length, stale: stale, ignored: ignored, bumped: bumped }; });
    }
    function removeIds(ids, stages) {
      var want = {}; ids.forEach(function (x) { want[String(x)] = true; });
      var st = norm(stages), ops = [], blocked = [], deleted = 0, gone = [], before = {};
      keys().forEach(function (k) {
        var d = get(k); if (isMeta(k) || !live(d) || !want[d.id] && !want[k]) return;
        var lk = lockOf(st, d.process, d.r1, d.c1, want);
        if (lk) { lk.id = d.id; blocked.push(lk); return; }
        var tomb = { del: true, id: d.id, process: d.process, r1: d.r1, c1: d.c1, code: 0, time: nowIso() };
        before[k] = cache[k];
        ops.push(cw(d.process, d.r1, d.c1, tomb)); gone.push([k, tomb]); deleted++;
      });
      gone.forEach(function (g) { cache[g[0]] = g[1]; }); if (gone.length) emit();
      if (!ops.length) return Promise.resolve({ ok: true, deleted: 0, blocked: blocked });
      return commit(ops, before).then(function () { return { ok: true, deleted: deleted, blocked: blocked }; });
    }
    function removeCells(p, cells, stages) {
      var ids = []; cells.forEach(function (x) { var d = get(id(p, x.r, x.c)); if (live(d)) ids.push(d.id); });
      return removeIds(ids, stages);
    }
    // import: make process p match "cells" exactly ([{r,c,code,r2,c2}]); bypasses cascade and lock on purpose (the sheet is the truth)
    function importProcess(p, cells, dry) {
      var want = {}, ops = [], before = {}, add = 0, change = 0, remove = 0, now = nowIso();
      cells.forEach(function (x) {
        var k = id(p, x.r, x.c); want[k] = true; var cur = get(k);
        if (live(cur) && Number(cur.code) === Number(x.code)) return;
        if (live(cur)) change++; else add++;
        if (dry) return;
        before[k] = cur;
        var d = { id: 'sheet_' + k, process: p, sheet: p, r1: x.r, c1: x.c, r2: x.r2 == null ? x.r : x.r2, c2: x.c2 == null ? x.c : x.c2, code: Number(x.code), time: now, source: 'SheetImport' };
        cache[k] = d; ops.push(cw(p, x.r, x.c, d));
      });
      keys().forEach(function (k) {
        var d = get(k); if (isMeta(k) || !live(d) || slug(d.process) !== slug(p) || want[k]) return;
        remove++; if (dry) return;
        before[k] = d; var tomb = { del: true, id: d.id, process: d.process, r1: d.r1, c1: d.c1, code: 0, time: now };
        cache[k] = tomb; ops.push(cw(d.process, d.r1, d.c1, tomb));
      });
      var res = { add: add, change: change, remove: remove };
      if (dry || !ops.length) return Promise.resolve(res);
      emit();
      return commit(ops, before).then(function () { return res; });
    }
    function all() { return keys().filter(function (k) { return !isMeta(k); }).map(get).filter(live); }
    function counts() { var c = {}; all().forEach(function (d) { var k = d.process; c[k] = (c[k] || 0) + (Number(d.code) > 0 ? 1 : 0); }); return c; }
    function destroy() { dead = true; subs = []; try { if (typeof unsub === 'function') unsub(); } catch (e) {} }
    return { broken: function () { return broken; }, destroy: destroy, pid: P, adapter: adapter, ready: ready, put: put, removeIds: removeIds, removeCells: removeCells, importProcess: importProcess, ensureEpoch: ensureEpoch, epoch: epochMs, counts: counts, value: value, lockOf: lockOf, all: all, setBase: setBase, baseSize: function () { return Object.keys(base).length; }, onChange: function (f) { subs.push(f); }, id: id };
  }
  var api = { create: create, slug: slug, projectScoped: true };
  root.DPB_FS2_CORE = api; if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : this);
