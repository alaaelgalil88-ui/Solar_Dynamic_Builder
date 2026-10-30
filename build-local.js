/* DPB local APK builder - runs the same steps as .github/workflows/build-apk.yml, on this PC.
   Run it through build.bat (double click). Safe to run again and again: it updates, never wipes. */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const cp = require('child_process');
const zlib = require('zlib');

const ROOT = __dirname;
const WEB_FILES = ['index.html','sw.js','manifest.json','icon-192.png','icon-512.png','dpb-fs.js','dpb-fs2-core.js','dpb-fs2.js','dpb-config.js','dpb-version.js','dpb-update.js'];
const PLUGINS = ['@capacitor/core','@capacitor/cli','@capacitor/android','@capacitor/filesystem','@capacitor/share','@capacitor/local-notifications','@capacitor/push-notifications'];
const PERMS = ['POST_NOTIFICATIONS','SCHEDULE_EXACT_ALARM','RECEIVE_BOOT_COMPLETED','FOREGROUND_SERVICE','FOREGROUND_SERVICE_DATA_SYNC','WAKE_LOCK'];
const PKG_DIR = 'com/dpb/map/v2';
const APP_NAME = 'solar_productivity';
const isWin = process.platform === 'win32';

const log = m => console.log('\n==> ' + m);
function die(m) { console.error('\n[STOP] ' + m); process.exit(1); }
function run(cmd, opts) {
  const r = cp.spawnSync(cmd, Object.assign({ stdio: 'inherit', shell: true, cwd: ROOT }, opts || {}));
  if (r.status !== 0) die('Command failed: ' + cmd);
}
function out(cmd, opts) {
  const r = cp.spawnSync(cmd, Object.assign({ encoding: 'utf8', shell: true, cwd: ROOT }, opts || {}));
  return ((r.stdout || '') + (r.stderr || '')).trim();
}

/* ---------- pure helpers (tested) ---------- */
function patchManifest(xml) {
  PERMS.forEach(p => {
    if (!xml.includes('android.permission.' + p))
      xml = xml.replace('<application', '<uses-permission android:name="android.permission.' + p + '" />\n    <application');
  });
  if (!xml.includes('DpbKeepAliveService'))
    xml = xml.replace('</application>', '    <service android:name=".DpbKeepAliveService" android:exported="false" android:foregroundServiceType="dataSync" />\n    </application>');
  return xml;
}
function patchVersion(gradle, code, name) {
  gradle = gradle.replace(/versionCode\s+\d+/, 'versionCode ' + code);
  gradle = gradle.replace(/versionName\s+"[^"]*"/, 'versionName "' + name + '"');
  return gradle;
}
function patchStrings(xml, name) {
  xml = xml.replace(/(<string name="app_name">)[^<]*(<\/string>)/, '$1' + name + '$2');
  xml = xml.replace(/(<string name="title_activity_main">)[^<]*(<\/string>)/, '$1' + name + '$2');
  return xml;
}
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  fs.readdirSync(src, { withFileTypes: true }).forEach(e => {
    const a = path.join(src, e.name), b = path.join(dst, e.name);
    e.isDirectory() ? copyDir(a, b) : fs.copyFileSync(a, b);
  });
}
function javaMajor(text) {
  const m = /version "(\d+)(?:\.(\d+))?/.exec(text || '');
  if (!m) return 0;
  return m[1] === '1' ? Number(m[2]) : Number(m[1]);
}

/* ---------- in-app update package (zip) ---------- */
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function makeZip(files) {
  const parts = [], central = []; let offset = 0;
  const d = new Date(), dt = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), dd = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8'), raw = f.data, comp = zlib.deflateRawSync(raw, { level: 9 });
    const useC = comp.length < raw.length, data = useC ? comp : raw, method = useC ? 8 : 0, crc = crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(method, 8); lh.writeUInt16LE(dt, 10); lh.writeUInt16LE(dd, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26);
    parts.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(method, 10); ch.writeUInt16LE(dt, 12); ch.writeUInt16LE(dd, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}
function walkFiles(dir, base) {
  base = base || dir; let out = [];
  fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walkFiles(full, base));
    else out.push({ name: path.relative(base, full).split(path.sep).join('/'), data: fs.readFileSync(full) });
  });
  return out;
}
/* version = YEAR.MMDD.HHMM as plain numbers (valid semver, compared number by number in the app) */
function makeVersion(d) { return d.getFullYear() + '.' + ((d.getMonth() + 1) * 100 + d.getDate()) + '.' + (d.getHours() * 100 + d.getMinutes()); }
function readUpdateUrl() {
  const f = path.join(ROOT, 'update-url.txt');
  if (!fs.existsSync(f)) {
    fs.writeFileSync(f, '# Put ONE line below: the address of the "update" folder on GitHub Pages, for example:\n# https://YOURNAME.github.io/Solar_Dynamic_Builder/update/\n# Lines starting with # are ignored. Empty = in-app updates are switched off.\n');
    return '';
  }
  const line = fs.readFileSync(f, 'utf8').split(/\r?\n/).map(x => x.trim()).find(x => x && x[0] !== '#') || '';
  if (!line) return '';
  if (!/^https:\/\//.test(line)) die('update-url.txt must start with https://');
  return line.replace(/\/?$/, '/');
}
function writeVersionFile(version, url) {
  fs.writeFileSync(path.join(ROOT, 'www', 'dpb-version.js'), "window.DPB_WEB_VERSION='" + version + "';window.DPB_UPDATE_URL='" + url + "';\n");
}
function makeUpdatePackage(version) {
  const www = path.join(ROOT, 'www'), outDir = path.join(ROOT, 'update');
  fs.mkdirSync(outDir, { recursive: true });
  const file = 'dpb-www-' + version + '.zip';
  fs.writeFileSync(path.join(outDir, file), makeZip(walkFiles(www)));
  fs.writeFileSync(path.join(outDir, 'version.json'), JSON.stringify({ version, file }) + '\n');
  fs.readdirSync(outDir).filter(f => /^dpb-www-.*\.zip$/.test(f) && f !== file).sort().slice(0, -1).forEach(f => fs.unlinkSync(path.join(outDir, f)));
  return path.join(outDir, file);
}
function installUpdaterPlugin() {
  try {
    const core = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', '@capacitor', 'core', 'package.json'), 'utf8'));
    const major = core.version.split('.')[0], pj = path.join(ROOT, 'node_modules', '@capgo', 'capacitor-updater', 'package.json');
    let have = fs.existsSync(pj) ? JSON.parse(fs.readFileSync(pj, 'utf8')).version : '';
    if (!have || have.split('.')[0] !== major) {
      const r = cp.spawnSync('npm i @capgo/capacitor-updater@^' + major, { stdio: 'inherit', shell: true, cwd: ROOT });
      have = fs.existsSync(pj) ? JSON.parse(fs.readFileSync(pj, 'utf8')).version : '';
      if (r.status !== 0 || !have) { console.log('\n[WARNING] Could not install the in-app update plugin for Capacitor ' + major + '. The APK will still build, without in-app updates.'); return false; }
    }
    console.log('in-app update plugin ' + have + ' (Capacitor ' + core.version + ')');
    return true;
  } catch (e) { console.log('\n[WARNING] update plugin skipped: ' + e.message); return false; }
}

module.exports = { patchManifest, patchVersion, patchStrings, copyDir, javaMajor, makeZip, makeVersion, walkFiles, crc32 };

/* ---------- main ---------- */
function findJava21() {
  // Prefer exactly Java 21 (what Capacitor/Gradle expect); accept a newer one only if 21 is not found.
  const homes = [];   // null = whatever "java" is on PATH
  const add = h => { if (h && !homes.includes(h)) homes.push(h); };
  homes.push(null);
  add(process.env.JAVA_HOME);
  ['C:\\Program Files\\Android\\Android Studio', 'C:\\Program Files\\Android\\Android Studio1',
   path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Android Studio')].forEach(b => { add(path.join(b, 'jbr')); add(path.join(b, 'jre')); });
  ['C:\\Program Files\\Eclipse Adoptium', 'C:\\Program Files\\Java', 'C:\\Program Files\\Microsoft', 'C:\\Program Files\\Zulu'].forEach(d => {
    try { fs.readdirSync(d).filter(n => /jdk|zulu/i.test(n)).forEach(n => add(path.join(d, n))); } catch (e) {}
  });
  const found = [];
  for (const h of homes) {
    const exe = h ? path.join(h, 'bin', isWin ? 'java.exe' : 'java') : 'java';
    if (h && !fs.existsSync(exe)) continue;
    const major = javaMajor(out(h ? '"' + exe + '" -version' : 'java -version'));
    if (major >= 21) found.push({ h, major });
  }
  if (!found.length) die('Java 21 not found. Install Android Studio (it includes Java) or "Temurin JDK 21" from adoptium.net, then run build.bat again.');
  const pick = found.find(f => f.major === 21) || found[0];
  console.log('Using Java ' + pick.major + (pick.h ? ' at ' + pick.h : ' (system)'));
  if (pick.major > 21) console.log('NOTE: Java ' + pick.major + ' is newer than 21. If Gradle complains about Java, install "Temurin JDK 21" and run again.');
  return pick.h;
}
function findSdk() {
  const cands = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT,
    path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk'), path.join(os.homedir(), 'Android', 'Sdk')].filter(Boolean);
  for (const c of cands) if (fs.existsSync(path.join(c, 'platforms')) || fs.existsSync(path.join(c, 'platform-tools'))) return c;
  die('Android SDK not found. Open Android Studio once -> More Actions -> SDK Manager -> install "Android SDK Platform 35" and let it finish, then run build.bat again.');
}
function setupKey() {
  const keysDir = path.join(ROOT, 'keys'), mine = path.join(keysDir, 'dpb-debug.keystore');
  const andDir = path.join(os.homedir(), '.android'), sys = path.join(andDir, 'debug.keystore');
  fs.mkdirSync(keysDir, { recursive: true }); fs.mkdirSync(andDir, { recursive: true });
  if (!fs.existsSync(mine)) {
    if (fs.existsSync(sys)) { fs.copyFileSync(sys, mine); log('Saved your existing signing key into keys\\dpb-debug.keystore'); }
    else {
      log('Creating the signing key (one time only)');
      run('keytool -genkeypair -keystore "' + mine + '" -storepass android -keypass android -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 36500 -dname "CN=DPB,O=DPB,C=EG"');
    }
  }
  if (fs.existsSync(sys) && fs.readFileSync(sys).equals(fs.readFileSync(mine))) return mine;
  if (fs.existsSync(sys)) fs.copyFileSync(sys, sys + '.bak-' + Date.now());
  fs.copyFileSync(mine, sys);
  return mine;
}

function main() {
  const t0 = Date.now();
  for (const f of WEB_FILES) if (!fs.existsSync(path.join(ROOT, f))) die('Missing file in project folder: ' + f);
  if (!fs.existsSync(path.join(ROOT, 'google-services.json'))) die('Missing google-services.json');

  const OTA = process.argv.includes('--ota');   // update.bat: only make the in-app update package, no APK
  let env = Object.assign({}, process.env), sdk = '';
  if (!OTA) {
    log('1/8 Checking Java + Android SDK');
    const jh = findJava21();
    if (jh) { env.JAVA_HOME = jh; env.PATH = path.join(jh, 'bin') + path.delimiter + env.PATH; }
    Object.assign(process.env, { JAVA_HOME: env.JAVA_HOME, PATH: env.PATH });
    sdk = findSdk();

    log('2/8 Signing key (keeps updates installable over the old app)');
    setupKey();
  }

  log('3/8 Copying web files into www');
  fs.mkdirSync(path.join(ROOT, 'www'), { recursive: true });
  WEB_FILES.forEach(f => fs.copyFileSync(path.join(ROOT, f), path.join(ROOT, 'www', f)));
  const updUrl = readUpdateUrl(), webVersion = makeVersion(new Date());
  writeVersionFile(webVersion, updUrl);
  if (!updUrl) console.log('NOTE: update-url.txt is empty -> in-app updates are OFF in this build.');

  log('4/8 Bundling Firebase');
  if (!fs.existsSync(path.join(ROOT, 'www', 'vendor', 'firebase-bundle.js')) || process.argv.includes('--vendor')) {
    run('npm i --no-save firebase@10.12.2 esbuild');
    fs.mkdirSync(path.join(ROOT, 'www', 'vendor'), { recursive: true });
    run('npx esbuild vendor-src/firebase-entry.js --bundle --format=esm --minify --target=es2020 --outfile=www/vendor/firebase-bundle.js');
  } else console.log('already built (use build.bat --vendor to rebuild)');
  if (!fs.existsSync(path.join(ROOT, 'www', 'vendor', 'firebase-bundle.js'))) die('firebase-bundle.js was not created');

  if (OTA) {
    if (!updUrl) die('update-url.txt is empty. Put the https address of the update folder in it first (otherwise the app would lose its update address after the next update).');
    log('Making the in-app update package');
    const z = makeUpdatePackage(webVersion);
    console.log('\nUpdate package ready: ' + z + '  (' + (fs.statSync(z).size / 1048576).toFixed(1) + ' MB, version ' + webVersion + ')');
    console.log('Now upload the whole "update" folder content (version.json + the .zip) to GitHub, inside the folder  update/  of the repo.');
    console.log('Open the app on the phone: a "new update" bar will appear. Your data stays.');
    return;
  }

  log('5/8 Capacitor + Android project');
  if (!fs.existsSync(path.join(ROOT, 'node_modules', '@capacitor', 'android')) || !fs.existsSync(path.join(ROOT, 'node_modules', '@capacitor', 'push-notifications')))
    run('npm i ' + PLUGINS.join(' '));
  if (!fs.existsSync(path.join(ROOT, 'android'))) run('npx cap add android');
  if (updUrl) installUpdaterPlugin();
  fs.copyFileSync(path.join(ROOT, 'google-services.json'), path.join(ROOT, 'android', 'app', 'google-services.json'));
  fs.writeFileSync(path.join(ROOT, 'android', 'local.properties'), 'sdk.dir=' + sdk.replace(/\\/g, '\\\\').replace(/:/g, '\\:') + '\n');

  const mf = path.join(ROOT, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
  fs.writeFileSync(mf, patchManifest(fs.readFileSync(mf, 'utf8')));
  const jd = path.join(ROOT, 'android', 'app', 'src', 'main', 'java', ...PKG_DIR.split('/'));
  fs.mkdirSync(jd, { recursive: true });
  fs.readdirSync(path.join(ROOT, 'android-native')).filter(f => f.endsWith('.java')).forEach(f => fs.copyFileSync(path.join(ROOT, 'android-native', f), path.join(jd, f)));

  // app name + icon (solar panel photo)
  const res = path.join(ROOT, 'android', 'app', 'src', 'main', 'res');
  const sx = path.join(res, 'values', 'strings.xml');
  if (fs.existsSync(sx)) fs.writeFileSync(sx, patchStrings(fs.readFileSync(sx, 'utf8'), APP_NAME));
  if (fs.existsSync(path.join(ROOT, 'android-res'))) copyDir(path.join(ROOT, 'android-res'), res);
  else console.log('android-res folder not found - icon not changed');

  // a higher versionCode every build, so Android always accepts it as an update
  const gr = path.join(ROOT, 'android', 'app', 'build.gradle'), now = new Date();
  const name = now.toISOString().slice(0, 16).replace('T', '-').replace(':', '');
  fs.writeFileSync(gr, patchVersion(fs.readFileSync(gr, 'utf8'), Math.floor(now.getTime() / 60000), name));

  log('6/8 Syncing web files into the app');
  run('npx cap sync android');

  log('7/8 Building the APK (the first time takes several minutes)');
  run(isWin ? 'gradlew.bat assembleDebug' : './gradlew assembleDebug', { cwd: path.join(ROOT, 'android'), env });

  log('8/8 Done');
  const apk = path.join(ROOT, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
  if (!fs.existsSync(apk)) die('APK was not produced');
  const dst = path.join(ROOT, 'DPB-Map.apk');
  fs.copyFileSync(apk, dst);
  console.log('\nAPK ready: ' + dst + '  (' + (fs.statSync(dst).size / 1048576).toFixed(1) + ' MB, ' + Math.round((Date.now() - t0) / 1000) + ' s)');
  console.log('Send DPB-Map.apk to the phone and install it over the old app.');
}
if (require.main === module) main();
