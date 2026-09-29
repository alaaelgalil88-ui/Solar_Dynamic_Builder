/* DPB service worker: تخزين الصفحة على الجهاز عشان تفتح من غير نت.
   الشبكة أولًا (لحد 3.5 ثانية) عشان التحديثات توصل، وإلا النسخة المخزّنة.
   طلبات السيرفر (Apps Script) مش بتتخزّن أبدًا. */
const CACHE='dpb-shell-v2';
const SHELL=['./','index.html','manifest.json','icon-192.png','icon-512.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL).catch(()=>{})).then(()=>self.skipWaiting()));});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',e=>{
  const r=e.request;
  if(r.method!=='GET'||new URL(r.url).origin!==location.origin)return;
  e.respondWith((async()=>{
    const cache=await caches.open(CACHE);
    const cached=await cache.match(r,{ignoreSearch:true});
    const net=fetch(r).then(res=>{if(res&&res.ok)cache.put(r,res.clone());return res;});
    if(!cached)return net;
    return Promise.race([net.catch(()=>cached),new Promise(res=>setTimeout(()=>res(cached),3500))]);
  })());
});
