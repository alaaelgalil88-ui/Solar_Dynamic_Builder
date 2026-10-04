/* DPB single-source cell layer. One doc per (process,row,col) = the single truth. No queue, no cascade_ ids, no local copies. */
(function (root) {
  function slug(s) { return String(s == null ? '' : s).trim().toLowerCase().replace(/[^a-z0-9\u0600-\u06ff]+/g, '-'); }
  function create(adapter, o) {
    o = o || {};
    var ns = o.ns || 'test', cache = {}, subs = [], first = null;
    function id(p, r, c) { return slug(p) + '_' + Number(r) + '_' + Number(c); }
    function path(p, r, c) { return 'dpb2/' + ns + '/cells/' + id(p, r, c); }
    // stages: [{name, code}] ordered; passed per call because the app sends them with each request
    function norm(stages) { return (stages || []).map(function (s, i) { return { name: s.name, code: Number(s.code) || (i + 1) }; }).sort(function (a, b) { return a.code - b.code; }); }
    function stageOf(st, p) { for (var i = 0; i < st.length; i++) if (slug(st[i].name) === slug(p)) return st[i]; return null; }
    function emit() { subs.forEach(function (f) { try { f(); } catch (e) {} }); }
    var ready = new Promise(function (res) {
      var done = false;
      adapter.listen('dpb2/' + ns + '/cells', function (docs) {
        var m = {}; docs.forEach(function (d) { m[d.id] = d.data; }); cache = m; if (!done) { done = true; res(); } emit();
      });
    });
    function live(d) { return d && !d.del; }
    function value(p, r, c) { var d = cache[id(p, r, c)]; return live(d) ? Number(d.code) || 0 : 0; }
    function lockOf(stages, p, r, c, skipIds) {
      var st = norm(stages), me = stageOf(st, p); if (!me) return null;
      for (var i = st.length - 1; i >= 0; i--) {
        var l = st[i]; if (l.code <= me.code) continue;
        var d = cache[id(l.name, r, c)];
        if (live(d) && Number(d.code) >= l.code && !(skipIds && skipIds[d.id])) return { process: p, r1: r, c1: c, lockedBy: l.name, value: Number(d.code), id: (cache[id(p, r, c)] || {}).id, message: 'الخلية (صف ' + r + '، عمود ' + c + ') اتنفذت في ' + l.name + ' (قيمة ' + Number(d.code) + ') — احذفها من هناك الأول' };
      }
      return null;
    }
    // records: app records ({id, process, r1, c1, code, ...}). Writes the cell doc + earlier-stage docs when this record reaches its own stage.
    function put(records, stages) {
      var st = norm(stages), now = new Date().toISOString(), ops = [], pending = {}, stale = [];
      records.forEach(function (rec) {
        if (!rec || !rec.process || rec.r1 == null || rec.c1 == null) return;
        var code = Number(rec.code) || 0, me = stageOf(st, rec.process), key = id(rec.process, rec.r1, rec.c1);
        var t = String(rec.time || rec.updatedAt || now), cur = pending[key] || cache[key];
        // an older copy never overwrites a newer one, and never brings back a deleted cell
        if (cur && String(cur.time || '') >= t) {
          if (live(cur) && String(cur.id) !== String(rec.id) && String(cur.time) > t) stale.push({ id: String(rec.id) });
          return;
        }
        var d = Object.assign({}, rec, { id: String(rec.id || rec.recordId || key), code: code, time: t });
        pending[key] = d;
        ops.push({ t: 's', path: path(rec.process, rec.r1, rec.c1), data: d });
        if (me && code >= me.code && rec.source !== 'Cascade') st.forEach(function (e) {
          if (e.code >= me.code) return;
          var k = id(e.name, rec.r1, rec.c1), c2 = pending[k] || cache[k];
          if (live(c2) && Number(c2.code) >= e.code) return;
          if (c2 && c2.del && String(c2.time) >= t) return;
          var c = Object.assign({}, rec, { id: k, process: e.name, code: e.code, source: 'Cascade', time: t });
          pending[k] = c; ops.push({ t: 's', path: path(e.name, rec.r1, rec.c1), data: c });
        });
      });
      Object.keys(pending).forEach(function (k) { cache[k] = pending[k]; });
      emit();
      return adapter.write(ops).then(function () { return { ok: true, written: ops.length, stale: stale }; });
    }
    // remove by record ids (what the app sends). Lock: a later grouped stage holding value >= its code on the same cell.
    function removeIds(ids, stages) {
      var want = {}; ids.forEach(function (x) { want[String(x)] = true; });
      var st = norm(stages), ops = [], blocked = [], deleted = 0, gone = [];
      Object.keys(cache).forEach(function (k) {
        var d = cache[k]; if (!live(d) || !want[d.id] && !want[k]) return;
        var lk = lockOf(st, d.process, d.r1, d.c1, want);
        if (lk) { lk.id = d.id; blocked.push(lk); return; }
        var tomb = { del: true, id: d.id, process: d.process, r1: d.r1, c1: d.c1, code: 0, time: new Date().toISOString() };
        ops.push({ t: 's', path: 'dpb2/' + ns + '/cells/' + k, data: tomb }); gone.push([k, tomb]); deleted++;
      });
      gone.forEach(function (g) { cache[g[0]] = g[1]; }); emit();
      return adapter.write(ops).then(function () { return { ok: true, deleted: deleted, blocked: blocked }; });
    }
    function removeCells(p, cells, stages) {
      var ids = []; cells.forEach(function (x) { var d = cache[id(p, x.r, x.c)]; if (live(d)) ids.push(d.id); });
      return removeIds(ids, stages);
    }
    function all() { return Object.keys(cache).map(function (k) { return cache[k]; }).filter(live); }
    return { ready: ready, put: put, removeIds: removeIds, removeCells: removeCells, value: value, lockOf: lockOf, all: all, onChange: function (f) { subs.push(f); }, id: id };
  }
  var api = { create: create, slug: slug };
  root.DPB_FS2_CORE = api; if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : this);
