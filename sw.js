/* DPB service worker: تخزين الصفحة على الجهاز عشان تفتح من غير نت.
   الشبكة أولًا (لحد 8 ثواني للصفحة، 3.5 للباقي) عشان التحديثات توصل، وإلا النسخة المخزّنة.
   لو اتفتحت النسخة المخزّنة وبعدها وصلت نسخة أحدث بنبعت للصفحة رسالة تعرض زرار "تحديث".
   طلبات السيرفر (Apps Script) مش بتتخزّن أبدًا. */
const CACHE='dpb-shell-v75';
// كل ملف بيتخزّن لوحده: ملف ناقص (زي أيقونة أو اختلاف حروف index/Index) مابقاش بيفشّل تخزين الباقي كله.
const SHELL=['./','index.html','Index.html','dpb-config.js','dpb-fs.js','dpb-fs2-core.js','dpb-fs2.js','manifest.json','icon-192.png','icon-512.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>Promise.all(SHELL.map(u=>c.add(u).catch(()=>{})))).then(()=>self.skipWaiting()));});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
function versionOf(res){return (res.headers.get('etag')||'')+'|'+(res.headers.get('last-modified')||'')+'|'+(res.headers.get('content-length')||'');}
self.addEventListener('fetch',e=>{
  const r=e.request;
  if(r.method!=='GET'||new URL(r.url).origin!==location.origin)return;
  const p=new URL(r.url).pathname;
  const isPage=r.mode==='navigate'||/\.html?$/i.test(p)||/\/$/.test(p);
  e.respondWith((async()=>{
    const cache=await caches.open(CACHE);
    const cached=await cache.match(r,{ignoreSearch:true});
    let servedStale=false;
    const net=fetch(r).then(res=>{
      if(res&&res.ok){
        cache.put(r,res.clone());
        if(cached&&isPage&&servedStale&&versionOf(cached)!==versionOf(res)){
          self.clients.matchAll().then(cs=>cs.forEach(c=>c.postMessage({type:'dpb-update-ready'})));
        }
      }
      return res;
    });
    if(!cached)return net;
    return Promise.race([net.catch(()=>cached),new Promise(res=>setTimeout(()=>{servedStale=true;res(cached);},isPage?8000:3500))]);
  })());
});
