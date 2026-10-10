/**
 * Dynamic Plan Builder — Google Sheets Backend (Code.gs)
 * ------------------------------------------------------
 * انسخ هذا الكود بالكامل والصقه داخل محرر Google Apps Script
 * المرتبط بالشيت (Extensions > Apps Script).
 *
 * الأوراق (Tabs) دي بتتعمل تلقائياً أول مرة تتنادى فيها أي دالة:
 *   Users        : بيانات تسجيل الدخول (مشرفين + أدمن)
 *   Production   : سجلات الإنتاجية (المزامنة الثنائية)
 *   History      : سجل الأحداث (Login / تعديلات ... إلخ)
 *   Productivity  : سجل تفصيلي لكل حركة إنتاجية
 *
 * بعد اللصق: Deploy > New deployment > Web app
 *   Execute as: Me
 *   Who has access: Anyone
 * وانسخ رابط /exec وابعته للمطوّر عشان يحدّث بيه البرنامج.
 *
 * ---------------------------------------------------------------------
 * ملحوظة: تسجيل الدخول (Users) بيتقرا ويتكتب من نفس الشيت القديم اللي
 * فيه بياناتك الحقيقية بالفعل (USERS_SHEET_ID تحت) - من غير ما تلمسه
 * يدوي. كل حاجة تانية (Production, History, Productivity, وكتابة خلايا
 * EXCUTION) بتحصل جوه نفس الشيت اللي السكربت مربوط بيه (EXCUTION).
 * ---------------------------------------------------------------------
 */
var EXECUTION_TAB_NAME = "EXCUTION"; // الاسم القديم - بيفضل شغال كـ fallback لأي عملية مش معروفة

// أي تبويب في الشيت اسمه واحد من دول (بغض النظر عن حالة الأحرف) بيتعتبر
// تبويب نظام (مش عملية)، ومتترجمش عملية جديدة منه أبدًا. أي تبويب تاني
// غيرهم بيتعتبر تلقائيًا "عملية" جزء من التسلسل.
var SYSTEM_TAB_NAMES_ = ["production", "history", "productivity", "unitmap", "users", "sheet1", EXECUTION_TAB_NAME.toLowerCase()];

// FIX (دعم عدد ديناميكي من العمليات N، مش 3 ثابتين): بدل ما العمليات
// تبقى Object ثابت بـ 3 مفاتيح (ramming/saddle/bearing)، دلوقتي أي
// تبويب في الشيت مش من تبويبات النظام (Production/History/...) بيتعتبر
// عملية تلقائيًا. ترتيب العمليات (1، 2، 3، ...) هو نفسه ترتيب التابات
// من الشمال لليمين في جوجل شيتس بالظبط - ده اللي بيحدد "مين قبل مين"
// لمنطق التسلسل (cascade) تحت. يعني لو الملف فيه 3 أو 4 أو 5 تابات
// عمليات، النظام بيتوسع لوحده من غير أي تعديل كود إضافي.
function processOrderList_() {
  var sheets = ss_().getSheets();
  var list = [];
  for (var i = 0; i < sheets.length; i++) {
    var nm = sheets[i].getName();
    if (SYSTEM_TAB_NAMES_.indexOf(nm.toLowerCase()) === -1 && !isIgnoredTab_(nm)) list.push(nm);
  }
  return list; // بنفس ترتيب التابات الفعلي في الشيت
}

function tabNameForProcess_(processName, processCode) {
  var key = String(processName || "").trim().toLowerCase();
  var norm = key.replace(/[^a-z0-9\u0600-\u06ff]+/g, "");
  var code = Number(processCode) || 0;
  var list = processOrderList_();

  // 1) Exact tab-name match (preferred).
  for (var i = 0; i < list.length; i++) {
    if (list[i].toLowerCase() === key) return list[i];
  }

  // 2) Match after removing spaces/punctuation. This is important for
  // Torque Tube because real sheets are often named "TorqueTube",
  // "Torque Tube", "4 Torque Tube", or "4-TorqueTube".
  if (norm) {
    for (var j = 0; j < list.length; j++) {
      var ln = list[j].toLowerCase();
      var lnorm = ln.replace(/[^a-z0-9\u0600-\u06ff]+/g, "");
      if (lnorm.indexOf(norm) !== -1 || norm.indexOf(lnorm) !== -1) return list[j];
    }
  }

  // 3) Match by process code / tab position. The code is 1-based while
  // processOrderList_ is 0-based. This is important when the user names the
  // tabs by operation code rather than by the English process name.
  if (code >= 1 && code <= list.length) return list[code - 1];

  // 4) Legacy fallback only when the caller really did not identify a process.
  return (!key && !code) ? EXECUTION_TAB_NAME : null;
}

// بيرجّع ترتيب العملية (0 = أول عملية، 1 = التانية...) أو -1 لو مش لاقيها.
function processOrderIndex_(processName) {
  var key = String(processName || "").trim().toLowerCase();
  var list = processOrderList_();
  for (var i = 0; i < list.length; i++) {
    if (list[i].toLowerCase() === key) return i;
  }
  return -1;
}

// الشيت القديم اللي فيه بيانات تسجيل الدخول الحقيقية (Users) شغالة
// بالفعل بنفس الأرقام السرية اللي إنت مستخدمها دلوقتي. السكربت هيقرا
// ويكتب اليوزرات من هنا تلقائيًا، من غير ما حد يلمس أي شيت يدوي.
var USERS_SHEET_ID = "1I6XfyRCStRKQPbIPV5hqYwFp_gB3UZ3Jx7G-nk95Rkc";

function usersSpreadsheet_() {
  if (USERS_SHEET_ID) {
    try { return SpreadsheetApp.openById(USERS_SHEET_ID); } catch (e) { /* رجوع للشيت الحالي لو فشل */ }
  }
  return ss_();
}

var SHEET_USERS = "Users";
var SHEET_PRODUCTION = "Production";
var SHEET_HISTORY = "History";
var SHEET_PRODUCTIVITY = "Productivity";
var SHEET_UNITMAP = "UnitMap";

var HEADERS = {
  Users: ["UserID", "Username", "Password", "Role", "ProcessIDs", "AllProcesses", "Active"],
  Production: ["RecordID", "ProjectID", "UpdatedAt", "EditedBy", "DataJSON"],
  History: ["Time", "User", "Action", "Details"],
  Productivity: ["Time", "Supervisor", "Owner", "Source", "Process", "Code", "Tracker", "Row", "Unit", "Action"],
  UnitMap: ["Sheet", "Row", "Tracker", "Unit", "R1", "C1", "R2", "C2"]
};

function ss_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function ensureSheet_(name) {
  var ss = (name === SHEET_USERS) ? usersSpreadsheet_() : ss_();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(HEADERS[name]);
  } else if (sh.getLastRow() === 0) {
    sh.appendRow(HEADERS[name]);
  }
  return sh;
}

function sheetToObjects_(sh) {
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  var headers = values[0];
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (row.join("") === "") continue;
    var obj = {};
    for (var c = 0; c < headers.length; c++) obj[headers[c]] = row[c];
    obj.__row = i + 1;
    out.push(obj);
  }
  return out;
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// بيمنع تعارض كتابتين في نفس اللحظة (مثلاً: onEdit وحفظة من البرنامج
// في نفس الثانية) عن طريق قفل بسيط على مستوى السكربت كله. من غيره،
// عمليتين بيكتبوا في نفس الوقت ممكن يبوظوا بعض أو يمسحوا تعديل بعض.
function runLocked_(fn) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
  } catch (e) {
    return { ok: false, error: "الخادم مشغول حاليًا، حاول تاني بعد ثواني." };
  }
  try {
    var out_ = fn();
    bumpRev_();
    return out_;
  } finally {
    lock.releaseLock();
  }
}

function withLock_(fn) {
  return jsonOut_(runLocked_(fn));
}

function doPost(e) {
  var body = {};
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
  } catch (err) {
    body = {};
  }
  var action = body.action || "";
  try {
    // login وgetUsers (قايمة الأسماء بدون PIN) مفتوحين. أول حفظ لأدمن في شيت مفيهوش أدمن كمان مفتوح (bootstrap).
    if (action !== "login" && action !== "getUsers" && action !== "renewToken" &&
        !(action === "saveUser" && !adminExists_() && String(((body.user || {}).role) || "").trim().toLowerCase() === "admin")) {
      var gate_ = tokenGate_(body.token);
      if (gate_) return jsonOut_(gate_);
    }
    switch (action) {
      case "renewToken": return jsonOut_(handleRenewToken_(body));
      case "login": return jsonOut_(handleLogin_(body));
      case "getUsers": return jsonOut_(handleGetUsers_(body));
      case "saveUser": return withLock_(function () { return handleSaveUser_(body); });
      case "deleteUser": return withLock_(function () { return handleDeleteUser_(body); });
      case "logHistory": return jsonOut_(handleLogHistory_(body));
      case "logProductivity": return withLock_(function () { return handleLogProductivity_(body); });
      case "sync": return withLock_(function () { return handleSync_(body); });
      case "getGrid": return jsonOut_(handleGetGrid_(body.process || body.sheet));
      // FIX (تجميع طلبات الشبكة اللايف): بدل ما الكلاينت يبعت نداء getGrid
      // منفصل لكل عملية (Ramming/Saddle/Bearing/...) بالتوازي، النداء ده
      // بياخد قائمة أسماء عمليات مرة واحدة (processes: ["Ramming","Saddle"])
      // ويرجّع شبكة كل واحدة فيهم في استجابة HTTP واحدة بس - تقليل عدد
      // الاتصالات الفعلية بالشبكة من N لكل تحديث لـ 1، وده الأهم مع أي
      // Polling متكرر (كل شوية ثواني) عشان ماما يتقلش حس البرنامج.
      case "getGridBatch": return jsonOut_(handleGetGridBatch_(body.processes || [], !!body.includeColors, !!body.light));
      case "upsertMany": return withLock_(function () { return handleUpsertMany_(body); });
      case "deleteMany": return withLock_(function () { return handleDeleteMany_(body); });
      case "saveUnitMap": return withLock_(function () { return handleSaveUnitMap_(body); });
      // FIX (نسخة الـ Build تتزامن بين كل الأجهزة): نتيجة الـ Build (شكل
      // الخريطة كامل بالألوان والتراكرز) كانت بتفضل حبيسة جوه المتصفح اللي
      // عمل الـ Build بس - أي جهاز تاني (موبايل مشرف مثلاً) كان لازم يرفع
      // نفس ملف الإكسل ويعمل Build بنفسه من الصفر عشان يشوف نفس الخريطة.
      // دلوقتي أي Build ناجح بيترفع تلقائيًا كملف على Google Drive، وأي
      // جهاز تاني بيقدر يجيبه ويعرض نفس الخريطة بالظبط من غير ما يرفع أي
      // إكسيل خالص.
      case "saveBuildResult": return withLock_(function () { return handleSaveBuildResult_(body); });
      case "getBuildResult": return jsonOut_(handleGetBuildResult_(body));
      // DPB KV (مزامنة الشركات/المشغلين وأسماء مشغلي الخلايا بين الأجهزة)
      case "kvGet": return jsonOut_(dpbKvGet_(body.key));
      case "kvPatch": return jsonOut_(dpbKvPatch_(body.key, body.set, body.del, body.replace));
      default: return jsonOut_({ ok: false, error: "Unknown action: " + action });
    }
  } catch (err) {
    return jsonOut_({ ok: false, error: String((err && err.message) || err) });
  }
}

function doGet(e) {
  // المرحلة (ب): كل القراءات (حتى ?debug وبيانات الإنتاج الكاملة) محتاجة توكن لما DPB_REQUIRE_TOKEN = 1
  var gate_ = tokenGate_(e && e.parameter && e.parameter.token);
  if (gate_) return jsonOut_(gate_);
  // زيارة الرابط ?debug=1 من المتصفح بتوريك بالظبط أي شيت السكربت
  // ده مربوط بيه فعليًا، وأي تبويبات (Tabs) موجودة جواه لحد دلوقتي —
  // ده أسرع طريقة نتأكد بيها إن السكربت شغال على نفس الشيت اللي بتتابعه.
  if (e && e.parameter && e.parameter.debug) {
    var ss = ss_();
    return jsonOut_({
      ok: true,
      boundSpreadsheetName: ss.getName(),
      boundSpreadsheetId: ss.getId(),
      boundSpreadsheetUrl: ss.getUrl(),
      sheetsFound: ss.getSheets().map(function (s) { return s.getName(); })
    });
  }
  // ?action=getGrid: بيرجّع شبكة تبويب EXCUTION اللايف بالكامل (كل خلية
  // زي ما هي دلوقتي بالظبط) - ده بقى المصدر الوحيد لهيكل وحالة الخريطة
  // في البرنامج، بدل النسخة المجمّدة من ملف الإكسل اللي كانت بتتلخبط مع
  // التعديلات اللايف على الشيت.
  if (e && e.parameter && e.parameter.action === "bench") {
    try { return jsonOut_(handleBench_()); } catch (err) { return jsonOut_({ ok: false, error: String((err && err.message) || err) }); }
  }
  if (e && e.parameter && e.parameter.action === "getProcesses") {
    try {
      return jsonOut_(handleGetProcesses_());
    } catch (err) {
      return jsonOut_({ ok: false, error: String((err && err.message) || err) });
    }
  }
  if (e && e.parameter && e.parameter.action === "getGrid") {
    try {
      return jsonOut_(handleGetGrid_(e.parameter.process || e.parameter.sheet));
    } catch (err) {
      return jsonOut_({ ok: false, error: String((err && err.message) || err) });
    }
  }
  // ?action=getGridBatch&processes=Ramming,Saddle,Bearing : نفس getGrid
  // بس لأكتر من عملية في نداء واحد (نسخة GET، عشان لو الكلاينت احتاجها
  // بالطريقة دي بدل POST).
  if (e && e.parameter && e.parameter.action === "getGridBatch") {
    try {
      var procList = String(e.parameter.processes || "").split(",").map(function(s){return s.trim();}).filter(Boolean);
      return jsonOut_(handleGetGridBatch_(procList, e.parameter.includeColors === "1" || e.parameter.includeColors === "true"));
    } catch (err) {
      return jsonOut_({ ok: false, error: String((err && err.message) || err) });
    }
  }
  // ?action=getBuildResult: بيرجّع آخر نسخة Build اتحفظت على Drive، عشان
  // أي جهاز (موبايل مشرف مثلاً) يقدر يعرض نفس خريطة الموقع من غير ما
  // يرفع نفس ملف الإكسيل ويعمل Build بنفسه.
  if (e && e.parameter && e.parameter.action === "getBuildResult") {
    try {
      return jsonOut_(handleGetBuildResult_());
    } catch (err) {
      return jsonOut_({ ok: false, error: String((err && err.message) || err) });
    }
  }
  // من غير أي باراميتر: البرنامج بيعمل GET على الرابط ده كل شوية عشان
  // يسحب آخر نسخة من سجلات الإنتاجية (Production) — سواء اتعملت من
  // البرنامج على جهاز تاني، أو اتعدلت يدوي جوه الشيت نفسه.
  return jsonOut_(handleGetProduction_(e && e.parameter && e.parameter.rev));
}

/* ---------------- Build result cache (cross-device Site Map) ---------------- */

// اسم ملف الكاش على Google Drive. بيتكتب فوق نفسه في كل Build ناجح، فمفيش
// تراكم ملفات قديمة.
// رقم نسخة عقد الكلاينت/السيرفر. الكلاينت بيقارنه ويحذّر لو Code.gs المنشور أقدم من المطلوب.
var API_VERSION = 2;

// FIX (المرحلة 2): عدّاد تغييرات Production. أي كتابة بتحصل تحت القفل بتزوّده،
// والكلاينت لو بعت نفس الرقم بيرجعله {unchanged:true} من غير ما السيرفر يقرا
// الشيت كله (كان كل فتح وكل 150 ثانية بيسحب Production بالكامل).
function currentRev_() {
  try { return String(PropertiesService.getScriptProperties().getProperty("DPB_PROD_REV") || "0"); } catch (e) { return "0"; }
}
function bumpRev_() {
  try {
    var p = PropertiesService.getScriptProperties();
    var prev = Number(p.getProperty("DPB_PROD_REV") || 0) || 0;
    var next = Math.max(Date.now(), prev + 1);
    p.setProperty("DPB_PROD_REV", String(next));
  } catch (e) {}
}

// FIX (المرحلة 2): جوجل شيتس ممكن يحوّل عمود UpdatedAt لتاريخ حقيقي، فمقارنة
// النصوص كانت بتتجاهل كل التحديثات بصمت. دايمًا نحوّله ISO قبل أي مقارنة.
function isoOf_(v) {
  if (v === undefined || v === null) return "";
  if (Object.prototype.toString.call(v) === "[object Date]") { return isNaN(v.getTime()) ? "" : v.toISOString(); }
  return String(v);
}

// FIX (المرحلة 2): أي تبويب جديد كان بيتحسب "عملية"، وتبويب زي "Copy of Ramming"
// كان بيتطابق بالتقريب مع Ramming وبيعمل سجلات وهمية. التابات اللي اسمها بيبدأ
// بـ _ أو # أو ~ أو "Copy of" / "نسخة من" / backup / temp / SheetN بتتتجاهل.
// وممكن تضيف أسماء إضافية في Script Property اسمها DPB_IGNORE_TABS (مفصولة بفاصلة).
function isIgnoredTab_(nm) {
  var n = String(nm || "").trim();
  if (/^[_#~]/.test(n)) return true;
  if (/^(copy of|نسخة من|backup|bak\b|temp\b|tmp\b|sheet\d+$)/i.test(n)) return true;
  try {
    var extra = String(PropertiesService.getScriptProperties().getProperty("DPB_IGNORE_TABS") || "");
    if (extra) {
      var low = n.toLowerCase();
      var parts = extra.split(",");
      for (var i = 0; i < parts.length; i++) if (parts[i].trim() && parts[i].trim().toLowerCase() === low) return true;
    }
  } catch (e) {}
  return false;
}

var BUILD_CACHE_FILENAME = "DPB_BuildCache.json"; // الاسم القديم المشترك - بيتنسخ مرة واحدة بس

// FIX (المرحلة 1 / بند 4): ملفات Drive كانت بالاسم بس، فأي مشروعين على نفس
// حساب جوجل كانوا بيقروا ويكتبوا فوق نفس الملفات (mapcat / master / mirror /
// BuildCache). دلوقتي الاسم فيه معرّف الشيت. أول مرة الملف الجديد مش موجود
// بنسخ محتوى الملف القديم (من غير ما نمسحه) عشان مفيش بيانات تضيع.
function scopedName_(base, ext) { return base + "_" + ss_().getId() + ext; }
function scopedDriveFile_(newName, legacyName, create, seed, mime) {
  var it = DriveApp.getFilesByName(newName);
  if (it.hasNext()) return it.next();
  var lit = DriveApp.getFilesByName(legacyName);
  if (lit.hasNext()) return DriveApp.createFile(newName, lit.next().getBlob().getDataAsString(), mime);
  return create ? DriveApp.createFile(newName, seed, mime) : null;
}

function handleSaveBuildResult_(body) {
  var json = String(body.json || "");
  if (!json) return { ok: false, error: "Empty build payload" };
  try {
    var files = DriveApp.getFilesByName(scopedName_("DPB_BuildCache", ".json"));
    if (files.hasNext()) {
      var f = files.next();
      f.setContent(json);
      // لو فيه أكتر من نسخة قديمة من أيام سابقة، امسح الزيادة واحتفظ
      // بالأولى بس اللي كتبنا فيها فوق.
      while (files.hasNext()) { files.next().setTrashed(true); }
    } else {
      DriveApp.createFile(scopedName_("DPB_BuildCache", ".json"), json, MimeType.PLAIN_TEXT);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function handleGetBuildResult_(body) {
  try {
    var f = scopedDriveFile_(scopedName_("DPB_BuildCache", ".json"), BUILD_CACHE_FILENAME, false, "", MimeType.PLAIN_TEXT);
    if (!f) return { ok: true, json: null };
    // FIX (المرحلة 2): تاريخ آخر تعديل للملف، عشان الأجهزة اللي استلمت الـ Build تعرف إن فيه أحدث
    // بطلب خفيف (metaOnly) من غير ما تنزّل الـ Build كله كل مرة.
    var upd_ = "";
    try { upd_ = f.getLastUpdated ? f.getLastUpdated().toISOString() : ""; } catch (e) {}
    if (body && body.metaOnly) return { ok: true, updated: upd_ };
    return { ok: true, json: f.getBlob().getDataAsString(), updated: upd_ };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* ---------------- Users ---------------- */

// قراءة حقل من صف بغض النظر عن حالة الأحرف أو المسافات في اسم العمود
// (مثال: "User id" أو "UserID" أو "userid" كلهم نفس الحقل).
function field_(row, names) {
  var keys = Object.keys(row);
  for (var n = 0; n < names.length; n++) {
    var target = String(names[n]).toLowerCase().replace(/[\s_]/g, "");
    for (var k = 0; k < keys.length; k++) {
      if (String(keys[k]).toLowerCase().replace(/[\s_]/g, "") === target) return row[keys[k]];
    }
  }
  return undefined;
}

function rowToUser_(u) {
  var role = String(field_(u, ["Role"]) || "").trim();
  var isAdmin = role.toLowerCase() === "admin";
  // FIX (المشرفين كلهم كانوا بياخدوا صلاحية فاضية، مش بس الأدمن): الشيت
  // القديم مفهوش أعمدة ProcessIDs/AllProcesses أصلاً. field_() بترجع
  // undefined لو العمود مش موجود خالص، لكن ترجع "" (فاضي) لو العمود
  // موجود والخلية فاضية بس لصف معيّن - الكود القديم كان بيستخدم "||"
  // فبيلخبط الحالتين مع بعض، ولما العمود مش موجود كان بيدّي "*" للأدمن
  // بس ويسيب أي مشرف عادي على "" (يعني مفيش عمليات خالص). الصح: لو
  // العمود مش موجود خالص في الشيت (مفيش نظام تقييد اتفعّل أصلاً)، الكل
  // - أدمن أو مشرف - ياخد كل العمليات "*" زي ما كان الوضع الافتراضي من
  // الأول. لو العمود *موجود فعلاً* والخلية فاضية لمشرف معيّن، وقتها بس
  // ده معناه فعلاً "مفيش عمليات متعينة له" (تقييد مقصود من الأدمن).
  var processIdsRaw = field_(u, ["ProcessIDs", "ProcessId"]);
  var processIdsColumnExists = processIdsRaw !== undefined;
  return {
    userID: field_(u, ["UserID", "User id"]),
    username: field_(u, ["Username"]),
    password: field_(u, ["Password"]),
    role: role,
    processIds: isAdmin ? "*" : (processIdsColumnExists ? processIdsRaw : "*"),
    allProcesses: field_(u, ["AllProcesses"]) !== undefined ? field_(u, ["AllProcesses"]) : (isAdmin || !processIdsColumnExists),
    active: field_(u, ["Active"])
  };
}

function handleLogin_(body) {
  var username = String(body.username || "").trim();
  var password = String(body.password || "").trim();
  var users = sheetToObjects_(ensureSheet_(SHEET_USERS));
  var row = users.find(function (u) { return String(field_(u, ["Username"]) || "").trim() === username; });
  if (!row) return { ok: false };
  var ls = lockState_(username);
  if (ls.locked) return { ok: false, locked: true, retryAfterSec: ls.retryAfterSec };
  var active = String(field_(row, ["Active"])).toUpperCase() !== "FALSE";
  if (active && password && String(field_(row, ["Password"]) || "").trim() === password) {
    clearFails_(username);
    var tk_ = issueToken_(username);
    return { ok: true, user: publicUser_(rowToUser_(row)), token: tk_.token, exp: tk_.exp }; // مبنرجّعش الباسورد أبدًا في رد الدخول
  }
  var f = noteFail_(username);
  return f.locked ? { ok: false, locked: true, retryAfterSec: f.retryAfterSec } : { ok: false };
}

/* ---------------- الأمان (المرحلة الأولى) ----------------
 * الرابط /exec كان بيرجّع كل الباسوردات صريحة لأي حد معاه الرابط، وحفظ/حذف المستخدمين
 * من غير أي هوية. دلوقتي:
 *  - getUsers من غير هوية أدمن صحيحة: مفيش باسوردات خالص (بس hasPin).
 *  - saveUser / deleteUser بيطلبوا هوية الأدمن (username + PIN) في الطلب نفسه.
 * مفاتيح الطوارئ (Script Properties) لو حصلت مشكلة أثناء تحديث الأجهزة:
 *   DPB_PINS_PUBLIC = 1  -> يرجّع السلوك القديم لـ getUsers (باسوردات ظاهرة)
 *   DPB_AUTH_OFF    = 1  -> يوقف اشتراط هوية الأدمن على saveUser/deleteUser
 * ------------------------------------------------------- */
function propFlag_(name) {
  try { return String(PropertiesService.getScriptProperties().getProperty(name) || "") === "1"; } catch (e) { return false; }
}
// ---- تحديد المحاولات: PIN من 4 أرقام يتخمّن كله في دقايق من غير ده ----
// بعد LOGIN_MAX_FAILS محاولة غلط لنفس المستخدم (من login أو من هوية الأدمن) الدخول بيتقفل LOGIN_LOCK_MS.
// بنتتبع بس أسماء موجودة فعلًا في الشيت (عشان محدّش يملّي الـ Properties بأسماء عشوائية)، والرد للاسم
// الموجود والغير موجود واحد. العدّاد تقريبي (من غير قفل) عن قصد عشان الدخول ما يستناش وراء طلبات الكتابة.
var LOGIN_MAX_FAILS = 8;
var LOGIN_LOCK_MS = 10 * 60 * 1000;
function failKey_(u) { return "DPB_FAIL_" + String(u || "").trim().toLowerCase().replace(/[^a-z0-9_\-]/g, "_").slice(0, 40); }
function readFails_(u) {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(failKey_(u)) || "{}") || {}; } catch (e) { return {}; }
}
function lockState_(u) {
  var st = readFails_(u), now = Date.now();
  if (st.until && st.until > now) return { locked: true, retryAfterSec: Math.ceil((st.until - now) / 1000) };
  if (st.until && st.until <= now) { clearFails_(u); }
  return { locked: false, retryAfterSec: 0 };
}
function noteFail_(u) {
  var st = readFails_(u), now = Date.now();
  if (st.until && st.until <= now) st = {};
  st.n = (Number(st.n) || 0) + 1;
  var locked = false;
  if (st.n >= LOGIN_MAX_FAILS) { st.until = now + LOGIN_LOCK_MS; st.n = 0; locked = true; }
  try { PropertiesService.getScriptProperties().setProperty(failKey_(u), JSON.stringify(st)); } catch (e) {}
  return locked ? { locked: true, retryAfterSec: Math.ceil(LOGIN_LOCK_MS / 1000) } : { locked: false, retryAfterSec: 0 };
}
function clearFails_(u) {
  try { PropertiesService.getScriptProperties().deleteProperty(failKey_(u)); } catch (e) {}
}
function publicUser_(u) {
  var c = {};
  Object.keys(u).forEach(function (k) { if (k !== "password") c[k] = u[k]; });
  c.hasPin = String(u.password || "").trim() !== "";
  return c;
}

function adminAuthOk_(auth) {
  if (!auth || typeof auth !== "object") return false;
  var u = String(auth.username || "").trim(), p = String(auth.password || "").trim();
  if (!u || !p) return false;
  var rows = sheetToObjects_(ensureSheet_(SHEET_USERS));
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (String(field_(r, ["Username"]) || "").trim() !== u) continue;
    if (String(field_(r, ["Active"])).toUpperCase() === "FALSE") continue;
    if (String(field_(r, ["Role"]) || "").trim().toLowerCase() !== "admin") continue;
    if (lockState_(u).locked) return false;
    if (String(field_(r, ["Password"]) || "").trim() === p) { clearFails_(u); return true; }
    noteFail_(u);
    return false;
  }
  return false;
}
/* ---------------- المرحلة (ب): توكن لكل الطلبات ----------------
 * بعد أي دخول ناجح السيرفر بيرجّع توكن موقّع (HMAC-SHA256) صالح 21 يوم. التطبيق بيبعته مع كل طلب
 * قراءة وكتابة (POST وGET). مفتاح التشغيل: Script Property  DPB_REQUIRE_TOKEN = 1.
 *   - مقفول (الافتراضي): السيرفر بيشتغل زي الأول ويسجّل بس آخر مرة جه طلب بتوكن/من غير توكن
 *     (DPB_TOK_LAST_WITH / DPB_TOK_LAST_WITHOUT) عشان تعرف إمتى كل الأجهزة اتحدّثت.
 *   - مفعّل: أي طلب من غير توكن صالح بيتردّ {ok:false, code:401}. مفتوح بس: login وgetUsers (قايمة الأسماء بدون PIN).
 * إلغاء التوكن: تغيير PIN مستخدم / تعطيله / حذفه بيلغي توكناته القديمة، وDPB_TOKEN_EPOCH = رقم (ms) بيلغي كل
 * التوكنات الأقدم منه. ملحوظة صريحة: التوكن بيثبت إن الطلب جاي من مستخدم صالح، مش بيحدد صلاحية كل مشرف
 * على كل عملية (ده لسه على مستوى الواجهة).
 * ------------------------------------------------------------ */
var TOKEN_TTL_MS = 21 * 24 * 3600 * 1000;
function tokenSecret_() {
  var p = PropertiesService.getScriptProperties();
  var s = p.getProperty("DPB_TOKEN_SECRET");
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid() + Utilities.getUuid(); p.setProperty("DPB_TOKEN_SECRET", s); }
  return s;
}
function tokSig_(payload) {
  return String(Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(payload, tokenSecret_()))).replace(/=+$/, "");
}
function safeEq_(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  var r = 0;
  for (var i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function userKey_(u) { return String(u || "").trim().toLowerCase().replace(/[^a-z0-9_\-]/g, "_").slice(0, 40); }
function issueToken_(username) {
  var now = Date.now();
  var payload = encodeURIComponent(JSON.stringify({ u: String(username || "").trim().toLowerCase(), iat: now, exp: now + TOKEN_TTL_MS }));
  return { token: payload + "." + tokSig_(payload), exp: now + TOKEN_TTL_MS };
}
function verifyToken_(tok) {
  try {
    if (!tok || typeof tok !== "string" || tok.length > 700) return { ok: false };
    var i = tok.lastIndexOf(".");
    if (i < 1) return { ok: false };
    var payload = tok.slice(0, i), sig = tok.slice(i + 1);
    if (!safeEq_(tokSig_(payload), sig)) return { ok: false };
    var o = JSON.parse(decodeURIComponent(payload));
    var now = Date.now();
    if (!o || !o.u || !o.iat || !o.exp || o.exp < now) return { ok: false, expired: true };
    var p = PropertiesService.getScriptProperties();
    if (o.iat < (Number(p.getProperty("DPB_TOKEN_EPOCH") || 0) || 0)) return { ok: false };
    if (o.iat < (Number(p.getProperty("DPB_REVOKE_" + userKey_(o.u)) || 0) || 0)) return { ok: false };
    return { ok: true, user: o.u, exp: o.exp };
  } catch (e) { return { ok: false }; }
}
function revokeUserTokens_(username) {
  try { PropertiesService.getScriptProperties().setProperty("DPB_REVOKE_" + userKey_(username), String(Date.now())); } catch (e) {}
}
function noteTokenSeen_(ok) {
  try {
    var p = PropertiesService.getScriptProperties(), k = ok ? "DPB_TOK_LAST_WITH" : "DPB_TOK_LAST_WITHOUT", now = Date.now();
    if (now - (Date.parse(p.getProperty(k) || "") || 0) > 60000) p.setProperty(k, new Date(now).toISOString());
  } catch (e) {}
}
// بيرجّع null لو الطلب مسموح، أو رد 401 جاهز. القراءة (GET) والكتابة (POST) بيمرّوا من هنا.
function tokenGate_(tok) {
  var tv = verifyToken_(tok);
  noteTokenSeen_(tv.ok);
  if (!tv.ok && propFlag_("DPB_REQUIRE_TOKEN")) return { ok: false, error: "unauthorized: token", code: 401 };
  return null;
}
function handleRenewToken_(body) {
  var tv = verifyToken_(body.token);
  if (!tv.ok) return { ok: false, error: "unauthorized: token", code: 401 };
  var rows = sheetToObjects_(ensureSheet_(SHEET_USERS));
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (String(field_(r, ["Username"]) || "").trim().toLowerCase() !== tv.user) continue;
    if (String(field_(r, ["Active"])).toUpperCase() === "FALSE") break;
    var t = issueToken_(tv.user);
    return { ok: true, token: t.token, exp: t.exp };
  }
  return { ok: false, error: "unauthorized: token", code: 401 };
}

// مشروع جديد من غير أي أدمن في الشيت: أول حفظ لحساب Admin بس بيعدّي من غير هوية (عشان ما تتقفلش بره).
function adminExists_() {
  var rows = sheetToObjects_(ensureSheet_(SHEET_USERS));
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (String(field_(r, ["Role"]) || "").trim().toLowerCase() === "admin" && String(field_(r, ["Active"])).toUpperCase() !== "FALSE") return true;
  }
  return false;
}

function handleGetUsers_(body) {
  var users = sheetToObjects_(ensureSheet_(SHEET_USERS)).map(rowToUser_);
  var full = propFlag_("DPB_PINS_PUBLIC") || adminAuthOk_(body && body.auth);
  if (!full) users = users.map(publicUser_);
  return { ok: true, users: users, pinsHidden: !full };
}

// كتابة/تحديث حساب يوزر باحترام ترتيب أعمدة الشيت الفعلي (أيًا كان).
// FIX: بدل ما أي عمود ناقص (زي ProcessIDs/AllProcesses في الشيت الحالي
// اللي متعمولوش لسه) يتجاهل بهدوء وتضيع الصلاحية من غير أي رسالة، دلوقتي
// أي عمود مطلوب مش موجود بيتضاف تلقائيًا (عمود جديد بعد آخر عمود، بنفس
// الاسم) أول مرة يُحتاج فيها - من غير ما تلمس الشيت يدوي خالص.
function saveUserRow_(sh, existingRow, fields) {
  var lastCol = Math.max(sh.getLastColumn(), 1);
  var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var colIndex = {};
  headers.forEach(function (h, i) {
    colIndex[String(h).toLowerCase().replace(/[\s_]/g, "")] = i + 1;
  });
  var targetRow = existingRow || (sh.getLastRow() + 1);
  Object.keys(fields).forEach(function (key) {
    var normKey = key.toLowerCase().replace(/[\s_]/g, "");
    var col = colIndex[normKey];
    if (!col) {
      lastCol += 1;
      sh.getRange(1, lastCol).setValue(key); // ضيف اسم العمود نفسه (مثلاً "ProcessIDs") كهيدر جديد
      colIndex[normKey] = lastCol;
      col = lastCol;
    }
    sh.getRange(targetRow, col).setValue(fields[key]);
  });
}

function handleSaveUser_(body) {
  if (!propFlag_("DPB_AUTH_OFF") && !adminAuthOk_(body.auth)) {
    var bootstrap_ = !adminExists_() && String((body.user || {}).role || "").trim().toLowerCase() === "admin";
    if (!bootstrap_) return { ok: false, error: "unauthorized: admin credentials required" };
  }
  var u = body.user || {};
  var username = String(u.username || "").trim();
  if (!username) return { ok: false, error: "username required" };
  var sh = ensureSheet_(SHEET_USERS);
  var rows = sheetToObjects_(sh);
  var existing = rows.find(function (r) {
    return String(field_(r, ["Username"]) || "").trim().toLowerCase() === username.toLowerCase();
  });
  var fields_ = {
    UserID: u.userID || ("u_" + username.toLowerCase()),
    Username: username,
    Password: u.password || "",
    Role: u.role || "Supervisor",
    ProcessIDs: Array.isArray(u.processIds) ? u.processIds.join(",") : (u.processIds || ""),
    AllProcesses: u.allProcesses === true ? "TRUE" : "FALSE",
    Active: u.active === false ? "FALSE" : "TRUE"
  };
  // الجهاز اللي مش شايف الباسوردات (getUsers من غير هوية) ممكن يبعت password فاضي:
  // ده مايمسحش الباسورد الموجود في الشيت أبدًا.
  if (existing && !String(u.password === undefined || u.password === null ? "" : u.password).trim()) delete fields_.Password;
  var pinChanged_ = !!existing && fields_.Password !== undefined && String(fields_.Password).trim() !== String(field_(existing, ["Password"]) || "").trim();
  var deactivated_ = !!existing && u.active === false;
  saveUserRow_(sh, existing ? existing.__row : null, fields_);
  // الأمان: تغيير PIN أو تعطيل مستخدم بيلغي توكناته القديمة. لو الأدمن غيّر PIN بتاعه هو، بيستلم توكن جديد.
  if (pinChanged_ || deactivated_) {
    revokeUserTokens_(username);
    var caller_ = body.auth && String(body.auth.username || "").trim().toLowerCase();
    if (pinChanged_ && !deactivated_ && caller_ && caller_ === username.toLowerCase()) {
      var t_ = issueToken_(username);
      return { ok: true, token: t_.token, exp: t_.exp };
    }
  }
  return { ok: true };
}

function handleDeleteUser_(body) {
  if (!propFlag_("DPB_AUTH_OFF") && !adminAuthOk_(body.auth)) return { ok: false, error: "unauthorized: admin credentials required" };
  var username = String(body.username || "").trim().toLowerCase();
  var sh = ensureSheet_(SHEET_USERS);
  var rows = sheetToObjects_(sh);
  var existing = rows.find(function (r) {
    return String(field_(r, ["Username"]) || "").trim().toLowerCase() === username;
  });
  if (existing) sh.deleteRow(existing.__row);
  if (existing) revokeUserTokens_(username); // المستخدم المحذوف توكناته بتتلغي فورًا
  return { ok: true };
}

/* ---------------- History / Productivity logs ---------------- */

function handleLogHistory_(body) {
  var sh = ensureSheet_(SHEET_HISTORY);
  sh.appendRow([
    body.time || new Date().toISOString(),
    body.user || "",
    body.action || "",
    body.details || ""
  ]);
  return { ok: true };
}

function handleLogProductivity_(body) {
  var entries = Array.isArray(body.entries) ? body.entries : [];
  if (!entries.length) return { ok: true };
  var sh = ensureSheet_(SHEET_PRODUCTIVITY);
  var rows = entries.map(function (en) {
    return [
      en.time || new Date().toISOString(),
      en.supervisor || "",
      en.owner || "",
      en.source || "",
      en.process || "",
      en.code || "",
      en.tracker || "",
      en.row || "",
      en.unit || "",
      en.action || ""
    ];
  });
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);

  // FIX: كان هنا بينادي writeEntriesToExecutionSheet_(entries) وده مسار
  // تاني منفصل تمامًا عن upsertMany بيكتب في نفس خلية EXCUTION بمنطق
  // تصعيد أعمى، وبيتنفذ في طلب POST مستقل بترتيب مش مضمون مقابل
  // upsertMany - ده كان بيخلق تعارض/سباق حقيقي بين الاتنين على نفس
  // الخلية. الكتابة الوحيدة الموثوقة للخلية بقت من خلال upsertMany
  // (اللي بيعيد الحساب من سجلات Production الحقيقية دايمًا)، فمسار
  // Productivity هنا بقى سجل تدقيق (Audit log) بس من غير أي أثر على
  // EXCUTION.

  return { ok: true };
}

/* ---------------- Cross-device Production sync (upsertMany / GET) ------
 * البرنامج فيه طبقة مزامنة تانية (Cloud Production Sync) بتشتغل تلقائي
 * كل 25 ثانية + بعد أي حفظ، وبتتوقع بالظبط الشكل ده من السيرفر:
 *   POST {action:"upsertMany", records:[...]}  -> {ok:true}
 *   GET  (من غير أي باراميتر)                  -> {ok:true, data:[...]}
 * الدالتين دول بيقروا ويكتبوا في نفس شيت Production اللي handleSync_
 * بيستخدمه، فمفيش تعارض؛ وكمان بيكتبوا فعليًا في خلية EXCUTION الحيّة
 * زي منطق logProductivity بالظبط.
 * ------------------------------------------------------------------- */

function handleGetProduction_(clientRev) {
  var rev = currentRev_(); // نقراه قبل البيانات: لو حصلت كتابة بينهم الكلاينت ببساطة هيسحب تاني مرة كمان
  if (clientRev && String(clientRev) === rev) return { ok: true, unchanged: true, rev: rev, api: API_VERSION };
  var sh = ensureSheet_(SHEET_PRODUCTION);
  var rows = sheetToObjects_(sh);
  var data = rows.map(function (r) {
    var parsed = {};
    try { parsed = JSON.parse(r.DataJSON || "{}"); } catch (e) { parsed = {}; }
    parsed.id = parsed.id || r.RecordID;
    parsed.recordId = parsed.recordId || r.RecordID;
    parsed.projectId = parsed.projectId || r.ProjectID;
    parsed.time = isoOf_(r.UpdatedAt) || parsed.time;
    parsed.editedBy = parsed.editedBy || r.EditedBy;
    return parsed;
  });
  return { ok: true, data: data, rev: rev, api: API_VERSION, serverTime: new Date().toISOString() };
}

// يستقبل قايمة سجلات إنتاجية كاملة (بنفس شكل السجل المحلي بالظبط: id,
// time, projectId, key, user, owner, source, process, code, tracker, row,
// unit, sheet, r1, c1, r2, c2 ...) ويعمل upsert لكل واحد فيهم في شيت
// Production بالـ id (نفس منطق الـ RecordID في handleSync_)، وبرضه يكتب
// فعليًا في خلية شيت EXCUTION الحيّة لو السجل معاه إحداثيات صحيحة.
function handleUpsertMany_(body) {
  var t0_ = Date.now();
  var incoming = Array.isArray(body.records) ? body.records : [];
  if (!incoming.length) return { ok: true };
  var progRecs_ = incoming.filter(function (r) {
    return r && r.done !== undefined && r.done !== null && r.done !== "" && isFinite(Number(r.done)) && r.sheet !== undefined && r.r1 !== undefined && r.c1 !== undefined;
  });
  if (progRecs_.length) removeOtherRecordsForCells_(progRecs_);

  // FIX (Cascade يقتصر على "عائلة" العمليات المجمّعة بس، ومعزول تمامًا عن
  // أي عملية منفصلة زي Torque Tube أو أي عملية تانية تتضاف بعد كده):
  // السيرفر لوحده مش عارف من اسم التبويب بس مين "مجمّعة" (ramming/saddle/
  // bearing) ومين "منفصلة" (Torque Tube) - التصنيف ده معروف بس عند
  // البرنامج (Process Setup). فالبرنامج بيبعت قايمة أسماء العمليات
  // المجمّعة صراحة مع كل طلب (body.groupedProcessNames)، والسيرفر بيقصر
  // منطق التسلسل (cascade) على العمليات الموجودة في القايمة دي بس - مش
  // على كل تابات processOrderList_ زي الأول. أي عملية منفصلة (زي Torque
  // Tube) بتتجاهل تمامًا هنا: مش بتولّد Cascade، ومش بتستقبل Cascade من
  // حاجة تانية، ونفس الكلام ينطبق أوتوماتيك على أي عملية منفصلة جديدة
  // تتضاف بعدين من غير أي تعديل كود إضافي.
  var groupedNames_ = Array.isArray(body.groupedProcessNames) ? body.groupedProcessNames : [];
  groupedNamesSet_(groupedNames_); // v70: يحفظ قايمة العمليات المجمّعة عشان قاعدة القفل
  // noCascade: مسار حذف الـ siblings بيحتاج نفس السلوك القديم بالظبط (من غير Cascade)
  if (body.noCascade) groupedNames_ = [];
  else if (!groupedNames_.length) groupedNames_ = storedGroupedNames_();
  var groupedOrder_ = processOrderList_().filter(function (nm) {
    return groupedNames_.some(function (g) { return String(g).trim().toLowerCase() === nm.toLowerCase(); });
  });
  var cascadeRecords_ = [];
  incoming.forEach(function (rec) {
    if (!rec || !rec.process || !(Number(rec.code) > 0)) return;
    if (rec.sheet === undefined || rec.r1 === undefined || rec.c1 === undefined) return;
    var idx = -1;
    for (var i = 0; i < groupedOrder_.length; i++) {
      if (groupedOrder_[i].toLowerCase() === String(rec.process).trim().toLowerCase()) { idx = i; break; }
    }
    if (idx <= 0) return; // مش من العمليات المجمّعة، أو هي أول عملية مجمّعة أصلاً (مفيش حاجة قبلها)
    for (var k = 0; k < idx; k++) {
      cascadeRecords_.push({
        id: "cascade_" + groupedOrder_[k].toLowerCase() + "_" + rec.sheet + "_" + rec.r1 + "_" + rec.c1,
        time: rec.time || rec.updatedAt || new Date().toISOString(),
        user: rec.user || "System", owner: rec.owner || rec.user || "System", source: "Cascade",
        process: groupedOrder_[k], code: k + 1, // رقم العملية دي هي بالظبط (ترتيبها 1-indexed)، مش 1 ثابت
        tracker: rec.tracker, row: rec.row, unit: rec.unit,
        sheet: rec.sheet, r1: rec.r1, c1: rec.c1, r2: rec.r2, c2: rec.c2
      });
    }
  });
  if (cascadeRecords_.length) incoming = incoming.concat(cascadeRecords_);

  var sh = ensureSheet_(SHEET_PRODUCTION);
  var existingRows = sheetToObjects_(sh);
  var byId = {};
  existingRows.forEach(function (r) { byId[String(r.RecordID)] = r; });
  var appendRows_ = [];
  var stale_ = []; // FIX (المرحلة 2): السجلات اللي اترفضت لأن النسخة اللي على السيرفر أحدث - كانت بترد ok وتسكت
  try {
    var pf_ = PropertiesService.getScriptProperties();
    if (pf_.getProperty("DPB_PROD_TXT") !== "1") { sh.getRange("C:C").setNumberFormat("@"); pf_.setProperty("DPB_PROD_TXT", "1"); }
  } catch (e) {}
  incoming.forEach(function (rec) {
    var id = String(rec.id || rec.recordId || "");
    if (!id) return;
    var updatedAt = String(rec.time || rec.updatedAt || rec.editedAt || new Date().toISOString());
    var editedBy = String(rec.editedBy || rec.user || "");
    var old = byId[id];
    var oldT_ = old ? isoOf_(old.UpdatedAt) : "";
    if (old && oldT_ >= updatedAt) { // نسخة أقدم أو مساوية - تجاهل (لو أقدم فعلًا نبلّغ الكلاينت)
      if (oldT_ > updatedAt) stale_.push({ id: id, serverTime: oldT_ });
      return;
    }
    var rowData = [id, rec.projectId || "", updatedAt, editedBy, JSON.stringify(rec)];
    if (old && old.__row) {
      sh.getRange(old.__row, 1, 1, rowData.length).setValues([rowData]);
      old.UpdatedAt = updatedAt; old.DataJSON = rowData[4];
    } else if (old) { // v2.6: سجل اتضاف في نفس الدفعة (لسه في الذاكرة)
      appendRows_[old.__ai] = rowData; old.UpdatedAt = updatedAt; old.DataJSON = rowData[4];
    } else {
      var nobj_ = { RecordID: id, ProjectID: rowData[1], UpdatedAt: updatedAt, EditedBy: editedBy, DataJSON: rowData[4], __row: 0, __ai: appendRows_.length };
      appendRows_.push(rowData); existingRows.push(nobj_); byId[id] = nobj_;
    }
  });
  // v2.6: كتابة كل السجلات الجديدة دفعة واحدة بدل appendRow لكل سجل (كان أبطأ جزء في الحفظ)
  if (appendRows_.length) {
    sh.getRange(sh.getLastRow() + 1, 1, appendRows_.length, appendRows_[0].length).setValues(appendRows_);
  }

  // FIX: بدل ما نكتب رقم "incoming.code" في الخلية بتصعيد أعمى (لو أكبر
  // من الموجود اكتبه)، بنعيد حساب القيمة الصح من الصفر من سجلات Production
  // الحقيقية الموجودة فعلاً على نفس الخلية دلوقتي - نفس بالظبط المنطق
  // المستخدم في الإلغاء. كده مفيش فرصة لسجل زومبي قديم إنه "يصعّد" الخلية
  // برقم غلط تاني بعد ما اتصلحت، لأي طريقة كتابة كانت.
  var cells = {};
  incoming.forEach(function (rec) {
    if (rec && rec.sheet !== undefined && rec.r1 !== undefined && rec.c1 !== undefined) {
      var ck = String(rec.sheet) + "|" + rec.r1 + "|" + rec.c1 + "|" + String(rec.process || "");
      cells[ck] = { sheet: rec.sheet, r1: Number(rec.r1), c1: Number(rec.c1), r2: Number(rec.r2), c2: Number(rec.c2), process: rec.process || "" };
    }
  });
  var keys = Object.keys(cells);
  var missingTabs_ = [];
  if (keys.length) missingTabs_ = revertExecutionCells_(keys.map(function (k) { return cells[k]; }), existingRows) || [];
  var ms_ = Date.now() - t0_;

  if (missingTabs_.length) {
    return { ok: true, ms: ms_, stale: stale_, serverTime: new Date().toISOString(), warning: "لم يتم العثور على تبويب في جوجل شيتس لهذه العمليات، فتم تسجيل الإدخال لكن لم تُكتب الخلية فعليًا: " + missingTabs_.join("، "), missingTabs: missingTabs_ };
  }
  return { ok: true, ms: ms_, stale: stale_, serverTime: new Date().toISOString() };
}


/* ---------------- قاعدة القفل للعمليات المجمّعة (v70) ----------------
 * في العمليات المجمّعة فقط (اللي جاية من ملف Excel واحد، مثل
 * Ramming→Saddle→Bearing): لو مرحلة لاحقة اتنفذت على خلية، مينفعش تتحذف
 * أو تتفضّى مرحلة أسبق منها على نفس الخلية (يعني لو Bearing اتنفذت مينفعش
 * تفضّي Saddle أو Ramming وتسيبها فاضية). القاعدة بتتطبق هنا في السيرفر
 * عشان تشتغل من أي طريق: زر الحذف في الخريطة، شاشة الأدمن، أو مسح يدوي
 * من جوه الشيت. الترتيب بيتحدد بـ code العملية (مش بأسماء ثابتة)، فبتشتغل
 * مع أي عدد عمليات (3 أو 4 أو 5...). العمليات المنفصلة (زي Torque Tube)
 * برا القايمة فمش بتتأثر أبدًا. قايمة المجمّعة بتيجي من البرنامج مع كل
 * حفظ/حذف، وبتتخزن هنا عشان المسح اليدوي من الشيت (onEdit) يعرفها. */
function groupedNamesSet_(bodyNames) {
  var names = Array.isArray(bodyNames) ? bodyNames.filter(Boolean).map(String) : [];
  var props = null;
  try { props = PropertiesService.getScriptProperties(); } catch (e) { props = null; }
  if (names.length) {
    try { var s = JSON.stringify(names); if (props && props.getProperty("DPB_GROUPED") !== s) props.setProperty("DPB_GROUPED", s); } catch (e) {}
  } else if (props) {
    try { names = JSON.parse(props.getProperty("DPB_GROUPED") || "[]") || []; } catch (e) { names = []; }
  }
  var set = {};
  names.forEach(function (n) { set[String(n).trim().toLowerCase()] = true; });
  return set;
}

// FIX (المرحلة 1 / بند 3): آخر قايمة عمليات مجمّعة البرنامج بعتها (متخزنة في
// ScriptProperties). onEdit مش بيبعت قايمة، فكان الـ Cascade بيتخطى تمامًا
// لأي كتابة يدوية في الشيت.
function storedGroupedNames_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty("DPB_GROUPED") || "[]") || []; } catch (e) { return []; }
}

function groupedRecs_(data, groupedSet) {
  var out = [];
  for (var i = 1; i < data.length; i++) {
    var p;
    try { p = JSON.parse(data[i][4] || "{}"); } catch (e) { continue; }
    if (!p || p.r1 === undefined || p.c1 === undefined) continue;
    var proc = String(p.process || "").trim().toLowerCase();
    if (!groupedSet[proc]) continue;
    out.push({ id: String(data[i][0]), p: p, proc: proc, code: Number(p.code) || 0, key: Number(p.r1) + "|" + Number(p.c1) });
  }
  return out;
}

// سجلات محمية من الحذف: فيه سجل بمرحلة أعلى على نفس الخلية مش داخل في نفس طلب الحذف
function findBlockedDeletes_(data, idsSet, groupedSet) {
  var recs = groupedRecs_(data, groupedSet), maxRemaining = {}, blocked = {};
  recs.forEach(function (r) {
    if (idsSet[r.id]) return;
    var cur = maxRemaining[r.key];
    if (!cur || r.code > cur.code) maxRemaining[r.key] = { code: r.code, name: String(r.p.process || "") };
  });
  recs.forEach(function (r) {
    if (!idsSet[r.id]) return;
    var m = maxRemaining[r.key];
    if (m && m.code > r.code) blocked[r.id] = { id: r.id, process: String(r.p.process || ""), r1: Number(r.p.r1), c1: Number(r.p.c1), lockedBy: m.name };
  });
  return blocked;
}

// المسح اليدوي من الشيت: الخلايا اللي عليها مرحلة لاحقة بتتسترجع قيمتها الصح
// (بدل ما تتحذف)، والباقي بيكمل حذف عادي. بترجّع الخلايا المسموح تتحذف.
function restoreLockedCells_(cells, groupedSet) {
  var sh = ensureSheet_(SHEET_PRODUCTION);
  var recs = groupedRecs_(sh.getDataRange().getValues(), groupedSet);
  var allowed = [], restore = [], lockedNames = [];
  cells.forEach(function (c) {
    var proc = String(c.process || "").trim().toLowerCase();
    if (!groupedSet[proc]) { allowed.push(c); return; }
    var key = Number(c.r1) + "|" + Number(c.c1), own = null, laterName = "", laterCode = 0;
    recs.forEach(function (r) {
      if (r.key !== key) return;
      if (r.proc === proc) { if (!own || r.code > own.code) own = r; }
    });
    if (!own) { allowed.push(c); return; }
    recs.forEach(function (r) {
      if (r.key === key && r.proc !== proc && r.code > own.code && r.code > laterCode) { laterCode = r.code; laterName = String(r.p.process || ""); }
    });
    if (!laterName) { allowed.push(c); return; }
    restore.push({ sheet: own.p.sheet || "", r1: Number(own.p.r1), c1: Number(own.p.c1), r2: Number(own.p.r2), c2: Number(own.p.c2), process: own.p.process || "", processTab: String(own.p.processTab || "") });
    lockedNames.push(String(c.process) + " ← " + laterName);
  });
  if (restore.length) {
    revertExecutionCells_(restore);
    try { ss_().toast("🔒 مينفعش تفضّي مرحلة سابقة بعد ما مرحلة لاحقة اتنفذت على نفس الخلية (" + lockedNames[0] + "). اتسترجعت القيمة.", "DPB", 8); } catch (e) {}
  }
  return allowed;
}

// بيمسح سجلات Production بالكامل بناءً على قايمة IDs - بينادى لما حد
// يلغي "إدخال" من Production entry في البرنامج، عشان السجل يتمسح فعليًا
// من الشيت مش يترجع تاني مع أول مزامنة دورية (كل 25 ثانية).
//
// FIX 1: كان بيمسح صف Production بس ويسيب رقم الخلية في EXCUTION زي ما هو
// (لأن الكتابة التانية بتستخدم Math.max اللي بيصعّد بس، مش بينزل). هنا
// بنجمع أماكن الخلايا اللي هتتأثر قبل المسح، وبعد المسح بنحسب أعلى رقم
// عملية لسه باقي فعلاً لنفس الخلية من باقي السجلات، ونكتبه هو بالظبط
// (0 لو معدش فيه أي سجل تاني على نفس الخلية).
//
// FIX 2: لو فيه سجل "شقيق" لسه موجود محليًا عند المستخدم بس لسه مترفعش
// للسحابة (سباق توقيت مع المزامنة الدورية كل 25 ثانية)، كنا بنحسب "معدش
// حاجة" بالغلط ونمسح الخلية بالكامل بدل ما نرجعها للمرحلة السابقة
// الصحيحة. body.siblings بيوصل معاه أي سجلات كده، فبنرفعها (upsert) هنا
// الأول قبل ما نحسب القيمة، عشان الحساب يبقى معتمد على الحقيقة الكاملة
// مش على توقيت المزامنة.
function handleDeleteMany_(body) {
  var ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
  if (!ids.length) return { ok: true, deleted: 0 };

  var siblings = Array.isArray(body.siblings) ? body.siblings : [];
  if (siblings.length) handleUpsertMany_({ records: siblings, noCascade: true });

  var sh = ensureSheet_(SHEET_PRODUCTION);
  var data = sh.getDataRange().getValues();
  var toDeleteRows = [];
  var affectedCells = {};

  // v70: قاعدة القفل (السيرفر هو المرجع الأخير)
  var idsSet_ = {};
  ids.forEach(function (x) { idsSet_[x] = true; });
  var blocked_ = findBlockedDeletes_(data, idsSet_, groupedNamesSet_(body.groupedProcessNames));

  for (var i = 1; i < data.length; i++) {
    if (ids.indexOf(String(data[i][0])) === -1) continue;
    if (blocked_[String(data[i][0])]) continue;
    toDeleteRows.push(i + 1);
    try {
      var parsed = JSON.parse(data[i][4] || "{}");
      if (parsed && parsed.r1 !== undefined && parsed.c1 !== undefined) {
        var ck = String(parsed.sheet || "") + "|" + parsed.r1 + "|" + parsed.c1 + "|" + String(parsed.process || "") + "|" + String(parsed.code || "");
        affectedCells[ck] = {
          sheet: parsed.sheet || "",
          r1: Number(parsed.r1), c1: Number(parsed.c1),
          r2: Number(parsed.r2), c2: Number(parsed.c2),
          process: parsed.process || "", code: Number(parsed.code) || 0
        };
      }
    } catch (e) {}
  }

  toDeleteRows.sort(function (a, b) { return b - a; });
  toDeleteRows.forEach(function (r) { sh.deleteRow(r); });

  if (Object.keys(affectedCells).length) {
    revertExecutionCells_(Object.keys(affectedCells).map(function (k) { return affectedCells[k]; }));
  }
  SpreadsheetApp.flush();
  var blockedList_ = Object.keys(blocked_).map(function (k) { return blocked_[k]; });
  return { ok: true, deleted: toDeleteRows.length, blocked: blockedList_ };
}

// Recompute the exact remaining stage for EACH process tab independently.
// A deletion must never leave a zombie number in the process tab.
function a1_(row, col, h, w) {
  function L(n) { var t = ""; while (n > 0) { var m = (n - 1) % 26; t = String.fromCharCode(65 + m) + t; n = Math.floor((n - 1) / 26); } return t; }
  var a = L(col) + row;
  return (h > 1 || w > 1) ? a + ":" + L(col + w - 1) + (row + h - 1) : a;
}

function revertExecutionCells_(cells, rowsOpt) {
  var sh = ensureSheet_(SHEET_PRODUCTION);
  var remaining = rowsOpt || sheetToObjects_(sh); // v2.6: نعيد استخدام القراءة اللي حصلت في upsertMany
  var ss = ss_();
  var tabCache = {};
  var writes_ = {};
  // FIX (بلّغ بدل ما تتجاهل بصمت): لو عملية زي Torque Tube مالهاش تاب
  // مطابق في الشيت، السجل كان بيتسجل في Production لكن الخلية الفعلية
  // في الشيت متتكتبش - من غير أي تنبيه للمستخدم. دلوقتي بنجمّع أسماء
  // العمليات اللي فشلت كده ونرجّعها للكولر عشان يوصلوا للواجهة.
  var missingTabs = {};

  // v69: كان بيعمل JSON.parse لكل سجل في Production مرة لكل خلية (آلاف
  // السجلات x كل خلية = بطء شديد وقفل السكربت مشغول). دلوقتي بنقرأ كل سجل
  // مرة واحدة ونفهرسه بمفتاح (sheet|r1|c1|process)، والبحث بعد كده فوري.
  // نفس شروط المطابقة القديمة بالظبط (بما فيها processTab).
  var idx_ = {};
  remaining.forEach(function (r) {
    var parsed = {};
    try { parsed = JSON.parse(r.DataJSON || "{}"); } catch (e) { return; }
    var pr1 = Number(parsed.r1), pc1 = Number(parsed.c1);
    if (!isFinite(pr1) || !isFinite(pc1)) return;
    var k = String(parsed.sheet) + "|" + pr1 + "|" + pc1 + "|" + String(parsed.process || "");
    // عمليات "التقدم" (زي Modules): السجل بيحمل done = عدد الوحدات المنجزة التراكمي، وهو اللي بيتكتب في الخلية
    var dn_ = (parsed.done !== undefined && parsed.done !== null && parsed.done !== "" && isFinite(Number(parsed.done))) ? Math.max(0, Number(parsed.done)) : null;
    if (dn_ !== null && isFinite(Number(parsed.total)) && Number(parsed.total) > 0) dn_ = Math.min(dn_, Number(parsed.total));
    (idx_[k] = idx_[k] || []).push({ code: Number(parsed.code) || 0, tab: parsed.processTab ? String(parsed.processTab) : "", done: dn_, val: (dn_ !== null ? dn_ : (Number(parsed.code) || 0)), time: String(parsed.time || parsed.updatedAt || "") });
  });

  cells.forEach(function (cell) {
    var tabName = tabNameForProcess_(cell.process, cell.code);
    if (!tabName) { missingTabs[String(cell.process || "?")] = true; return; }
    var tab = tabCache[tabName];
    if (tab === undefined) { tab = ss.getSheetByName(tabName); tabCache[tabName] = tab; }
    if (!tab) { missingTabs[String(cell.process || "?")] = true; return; }

    var maxCode = 0;
    if (isFinite(cell.r1) && isFinite(cell.c1)) {
      var hits_ = idx_[String(cell.sheet) + "|" + cell.r1 + "|" + cell.c1 + "|" + String(cell.process || "")] || [];
      var progAny_ = false, latest_ = null;
      hits_.forEach(function (h) {
        if (cell.processTab && h.tab && h.tab !== String(cell.processTab)) return;
        if (h.code > maxCode) maxCode = h.code;
        if (h.done !== null && h.done !== undefined) progAny_ = true;
        if (!latest_ || h.time >= latest_.time) latest_ = h;
      });
      // progress: لو الخلية عليها سجل تقدم، آخر سجل (بالوقت) هو الحقيقة سواء كان تقدم أو كتابة يدوية في الشيت، مش أعلى كود
      if (progAny_ && latest_) maxCode = latest_.val;
    }

    try {
      var row = cell.r1 + 1, col = cell.c1 + 1;
      var height = cell.r2 >= cell.r1 ? (cell.r2 - cell.r1 + 1) : 1;
      var width = cell.c2 >= cell.c1 ? (cell.c2 - cell.c1 + 1) : 1;
      // FIX (التناقض الحقيقي بين البرنامج والشيت): كان بيكتب "" (فاضي)
      // لما آخر سجل يتلغى، والواجهة بتتجاهل الخلايا الفاضية تمامًا وقت
      // قراءة الشبكة اللايف (معتبراها "لسه محدش قرأها" مش "الشيت قال
      // صراحة إنها فاضية"). فكانت الشاشة بترجع تعتمد على سجل محلي قديم
      // عالق (لو موجود) بدل ما تصدّق إلغاء الشيت الصريح - فتفضل الخلية
      // "Done" في البرنامج رغم إنها فعليًا فاضية في الشيت. الحل: نكتب
      // الرقم 0 صراحةً (مش ""), عشان الواجهة تستقبله كـ"تأكيد رسمي إن
      // الخلية فاضية" وتلغي أي سجل محلي قديم عالق فورًا.
      // v2.6: تجميع الكتابة حسب (تبويب، قيمة) ونكتبها دفعة واحدة بعد اللوب
      var wk_ = tabName + "|" + maxCode;
      (writes_[wk_] = writes_[wk_] || { tab: tab, val: maxCode, a1: [] }).a1.push(a1_(row, col, height, width));
    } catch (e) {}
  });
  Object.keys(writes_).forEach(function (k) {
    var w = writes_[k];
    try { w.tab.getRangeList(w.a1).setValue(w.val); } catch (e) {}
  });
  SpreadsheetApp.flush();
  return Object.keys(missingTabs);
}

/* ---------------- Unit map (cell -> logical unit) + Sheet-side edits ---
 * البرنامج بيبعت الخريطة دي مرة واحدة بعد كل "Build Plan" (شيت، صف،
 * تراكر، رقم الوحدة، وإحداثيات الخلية). بنستخدمها هنا في onEdit_ عشان
 * لما حد يعدّل يدوي في خلية جوه تبويب EXCUTION، نعرف الوحدة دي بتاعة
 * مين بالظبط، ونعمل سجل Production مطابق يترجع للبرنامج تلقائي زي أي
 * سجل تاني (لأن البرنامج بيسحب Production كل شوية وبيدمجها).
 * ------------------------------------------------------------------- */

function handleSaveUnitMap_(body) {
  var rows = Array.isArray(body.rows) ? body.rows : [];
  var sh = ensureSheet_(SHEET_UNITMAP);
  // إعادة كتابة الخريطة بالكامل في كل مرة (الخطة بتتغير من الآخر لحد
  // الأول لما حد يعمل Build جديد)، فمفيش داعي لعمل upsert جزئي هنا.
  var lastRow = sh.getLastRow();
  if (lastRow > 1) sh.getRange(2, 1, lastRow - 1, HEADERS.UnitMap.length).clearContent();
  if (!rows.length) return { ok: true };
  var out = rows.map(function (r) {
    return [
      String(r.sheet || ""), String(r.row || ""), String(r.tracker || ""), Number(r.unit) || 0,
      Number(r.r1), Number(r.c1), Number(r.r2), Number(r.c2)
    ];
  });
  sh.getRange(2, 1, out.length, HEADERS.UnitMap.length).setValues(out);
  return { ok: true, count: out.length };
}

// بيبني خريطة بحث سريعة (Object) من تبويب UnitMap مرة واحدة بس - عشان
// لو تعديل واحد شمل أكتر من خلية (لصق/سحب)، منقراش الشيت كله (ممكن
// يبقى فيه آلاف الصفوف) لكل خلية على حدة، وده كان بيبطّئ التنفيذ لحد
// ما جوجل توقفه بالقوة (الـ onEdit البسيط له سقف وقت قصير جدًا).
function buildUnitMapIndex_() {
  var sh = ss_().getSheetByName(SHEET_UNITMAP);
  var idx = {};
  if (!sh) return idx;
  var values = sh.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (row.join("") === "") continue;
    var r1 = Number(row[4]), c1 = Number(row[5]); // R1, C1
    idx[r1 + "_" + c1] = { sheet: String(row[0] || ""), row: String(row[1] || ""), tracker: String(row[2] || ""), unit: Number(row[3]) || 0, r1: r1, c1: c1, r2: Number(row[6]), c2: Number(row[7]) };
  }
  return idx;
}

// Simple trigger — بيتنفذ أوتوماتيك من جوجل شيتس نفسها لما أي حد يعدّل
// خلية (أو مجموعة خلايا - لصق/سحب) يدوي (مش محتاج أي تركيب/تفعيل
// إضافي، بيشتغل بمجرد وجود الدالة).

// Targeted DELETE path: clearing a process-tab cell is a real deletion.
// It deliberately does not touch the normal add/change path.
function deleteProductionForCells_(cells) {
  if (!Array.isArray(cells) || !cells.length) return 0;
  var sh = ensureSheet_(SHEET_PRODUCTION);
  var data = sh.getDataRange().getValues();
  var toDelete = [];
  var affected = {};
  var cellMatches = cells.map(function(c){
    return {
      sheet: String(c.sheet || ""), processTab: String(c.processTab || ""),
      process: String(c.process || ""), r1:Number(c.r1), c1:Number(c.c1),
      r2:Number(c.r2), c2:Number(c.c2)
    };
  });
  for (var i=1;i<data.length;i++) {
    var parsed;
    try { parsed = JSON.parse(data[i][4] || "{}"); } catch(e) { continue; }
    var match = cellMatches.some(function(c){
      if (String(parsed.process || "").trim().toLowerCase() !== c.process.trim().toLowerCase()) return false;
      if (Number(parsed.r1) !== c.r1 || Number(parsed.c1) !== c.c1) return false;
      var ptab = String(parsed.processTab || "").trim();
      // DELETE must identify the real Production record by the physical
      // process tab + coordinates. Do NOT require parsed.sheet to match: old
      // records created by Production Entry may carry the Excel source-sheet
      // name while UnitMap carries a different Google/plan sheet name.
      if (c.processTab && ptab) return ptab.toLowerCase() === c.processTab.trim().toLowerCase();
      // Legacy records have no processTab. In that case process + coordinates
      // are the authoritative identity for this active project.
      return true;
    });
    if (!match) continue;
    toDelete.push(i+1);
    var ck=String(parsed.sheet||"")+"|"+parsed.r1+"|"+parsed.c1+"|"+String(parsed.process||"");
    affected[ck]={sheet:parsed.sheet||"",r1:Number(parsed.r1),c1:Number(parsed.c1),r2:Number(parsed.r2),c2:Number(parsed.c2),process:parsed.process||"",processTab:String(parsed.processTab||"")};
  }
  // IMPORTANT: clearing one process must NOT delete genuine earlier-process
  // records. In a grouped file those earlier records are the completed
  // history that makes the previous operation remain locked/complete. Only
  // the record belonging to the cleared process is removed; recomputation
  // then restores the highest remaining stage.
  var extraDelete=[];
  toDelete.sort(function(a,b){return b-a;});
  toDelete.forEach(function(r){sh.deleteRow(r);});
  if(Object.keys(affected).length) revertExecutionCells_(Object.keys(affected).map(function(k){return affected[k];}));
  // Recompute all process tabs touched by removed cascade records too.
  if(extraDelete.length){
    var allAffected={};
    cellMatches.forEach(function(c){allAffected[c.process+'|'+c.r1+'|'+c.c1]={sheet:c.sheet,r1:c.r1,c1:c.c1,r2:c.r2,c2:c.c2,process:c.process,processTab:c.processTab};});
    // Recompute every process represented by the remaining records at these cells.
    Object.keys(allAffected).forEach(function(k){revertExecutionCells_([allAffected[k]]);});
  }
  SpreadsheetApp.flush();
  return toDelete.length;
}

function onEdit(e) {
  try {
    if (!e || !e.range) return;
    var sheet = e.range.getSheet();
    var sheetName = sheet.getName();
    var processName = processNameForTab_(sheetName);
    if (!processName) return;

    var numRows = e.range.getNumRows(), numCols = e.range.getNumColumns();
    var values = e.range.getValues();
    var startRow = e.range.getRow(), startCol = e.range.getColumn();
    var editor = (e.user && e.user.getEmail && e.user.getEmail()) || "Sheet";
    var now = new Date().toISOString();
    var unitIndex = buildUnitMapIndex_();
    var changedCells = [];
    var clearedCells = [];
    var setCells = [];
    var records = [];

    for (var i = 0; i < numRows; i++) {
      for (var j = 0; j < numCols; j++) {
        var r1 = (startRow + i) - 1, c1 = (startCol + j) - 1;
        var unit = unitIndex[r1 + "_" + c1];
        if (!unit) continue;
        var value = values[i][j];
        var raw = String(value === null || value === undefined ? "" : value).trim();
        var code = Number(raw);

        // IMPORTANT: the physical process tab is part of the identity.
        // This prevents Ramming/Saddle/Bearing records from colliding when
        // the same logical plan coordinate exists in several tabs.
        var cellObj_ = {
          sheet: unit.sheet,
          processTab: sheetName,
          r1: unit.r1, c1: unit.c1, r2: unit.r2, c2: unit.c2,
          process: processName, code: code || 0
        };
        changedCells.push(cellObj_);

        // A cleared/invalid cell means DELETE for this process only.
        if (!raw || !Number.isFinite(code) || code <= 0) { clearedCells.push(cellObj_); continue; }
        setCells.push(cellObj_);
        records.push({
          id: "sheetedit_" + processName + "_" + r1 + "_" + c1,
          time: now, user: editor, owner: editor, source: "SheetEdit",
          process: processName, processTab: sheetName, code: code,
          tracker: unit.tracker, row: unit.row, unit: unit.unit,
          sheet: unit.sheet, r1: unit.r1, c1: unit.c1, r2: unit.r2, c2: unit.c2
        });
      }
    }

    runLocked_(function () {
      // FIX (المرحلة 1 / بند 3): الخلايا المتفضّية دايمًا بتعدّي على مسار الحذف
      // اللي بيحترم القفل، حتى لو نفس اللصقة فيها خلايا تانية فيها قيم. قبل كده
      // أي لصق مختلط كان بيمسح سجلات الخلايا الفاضية من غير فحص القفل.
      if (clearedCells.length) {
        // v70: مرحلة سابقة عليها مرحلة لاحقة منفّذة = القيمة بتتسترجع مش بتتحذف
        var gset_ = groupedNamesSet_(null);
        var toDel_ = Object.keys(gset_).length ? restoreLockedCells_(clearedCells, gset_) : clearedCells;
        if (toDel_.length) deleteProductionForCells_(toDel_);
      }
      if (records.length) {
        removeOtherRecordsForCells_(setCells);
        handleUpsertMany_({records: records});
      }
      SpreadsheetApp.flush();
      return {ok: true};
    });
  } catch (err) {
    // Simple onEdit must never surface an exception to the sheet user.
  }
}
function processNameForTab_(tabName) {
  if (isIgnoredTab_(tabName)) return null;
  var key = String(tabName || "").trim().toLowerCase();
  var norm = key.replace(/[^a-z0-9\u0600-\u06ff]+/g, "");
  var list = processOrderList_();
  for (var i = 0; i < list.length; i++) {
    if (list[i].toLowerCase() === key) return list[i];
  }
  // Also support operation tabs named with their code and/or without spaces,
  // e.g. "1 Ramming", "TorqueTube", "4-Torque Tube".
  for (var j = 0; j < list.length; j++) {
    var name = list[j], ln = name.toLowerCase();
    var lnorm = ln.replace(/[^a-z0-9\u0600-\u06ff]+/g, "");
    if ((norm && (lnorm.indexOf(norm) !== -1 || norm.indexOf(lnorm) !== -1)) ||
        (!norm && (ln.indexOf(key) !== -1 || key.indexOf(ln) !== -1))) return name;
  }
  return null;
}

/* ---------------- Live grid (single source of truth) ---------------- */

// بترجّع محتوى تبويب EXCUTION بالكامل زي ما هو دلوقتي بالظبط: كل قيم
// الخلايا + الخلايا المدمجة (Merged cells، مهمة عشان نعرف حدود كل "ROW
// N" وكل تراكر). البرنامج هيستخدم النتيجة دي لبناء الخريطة بالكامل من
// الشيت اللايف، بدل نسخة مجمّدة من ملف إكسل.
function handleGetProcesses_() {
  var list = processOrderList_();
  return { ok: true, processes: list.map(function(name, i) { return { name: name, code: i + 1, tab: name }; }) };
}

function handleGetGrid_(sheetParam, includeColors, light) {
  var ss = ss_();
  var tabName = sheetParam ? tabNameForProcess_(sheetParam) : EXECUTION_TAB_NAME;
  var sh = ss.getSheetByName(tabName);
  if (!sh) return { ok: false, error: "Sheet '" + tabName + "' not found" };
  var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  if (lastRow < 1 || lastCol < 1) return { ok: true, sheet: tabName, values: [], merges: [], rows: 0, cols: 0 };
  var range = sh.getRange(1, 1, lastRow, lastCol);
  var values = range.getValues();
  // v69: وضع light (بيستخدمه الـ poll كل 8 ثواني فقط): بيرجّع القيم والألوان
  // بس. الدمج والحدود والـ mirror ثابتين ومتخزنين عند الجهاز من الـ Build،
  // فمفيش داعي نقرأ ملف Drive (mirror) ولا نبعت خلفياته الكبيرة كل 8 ثواني.
  var merges = [];
  if (!light) {
    var mergedRanges = range.getMergedRanges();
    merges = mergedRanges.map(function (r) {
      return { r1: r.getRow() - 1, c1: r.getColumn() - 1, r2: r.getLastRow() - 1, c2: r.getLastColumn() - 1 };
    });
  }
  var out = { ok: true, sheet: tabName, values: values, merges: merges, rows: lastRow, cols: lastCol };
  // FIX (لون خلية حقيقي حي من جوجل شيت -> يظهر على الخريطة): بطلب صريح من
  // المستخدم إن الخاصية دي المفروض شغالة زي الأول - رجّعناها، لكن بشرط
  // إنها ما تأثرش على أي مكان تاني بيستخدم getGrid العادي. getBackgrounds()
  // فعلاً أبطأ من getValues() (زي ما اتفقنا قبل كده)، فبدل ما نحملها على
  // كل نداء getGrid في البرنامج (ده كان هيرجّع نفس مشكلة التقل اللي
  // اتصلحت قبل كده في الـ150 ثانية)، بنجيبها بس لما الطالب يطلبها صراحة
  // (includeColors=true) - وده بيحصل بس من الـpolling الخاص بشاشة الماب
  // الدايناميك المفتوحة فعليًا (كل 8 ثواني)، مش من أي مكان تاني في البرنامج.
  if (includeColors) {
    out.liveColors = range.getBackgrounds();
  }
  if (light) return out;
  // FIX (الحدود والألوان الحقيقية بين الأجهزة): الجهاز اللي عمل Build بيرفع
  // الحدود (أكبر Named Range) والألوان الحقيقية (fills) والدمج بتاع الإكسل
  // نفسه مرة واحدة عن طريق kvPatch("mirror_"+tab) - مش Named Ranges جوجل
  // شيت نفسها (اللي بتتلخبط مع أي استيراد إكسل جديد). أي جهاز تاني بيجيبها
  // هنا تلقائيًا مع كل getGrid، من غير ما يرفع نفس الإكسل ومن غير أي
  // اعتماد على Named Ranges الشيت.
  try {
    var mirror = JSON.parse(dpbKvGet_("mirror_" + tabName).json || "{}");
    if (mirror && Array.isArray(mirror.areas) && mirror.areas.length) {
      out.namedRanges = mirror.areas.map(function (a) {
        return { name: mirror.base || "", r1: a.r1, c1: a.c1, r2: a.r2, c2: a.c2 };
      });
    }
    if (mirror && Array.isArray(mirror.backgrounds) && mirror.backgrounds.length) out.backgrounds = mirror.backgrounds;
    if (mirror && Array.isArray(mirror.merges) && mirror.merges.length) out.excelMerges = mirror.merges;
  } catch (e) { /* مفيش نسخة محفوظة لسه لهذا التبويب - عادي، الكلاينت هيرجع لسلوكه القديم */ }
  return out;
}

// بتنادي handleGetGrid_ لكل اسم عملية في القايمة وترجّع كل النتايج مع
// بعض في استجابة واحدة: { ok:true, grids: { "Ramming": {...getGrid
// result...}, "Saddle": {...} } }. لو عملية معينة فشلت (شيت مش موجود
// مثلًا) بتتسجل جوه grids بنفس شكل الخطأ العادي ({ok:false,error})
// من غير ما توقف باقي العمليات - نفس منطق Promise.all(...).catch اللي
// كان الكلاينت بيعمله، بس دلوقتي في السيرفر وفي رحلة شبكة واحدة.
// v2.6.1: تشخيص السرعة. افتح الرابط ?action=bench من المتصفح وابعت الناتج:
// بيقيس زمن كل خطوة تقيلة (قراءة Production، وقيم وألوان كل تبويب عملية).
function handleBench_() {
  var out = { ok: true, steps: [] };
  var all0 = Date.now();
  function t(name, fn) {
    var s0 = Date.now(), info;
    try { info = fn(); } catch (e) { info = "ERR " + String((e && e.message) || e); }
    out.steps.push({ step: name, ms: Date.now() - s0, info: info });
  }
  var ss;
  t("open spreadsheet", function () { ss = ss_(); return ss.getName(); });
  t("read Production", function () { return ensureSheet_(SHEET_PRODUCTION).getDataRange().getValues().length + " rows"; });
  processOrderList_().forEach(function (nm) {
    var tab = tabNameForProcess_(nm);
    var sh = tab && ss.getSheetByName(tab);
    if (!sh) { out.steps.push({ step: nm, info: "tab not found" }); return; }
    var rows = Math.max(sh.getLastRow(), 1), cols = Math.max(sh.getLastColumn(), 1);
    var r = sh.getRange(1, 1, rows, cols);
    t(nm + " values (" + rows + "x" + cols + ")", function () { return r.getValues().length; });
    t(nm + " colors", function () { return r.getBackgrounds().length; });
  });
  out.totalMs = Date.now() - all0;
  return out;
}

function handleGetGridBatch_(processNames, includeColors, light) {
  var t0_ = Date.now();
  var list = Array.isArray(processNames) ? processNames : [];
  var grids = {};
  for (var i = 0; i < list.length; i++) {
    var name = String(list[i] || "").trim();
    if (!name) continue;
    try {
      grids[name] = handleGetGrid_(name, includeColors, light);
    } catch (e) {
      grids[name] = { ok: false, error: String((e && e.message) || e) };
    }
  }
  return { ok: true, grids: grids, ms: Date.now() - t0_ };
}

// بتمسح أي سجل Production موجود بالفعل لنفس الخلية (sheet+r1+c1) بغض
// النظر عن الـ id بتاعه، ما عدا الـ id اللي جاي جوه newRecords نفسها
// (سجل التعديل اليدوي الجديد). بتنادى قبل upsert التعديل اليدوي عشان
// تضمن إن التعديل يبقى الأحق بتحديد قيمة الخلية.
function removeOtherRecordsForCells_(newRecords) {
  var keepIds = {};
  var cellKeys = {};
  newRecords.forEach(function (r) {
    if (r.id !== undefined) keepIds[String(r.id)] = true;
    var processTab = String(r.processTab || "");
    cellKeys[String(r.sheet) + "|" + r.r1 + "|" + r.c1 + "|" + String(r.process || "") + "|" + processTab] = true;
  });
  var sh = ensureSheet_(SHEET_PRODUCTION);
  var data = sh.getDataRange().getValues();
  var toDeleteRows = [];
  for (var i = 1; i < data.length; i++) {
    var id = String(data[i][0]);
    if (keepIds[id]) continue;
    try {
      var parsed = JSON.parse(data[i][4] || "{}");
      var ptab = String(parsed.processTab || "");
      var ck = String(parsed.sheet) + "|" + parsed.r1 + "|" + parsed.c1 + "|" + String(parsed.process || "") + "|" + ptab;
      var legacyKey = String(parsed.sheet) + "|" + parsed.r1 + "|" + parsed.c1 + "|" + String(parsed.process || "") + "|";
      if (cellKeys[ck] || (ptab === "" && cellKeys[legacyKey])) toDeleteRows.push(i + 1);
    } catch (e) { /* ignore malformed row */ }
  }
  toDeleteRows.sort(function (a, b) { return b - a; });
  toDeleteRows.forEach(function (r) { sh.deleteRow(r); });
}

// كل عملية حفظ في البرنامج بتوصل هنا ومعاها sheet/r1/c1/r2/c2 (إحداثيات
// الخلية الفعلية زي ما اتقرت من ملف الخطة وقت الرفع). لو الإحداثيات دي
// موجودة ومعاها كود عملية (1/2/3...)، بنكتب القيمة في نفس الخلية بالظبط
// جوه تبويب EXCUTION (هو تبويب جوه نفس الشيت اللي السكربت مربوط بيه).
// القيمة بتتكتب بمنطق "تصاعدي فقط" (Math.max) زي بالظبط منطق التطبيق،
// عشان مرحلة متقدمة (Bearing=3) متترجعش لمرحلة أقل (Ramming=1) بالغلط.
function writeEntriesToExecutionSheet_(entries) {
  var toWrite = entries.filter(function (en) {
    return en && en.r1 !== undefined && en.r1 !== null && en.c1 !== undefined && en.c1 !== null && en.code;
  });
  if (!toWrite.length) return;

  var ss = ss_(); // نفس الشيت اللي السكربت مربوط بيه (EXCUTION)

  // ملحوظة: en.sheet جاي من اسم الشيت الداخلي جوه ملف الإكسيل الأصلي
  // (مثلاً "plan")، ومش هو نفسه اسم التبويب الحقيقي في جوجل شيتس. التبويب
  // الحي اللي فيه الأرقام دايمًا واحد بس وهو EXECUTION_TAB_NAME، فبنكتب
  // فيه مباشرة من غير ما نحاول نطابق اسم الشيت الجاي من الـ Excel.
  var tab = ss.getSheetByName(EXECUTION_TAB_NAME);
  if (!tab) return; // التبويب مش موجود - تجاهل

  toWrite.forEach(function (en) {
    try {
      // r1/c1 جايين من SheetJS وهما مبنيين على أساس صفر (0-indexed)؛
      // الـ Range API في Google Sheets مبني على أساس واحد (1-indexed).
      var row = Number(en.r1) + 1;
      var col = Number(en.c1) + 1;
      var height = Number(en.r2) >= Number(en.r1) ? (Number(en.r2) - Number(en.r1) + 1) : 1;
      var width = Number(en.c2) >= Number(en.c1) ? (Number(en.c2) - Number(en.c1) + 1) : 1;
      if (row < 1 || col < 1) return;
      var range = tab.getRange(row, col, height, width);
      var current = Number(range.getValue()) || 0;
      var incoming = Number(en.code) || 0;
      if (incoming > current) range.setValue(incoming);
    } catch (e) {
      // خلية واحدة فشلت (مثلاً برّه حدود الشيت) - كمّل الباقي عادي
    }
  });
}

/* ---------------- Bidirectional Production sync ---------------- */

function handleSync_(body) {
  var projectId = String(body.projectId || "").trim();
  var since = String(body.since || "").trim();
  var incoming = Array.isArray(body.records) ? body.records : [];
  var sh = ensureSheet_(SHEET_PRODUCTION);

  // 1) ارفع أي سجلات جديدة/معدّلة جاية من التطبيق (upsert بالـ RecordID)
  if (incoming.length) {
    var existingRows = sheetToObjects_(sh);
    var byId = {};
    existingRows.forEach(function (r) { byId[String(r.RecordID)] = r; });
    incoming.forEach(function (rec) {
      var id = String(rec.recordId || rec.id || "");
      if (!id) return;
      var updatedAt = String(rec.updatedAt || rec.editedAt || new Date().toISOString());
      var editedBy = String(rec.editedBy || rec.user || "");
      var rowData = [id, rec.projectId || projectId, updatedAt, editedBy, JSON.stringify(rec)];
      var old = byId[id];
      if (old && isoOf_(old.UpdatedAt) >= updatedAt) return; // القديم أحدث أو مساوي، تجاهل
      if (old) {
        sh.getRange(old.__row, 1, 1, rowData.length).setValues([rowData]);
      } else {
        sh.appendRow(rowData);
      }
    });
  }

  // 2) رجّع كل السجلات المتعلقة بالمشروع اللي اتحدثت بعد "since"
  var all = sheetToObjects_(sh).filter(function (r) {
    return !projectId || String(r.ProjectID) === projectId;
  });
  var changed = since ? all.filter(function (r) { return isoOf_(r.UpdatedAt) > since; }) : all;
  var records = changed.map(function (r) {
    var parsed = {};
    try { parsed = JSON.parse(r.DataJSON || "{}"); } catch (e) { parsed = {}; }
    parsed.recordId = parsed.recordId || r.RecordID;
    parsed.id = parsed.id || r.RecordID;
    parsed.projectId = parsed.projectId || r.ProjectID;
    parsed.updatedAt = r.UpdatedAt;
    parsed.editedBy = parsed.editedBy || r.EditedBy;
    return parsed;
  });
  var cursor = all.reduce(function (mx, r) {
    return isoOf_(r.UpdatedAt) > mx ? isoOf_(r.UpdatedAt) : mx;
  }, since || "");
  return { ok: true, records: records, cursor: cursor };
}

/* ======================= DPB KV (مضاف) =======================
 * تخزين بسيط key -> JSON على Drive (ملف لكل key). بيستخدم في:
 *   key="master"            : قايمة الشركات والمشغلين (Admin Control Center)
 *   key="cellmeta_ramming"  : اسم المشغل/الشركة لكل خلية Ramming
 * kvPatch بيقفل الـ Script Lock بنفسه، فمتتحطش جوه withLock_.
 * ============================================================== */
function dpbKvFile_(key, create) {
  var safe = String(key).replace(/[^A-Za-z0-9_\-]/g, "_");
  return scopedDriveFile_("DPB_KV_" + ss_().getId() + "_" + safe + ".json", "DPB_KV_" + safe + ".json", create, "{}", "application/json");
}

function dpbKvGet_(key) {
  var f = dpbKvFile_(key, false);
  return { ok: true, json: f ? f.getBlob().getDataAsString() : "{}" };
}

// set: object key->value لإضافة/تعديل | del: array مفاتيح للحذف
// replace=true: الملف كله يبقى هو set (بنستخدمه لقايمة الشركات/المشغلين)
function dpbKvPatch_(key, setObj, delArr, replace) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var f = dpbKvFile_(key, true), cur = {};
    try { cur = JSON.parse(f.getBlob().getDataAsString() || "{}") || {}; } catch (e) { cur = {}; }
    if (replace) {
      cur = setObj || {};
    } else {
      var k;
      for (k in (setObj || {})) cur[k] = setObj[k];
      (delArr || []).forEach(function (x) { delete cur[x]; });
    }
    f.setContent(JSON.stringify(cur));
    return { ok: true, count: Object.keys(cur).length };
  } finally {
    lock.releaseLock();
  }
}
