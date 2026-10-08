/* dpb-fs.js (v2) — Firebase connection card + one-cell diagnosis.
 *
 * The old Phase-1 Firestore layer (data under dpb/{ns}/..., grid/colors/records tools, its own fetch shim) is GONE.
 * Everything runs through dpb-fs2.js now (data under dpb2/{ns}/rows and dpb2/{ns}/kv); firestore.rules keeps dpb/** closed.
 *
 * What is left here:
 *  - the admin card (Admin > Sync): namespace, Firebase config, Email/Password account, save + test the connection,
 *    and the one-time move of the user accounts from the Sheet into Firestore (hashes only).
 *  - DPB_FS.diagCell(info): the one-cell diagnosis the map's 🔎 button calls (reads the dpb-fs2 store).
 * Keys it writes (read by dpb-fs2.js): dpb_fs_ns, dpb_fs_cfg, dpb_fs_auth.
 * Load BEFORE dpb-fs2.js (index.html already does).
 */
(function () {
  'use strict';
  if (window.DPB_FS) return;

  var LS_NS = 'dpb_fs_ns', LS_CFG = 'dpb_fs_cfg', LS_AUTH = 'dpb_fs_auth', LS_OLD_MODE = 'dpb_fs_mode';
  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function ns() { return String(lsGet(LS_NS, 'test') || 'test').replace(/[^A-Za-z0-9_\-]/g, '_'); }
  function cfg() { try { return JSON.parse(lsGet(LS_CFG, '') || 'null'); } catch (e) { return null; } }
  function authCfg() { try { var o = JSON.parse(lsGet(LS_AUTH, '') || 'null'); return o && o.email && o.password ? o : null; } catch (e) { return null; } }
  function low(x) { return String(x == null ? '' : x).trim().toLowerCase(); }
  function esc(t) { return String(t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  // the old Phase-1 layer is retired: a device that still has its switch on must not keep sending requests to dpb/** (closed by the rules)
  if (lsGet(LS_OLD_MODE, 'off') === 'on') lsSet(LS_OLD_MODE, 'off');

  /* ------------------------------------------------ one-cell diagnosis (what the app shows vs what Firestore holds) */
  function showDiag(text) {
    if (typeof document === 'undefined') return;
    var old = document.getElementById('dpbFsDiag'); if (old) old.remove();
    var o = document.createElement('div'); o.id = 'dpbFsDiag';
    o.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483100;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:12px';
    var b = document.createElement('div');
    b.style.cssText = 'background:#0d2233;color:#dceafa;border:1px solid #31516d;border-radius:14px;max-width:600px;width:100%;max-height:85vh;overflow:auto;padding:14px;direction:rtl;font:13px system-ui';
    var pre = document.createElement('pre'); pre.style.cssText = 'white-space:pre-wrap;margin:0 0 10px;font:12px/1.7 system-ui;user-select:text;-webkit-user-select:text'; pre.textContent = text;
    var x = document.createElement('button'); x.type = 'button'; x.textContent = 'إغلاق';
    x.style.cssText = 'padding:8px 18px;border-radius:10px;border:0;background:#2b6cb0;color:#fff;font:700 13px system-ui';
    x.onclick = function () { o.remove(); }; o.onclick = function (e) { if (e.target === o) o.remove(); };
    b.appendChild(pre); b.appendChild(x); o.appendChild(b); document.body.appendChild(o);
  }
  function diagCell(info) {
    info = info || {};
    var r1 = Number(info.r1), c1 = Number(info.c1), L = [];
    L.push('الخلية: ' + (info.label || '?') + (info.post ? ' — ' + info.post : '') + (info.rowLabel ? ' (' + info.rowLabel + ')' : '') + '   [صف ' + r1 + ' / عمود ' + c1 + ']');
    if (info.appLines && info.appLines.length) { L.push('', '— اللي التطبيق شايفه —'); info.appLines.forEach(function (x) { L.push(x); }); }
    function fin() { var t = L.join('\n'); showDiag(t); return t; }
    var F = window.DPB_FS2, C = window.DPB_FS2_CORE;
    if (!F || !C || !F.on()) { L.push('', 'الطبقة الجديدة (Firestore) مقفولة دلوقتي، فمفيش بيانات Firestore تتعرض.'); return Promise.resolve(fin()); }
    return F.store().then(function (s) {
      var recs = s.all().filter(function (p) { return p && Number(p.r1) === r1 && Number(p.c1) === c1; });
      var procs = {}; recs.forEach(function (p) { if (p.process) procs[C.slug(p.process)] = String(p.process); });
      (info.processes || []).forEach(function (n) { procs[C.slug(n)] = String(n); });
      var names = Object.keys(procs).map(function (k) { return procs[k]; });
      L.push('', '— اللي Firestore شايله —');
      names.forEach(function (n) {
        var mine = recs.filter(function (p) { return C.slug(p.process) === C.slug(n); });
        var maxCode = mine.reduce(function (m, p) { return Math.max(m, Number(p.code) || 0); }, 0);
        var v = s.value(n, r1, c1);
        L.push('• ' + n + ': قيمة الخلية = ' + (v ? v : '0 (مفيش)') + '  |  سجلات: ' + mine.length + (mine.length ? ' (أعلى كود ' + maxCode + ')' : ''));
      });
      if (recs.length) {
        L.push('', 'السجلات:');
        recs.slice(0, 12).forEach(function (p) { L.push('  - ' + p.process + ' | كود ' + p.code + ' | ' + (p.source || '—') + ' | ' + (p.user || p.editedBy || '—') + ' | ' + String(p.time || '').slice(0, 16).replace('T', ' ') + ' | id=' + p.id); });
        if (recs.length > 12) L.push('  ... و ' + (recs.length - 12) + ' كمان');
      } else L.push('', 'مفيش أي سجل في Firestore للخلية دي.');
      return fin();
    }, function (e) { L.push('', '❌ فشلت قراءة Firestore: ' + (e && e.message || e)); return fin(); });
  }

  /* ------------------------------------------------------------- admin card */
  function mountCard() {
    var host = document.querySelector('.dpbAdminTabPanel[data-tab="sync"]');
    if (!host || document.getElementById('dpbFsCard')) return;
    var c = document.createElement('section'); c.className = 'dpbAdminCard'; c.id = 'dpbFsCard';
    var inp = 'width:100%;box-sizing:border-box;padding:8px;border-radius:8px;direction:ltr';
    c.innerHTML =
      '<h3>🔌 اتصال Firebase والمستخدمين</h3>' +
      '<div class="hint">إعدادات الاتصال بـ Firebase اللي الطبقة الجديدة بتستخدمها. بعد أي تغيير في الإعدادات اقفل التطبيق وافتحه تاني.</div>' +
      '<label class="hint" style="display:block;margin-top:8px">اسم المشروع (namespace)</label>' +
      '<input id="dpbFsNs" style="' + inp + '" value="' + esc(ns()) + '">' +
      '<label class="hint" style="display:block;margin-top:8px">Firebase config (JSON: apiKey, authDomain, projectId, appId ...)</label>' +
      '<textarea id="dpbFsCfg" rows="4" style="' + inp + ';font:12px monospace" placeholder="{&quot;apiKey&quot;:&quot;...&quot;,&quot;projectId&quot;:&quot;...&quot;}">' + esc(lsGet(LS_CFG, '')) + '</textarea>' +
      '<label class="hint" style="display:block;margin-top:8px">حساب Firebase (Email/Password). لازم يتسجّل علشان قواعد الأمان تسمح بالقراءة والكتابة.</label>' +
      '<input id="dpbFsEmail" type="email" autocomplete="off" style="' + inp + '" placeholder="app@yourdomain.com" value="' + esc((authCfg() || {}).email || '') + '">' +
      '<input id="dpbFsPass" type="password" autocomplete="off" style="' + inp + ';margin-top:6px" placeholder="' + (authCfg() ? '•••••• (محفوظ — اكتب باسورد جديد لتغييره)' : 'password') + '">' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">' +
      '<button type="button" class="dpbAdminBtn" id="dpbFsSave">حفظ الإعدادات</button>' +
      '<button type="button" class="dpbAdminBtn" id="dpbFsTest">اختبار الاتصال</button>' +
      '<button type="button" class="dpbAdminBtn" id="dpbFsUsers">👤 نقل المستخدمين لـ Firestore</button></div>' +
      '<div class="hint" style="margin-top:6px">نقل المستخدمين: بيقرا الحسابات من الشيت مرة واحدة (محتاج PIN الأدمن محفوظ على الجهاز، سجّل دخول الأدمن الأول)، والباسوردات بتتخزّن كبصمة بس. بعدها الدخول وإدارة المستخدمين بيتمّوا من Firestore. لو Firestore مش متاح بيرجع للشيت تلقائي.</div>' +
      '<div class="hint" id="dpbFsMsg" style="margin-top:8px;white-space:pre-line"></div>';
    host.appendChild(c);
    var $ = function (id) { return document.getElementById(id); };
    function msg(t) { $('dpbFsMsg').textContent = t; }
    function save() {
      var raw = $('dpbFsCfg').value.trim();
      if (raw) { try { var o = JSON.parse(raw); if (!o.projectId) throw new Error('projectId ناقص'); lsSet(LS_CFG, JSON.stringify(o)); } catch (e) { msg('❌ الـ config مش JSON صحيح: ' + e.message); return false; } }
      lsSet(LS_NS, ($('dpbFsNs').value.trim() || 'test'));
      var em = $('dpbFsEmail').value.trim(), pw = $('dpbFsPass').value;
      if (!em) { try { localStorage.removeItem(LS_AUTH); } catch (e) {} }
      else {
        var prev = authCfg();
        if (!pw && prev && prev.email.toLowerCase() === em.toLowerCase()) pw = prev.password;
        if (!pw) { msg('❌ اكتب باسورد حساب Firebase'); return false; }
        lsSet(LS_AUTH, JSON.stringify({ email: em, password: pw })); $('dpbFsPass').value = '';
      }
      return true;
    }
    $('dpbFsSave').onclick = function () { if (save()) msg('✅ اتحفظ. المشروع: ' + ns() + '\nاقفل التطبيق وافتحه تاني علشان الإعدادات الجديدة تشتغل.'); };
    $('dpbFsTest').onclick = function () {
      if (!save()) return;
      var F = window.DPB_FS2; if (!F || !F.testConnection) { msg('❌ الطبقة الجديدة (dpb-fs2.js) مش محمّلة.'); return; }
      msg('جاري الاختبار...');
      F.testConnection().then(function (r) {
        msg('✅ الاتصال شغال (' + r.ms + ' ms) على المشروع: ' + r.ns + ' — الدخول: ' + (r.auth === 'email' ? 'Email/Password 🔒' : r.auth === 'emulator' ? 'Emulator محلي' : 'مجهول (القواعد هترفض)'));
      }, function (e) { msg('❌ فشل: ' + (e && e.message || e)); });
    };
    $('dpbFsUsers').onclick = function () {
      if (!save()) return;
      var F = window.DPB_FS2; if (!F || !F.seedUsers) { msg('❌ الطبقة الجديدة (dpb-fs2.js) مش محمّلة.'); return; }
      if (!F.on()) { msg('❌ شغّل الطبقة الجديدة الأول (كارت 🧩 تحت).'); return; }
      msg('جاري نقل المستخدمين...');
      F.seedUsers().then(function (r) { msg('✅ اتنقل ' + r.count + ' مستخدم. الباسوردات متخزنة كبصمة بس، والدخول بقى من Firestore.'); }, function (e) { msg('❌ ' + (e && e.message || e)); });
    };
  }
  function boot() { mountCard(); try { new MutationObserver(mountCard).observe(document.documentElement, { childList: true, subtree: true }); } catch (e) {} }
  if (typeof document !== 'undefined') { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot(); }

  window.DPB_FS = {
    mode: function () { return false; },   // the Phase-1 layer no longer exists
    ns: ns,
    setNs: function (n) { lsSet(LS_NS, String(n || 'test')); },
    setConfig: function (c) { lsSet(LS_CFG, typeof c === 'string' ? c : JSON.stringify(c)); },
    hasConfig: function () { var c = cfg(); return !!(c && c.projectId); },
    diagCell: diagCell
  };
})();
