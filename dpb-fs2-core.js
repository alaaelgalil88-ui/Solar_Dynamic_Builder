/* DPB single-source cell layer (v2.1). One doc per (process,row) = the single truth; each cell is one field inside its row doc
   (dpb2/{ns}/rows/{process}_{row} -> cells.{col}). Two devices writing different cells of the same row never overwrite each other.
   No queue, no cascade_ ids, no local copies. Deleted cell = tombstone field (del:true + time).
   Meta docs have ids starting with "__" (e.g. __epoch__) and never show up as cells. */
(function (root) {
  function slug(s) { return String(s == null ? '' : s).trim().toLowerCase().replace(/[^a-z0-9\u0600-\u06ff]+/g, '-'); }
  var EPOCH_MARGIN_MS = 10 * 60 * 1000; // records older than (epoch - 10 min) are leftovers from the old system, never written
  function create(adapter, o) {
    o = o || {};
    var ns = o.ns || 'test', cache = {}, subs = [];
    // project scope: every row doc belongs to ONE project (id prefix + projectId field), the listener only sees that project's docs,
    // so two projects that use the same process names can never read or overwrite each other's cells
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
      unsub = adapter.listen(COL, function (docs, err) {
        if (dead) return;
        if (err) { if (!done) { done = true; rej(err); } return; }   // listener failed (rules / network): report it, never hang
        var m = {};
        docs.forEach(function (d) {
          if (isMeta(d.id)) { m[d.id === EPOCH_ID ? '__epoch__' : d.id] = d.data; return; }
          var cells = (d.data && d.data.cells) || {};
          Object.keys(cells).forEach(function (col) {
            var cell = cells[col]; if (!cell) return;
            m[id(cell.process != null ? cell.process : d.data.process, cell.r1 != null ? cell.r1 : d.data.r, cell.c1 != null ? cell.c1 : col)] = cell;
          });
        });
        cache = m;
        if (!done) { done = true; res(); } emit();
      }, P ? { where: ['projectId', '==', P] } : null);
    });
    function live(d) { return d && !d.del && d.process != null && d.r1 != null; }
    function value(p, r, c) { var d = cache[id(p, r, c)]; return live(d) ? Number(d.code) || 0 : 0; }
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
        var d = cache[id(l.name, r, c)];
        if (live(d) && Number(d.code) >= l.code && !(skipIds && skipIds[d.id])) return { process: p, r1: r, c1: c, lockedBy: l.name, value: Number(d.code), id: (cache[id(p, r, c)] || {}).id, message: 'الخلية (صف ' + r + '، عمود ' + c + ') اتنفذت في ' + l.name + ' (قيمة ' + Number(d.code) + ') — احذفها من هناك الأول' };
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
        var rawT = rec.time || rec.updatedAt, t = rawT ? String(rawT) : now, cur = pending[key] || cache[key];
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
          var k = id(e.name, rec.r1, rec.c1), c2 = pending[k] || cache[k];
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
      Object.keys(cache).forEach(function (k) {
        var d = cache[k]; if (isMeta(k) || !live(d) || !want[d.id] && !want[k]) return;
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
      var ids = []; cells.forEach(function (x) { var d = cache[id(p, x.r, x.c)]; if (live(d)) ids.push(d.id); });
      return removeIds(ids, stages);
    }
    // import: make process p match "cells" exactly ([{r,c,code,r2,c2}]); bypasses cascade and lock on purpose (the sheet is the truth)
    function importProcess(p, cells, dry) {
      var want = {}, ops = [], before = {}, add = 0, change = 0, remove = 0, now = nowIso();
      cells.forEach(function (x) {
        var k = id(p, x.r, x.c); want[k] = true; var cur = cache[k];
        if (live(cur) && Number(cur.code) === Number(x.code)) return;
        if (live(cur)) change++; else add++;
        if (dry) return;
        before[k] = cur;
        var d = { id: 'sheet_' + k, process: p, sheet: p, r1: x.r, c1: x.c, r2: x.r2 == null ? x.r : x.r2, c2: x.c2 == null ? x.c : x.c2, code: Number(x.code), time: now, source: 'SheetImport' };
        cache[k] = d; ops.push(cw(p, x.r, x.c, d));
      });
      Object.keys(cache).forEach(function (k) {
        var d = cache[k]; if (isMeta(k) || !live(d) || slug(d.process) !== slug(p) || want[k]) return;
        remove++; if (dry) return;
        before[k] = d; var tomb = { del: true, id: d.id, process: d.process, r1: d.r1, c1: d.c1, code: 0, time: now };
        cache[k] = tomb; ops.push(cw(d.process, d.r1, d.c1, tomb));
      });
      var res = { add: add, change: change, remove: remove };
      if (dry || !ops.length) return Promise.resolve(res);
      emit();
      return commit(ops, before).then(function () { return res; });
    }
    function all() { return Object.keys(cache).filter(function (k) { return !isMeta(k); }).map(function (k) { return cache[k]; }).filter(live); }
    function counts() { var c = {}; all().forEach(function (d) { var k = d.process; c[k] = (c[k] || 0) + (Number(d.code) > 0 ? 1 : 0); }); return c; }
    function destroy() { dead = true; subs = []; try { if (typeof unsub === 'function') unsub(); } catch (e) {} }
    return { destroy: destroy, pid: P, adapter: adapter, ready: ready, put: put, removeIds: removeIds, removeCells: removeCells, importProcess: importProcess, ensureEpoch: ensureEpoch, epoch: epochMs, counts: counts, value: value, lockOf: lockOf, all: all, onChange: function (f) { subs.push(f); }, id: id };
  }
  var api = { create: create, slug: slug, projectScoped: true };
  root.DPB_FS2_CORE = api; if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : this);
