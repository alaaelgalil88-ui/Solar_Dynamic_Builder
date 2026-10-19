/* DPB service worker: تخزين الصفحة على الجهاز عشان تفتح من غير نت.
   النسخة المخزّنة أولًا (بتفتح فورًا حتى من غير نت)، والتحديث بينزل في الخلفية.
   لو اتفتحت النسخة المخزّنة وبعدها وصلت نسخة أحدث بنبعت للصفحة رسالة تعرض زرار "تحديث".
   طلبات السيرفر (Apps Script) مش بتتخزّن أبدًا. */
const CACHE='dpb-shell-v136';
const SDK_CACHE='dpb-sdk-v1'; // مكتبات Firebase (نسخة ثابتة 10.12.2، مابتتغيّرش) بتتخزّن على الجهاز عشان الطبقة تشتغل حتى لو التطبيق اتفتح من غير نت
const SDK_RE=/^https:\/\/www\.gstatic\.com\/firebasejs\//;
// كل ملف بيتخزّن لوحده: ملف ناقص (زي أيقونة أو اختلاف حروف index/Index) مابقاش بيفشّل تخزين الباقي كله.
const SHELL=['./','index.html','Index.html','dpb-config.js','dpb-fs.js','dpb-fs2-core.js','dpb-fs2.js','vendor/firebase-bundle.js','manifest.json','icon-192.png','icon-512.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>Promise.all(SHELL.map(u=>c.add(u).catch(()=>{})))).then(()=>self.skipWaiting()));});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE&&k!==SDK_CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
function versionOf(res){return (res.headers.get('etag')||'')+'|'+(res.headers.get('last-modified')||'')+'|'+(res.headers.get('content-length')||'');}
self.addEventListener('fetch',e=>{
  const r=e.request;
  if(r.method==='GET'&&SDK_RE.test(r.url)){
    e.respondWith((async()=>{
      const c=await caches.open(SDK_CACHE);
      const m=await c.match(r);
      if(m)return m;
      const res=await fetch(r);
      if(res&&res.ok)c.put(r,res.clone());
      return res;
    })());
    return;
  }
  if(r.method!=='GET'||new URL(r.url).origin!==location.origin)return;
  const p=new URL(r.url).pathname;
  const isPage=r.mode==='navigate'||/\.html?$/i.test(p)||/\/$/.test(p);
  e.respondWith((async()=>{
    const cache=await caches.open(CACHE);
    const cached=await cache.match(r,{ignoreSearch:true});
    // تحديث في الخلفية: بيجيب النسخة الجديدة ويخزّنها، ولو الصفحة اتغيّرت بيبلّغ الصفحة تعرض زرار "تحديث"
    const net=fetch(r).then(res=>{
      if(res&&res.ok){
        cache.put(r,res.clone());
        if(cached&&isPage&&versionOf(cached)!==versionOf(res)){
          self.clients.matchAll().then(cs=>cs.forEach(c=>c.postMessage({type:'dpb-update-ready'})));
        }
      }
      return res;
    });
    // فيه نسخة على الجهاز: افتح منها فورًا (من غير انتظار الشبكة). مفيش نسخة: الشبكة.
    if(cached){e.waitUntil(net.catch(()=>{}));return cached;}
    return net;
  })());
});
