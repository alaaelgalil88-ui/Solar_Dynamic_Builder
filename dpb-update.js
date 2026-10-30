/* DPB in-app update (Capacitor only). Downloads a new copy of the web files (a few MB, only when you tap "تحديث"),
   switches to it, and falls back to the previous copy automatically if the new one does not start.
   Does nothing in the browser/PWA, or when the update plugin / update address is missing. */
(function () {
  'use strict';
  var P = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorUpdater;
  var CUR = String(window.DPB_WEB_VERSION || ''), BASE = String(window.DPB_UPDATE_URL || '');
  if (!P || !CUR || CUR === 'web') return;
  var LS = null, busy = false, lastCheck = 0;
  try { LS = window.localStorage; } catch (e) {}

  function cmp(a, b) {                       // numeric compare of "2026.1030.1200"
    var x = String(a).split('.'), y = String(b).split('.'), n = Math.max(x.length, y.length);
    for (var i = 0; i < n; i++) { var p = parseInt(x[i] || '0', 10), q = parseInt(y[i] || '0', 10); if (p !== q) return p < q ? -1 : 1; }
    return 0;
  }
  function lsGet(k) { try { return (LS && LS.getItem(k)) || ''; } catch (e) { return ''; } }
  function lsSet(k, v) { try { LS.setItem(k, v); } catch (e) {} }

  /* 1) tell the plugin this copy started fine (otherwise it rolls back by itself), then remove old copies */
  function confirmOk() {
    var tries = 0;
    (function wait() {
      tries++;
      if (document.querySelector('.app > aside')) {
        try { P.notifyAppReady(); } catch (e) {}
        setTimeout(cleanup, 8000);
      } else if (tries < 10) setTimeout(wait, 1000);
    })();
  }
  function cleanup() {
    try {
      Promise.all([P.list(), P.current()]).then(function (r) {
        var cur = r[1] && r[1].bundle && r[1].bundle.id, list = (r[0] && r[0].bundles) || [];
        list.forEach(function (b) { if (b.id && b.id !== cur && b.id !== 'builtin' && b.version !== 'builtin') { try { P.delete({ id: b.id }); } catch (e) {} } });
      }).catch(function () {});
    } catch (e) {}
  }
  try { P.addListener('updateFailed', function (ev) { var v = ev && ev.bundle && ev.bundle.version; if (v) lsSet('dpb_ota_failed', String(v)); }); } catch (e) {}

  /* 2) small bar at the top */
  function bar(html) {
    var b = document.getElementById('dpbOtaBar');
    if (!b) {
      b = document.createElement('div'); b.id = 'dpbOtaBar'; b.dir = 'rtl';
      b.style.cssText = 'position:fixed;left:10px;right:10px;top:calc(8px + env(safe-area-inset-top,0px));z-index:100001;display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 12px;border-radius:14px;background:#0b2238;border:1px solid #2f8fd0;color:#e8f4ff;font:700 13px system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.6)';
      document.body.appendChild(b);
    }
    b.innerHTML = html; return b;
  }
  function btn(id, txt, main) {
    return '<button type="button" id="' + id + '" style="border:0;border-radius:10px;padding:8px 14px;font:800 13px system-ui,sans-serif;color:#fff;background:' + (main ? '#1ca878' : '#27425c') + '">' + txt + '</button>';
  }
  function hide() { var b = document.getElementById('dpbOtaBar'); if (b) b.remove(); }
  function toast(t) { bar('<span>' + t + '</span>'); setTimeout(hide, 3500); }

  function offer(info) {
    var b = bar('<span style="flex:1 1 150px">🔄 تحديث جديد متاح<br><small style="font-weight:600;opacity:.8">التطبيق هيعيد التشغيل وبياناتك محفوظة</small></span>' + btn('dpbOtaGo', 'تحديث', true) + btn('dpbOtaLater', 'لاحقًا', false));
    b.querySelector('#dpbOtaLater').onclick = hide;
    b.querySelector('#dpbOtaGo').onclick = function () { install(info); };
  }
  function install(info) {
    if (busy) return; busy = true;
    bar('<span>⏳ جاري تنزيل التحديث…</span>');
    Promise.resolve(P.download({ url: BASE + info.file, version: String(info.version) })).then(function (bundle) {
      bar('<span>✅ تم التنزيل — بيتم التشغيل…</span>');
      return P.set(bundle);
    }).catch(function () {
      busy = false;
      bar('<span style="flex:1">تعذّر التنزيل — تأكد من النت وجرّب تاني</span>' + btn('dpbOtaX', 'حسنًا', false)).querySelector('#dpbOtaX').onclick = hide;
    });
  }

  /* 3) look for a newer version (a tiny file) */
  function check(manual) {
    if (!BASE || busy) return;
    var now = Date.now(); if (!manual && now - lastCheck < 15 * 60 * 1000) return; lastCheck = now;
    fetch(BASE + 'version.json?t=' + now, { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error('http'); return r.json(); }).then(function (j) {
      if (!j || !j.version || !j.file) return;
      if (cmp(j.version, CUR) <= 0) { if (manual) toast('أنت على آخر نسخة ✓'); return; }
      if (!manual && lsGet('dpb_ota_failed') === String(j.version)) return;
      offer(j);
    }).catch(function () { if (manual) toast('تعذّر الفحص — تأكد من النت'); });
  }
  window.dpbCheckUpdate = function () { check(true); };

  confirmOk();
  setTimeout(function () { check(false); }, 6000);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') check(false); });
})();
