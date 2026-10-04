/* DPB single-source cell layer (v2). One doc per (process,row,col) = the single truth.
   No queue, no cascade_ ids, no local copies. Deleted cell = tombstone doc (del:true + time).
   Meta docs have ids starting with "__" (e.g. __epoch__) and never show up as cells. */
(function (root) {
  function slug(s) { return String(s == null ? '' : s).trim().toLowerCase().replace(/[^a-z0-9\u0600-\u06ff]+/g, '-'); }
  var EPOCH_MARGIN_MS = 10 * 60 * 1000; // records older than (epoch - 10 min) are leftovers from the old system, never written
  function create(adapter, o) {
    o = o || {};
    var ns = o.ns || 'test', cache = {}, subs = [];
    function id(p, r, c) { return slug(p) + '_' + Number(r) + '_' + Number(c); }
    function path(p, r, c) { return 'dpb2/' + ns + '/cells/' + id(p, r, c); }
    function isMeta(k) { return String(k).slice(0, 2) === '__'; }
    function norm(stages) { return (stages || []).map(function (s, i) { return { name: s.name, code: Number(s.code) || (i + 1) }; }).sort(function (a, b) { return a.code - b.code; }); }
    function stageOf(st, p) { for (var i = 0; i < st.length; i++) if (slug(st[i].name) === slug(p)) return st[i]; return null; }
    function emit() { subs.forEach(function (f) { try { f(); } catch (e) {} }); }
    var ready = new Promise(function (res, rej) {
      var done = false;
      adapter.listen('dpb2/' + ns + '/cells', function (docs, err) {
        if (err) { if (!done) { done = true; rej(err); } return; }   // listener failed (rules / network): report it, never hang
        var m = {}; docs.forEach(function (d) { m[d.id] = d.data; }); cache = m;
        if (!done) { done = true; res(); } emit();
      });
    });
    function live(d) { return d && !d.del && d.process != null && d.r1 != null; }
    function value(p, r, c) { var d = cache[id(p, r, c)]; return live(d) ? Number(d.code) || 0 : 0; }
    function epochMs() { var e = cache['__epoch__']; return e && e.time ? Date.parse(e.time) || 0 : 0; }
    // first device that opens the layer stamps the start time; older leftovers from the old system are ignored afterwards
    function ensureEpoch() {
      if (cache['__epoch__']) return Promise.resolve();
      var d = { time: new Date().toISOString(), meta: true }; cache['__epoch__'] = d;
      return adapter.write([{ t: 's', path: 'dpb2/' + ns + '/cells/__epoch__', data: d }]).catch(function () { delete cache['__epoch__']; });
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
      return adapter.write(ops).catch(function (e) {
        Object.keys(before).forEach(function (k) { if (before[k] === undefined) delete cache[k]; else cache[k] = before[k]; });
        emit(); throw e;
      });
    }
    function put(records, stages) {
      var st = norm(stages), now = new Date().toISOString(), ops = [], pending = {}, before = {}, stale = [], ignored = 0, ep = epochMs();
      records.forEach(function (rec) {
        if (!rec || !rec.process || rec.r1 == null || rec.c1 == null) return;
        var code = Number(rec.code) || 0, me = stageOf(st, rec.process), key = id(rec.process, rec.r1, rec.c1);
        var t = String(rec.time || rec.updatedAt || now), cur = pending[key] || cache[key];
        if (ep && rec.source !== 'SheetImport' && (Date.parse(t) || 0) < ep - EPOCH_MARGIN_MS) { ignored++; return; } // old-system leftover
        if (cur && String(cur.time || '') >= t) {
          if (live(cur) && String(cur.id) !== String(rec.id) && String(cur.time) > t) stale.push({ id: String(rec.id) });
          return;
        }
        var d = Object.assign({}, rec, { id: String(rec.id || rec.recordId || key), code: code, time: t });
        if (!(key in before)) before[key] = cache[key];
        pending[key] = d;
        ops.push({ t: 's', path: path(rec.process, rec.r1, rec.c1), data: d });
        if (me && code >= me.code && rec.source !== 'Cascade') st.forEach(function (e) {
          if (e.code >= me.code) return;
          var k = id(e.name, rec.r1, rec.c1), c2 = pending[k] || cache[k];
          if (live(c2) && Number(c2.code) >= e.code) return;
          if (c2 && c2.del && String(c2.time) >= t) return;
          var c = Object.assign({}, rec, { id: k, process: e.name, code: e.code, source: 'Cascade', time: t });
          if (!(k in before)) before[k] = cache[k];
          pending[k] = c; ops.push({ t: 's', path: path(e.name, rec.r1, rec.c1), data: c });
        });
      });
      Object.keys(pending).forEach(function (k) { cache[k] = pending[k]; });
      if (ops.length) emit();
      if (!ops.length) return Promise.resolve({ ok: true, written: 0, stale: stale, ignored: ignored });
      return commit(ops, before).then(function () { return { ok: true, written: ops.length, stale: stale, ignored: ignored }; });
    }
    function removeIds(ids, stages) {
      var want = {}; ids.forEach(function (x) { want[String(x)] = true; });
      var st = norm(stages), ops = [], blocked = [], deleted = 0, gone = [], before = {};
      Object.keys(cache).forEach(function (k) {
        var d = cache[k]; if (isMeta(k) || !live(d) || !want[d.id] && !want[k]) return;
        var lk = lockOf(st, d.process, d.r1, d.c1, want);
        if (lk) { lk.id = d.id; blocked.push(lk); return; }
        var tomb = { del: true, id: d.id, process: d.process, r1: d.r1, c1: d.c1, code: 0, time: new Date().toISOString() };
        before[k] = cache[k];
        ops.push({ t: 's', path: 'dpb2/' + ns + '/cells/' + k, data: tomb }); gone.push([k, tomb]); deleted++;
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
      var want = {}, ops = [], before = {}, add = 0, change = 0, remove = 0, now = new Date().toISOString();
      cells.forEach(function (x) {
        var k = id(p, x.r, x.c); want[k] = true; var cur = cache[k];
        if (live(cur) && Number(cur.code) === Number(x.code)) return;
        if (live(cur)) change++; else add++;
        if (dry) return;
        before[k] = cur;
        var d = { id: 'sheet_' + k, process: p, sheet: p, r1: x.r, c1: x.c, r2: x.r2 == null ? x.r : x.r2, c2: x.c2 == null ? x.c : x.c2, code: Number(x.code), time: now, source: 'SheetImport' };
        cache[k] = d; ops.push({ t: 's', path: path(p, x.r, x.c), data: d });
      });
      Object.keys(cache).forEach(function (k) {
        var d = cache[k]; if (isMeta(k) || !live(d) || slug(d.process) !== slug(p) || want[k]) return;
        remove++; if (dry) return;
        before[k] = d; var tomb = { del: true, id: d.id, process: d.process, r1: d.r1, c1: d.c1, code: 0, time: now };
        cache[k] = tomb; ops.push({ t: 's', path: 'dpb2/' + ns + '/cells/' + k, data: tomb });
      });
      var res = { add: add, change: change, remove: remove };
      if (dry || !ops.length) return Promise.resolve(res);
      emit();
      return commit(ops, before).then(function () { return res; });
    }
    function all() { return Object.keys(cache).filter(function (k) { return !isMeta(k); }).map(function (k) { return cache[k]; }).filter(live); }
    function counts() { var c = {}; all().forEach(function (d) { var k = d.process; c[k] = (c[k] || 0) + (Number(d.code) > 0 ? 1 : 0); }); return c; }
    return { ready: ready, put: put, removeIds: removeIds, removeCells: removeCells, importProcess: importProcess, ensureEpoch: ensureEpoch, epoch: epochMs, counts: counts, value: value, lockOf: lockOf, all: all, onChange: function (f) { subs.push(f); }, id: id };
  }
  var api = { create: create, slug: slug };
  root.DPB_FS2_CORE = api; if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : this);
