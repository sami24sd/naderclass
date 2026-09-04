/**
 * پنل آموزشی جامع
 * طراح: نادر اکشیک
 *
 * یک Cloudflare Worker کامل شامل:
 *  - پنل معلم (ورود/خروج، تغییر رمز عبور، تم روشن/تاریک)
 *  - مدیریت دانش‌آموزان با لینک اختصاصی
 *  - آزمون‌سازی با انواع سوال (تشریحی، چهارگزینه‌ای، صحیح/غلط، کوتاه‌پاسخ)
 *  - سربرگ کامل آزمون (نام مدرسه، نام آموزگار، نام آزمون، مدت زمان آزمون به دقیقه)
 *  - انتخاب مقطع تحصیلی (ابتدایی توصیفی / متوسطه اول و دوم نمره‌ای)
 *  - تایمر معکوس برای دانش‌آموز (Countdown Timer)
 *  - ویرایشگر غنی سوال (علائم ریاضی، کسر، تقسیم چکشی، اشکال هندسی SVG، عکس)
 *  - صفحه آزمون دانش‌آموز با سوال امنیتی و نمایش تایمر
 *  - تصحیح و بازخورد:
 *    * ابتدایی: توصیفی (خیلی خوب، خوب، قابل‌قبول، نیاز به تلاش)
 *    * متوسطه اول و دوم: نمره‌ای (عددی با اعشار) - نمره کل از 20
 *  - پاسخنامه‌ها با وضعیت‌های مختلف
 *  - برنامه هفتگی با خروجی Word/PDF/چاپ و ذخیره در KV
 *  - جدول‌ساز حرفه‌ای با خروجی اکسل RTL و میانگین‌گیری
 *  - اسکنر حرفه‌ای (مشابه CamScanner) با فیلترهای متنوع
 *  - کاهش حجم عکس با کیفیت و فرمت‌های مختلف
 *  - برش عکس با نسبت‌های مختلف (پشتیبانی از لمس برای گوشی)
 *  - تبدیل PDF به عکس با انتخاب صفحات و DPI
 *  - چت AI با Groq (حالت‌های مختلف)
 *  - ترجمه متن با MyMemory
 *  - ذخیره‌سازی در Cloudflare KV (binding: EXAM_KV)
 */

const APP_TITLE = "پنل آموزشی جامع";
const APP_DESIGNER = "طراح: نادر اکشیک";

const DEFAULT_META = {
  school: "",
  teacher: "",
  examName: "",
  examDuration: "30",
  gradeLevel: "elementary",
};

const QUESTION_TYPES = {
  descriptive: "تشریحی",
  multiple: "چهارگزینه‌ای",
  truefalse: "صحیح / غلط",
  short: "کوتاه‌پاسخ",
};

/* ------------------------- ابزارهای کمکی ------------------------- */

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function html(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const FA_DIGITS_SRV = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"];
function toFaDigitsSrv(s) {
  return String(s == null ? "" : s).replace(/[0-9]/g, (d) => FA_DIGITS_SRV[+d]);
}

function sanitizeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/<\s*\/?\s*(script|iframe|object|embed|link|meta|style)\b[^>]*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "")
    .replace(/javascript:/gi, "");
}

function uuid() {
  return crypto.randomUUID();
}

function parseCookies(req) {
  const out = {};
  const c = req.headers.get("cookie") || "";
  c.split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text)));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function getTeacherHash(env) {
  return await env.EXAM_KV.get("teacher_pass");
}

async function isTeacher(req, env) {
  const stored = await getTeacherHash(env);
  if (!stored) return false;
  const cookies = parseCookies(req);
  return Boolean(cookies.t_auth && cookies.t_auth === stored);
}

async function getMeta(env) {
  const raw = await env.EXAM_KV.get("meta");
  return raw ? { ...DEFAULT_META, ...JSON.parse(raw) } : { ...DEFAULT_META };
}

async function getQuestions(env) {
  const raw = await env.EXAM_KV.get("questions");
  return raw ? JSON.parse(raw) : [];
}

async function listStudents(env) {
  const out = [];
  let cursor;
  do {
    const res = await env.EXAM_KV.list({ prefix: "student:", cursor });
    const values = await Promise.all(res.keys.map((k) => env.EXAM_KV.get(k.name)));
    for (const v of values) {
      if (v) out.push(JSON.parse(v));
    }
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);
  out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return out;
}

function getScheduleHtml(data) {
  const school = data.school || 'مدرسه';
  const year = data.year || '';
  const topic = data.topic || '';
  const principal = data.principal || '';
  const cls = data.cls || '';
  const teacher = data.teacher || '';
  const days = ['شنبه', 'یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه'];
  const zang = ['زنگ اول', 'زنگ دوم', 'زنگ سوم', 'زنگ چهارم', 'زنگ پنجم'];
  const dayColors = [
    'linear-gradient(135deg,#ff9a9e,#fecfef)',
    'linear-gradient(135deg,#fddb92,#d1fdff)',
    'linear-gradient(135deg,#a1ffce,#faffbd)',
    'linear-gradient(135deg,#e0c3fc,#8ec5fc)',
    'linear-gradient(135deg,#a8edea,#fed6e3)'
  ];
  const accentColors = ['#ef4444','#f59e0b','#10b981','#8b5cf6','#06b6d4'];
  const cellColors = ['#fef2f2','#fffbeb','#f0fdf4','#f5f3ff','#ecfeff'];
  
  let style = `<style>
    @font-face{font-family:"BNazanin";src:url(https://cdn.jsdelivr.net/gh/naderuser/bnazanin@main/BNazanin.ttf)}
    body{direction:rtl;font-family:"BNazanin",tahoma,Arial;padding:30px;background:#f8fafc}
    .header{text-align:center;padding:20px;background:#fff;color:#1e293b;border-radius:20px;margin-bottom:20px;border:1.5px solid #e2e8f0}
    .header h1{font-size:24px;margin:0 0 10px;font-weight:800;letter-spacing:.3px}.header p{margin:5px 0;font-size:14px}
    table{width:100%;border-collapse:separate;border-spacing:0;border-radius:18px;overflow:hidden;box-shadow:0 8px 24px rgba(15,23,42,.10);border:1px solid #e2e8f0}
    th{padding:14px 8px;font-size:14px;font-weight:800;text-align:center;border-bottom:2px solid #e2e8f0;border-left:1px solid #e2e8f0}
    td{padding:14px 10px;text-align:center;font-size:13px;min-height:50px;font-weight:600;color:#1e293b;border-bottom:1px solid #eef2f6;border-left:1px solid #eef2f6}
    tr:last-child td{border-bottom:none}
    .daylabel{border-right:5px solid;font-weight:800}
    .footer{text-align:center;margin-top:30px;padding:20px;border-top:2px dashed #ddd}
  </style>`;
  
  let header = `<div class="header"><h1>⭐ برنامه هفتگی کلاس ⭐</h1><p>🏫 ${esc(school)} | سال تحصیلی: ${esc(year)}</p><p>کلاس: ${esc(cls)} | آموزگار: ${esc(teacher)}</p></div>`;
  
  let table = '<table><tr><th style="background:#fff;color:#1e293b;border-bottom:none">روز / زنگ</th>';
  for (let z = 0; z < 5; z++) {
    table += `<th style="background:#f8fafc;color:#334155">🔔 ${zang[z]}</th>`;
  }
  table += '</tr>';
  
  for (let d = 0; d < 5; d++) {
    table += `<tr><td class="daylabel" style="background:${cellColors[d]};border-right-color:${accentColors[d]}">${days[d]}</td>`;
    for (let i = 1; i <= 5; i++) {
      const key = `c${d}${i}`;
      const val = (data.cells && data.cells[key]) || '&nbsp;';
      table += `<td style="background:${cellColors[d]}"><div style="min-height:40px">${val}</div></td>`;
    }
    table += '</tr>';
  }
  table += '</table>';
  
  const footer = ``;
  return `<html><head><meta charset="utf-8">${style}</head><body>${header}${table}${footer}</body></html>`;
}

function safeQuestion(q) {
  return { 
    id: q.id, 
    type: q.type, 
    rich: Boolean(q.rich), 
    text: q.text, 
    options: q.options || [], 
    image: q.image || "",
    imageWidth: q.imageWidth || 320,
    weight: q.weight || 1
  };
}

/* ------------------------- روتر اصلی ------------------------- */

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;

    try {
      if (path === "/api/classroom/ws") return await handleClassroomSocket(req, env, url);

      if (path.startsWith("/api/")) return await handleApi(req, env, url, path);

      if (path.startsWith("/s/")) {
        const id = decodeURIComponent(path.slice(3));
        return await studentPage(env, id);
      }

      if (path.startsWith("/info/")) {
        const id = decodeURIComponent(path.slice(6));
        return await infoLinkPage(env, id);
      }

      if (path.startsWith("/w/")) {
        const id = decodeURIComponent(path.slice(3));
        return await workSheetPage(env, id);
      }

      if (path.startsWith("/class/")) {
        const id = decodeURIComponent(path.slice(7));
        return await studentClassPage(env, id);
      }

      if (path === "/teacher" || path === "/teacher/") return html(teacherPage());

      if (path === "/") return html(landingPage());

      return html(notFoundPage(), 404);
    } catch (err) {
      return json({ ok: false, error: String(err && err.message ? err.message : err) }, 500);
    }
  },
};

/* ------------------------- کلاس آنلاین (Durable Object) -------------------------
 * برای فعال شدن این بخش باید در wrangler.toml موارد زیر اضافه شود:
 *
 * [[durable_objects.bindings]]
 * name = "CLASSROOM"
 * class_name = "ClassRoom"
 *
 * [[migrations]]
 * tag = "v1"
 * new_sqlite_classes = ["ClassRoom"]
 *
 * توجه: از مدتی پیش Durable Objects (نوع SQLite) روی پلن رایگان Workers هم در دسترس
 * است و نیازی به پلن Paid نیست؛ فقط باید حتماً از "new_sqlite_classes" (نه
 * "new_classes") در migrations استفاده شود تا با پلن رایگان سازگار باشد.
 * -------------------------------------------------------------------------------- */

async function handleClassroomSocket(req, env, url) {
  const role = url.searchParams.get("role") === "teacher" ? "teacher" : "student";

  // مسیر تشخیصی: بدون WebSocket، فقط بررسی می‌کند که آیا اتصال باید موفق باشد یا نه
  // و در صورت خطا، دلیل دقیق را برمی‌گرداند (برای نمایش پیام مشخص به‌جای «قطع شد»).
  if (url.searchParams.get("check") === "1") {
    if (role === "teacher") {
      if (!(await isTeacher(req, env))) return json({ ok: false, error: "برای کلاس آنلاین باید ابتدا در پنل معلم وارد شوید." }, 401);
    } else {
      const id = url.searchParams.get("id") || "";
      const rec = id ? await env.EXAM_KV.get("student:" + id) : null;
      if (!rec) return json({ ok: false, error: "این لینک کلاس آنلاین معتبر نیست. لینک را از پنل معلم دوباره کپی کنید." }, 404);
    }
    if (!env.CLASSROOM) {
      return json({ ok: false, error: "کلاس آنلاین روی این ورکر فعال نشده است. باید در wrangler.toml بخش durable_objects و migrations برای ClassRoom اضافه و دوباره deploy شود." }, 500);
    }
    return json({ ok: true });
  }

  if (req.headers.get("upgrade") !== "websocket") {
    return json({ ok: false, error: "این مسیر فقط برای اتصال WebSocket است" }, 400);
  }

  if (role === "teacher") {
    if (!(await isTeacher(req, env))) return json({ ok: false, error: "دسترسی غیرمجاز" }, 401);
  } else {
    const id = url.searchParams.get("id") || "";
    const rec = await env.EXAM_KV.get("student:" + id);
    if (!rec) return json({ ok: false, error: "لینک نامعتبر است" }, 404);
  }

  if (!env.CLASSROOM) {
    return json({ ok: false, error: "کلاس آنلاین روی این ورکر فعال نشده (Durable Object تنظیم نشده)" }, 500);
  }

  const roomId = env.CLASSROOM.idFromName("main");
  const stub = env.CLASSROOM.get(roomId);
  return stub.fetch(req);
}

export class ClassRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map(); // ws -> { role, id, name }
    this.strokes = []; // تاریخچه تخته هوشمند برای سینک اعضای جدید
    this.chat = []; // آخرین پیام‌های چت
    this.boardBg = null; // صفحه‌ی PDF فعلی روی تخته (data URL) یا null
    this.boardBgW = 900;
    this.boardBgH = 560;
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (req.headers.get("upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 400 });
    }
    const role = url.searchParams.get("role") === "teacher" ? "teacher" : "student";
    const id = url.searchParams.get("id") || "";
    const name = (url.searchParams.get("name") || (role === "teacher" ? "معلم" : "دانش‌آموز")).slice(0, 60);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    const session = { role, id, name };
    this.sessions.set(server, session);

    server.send(JSON.stringify({
      type: "init",
      role,
      strokes: this.strokes,
      boardBg: this.boardBg,
      boardBgW: this.boardBgW,
      boardBgH: this.boardBgH,
      chat: this.chat.slice(-50),
      participants: this.participantList(),
    }));

    this.broadcast({ type: "presence", event: "join", role, name, participants: this.participantList() }, server);

    server.addEventListener("message", (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }
      this.handleMessage(server, session, msg);
    });

    const onClose = () => {
      if (!this.sessions.has(server)) return;
      this.sessions.delete(server);
      this.broadcast({ type: "presence", event: "leave", role: session.role, name: session.name, participants: this.participantList() });
    };
    server.addEventListener("close", onClose);
    server.addEventListener("error", onClose);

    return new Response(null, { status: 101, webSocket: client });
  }

  participantList() {
    return Array.from(this.sessions.values()).map((s) => ({ role: s.role, name: s.name, id: s.id }));
  }

  handleMessage(sender, session, msg) {
    if (!msg || typeof msg !== "object") return;

    // فقط معلم اجازه‌ی رسم روی تخته هوشمند و پخش صدا را دارد
    if (msg.type === "draw" && session.role === "teacher") {
      this.strokes.push(msg.stroke);
      if (this.strokes.length > 3000) this.strokes.splice(0, 1000);
      this.broadcast({ type: "draw", stroke: msg.stroke }, sender);
      return;
    }

    if (msg.type === "clear" && session.role === "teacher") {
      this.strokes = [];
      this.broadcast({ type: "clear" }, sender);
      return;
    }

    if (msg.type === "board-bg" && session.role === "teacher") {
      if (msg.data && msg.data.length > 4_000_000) {
        try { sender.send(JSON.stringify({ type: "error", message: "حجم تصویر صفحه‌ی PDF برای ارسال زنده خیلی زیاد است." })); } catch {}
        return;
      }
      this.boardBg = msg.data || null;
      this.boardBgW = msg.w || 900;
      this.boardBgH = msg.h || 560;
      this.strokes = []; // با تغییر صفحه‌ی PDF، یادداشت‌های قبلی روی صفحه‌ی قبل پاک می‌شود
      this.broadcast({ type: "board-bg", data: this.boardBg, w: this.boardBgW, h: this.boardBgH }, sender);
      return;
    }

    if (msg.type === "audio" && session.role === "teacher") {
      // چانک صوتی فشرده (base64) برای پخش تقریباً زنده برای دانش‌آموزان
      this.broadcast({ type: "audio", data: msg.data, mime: msg.mime || "audio/webm" }, sender);
      return;
    }

    if (msg.type === "video-frame" && session.role === "teacher") {
      // فریم تصویر معلم (JPEG با کیفیت پایین) برای تماس تصویری ساده‌ی زنده
      this.broadcast({ type: "video-frame", data: msg.data }, sender);
      return;
    }

    if (msg.type === "video-stop" && session.role === "teacher") {
      this.broadcast({ type: "video-stop" }, sender);
      return;
    }

    if (msg.type === "chat") {
      const entry = {
        from: session.name,
        role: session.role,
        text: String(msg.text || "").slice(0, 1000),
        ts: Date.now(),
      };
      if (!entry.text) return;
      this.chat.push(entry);
      if (this.chat.length > 200) this.chat.splice(0, 100);
      this.broadcast({ type: "chat", entry });
      return;
    }

    if (msg.type === "file") {
      // ارسال فایل (عکس/سند) بین معلم و دانش‌آموزان - فقط زنده پخش می‌شود، در تاریخچه ذخیره نمی‌شود
      const name = String(msg.name || "file").slice(0, 200);
      const mime = String(msg.mime || "application/octet-stream").slice(0, 100);
      const data = String(msg.data || "");
      if (!data || data.length > 3_000_000) return; // حداکثر ~2 مگابایت فایل (بعد از base64)
      this.broadcast({ type: "file", from: session.name, role: session.role, name, mime, data, ts: Date.now() });
      return;
    }

    if (msg.type === "raise-hand" && session.role === "student") {
      this.broadcast({ type: "raise-hand", name: session.name });
      return;
    }
  }

  broadcast(payload, exclude) {
    const data = JSON.stringify(payload);
    for (const ws of this.sessions.keys()) {
      if (ws === exclude) continue;
      try { ws.send(data); } catch { /* اتصال قطع شده - نادیده گرفته می‌شود */ }
    }
  }
}

/* ------------------------- API ------------------------- */

async function handleApi(req, env, url, path) {
  const method = req.method;

  /* --- دریافت و ارسال اطلاعات: پشتیبانی از ارسال بین دو پنل جدا روی کلودفلر (CORS) --- */
  const INFO_CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
  };
  if (path.startsWith("/api/info/") && method === "OPTIONS") {
    return new Response(null, { status: 204, headers: INFO_CORS_HEADERS });
  }

  /* --- تشخیصی موقت: بررسی وجود کلید Gemini (بدون افشای مقدار) --- */
  if (path === "/api/debug/env-check" && method === "GET") {
    return json({
      hasGeminiKey: typeof env.GEMINI_API_KEY === "string" && env.GEMINI_API_KEY.length > 0,
      geminiKeyLength: env.GEMINI_API_KEY ? env.GEMINI_API_KEY.length : 0,
    });
  }

  /* --- معلم: ورود/خروج --- */
  if (path === "/api/teacher/login" && method === "POST") {
    const body = await req.json().catch(() => ({}));
    const pass = String(body.password || "");
    const stored = await getTeacherHash(env);
    const cookieFor = (h) => `t_auth=${h}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`;
    if (!stored) {
      if (pass.length < 4) return json({ ok: false, error: "رمز باید حداقل ۴ کاراکتر باشد" }, 400);
      const hash = await sha256(pass);
      await env.EXAM_KV.put("teacher_pass", hash);
      return json({ ok: true, created: true }, 200, { "set-cookie": cookieFor(hash) });
    }
    const hash = await sha256(pass);
    if (hash === stored) return json({ ok: true }, 200, { "set-cookie": cookieFor(hash) });
    return json({ ok: false, error: "رمز عبور اشتباه است" }, 401);
  }

  if (path === "/api/teacher/logout" && method === "POST") {
    return json({ ok: true }, 200, { "set-cookie": "t_auth=; Path=/; Max-Age=0" });
  }

  if (path === "/api/teacher/state" && method === "GET") {
    const stored = await getTeacherHash(env);
    return json({ ok: true, auth: await isTeacher(req, env), configured: Boolean(stored) });
  }

  /* --- آزمون دانش‌آموز (عمومی) --- */
  if (path.startsWith("/api/exam/")) {
    const rest = path.slice("/api/exam/".length);
    const parts = rest.split("/");
    const id = decodeURIComponent(parts[0] || "");
    const studentRaw = await env.EXAM_KV.get("student:" + id);
    if (!studentRaw) return json({ ok: false, error: "لینک نامعتبر است" }, 404);

    if (parts[1] === "submit" && method === "POST") {
      const existing = await env.EXAM_KV.get("submission:" + id);
      if (existing) return json({ ok: false, error: "این آزمون قبلاً ثبت شده است" }, 409);
      
      const body = await req.json().catch(() => ({}));
      const meta = await getMeta(env);
      const questions = await getQuestions(env);
      
      const durationMinutes = parseInt(meta.examDuration) || 30;
      const endTime = Date.now() + (durationMinutes * 60 * 1000);
      
      const submission = {
        uuid: id,
        student: {
          name: String(body.name || "").slice(0, 120),
          fatherName: String(body.fatherName || "").slice(0, 120),
          nationalId: String(body.nationalId || "").slice(0, 30),
          courseName: String(body.courseName || "").slice(0, 120),
          examDate: String(body.examDate || "").slice(0, 40),
        },
        answers: body.answers || {},
        photoAnswers: body.photoAnswers || {},
        meta,
        questionsSnapshot: questions,
        submittedAt: Date.now(),
        endTime: endTime,
        grading: null,
      };
      await env.EXAM_KV.put("submission:" + id, JSON.stringify(submission));
      return json({ ok: true });
    }

    if (method === "GET") {
      const meta = await getMeta(env);
      const subRaw = await env.EXAM_KV.get("submission:" + id);
      const st = JSON.parse(studentRaw);
      
      if (subRaw) {
        const sub = JSON.parse(subRaw);
        const resultQuestions = (sub.questionsSnapshot || []).map(safeQuestion);
        
        const now = Date.now();
        const remaining = Math.max(0, Math.floor((sub.endTime - now) / 1000));
        const isExpired = remaining <= 0;
        
        return json({
          ok: true,
          meta,
          submitted: true,
          timeCheck: true,
          remaining: remaining,
          isExpired: isExpired,
          result: {
            questions: resultQuestions,
            answers: sub.answers || {},
            student: sub.student || {},
            grading: sub.grading || null,
          },
        });
      }
      const questions = (await getQuestions(env)).map(safeQuestion);
      const durationMinutes = parseInt(meta.examDuration) || 30;
      
      return json({ 
        ok: true, 
        meta, 
        submitted: false, 
        questions, 
        label: st.label || "", 
        timeCheck: true,
        duration: durationMinutes * 60
      });
    }
  }

  /* --- کاربرگ دانش‌آموز (عمومی) --- */
  if (path.startsWith("/api/worksheet/")) {
    const rest = path.slice("/api/worksheet/".length);
    const parts = rest.split("/");
    const id = decodeURIComponent(parts[0] || "");
    const studentRaw = await env.EXAM_KV.get("student:" + id);
    if (!studentRaw) return json({ ok: false, error: "لینک نامعتبر است" }, 404);
    const st = JSON.parse(studentRaw);

    if (parts[1] === "submit" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const photos = Array.isArray(body.photos) ? body.photos.slice(0, 6) : [];
      for (const p of photos) {
        if (typeof p !== "string" || !p.startsWith("data:image/")) return json({ ok: false, error: "فرمت عکس نامعتبر است" }, 400);
        if (p.length > 2_800_000) return json({ ok: false, error: "حجم یکی از عکس‌ها بیش از حد مجاز است (حداکثر ۲ مگابایت)" }, 400);
      }
      if (!photos.length) return json({ ok: false, error: "حداقل یک عکس باید بارگذاری شود" }, 400);
      const raw = await env.EXAM_KV.get("worksheet:" + id);
      const rec = raw ? JSON.parse(raw) : { uuid: id };
      rec.studentFiles = photos;
      rec.studentUploadedAt = Date.now();
      await env.EXAM_KV.put("worksheet:" + id, JSON.stringify(rec));
      return json({ ok: true });
    }

    if (method === "GET") {
      const raw = await env.EXAM_KV.get("worksheet:" + id);
      const rec = raw ? JSON.parse(raw) : {};
      return json({
        ok: true,
        label: st.label || "",
        teacherFile: rec.teacherFile || "",
        teacherFileName: rec.teacherFileName || "",
        teacherFileType: rec.teacherFileType || "",
        teacherUploadedAt: rec.teacherUploadedAt || null,
        studentFiles: rec.studentFiles || [],
        studentUploadedAt: rec.studentUploadedAt || null,
        feedback: rec.feedback || "",
        feedbackAt: rec.feedbackAt || null,
      });
    }
  }

  /* --- کارنامه‌ی ماهیانه‌ی دانش‌آموز (عمومی، فقط خواندنی) --- */
  if (path.startsWith("/api/student/reportcard/")) {
    const uuid = decodeURIComponent(path.slice("/api/student/reportcard/".length));
    const studentRaw = await env.EXAM_KV.get("student:" + uuid);
    if (!studentRaw) return json({ ok: false, error: "لینک نامعتبر است" }, 404);
    const RC_MONTHS = ["مهر", "آبان", "آذر", "دی", "بهمن", "اسفند", "فروردین", "اردیبهشت"];
    const months = {};
    for (const m of RC_MONTHS) {
      const raw = await env.EXAM_KV.get("lbdata:reportcard:student:" + uuid + ":" + m);
      if (raw) months[m] = JSON.parse(raw);
    }
    return json({ ok: true, months });
  }

  /* --- دریافت و ارسال اطلاعات: صفحه‌ی عمومی لینک اختصاصی (بدون نیاز به ورود) --- */
  if (path.startsWith("/api/info/link/") && !path.includes("/reply")) {
    const rest = path.slice("/api/info/link/".length);
    const parts = rest.split("/");
    const linkId = decodeURIComponent(parts[0] || "");

    if (parts.length === 1 && method === "GET") {
      const raw = await env.EXAM_KV.get("infolink:" + linkId);
      if (!raw) return json({ ok: false, error: "این لینک معتبر نیست" }, 404, INFO_CORS_HEADERS);
      const meta = JSON.parse(raw);
      return json({ ok: true, ownerName: meta.ownerName, ownerRole: meta.ownerRole }, 200, INFO_CORS_HEADERS);
    }

    if (parts[1] === "send" && method === "POST") {
      const raw = await env.EXAM_KV.get("infolink:" + linkId);
      if (!raw) return json({ ok: false, error: "این لینک معتبر نیست" }, 404, INFO_CORS_HEADERS);
      const body = await req.json().catch(() => ({}));
      const senderName = String(body.senderName || "").slice(0, 80);
      const message = String(body.message || "").slice(0, 3000);
      const files = Array.isArray(body.files) ? body.files.slice(0, 6) : [];
      if (!senderName) return json({ ok: false, error: "نام فرستنده الزامی است" }, 400, INFO_CORS_HEADERS);
      if (!message && !files.length) return json({ ok: false, error: "پیام یا حداقل یک فایل الزامی است" }, 400, INFO_CORS_HEADERS);
      for (const f of files) {
        if (!f || typeof f.data !== "string" || !/^data:(image\/|application\/pdf|application\/vnd\.|application\/msword)/.test(f.data)) {
          return json({ ok: false, error: "فرمت یکی از فایل‌ها معتبر نیست" }, 400, INFO_CORS_HEADERS);
        }
        if (f.data.length > 6_000_000) return json({ ok: false, error: "حجم یکی از فایل‌ها بیش از حد مجاز است (حداکثر ۴ مگابایت)" }, 400, INFO_CORS_HEADERS);
      }
      const code = Math.random().toString(36).slice(2, 8).toUpperCase();
      const inboxRaw = await env.EXAM_KV.get("infolink-inbox:" + linkId);
      const inbox = inboxRaw ? JSON.parse(inboxRaw) : [];
      inbox.unshift({
        code, senderName, message,
        files: files.map((f) => ({ name: f.name || "فایل", mime: f.mime || "", data: f.data })),
        reply: null, createdAt: Date.now(),
      });
      await env.EXAM_KV.put("infolink-inbox:" + linkId, JSON.stringify(inbox.slice(0, 300)));
      return json({ ok: true, code }, 200, INFO_CORS_HEADERS);
    }

    if (parts[1] === "thread" && parts[2] && method === "GET") {
      const code = decodeURIComponent(parts[2]);
      const inboxRaw = await env.EXAM_KV.get("infolink-inbox:" + linkId);
      const inbox = inboxRaw ? JSON.parse(inboxRaw) : [];
      const thread = inbox.find((t) => t.code === code);
      if (!thread) return json({ ok: false, error: "کدی با این مشخصات پیدا نشد" }, 404, INFO_CORS_HEADERS);
      return json({ ok: true, thread }, 200, INFO_CORS_HEADERS);
    }
  }

  /* --- از این به بعد فقط معلم --- */
  if (path.startsWith("/api/teacher/")) {
    if (!(await isTeacher(req, env))) return json({ ok: false, error: "دسترسی غیرمجاز" }, 401);

    if (path === "/api/teacher/password" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const np = String(body.newPassword || "");
      if (np.length < 4) return json({ ok: false, error: "رمز جدید باید حداقل ۴ کاراکتر باشد" }, 400);
      const hash = await sha256(np);
      await env.EXAM_KV.put("teacher_pass", hash);
      return json({ ok: true }, 200, { "set-cookie": `t_auth=${hash}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400` });
    }

    if (path === "/api/teacher/schedule" && method === "GET") {
      const raw = await env.EXAM_KV.get("schedule_data");
      return json({ ok: true, data: raw ? JSON.parse(raw) : null });
    }

    /* --- دریافت و ارسال اطلاعات: مدیریت لینک‌های اختصاصی (فقط معلم/راهبر/مدیر با ورود) --- */
    if (path === "/api/teacher/info-links" && method === "GET") {
      const raw = await env.EXAM_KV.get("infolinks-index");
      const list = raw ? JSON.parse(raw) : [];
      return json({ ok: true, links: list });
    }
    if (path === "/api/teacher/info-links" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const ownerName = String(body.ownerName || "").slice(0, 80);
      const ownerRole = String(body.ownerRole || "معلم").slice(0, 40);
      if (!ownerName) return json({ ok: false, error: "نام الزامی است" }, 400);
      const linkId = uuid();
      const rec = { uuid: linkId, ownerName, ownerRole, createdAt: Date.now() };
      await env.EXAM_KV.put("infolink:" + linkId, JSON.stringify(rec));
      const idxRaw = await env.EXAM_KV.get("infolinks-index");
      const idx = idxRaw ? JSON.parse(idxRaw) : [];
      idx.unshift(rec);
      await env.EXAM_KV.put("infolinks-index", JSON.stringify(idx));
      return json({ ok: true, link: rec });
    }
    if (path.startsWith("/api/teacher/info-links/") && method === "DELETE") {
      const linkId = decodeURIComponent(path.slice("/api/teacher/info-links/".length));
      await env.EXAM_KV.delete("infolink:" + linkId);
      await env.EXAM_KV.delete("infolink-inbox:" + linkId);
      const idxRaw = await env.EXAM_KV.get("infolinks-index");
      const idx = idxRaw ? JSON.parse(idxRaw) : [];
      await env.EXAM_KV.put("infolinks-index", JSON.stringify(idx.filter((l) => l.uuid !== linkId)));
      return json({ ok: true });
    }
    if (path.startsWith("/api/teacher/info-links/") && path.endsWith("/inbox") && method === "GET") {
      const linkId = decodeURIComponent(path.slice("/api/teacher/info-links/".length, -"/inbox".length));
      const raw = await env.EXAM_KV.get("infolink-inbox:" + linkId);
      return json({ ok: true, inbox: raw ? JSON.parse(raw) : [] });
    }
    if (path.startsWith("/api/teacher/info-links/") && path.includes("/thread/") && method === "DELETE") {
      const rest = path.slice("/api/teacher/info-links/".length);
      const [linkId, , code] = rest.split("/"); // linkId / thread / code
      const raw = await env.EXAM_KV.get("infolink-inbox:" + linkId);
      const inbox = raw ? JSON.parse(raw) : [];
      await env.EXAM_KV.put("infolink-inbox:" + linkId, JSON.stringify(inbox.filter((t) => t.code !== decodeURIComponent(code))));
      return json({ ok: true });
    }
    if (path.startsWith("/api/teacher/info-links/") && path.includes("/thread/") && path.endsWith("/reply") && method === "POST") {
      const rest = path.slice("/api/teacher/info-links/".length);
      const [linkId, , code] = rest.split("/"); // linkId / thread / code / reply
      const body = await req.json().catch(() => ({}));
      const message = String(body.message || "").slice(0, 3000);
      const files = Array.isArray(body.files) ? body.files.slice(0, 6) : [];
      for (const f of files) {
        if (!f || typeof f.data !== "string" || !/^data:(image\/|application\/pdf|application\/vnd\.|application\/msword)/.test(f.data)) {
          return json({ ok: false, error: "فرمت یکی از فایل‌ها معتبر نیست" }, 400);
        }
        if (f.data.length > 6_000_000) return json({ ok: false, error: "حجم یکی از فایل‌ها بیش از حد مجاز است (حداکثر ۴ مگابایت)" }, 400);
      }
      const inboxRaw = await env.EXAM_KV.get("infolink-inbox:" + linkId);
      const inbox = inboxRaw ? JSON.parse(inboxRaw) : [];
      const thread = inbox.find((t) => t.code === decodeURIComponent(code));
      if (!thread) return json({ ok: false, error: "پیام پیدا نشد" }, 404);
      thread.reply = { message, files: files.map((f) => ({ name: f.name || "فایل", mime: f.mime || "", data: f.data })), repliedAt: Date.now() };
      await env.EXAM_KV.put("infolink-inbox:" + linkId, JSON.stringify(inbox));
      return json({ ok: true });
    }

    /* --- دریافت و ارسال اطلاعات: پیام‌های ارسالی معلم (بدون نیاز به کد رهگیری) --- */
    if (path === "/api/teacher/info-outbox" && method === "GET") {
      const raw = await env.EXAM_KV.get("infoex-outbox");
      return json({ ok: true, outbox: raw ? JSON.parse(raw) : [] });
    }
    if (path === "/api/teacher/info-outbox" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const rec = {
        id: uuid(),
        targetOrigin: String(body.targetOrigin || "").slice(0, 300),
        targetCode: String(body.targetCode || "").slice(0, 60),
        targetLabel: String(body.targetLabel || "").slice(0, 120),
        senderName: String(body.senderName || "").slice(0, 80),
        message: String(body.message || "").slice(0, 3000),
        files: Array.isArray(body.files) ? body.files.slice(0, 6).map((f) => ({ name: f && f.name || "فایل" })) : [],
        trackingCode: String(body.trackingCode || "").slice(0, 20),
        createdAt: Date.now(),
      };
      const raw = await env.EXAM_KV.get("infoex-outbox");
      const list = raw ? JSON.parse(raw) : [];
      list.unshift(rec);
      await env.EXAM_KV.put("infoex-outbox", JSON.stringify(list.slice(0, 300)));
      return json({ ok: true, sent: rec });
    }
    if (path.startsWith("/api/teacher/info-outbox/") && method === "DELETE") {
      const id = decodeURIComponent(path.slice("/api/teacher/info-outbox/".length));
      const raw = await env.EXAM_KV.get("infoex-outbox");
      const list = raw ? JSON.parse(raw) : [];
      await env.EXAM_KV.put("infoex-outbox", JSON.stringify(list.filter((r) => r.id !== id)));
      return json({ ok: true });
    }

    if (path === "/api/teacher/schedule" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      await env.EXAM_KV.put("schedule_data", JSON.stringify(body.data || {}));
      return json({ ok: true });
    }

    /* --- دفتر مدیریت کلاسی: ذخیره/بازیابی عمومی --- */
    if (path === "/api/teacher/lb-save" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const key = String(body.key || "").slice(0, 200);
      if (!key) return json({ ok: false, error: "کلید نامعتبر است" }, 400);
      await env.EXAM_KV.put("lbdata:" + key, JSON.stringify(body.value ?? null));
      return json({ ok: true });
    }

    if (path === "/api/teacher/lb-load" && method === "GET") {
      const key = url.searchParams.get("key") || "";
      if (!key) return json({ ok: false, error: "کلید نامعتبر است" }, 400);
      const raw = await env.EXAM_KV.get("lbdata:" + key);
      return json({ ok: true, value: raw ? JSON.parse(raw) : null });
    }

    if (path.startsWith("/api/teacher/worksheet/") && path.endsWith("/feedback") && method === "POST") {
      const id = decodeURIComponent(path.slice("/api/teacher/worksheet/".length, -"/feedback".length));
      const studentRaw = await env.EXAM_KV.get("student:" + id);
      if (!studentRaw) return json({ ok: false, error: "دانش‌آموز پیدا نشد" }, 404);
      const body = await req.json().catch(() => ({}));
      const raw = await env.EXAM_KV.get("worksheet:" + id);
      const rec = raw ? JSON.parse(raw) : { uuid: id };
      rec.feedback = String(body.feedback || "").slice(0, 5000);
      rec.feedbackAt = Date.now();
      await env.EXAM_KV.put("worksheet:" + id, JSON.stringify(rec));
      return json({ ok: true });
    }

    if (path.startsWith("/api/teacher/worksheet/") && method === "GET") {
      const id = decodeURIComponent(path.slice("/api/teacher/worksheet/".length));
      const raw = await env.EXAM_KV.get("worksheet:" + id);
      const rec = raw ? JSON.parse(raw) : {};
      return json({ ok: true, worksheet: rec });
    }

    if (path.startsWith("/api/teacher/worksheet/") && method === "POST") {
      const id = decodeURIComponent(path.slice("/api/teacher/worksheet/".length));
      const studentRaw = await env.EXAM_KV.get("student:" + id);
      if (!studentRaw) return json({ ok: false, error: "دانش‌آموز پیدا نشد" }, 404);
      const body = await req.json().catch(() => ({}));
      const fileDataUrl = String(body.fileDataUrl || "");
      if (!fileDataUrl.startsWith("data:image/") && !fileDataUrl.startsWith("data:application/pdf")) {
        return json({ ok: false, error: "فرمت فایل باید عکس یا PDF باشد" }, 400);
      }
      if (fileDataUrl.length > 4_500_000) return json({ ok: false, error: "حجم فایل بیش از حد مجاز است (حداکثر حدود ۴ مگابایت)" }, 400);
      const raw = await env.EXAM_KV.get("worksheet:" + id);
      const rec = raw ? JSON.parse(raw) : { uuid: id };
      rec.teacherFile = fileDataUrl;
      rec.teacherFileName = String(body.fileName || "").slice(0, 200);
      rec.teacherFileType = fileDataUrl.startsWith("data:application/pdf") ? "pdf" : "image";
      rec.teacherUploadedAt = Date.now();
      await env.EXAM_KV.put("worksheet:" + id, JSON.stringify(rec));
      return json({ ok: true });
    }

    if (path.startsWith("/api/teacher/worksheet/") && method === "DELETE") {
      const id = decodeURIComponent(path.slice("/api/teacher/worksheet/".length));
      const raw = await env.EXAM_KV.get("worksheet:" + id);
      if (raw) {
        const rec = JSON.parse(raw);
        delete rec.teacherFile;
        delete rec.teacherFileName;
        delete rec.teacherFileType;
        delete rec.teacherUploadedAt;
        await env.EXAM_KV.put("worksheet:" + id, JSON.stringify(rec));
      }
      return json({ ok: true });
    }

    if (path === "/api/teacher/students" && method === "GET") {
      const students = await listStudents(env);
      const subs = await Promise.all(students.map((s) => env.EXAM_KV.get("submission:" + s.uuid)));
      const withStatus = students.map((s, idx) => {
        const subRaw = subs[idx];
        let status = "pending";
        if (subRaw) {
          const sub = JSON.parse(subRaw);
          status = sub.grading && sub.grading.graded ? "graded" : "submitted";
        }
        return { ...s, status };
      });
      return json({ ok: true, students: withStatus });
    }

    if (path === "/api/teacher/students" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const id = uuid();
      let photo = "";
      if (typeof body.photo === "string" && body.photo.startsWith("data:image/")) {
        if (body.photo.length > 2_800_000) return json({ ok: false, error: "حجم عکس پروفایل بیش از حد مجاز است (حداکثر ۲ مگابایت)" }, 400);
        photo = body.photo;
      }
      let grade = parseInt(body.grade, 10);
      if (!Number.isInteger(grade) || grade < 0 || grade > 5) grade = 0;
      const rec = { uuid: id, label: String(body.label || "").slice(0, 120), photo, grade, createdAt: Date.now() };
      await env.EXAM_KV.put("student:" + id, JSON.stringify(rec));
      return json({ ok: true, student: rec });
    }

    if (path.startsWith("/api/teacher/students/") && method === "PATCH") {
      const id = decodeURIComponent(path.slice("/api/teacher/students/".length));
      const raw = await env.EXAM_KV.get("student:" + id);
      if (!raw) return json({ ok: false, error: "دانش‌آموز پیدا نشد" }, 404);
      const rec = JSON.parse(raw);
      const body = await req.json().catch(() => ({}));
      if (typeof body.photo === "string") {
        if (body.photo && body.photo.startsWith("data:image/")) {
          if (body.photo.length > 2_800_000) return json({ ok: false, error: "حجم عکس پروفایل بیش از حد مجاز است (حداکثر ۲ مگابایت)" }, 400);
          rec.photo = body.photo;
        } else if (body.photo === "") {
          rec.photo = "";
        }
      }
      if (typeof body.label === "string") rec.label = body.label.slice(0, 120);
      if (body.grade !== undefined) {
        const g = parseInt(body.grade, 10);
        if (Number.isInteger(g) && g >= 0 && g <= 5) rec.grade = g;
      }
      await env.EXAM_KV.put("student:" + id, JSON.stringify(rec));
      return json({ ok: true, student: rec });
    }

    if (path.startsWith("/api/teacher/students/") && method === "DELETE") {
      const id = decodeURIComponent(path.slice("/api/teacher/students/".length));
      await env.EXAM_KV.delete("student:" + id);
      await env.EXAM_KV.delete("submission:" + id);
      return json({ ok: true });
    }

    if (path === "/api/teacher/questions" && method === "GET") {
      return json({ ok: true, meta: await getMeta(env), questions: await getQuestions(env) });
    }

    if (path === "/api/teacher/questions" && method === "PUT") {
      const body = await req.json().catch(() => ({}));
      const questions = (Array.isArray(body.questions) ? body.questions : []).map((q, i) => {
        const type = QUESTION_TYPES[q.type] ? q.type : "descriptive";
        const rich = type === "descriptive" && Boolean(q.rich);
        return {
          id: q.id || uuid(),
          type,
          rich,
          text: rich ? sanitizeHtml(String(q.text || "")) : String(q.text || ""),
          options: Array.isArray(q.options) ? q.options.map((o) => String(o)) : [],
          correct: q.correct == null ? "" : q.correct,
          image: typeof q.image === "string" ? q.image : "",
          imageWidth: Number.isFinite(parseInt(q.imageWidth, 10)) ? Math.min(900, Math.max(80, parseInt(q.imageWidth, 10))) : 320,
          imageAsQuestion: Boolean(q.imageAsQuestion),
          weight: Math.min(20, Math.max(0.5, parseFloat(q.weight) || 1)),
          order: i,
        };
      });
      await env.EXAM_KV.put("questions", JSON.stringify(questions));
      if (body.meta) {
        const meta = { ...DEFAULT_META, ...body.meta };
        await env.EXAM_KV.put("meta", JSON.stringify(meta));
      }
      return json({ ok: true });
    }

    if (path === "/api/teacher/submissions" && method === "GET") {
      const students = await listStudents(env);
      const out = [];
      for (const s of students) {
        const raw = await env.EXAM_KV.get("submission:" + s.uuid);
        if (raw) {
          const sub = JSON.parse(raw);
          sub.label = s.label || "";
          sub.studentPhoto = s.photo || "";
          out.push(sub);
        }
      }
      out.sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));
      return json({ ok: true, submissions: out });
    }

    if (path === "/api/teacher/grade" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const id = body.uuid;
      const raw = await env.EXAM_KV.get("submission:" + id);
      if (!raw) return json({ ok: false, error: "پاسخنامه یافت نشد" }, 404);
      const sub = JSON.parse(raw);
      sub.grading = {
        graded: true,
        overall: String(body.overall || ""),
        feedback: body.feedback && typeof body.feedback === "object" ? body.feedback : {},
        marks: body.marks && typeof body.marks === "object" ? body.marks : {},
        gradedAt: Date.now(),
      };
      await env.EXAM_KV.put("submission:" + id, JSON.stringify(sub));
      return json({ ok: true });
    }

    if (path === "/api/teacher/word" && method === "GET") {
      const type = url.searchParams.get("type") || "questions";
      const meta = await getMeta(env);
      if (type === "answers") {
        const id = url.searchParams.get("uuid");
        const raw = await env.EXAM_KV.get("submission:" + id);
        if (!raw) return json({ ok: false, error: "پاسخنامه یافت نشد" }, 404);
        const sub = JSON.parse(raw);
        return wordResponse(answerSheetWord(sub), `پاسخنامه-${sub.student.name || id}.doc`);
      }
      const questions = await getQuestions(env);
      if (type === "examsheet") {
        const raw = await env.EXAM_KV.get("lbdata:examsheet");
        const data = raw ? JSON.parse(raw) : {};
        return wordResponse(examSheetWord(data), "برگه-آزمون-چاپی.doc", "0.6cm");
      }
      return wordResponse(examWord(meta, questions), "برگه-آزمون.doc");
    }

    if (path === "/api/teacher/ai/chat" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const messages = body.messages || [];
      const maxTokens = Math.min(Math.max(parseInt(body.max_tokens, 10) || 1024, 256), 8192);

      const geminiKey = env.GEMINI_API_KEY;
      if (!geminiKey) return json({ error: "کلید GEMINI_API_KEY تنظیم نشده" }, 500);
      // مدل فعلی: gemini-3.6-flash (نسخه‌ی پایدار/GA در سال ۲۰۲۶؛ در صورت بازنشستگی باید به‌روزرسانی شود)
      const geminiModel = "gemini-3.6-flash";
      // تبدیل قالب پیام‌های OpenAI-style به قالب contents مورد نیاز Gemini
      let systemInstruction = "";
      const contents = [];
      for (const m of messages.slice(-10)) {
        if (m.role === "system") { systemInstruction += (systemInstruction ? "\n" : "") + (typeof m.content === "string" ? m.content : ""); continue; }
        const role = m.role === "assistant" ? "model" : "user";
        const parts = [];
        if (typeof m.content === "string") {
          parts.push({ text: m.content });
        } else if (Array.isArray(m.content)) {
          for (const c of m.content) {
            if (c.type === "text") parts.push({ text: c.text });
            else if (c.type === "image_url" && c.image_url?.url) {
              const durl = c.image_url.url;
              const match = /^data:(.+?);base64,(.+)$/.exec(durl);
              if (match) parts.push({ inline_data: { mime_type: match[1], data: match[2] } });
            }
          }
        }
        if (parts.length) contents.push({ role, parts });
      }
      // تلاش مجدد خودکار برای خطاهای موقت گوگل (503 = مدل شلوغ، 429 = محدودیت نرخ)
      const RETRYABLE_STATUSES = [503, 429];
      const MAX_ATTEMPTS = 3;
      let lastErr = null, lastStatus = 500;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          const aiRes = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${geminiKey}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                contents,
                systemInstruction: systemInstruction ? { parts: [{ text: systemInstruction }] } : undefined,
                generationConfig: { maxOutputTokens: maxTokens }
              })
            }
          );
          if (!aiRes.ok) {
            const errText = await aiRes.text();
            lastErr = "Gemini: " + errText;
            lastStatus = aiRes.status;
            if (RETRYABLE_STATUSES.includes(aiRes.status) && attempt < MAX_ATTEMPTS) {
              await new Promise(r => setTimeout(r, attempt * 1200));
              continue;
            }
            return json({ error: lastErr }, lastStatus);
          }
          const aiData = await aiRes.json();
          const text = aiData.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
          return json({ ok: true, content: text });
        } catch (e) {
          lastErr = "Error: " + e.message;
          lastStatus = 500;
          if (attempt < MAX_ATTEMPTS) { await new Promise(r => setTimeout(r, attempt * 1200)); continue; }
          return json({ error: lastErr }, lastStatus);
        }
      }
      return json({ error: lastErr || "خطای نامشخص در ارتباط با هوش مصنوعی" }, lastStatus);
    }
  }

  return json({ ok: false, error: "مسیر یافت نشد" }, 404);
}

/* ------------------------- خروجی Word ------------------------- */

function wordResponse(bodyHtml, filename, margin) {
  const doc =
    `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">` +
    `<head><meta charset="utf-8">` +
    `<style>
      @page { size: A4; margin: ${margin || "1.5cm"}; }
      body { font-family: 'B Nazanin','Tahoma',sans-serif; direction: rtl; font-size: 13pt; }
      .hdr { text-align:center; border-bottom: 2px solid #000; padding-bottom:8px; margin-bottom:14px; }
      .hdr h1 { font-size: 15pt; margin: 2px 0; }
      .hdr h2 { font-size: 12pt; margin: 2px 0; font-weight: normal; }
      .hdr h3 { font-size: 12pt; margin: 2px 0; font-weight: normal; }
      .meta-table { width:100%; mso-table-layout-alt:fixed; border-collapse: collapse; margin-bottom: 14px; }
      .meta-table td { border: 1px solid #000; padding: 6px 8px; }
      table.q { width:100%; mso-table-layout-alt:fixed; border-collapse: collapse; margin-bottom: 10px; }
      table.q td, table.q th { border: 1px solid #000; padding: 6px 8px; vertical-align: top; }
      .qnum { width: 36px; text-align:center; font-weight:bold; }
      .opt { padding: 2px 18px; }
      .ans { min-height: 40px; }
      img { max-width: 900px; }
      .frac{display:inline-block;text-align:center;vertical-align:middle;margin:0 3px}
      .frac .fn{display:block;border-bottom:1.5px solid #000;padding:0 4px}
      .frac .fd{display:block;padding:0 4px}
      .shape{display:inline-block;vertical-align:middle;line-height:1;margin:0 2px}
      .shape svg{display:block}
      .ldiv{border-collapse:collapse;display:inline-table;margin:6px 4px;vertical-align:middle}
      .ldiv td{padding:3px 10px;text-align:center;vertical-align:top}
      .ldiv td.ld-bar{border-right:2px solid #000}
      .ldiv td.ld-top{border-bottom:2px solid #000;min-width:60px;min-height:20px}
      .ldiv .ld-divisor{vertical-align:bottom;padding-bottom:6px;font-weight:bold}
      .ldiv .ld-dividend{padding:2px 6px;text-align:center}
      .ldiv .ld-work{min-height:26px}
      .mt-frac{display:inline-block;text-align:center;vertical-align:middle;margin:0 4px}
      .mt-frac .mt-num{display:block;border-bottom:2px solid #000;padding:0 4px}
      .mt-frac .mt-den{display:block;padding:0 4px}
      .mt-root{display:inline-block;vertical-align:middle;margin:0 4px}
      .mt-root .mt-idx{font-size:.6em;vertical-align:top}
      .mt-root .mt-rad{text-decoration:overline;padding:0 3px}
      .mt-op{display:inline-block;vertical-align:middle;margin:0 4px}
      .mt-op-stack{display:inline-block;text-align:center;vertical-align:middle}
      .mt-op-over,.mt-op-under{display:block;font-size:.55em}
      .mt-op-sign{display:block;font-size:1.6em;line-height:1}
      .mt-op-arg{display:inline-block;vertical-align:middle}
      .mt-lim{display:inline-block;vertical-align:middle;margin:0 4px}
      .mt-lim-stack{display:inline-block;text-align:center;vertical-align:middle}
      .mt-lim-word{display:block;font-size:.7em}
      .mt-lim-under{display:block;font-size:.55em}
      .mt-matrix{border-collapse:collapse;display:inline-table;vertical-align:middle;margin:0 5px;border-left:2px solid #000;border-right:2px solid #000}
      .mt-matrix td{padding:4px 10px;text-align:center}
      .mt-ph{display:inline-block;min-width:16px}
    </style></head><body dir="rtl">` +
    bodyHtml +
    `</body></html>`;
  return new Response(doc, {
    headers: {
      "content-type": "application/msword; charset=utf-8",
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    },
  });
}

function wordHeader(meta, extra = "") {
  let html = `<div class="hdr">`;
  if (meta.school) html += `<h1>${esc(meta.school)}</h1>`;
  if (meta.examName) html += `<h2>${esc(meta.examName)}</h2>`;
  if (meta.teacher) html += `<h3>آموزگار: ${esc(meta.teacher)}</h3>`;
  if (meta.examDuration) html += `<h3>مدت زمان: ${esc(meta.examDuration)} دقیقه</h3>`;
  html += `</div>`;
  return html + extra;
}

function questionBodyWord(q) {
  let inner = `<div><b>${q.rich ? q.text : esc(q.text)}</b> <span style="font-size:11px;color:#666">(وزن: ${q.weight || 1})</span></div>`;
  if (q.image) inner += `<div><img src="${esc(q.image)}" style="width:${q.imageWidth || 320}px;max-width:100%"></div>`;
  if (q.type === "multiple") {
    (q.options || []).forEach((o, oi) => {
      inner += `<div class="opt">${["الف", "ب", "ج", "د"][oi] || oi + 1}) ${esc(o)}</div>`;
    });
  } else if (q.type === "truefalse") {
    inner += `<div class="opt">صحیح ☐&nbsp;&nbsp;&nbsp; غلط ☐</div>`;
  } else if (q.type === "short") {
    inner += `<div class="ans">پاسخ: ...........................................................</div>`;
  } else {
    inner += `<div class="ans">پاسخ:<br><br><br></div>`;
  }
  return inner;
}

function examWord(meta, questions) {
  let body = wordHeader(meta);
  body +=
    `<table class="meta-table">` +
    `<tr><td>نام و نام خانوادگی: ...................</td><td>نام پدر: ...................</td><td>کد ملی: ...................</td></tr>` +
    `<tr><td>نام درس: ...................</td><td>کلاس: ...................</td><td></td></tr>` +
    `</table>`;

  questions.forEach((q, i) => {
    body +=
      `<table class="q"><tr>` +
      `<td class="qnum">${i + 1}</td>` +
      `<td>${questionBodyWord(q)}</td>` +
      `</tr></table>`;
  });
  return body;
}

function examSheetWord(d) {
  d = d || {};
  const rows = Array.isArray(d.rows) && d.rows.length ? d.rows : [{ q: "", mark: "" }];
  const teacherLabel = d.teacherLabel || "نام دبیر";
  const markLabel = d.markLabel || "بارم";
  const fontSize = parseInt(d.fontSize, 10) || 12;
  const tblStyle = "width:100%;table-layout:fixed;mso-table-layout-alt:fixed";
  const fontWrap = (inner) => `<div style="font-family:'B Nazanin',Tahoma,Arial;font-weight:bold;font-size:${fontSize}pt">${inner}</div>`;
  const examTitleFull = esc(d.examtitle || "آزمون نوبت اول") + (d.examtitleExtra ? " - " + esc(d.examtitleExtra) : "");
  let body =
    `<table class="meta-table" width="100%" style="${tblStyle}"><tr>` +
    `<td style="width:33%">نام و نام‌خانوادگی: ...................................</td>` +
    `<td style="width:34%;text-align:center">${esc(d.org1 || "وزارت آموزش و پرورش جمهوری اسلامی ایران")}</td>` +
    `<td style="width:33%">تاریخ آزمون: ${esc(d.date || "")}</td>` +
    `</tr><tr>` +
    `<td>نام پدر: ...................................</td>` +
    `<td style="text-align:center">${esc(d.org2 || "")}</td>` +
    `<td>زمان آزمون: ${esc(d.time || "")}</td>` +
    `</tr><tr>` +
    `<td>رشته / پایه: ${esc(d.grade || "")}</td>` +
    `<td>سال تحصیلی: ${esc(d.schoolyear || "")}</td>` +
    `<td>${examTitleFull}</td>` +
    `</tr></table>` +
    `<table class="meta-table" width="100%" style="${tblStyle};margin-top:6px"><tr>` +
    `<td style="width:50%">نام درس: ${esc(d.course || "")}</td>` +
    `<td style="width:50%">${esc(teacherLabel)}: ${esc(d.teacher || "")}</td>` +
    `</tr></table>` +
    `<table class="q" width="100%" style="${tblStyle};margin-top:6px">` +
    `<thead><tr><th class="qnum" style="width:8%">ردیف</th><th style="width:80%">سؤال</th><th style="width:12%">${esc(markLabel)}</th></tr></thead>` +
    `<tbody>` +
    rows.map((r, i) => {
      const spRaw = parseInt(r.space, 10);
      const sp = isNaN(spRaw) ? 90 : spRaw;
      const brCount = sp > 0 ? Math.max(1, Math.round(sp / 35)) : 0;
      return `<tr style="page-break-inside:avoid"><td class="qnum" style="vertical-align:top">${toFaDigitsSrv(i + 1)}</td>` +
        `<td style="vertical-align:top;font-size:${fontSize}pt">${r.q || ""}${"<br>".repeat(brCount)}</td>` +
        `<td style="text-align:center;vertical-align:top">${esc(r.mark || "")}</td></tr>`;
    }).join("") +
    `</tbody></table>`;
  return fontWrap(body);
}

function answerLabel(q, ans) {
  if (q.type === "multiple") {
    const idx = Number(ans);
    if (!isNaN(idx) && q.options && q.options[idx] != null) {
      return `${["الف", "ب", "ج", "د"][idx] || idx + 1}) ${esc(q.options[idx])}`;
    }
    return esc(ans);
  }
  if (q.type === "truefalse") {
    if (ans === "true" || ans === true) return "صحیح";
    if (ans === "false" || ans === false) return "غلط";
    return esc(ans);
  }
  return esc(ans);
}

const MARK_LABEL = { correct: "صحیح", wrong: "غلط", partial: "نیمه‌درست" };

function answerSheetWord(sub) {
  const meta = sub.meta || DEFAULT_META;
  const questions = sub.questionsSnapshot || [];
  const g = sub.grading || {};
  const st = sub.student || {};
  let body = wordHeader(meta);
  body +=
    `<table class="meta-table">` +
    `<tr><td>نام و نام خانوادگی: ${esc(st.name)}</td><td>نام پدر: ${esc(st.fatherName)}</td><td>کد ملی: ${esc(st.nationalId)}</td></tr>` +
    `<tr><td>نام درس: ${esc(st.courseName)}</td><td>تاریخ ثبت: ${esc(new Date(sub.submittedAt).toLocaleString("fa-IR"))}</td><td></td></tr>` +
    `</table>`;

  body += `<table class="q"><tr><th class="qnum">ردیف</th><th>سوال</th><th>پاسخ دانش‌آموز</th><th>نمره</th><th>بازخورد معلم</th></tr>`;
  questions.forEach((q, i) => {
    const ans = sub.answers ? sub.answers[q.id] : "";
    const mark = g.marks ? g.marks[q.id] : "";
    const fb = g.feedback ? g.feedback[q.id] : "";
    let qcell = q.rich ? q.text : esc(q.text);
    if (q.image) qcell += `<div><img src="${esc(q.image)}" style="width:${q.imageWidth || 320}px;max-width:100%"></div>`;
    body +=
      `<tr><td class="qnum">${i + 1}</td>` +
      `<td>${qcell} <small>(${esc(QUESTION_TYPES[q.type] || q.type)})</small></td>` +
      `<td>${ans == null || ans === "" ? "<i>بدون پاسخ</i>" : answerLabel(q, ans)}</td>` +
      `<td>${esc(mark)}</td>` +
      `<td>${esc(fb || "")}</td></tr>`;
  });
  body += `</table>`;
  if (g.overall) body += `<p><b>نتیجه/بازخورد کلی:</b> ${esc(g.overall)}</p>`;
  return body;
}

/* ------------------------- استایل مشترک صفحات ------------------------- */

const SHARED_CSS = `
  @font-face{font-family:"BNazanin";src:url(https://cdn.jsdelivr.net/gh/intuxicated/css-persian@master/fonts/BNazanin.ttf);font-weight:bold}
  @font-face{font-family:"BMitra";src:url(https://cdn.jsdelivr.net/gh/intuxicated/css-persian@master/fonts/BMitra.ttf);font-weight:bold}
  @font-face{font-family:"BTitr";src:url(https://cdn.jsdelivr.net/gh/intuxicated/css-persian@master/fonts/BTitrBold.ttf);font-weight:bold}
  @font-face{font-family:"BKoodak";src:url(https://cdn.jsdelivr.net/gh/intuxicated/css-persian@master/fonts/BKoodakBold.ttf);font-weight:bold}
  :root{--bg:#F3F6F9;--card:#FFFFFF;--primary:#123A5C;--primary-2:#1F6E8C;--accent:#B8922E;--muted:#5B6B7C;--line:#DEE5EC;--danger:#B3261E;--text:#16212E;--soft:#EBF0F5;--soft-2:#DCE4EC;--success:#1B7A4B;--warning:#A0611A;--info:#1B5E82;--shadow:0 10px 28px rgba(18,32,48,.10);}
  [data-theme="light"]{--bg:#F3F6F9;--card:#FFFFFF;--primary:#123A5C;--primary-2:#1F6E8C;--muted:#5B6B7C;--line:#DEE5EC;--text:#16212E;--soft:#EBF0F5;--soft-2:#DCE4EC;}
  [data-theme="dark"]{--bg:#0B141E;--card:#101C29;--primary:#2E7A9E;--primary-2:#3C8CB0;--muted:#93A6B8;--line:#1E2E3F;--text:#E8EEF3;--soft:#152232;--soft-2:#1C2C3F;--shadow:0 14px 34px rgba(0,0,0,.45);}
  .theme-btn{padding:10px 20px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--text);font-size:14px;cursor:pointer;transition:all .15s ease}
  .theme-btn:hover,.theme-btn.active{background:var(--primary);color:#fff;border-color:var(--primary)}
  .color-swatch{width:42px;height:42px;border-radius:10px;border:1.5px solid var(--line);box-shadow:0 2px 8px rgba(18,32,48,.14);cursor:pointer;transition:transform .15s,box-shadow .15s;padding:0}
  .color-swatch:hover{transform:translateY(-2px)}
  .color-swatch.active{box-shadow:0 2px 8px rgba(18,32,48,.14),0 0 0 3px var(--primary)}
  *{box-sizing:border-box}
  html{scroll-behavior:smooth}
  body{margin:0;min-height:100vh;font-family:'Vazirmatn',Tahoma,system-ui,sans-serif;color:var(--text);direction:rtl;transition:background .3s,color .3s;-webkit-font-smoothing:antialiased;
    background:
      radial-gradient(1100px 620px at 18% -12%, var(--soft-2) 0%, transparent 62%),
      radial-gradient(900px 560px at 105% 8%, var(--soft) 0%, transparent 58%),
      radial-gradient(1200px 720px at 50% 120%, var(--soft-2) 0%, transparent 60%),
      var(--bg);
    background-attachment:fixed;
  }
  .wrap{max-width:1180px;margin:0 auto;padding:18px;position:relative}
  .header{position:relative;background:linear-gradient(rgba(0,0,0,.22),rgba(0,0,0,.22)),linear-gradient(120deg,var(--primary),var(--primary-2));color:#fff;border:1px solid rgba(255,255,255,.14);border-radius:16px;padding:28px 22px;text-align:center;box-shadow:var(--shadow);}
  .header::before{content:'';position:absolute;right:0;left:0;bottom:0;height:3px;background:linear-gradient(90deg,transparent,var(--accent),transparent);border-radius:0 0 16px 16px;pointer-events:none}
  .header::after{content:'';position:absolute;right:8%;left:8%;top:-26px;height:60px;background:radial-gradient(60% 100% at 50% 100%, color-mix(in srgb, var(--primary-2) 55%, transparent) 0%, transparent 75%);filter:blur(6px);pointer-events:none;z-index:-1}
  .header h1{position:relative;margin:4px 0;font-size:22px;font-weight:800;color:#fff;letter-spacing:.2px;text-shadow:0 1px 3px rgba(0,0,0,.4)}
  .header h2{position:relative;margin:4px 0;font-size:15px;font-weight:500;color:rgba(255,255,255,.92);text-shadow:0 1px 3px rgba(0,0,0,.4)}
  .header h3{position:relative;margin:4px 0;font-size:13px;font-weight:400;color:rgba(255,255,255,.88);text-shadow:0 1px 3px rgba(0,0,0,.4)}
  .teacher-header{position:relative;padding:20px 18px}
  .teacher-header h1{font-size:18px;margin:2px 0}
  .th-topbar{position:relative;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px}
  .th-clock{background:rgba(0,0,0,.32);border:1px solid rgba(255,255,255,.35);color:#fff;border-radius:8px;padding:5px 12px;font-size:13px;font-weight:700;letter-spacing:1px;font-variant-numeric:tabular-nums;direction:ltr;text-shadow:0 1px 2px rgba(0,0,0,.4)}
  .th-en-badge{background:rgba(0,0,0,.32);border:1px solid rgba(255,255,255,.35);color:#fff;border-radius:8px;padding:5px 12px;font-size:11px;font-weight:600;letter-spacing:.3px;white-space:nowrap;text-shadow:0 1px 2px rgba(0,0,0,.4)}
  .th-designer{position:relative;display:inline-flex;align-items:center;gap:8px;background:rgba(0,0,0,.32);border:1px solid rgba(255,255,255,.35);color:#fff;border-radius:999px;padding:4px 14px;font-size:11px;margin-top:2px;text-shadow:0 1px 2px rgba(0,0,0,.4)}
  .th-designer .en{opacity:.85;font-weight:400}
  @media (max-width:600px){.th-topbar{justify-content:center}}
  .home-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px;margin-top:14px}
  .home-card{border:1px solid var(--line);border-radius:18px;padding:16px;cursor:pointer;background:var(--card);transition:transform .15s,box-shadow .15s;text-align:right;text-decoration:none;color:var(--text);display:block;box-shadow:0 4px 14px rgba(18,32,48,.10)}
  .home-card:hover{transform:translateY(-3px);box-shadow:0 6px 18px rgba(18,32,48,.10);border-color:var(--primary)}
  .home-card h4{margin:0 0 6px;font-size:15px}
  .home-card ul{margin:8px 0 0;padding-inline-start:18px;font-size:12.5px;color:var(--muted);line-height:1.9}
  .card{background:linear-gradient(165deg, var(--card) 0%, var(--soft) 100%);border:1px solid var(--line);border-radius:20px;padding:20px;margin-top:16px;box-shadow:var(--shadow);transition:transform .15s ease}
  label{display:block;font-size:14px;margin:10px 0 6px;font-weight:600}
  input,textarea,select{width:100%;padding:11px 12px;border:2px solid var(--line);border-radius:12px;font-family:inherit;font-size:15px;background:var(--card);color:var(--text);transition:border-color .15s ease}
  input:focus,textarea:focus,select:focus{outline:none;border-color:var(--primary)}
  textarea{min-height:90px;resize:vertical}
  .btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;background:var(--primary);color:#fff;border:none;padding:11px 22px;border-radius:14px;font-size:15px;font-weight:700;cursor:pointer;font-family:inherit;text-decoration:none;transition:all .12s ease;box-shadow:0 4px 14px rgba(18,32,48,.16)}
  .btn:hover{transform:translateY(-2px)}
  .btn:active{transform:translateY(4px);box-shadow:0 1px 4px rgba(18,32,48,.14)}
  .btn.sec{background:var(--info)}
  .btn.gray{background:var(--card);border:1px solid var(--line);box-shadow:none;color:var(--text)}
  .btn.gray:hover{background:var(--soft);transform:none}
  .btn.gray.active{background:var(--primary);color:#fff;box-shadow:inset 0 0 0 2px rgba(255,255,255,.5)}
  .btn.danger{background:var(--danger)}
  .btn.sm{padding:8px 14px;font-size:13px;border-radius:10px;box-shadow:0 3px 10px rgba(18,32,48,.16)}
  .btn.sm:active{box-shadow:0 1px 4px rgba(18,32,48,.14)}
  .row{display:flex;gap:10px;flex-wrap:wrap}
  .row>*{flex:1;min-width:160px}
  .muted{color:var(--muted);font-size:13px}
  .q-block{border:1px solid var(--line);border-radius:16px;padding:14px;margin-top:12px;background:var(--card);transition:transform .15s ease}
  .q-block:hover{transform:translateY(-2px);box-shadow:var(--shadow)}
  .q-block .qhead{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap}
  .badge{background:var(--primary);color:#fff;border-radius:999px;padding:4px 12px;font-size:12px;font-weight:700}
  .opt-row{display:flex;gap:8px;align-items:center;margin-top:6px}
  .opt-row input[type=text]{flex:1}
  .toolbar{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}
  .toolbar button{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:6px 12px;cursor:pointer;font-size:15px;min-width:34px;transition:all .15s ease}
  .toolbar button:hover{background:var(--primary);border-color:var(--primary);color:#fff}
  .toolbar .grp-label{font-size:12px;color:var(--muted);align-self:center;margin-left:6px}
  .imgprev{height:auto;border:1px solid var(--line);border-radius:12px;margin-top:6px;display:block}
  table{width:100%;border-collapse:collapse;border-radius:14px;overflow:hidden;margin-top:10px;box-shadow:var(--shadow)}
  th,td{border:1px solid var(--line);padding:10px;text-align:right;font-size:14px;vertical-align:top}
  th{background:var(--primary);color:#fff;font-weight:700}
  tr:hover td{background:var(--soft)}
  .ans-table-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
  .ans-grade-table{min-width:640px}
  .ans-grade-table th:nth-child(1),.ans-grade-table td:nth-child(1){min-width:32px}
  .ans-grade-table th:nth-child(2),.ans-grade-table td:nth-child(2){min-width:200px}
  .ans-grade-table th:nth-child(3),.ans-grade-table td:nth-child(3){min-width:200px}
  .ans-grade-table th:nth-child(4),.ans-grade-table td:nth-child(4){min-width:100px}
  .ans-grade-table th:nth-child(5),.ans-grade-table td:nth-child(5){min-width:140px}
  .dash-flex{display:flex;gap:16px;align-items:flex-start;margin-top:16px}
  .tabs{display:flex;flex-direction:column;gap:6px;flex:0 0 180px;width:180px}
  .tab{padding:9px 12px;border-radius:12px;background:var(--soft);border:1px solid var(--line);cursor:pointer;font-weight:600;font-size:13px;line-height:1.4;text-decoration:none;color:var(--text);display:flex;align-items:center;justify-content:center;gap:7px;text-align:right;transition:all .15s ease}
  .tab .tab-ico{flex:0 0 auto;font-size:15px;line-height:1}
  .badge-dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:#ef4444;margin-inline-start:auto;flex:0 0 auto}
  .tab .tab-label{flex:0 1 auto}
  .tab:hover{background:var(--soft-2)}
  .tab.active{background:var(--primary);color:#fff;border-color:var(--primary)}
  .dash-flex>.tab-content{flex:1;min-width:0;margin-top:0}
  .mobile-menu-btn{display:none}
  .tabs-overlay{display:none}
  @media (max-width:760px), (pointer:coarse) and (max-width:1024px){
    .dash-flex{flex-direction:column}
    .mobile-menu-btn{display:inline-flex;align-items:center;gap:6px;background:var(--primary);color:#fff;border:none;padding:10px 16px;border-radius:12px;font-weight:700;font-size:14px;cursor:pointer;margin:16px 0 0;box-shadow:0 3px 10px rgba(18,32,48,.16)}
    .tabs{position:fixed;top:0;right:0;height:100vh;width:78vw;max-width:280px;background:var(--card);border-left:2px solid var(--text);box-shadow:-6px 0 24px rgba(0,0,0,.25);z-index:301;flex-wrap:nowrap;padding:64px 14px 14px;transform:translateX(100%);transition:transform .25s ease;overflow-y:auto}
    .tabs.open{transform:translateX(0)}
    .tabs .tab{font-size:14px;padding:12px 14px}
    .tabs .tab-parent{font-size:14px;padding:12px 14px}
    .tabs .tab-child{font-size:13px;padding:11px 14px}
    .tabs-overlay.open{display:block;position:fixed;top:0;right:0;bottom:0;left:0;width:100vw;height:100vh;background:rgba(15,23,42,.55);z-index:300}
    .dash-flex>.tab-content{margin-top:16px}
  }
  .subtab{padding:8px 14px;border-radius:12px;background:var(--soft);border:1px solid var(--line);cursor:pointer;font-weight:600;font-size:13px;transition:all .15s ease}
  .subtab:hover{background:var(--soft-2)}
  .subtab.active{background:var(--primary);color:#fff;border-color:var(--primary)}
  .tab-group{display:flex;flex-direction:column;gap:4px}
  .tab-parent{display:flex;align-items:center;gap:7px;padding:9px 12px;border-radius:12px;background:var(--soft);border:1px solid var(--line);cursor:pointer;font-weight:600;font-size:13px;line-height:1.4;color:var(--text);user-select:none;transition:all .15s ease}
  .tab-parent .tab-ico{flex:0 0 auto;font-size:15px;line-height:1}
  .tab-parent .tab-label{flex:1;text-align:right}
  .tab-parent:hover{background:var(--soft-2)}
  .tab-parent.open{background:var(--soft-2)}
  .tab-parent.active{background:var(--primary);color:#fff;border-color:var(--primary)}
  .tab-parent.active .tab-arrow{color:#fff}
  .tab-parent .tab-arrow{font-size:10px;transition:transform .2s ease;flex:0 0 auto;align-self:center}
  .tab-parent.open .tab-arrow{transform:rotate(180deg)}
  .tab-children{display:flex;flex-direction:column;gap:3px;max-height:0;overflow:hidden;transition:max-height .25s ease;padding-right:10px}
  .tab-children.open{max-height:900px;margin-top:4px}
  .tab-child{display:block;padding:7px 10px;border-radius:8px;background:var(--card);font-size:12px;font-weight:600;text-decoration:none;color:var(--text);border:2px solid var(--line);transition:all .15s ease}
  .tab-child:hover{background:var(--soft);border-color:var(--text)}
  .tab-subgroup{display:flex;flex-direction:column;gap:3px}
  .tab-subgroup-head{display:flex;align-items:center;gap:6px;padding:7px 10px;border-radius:8px;background:var(--card);border:2px solid var(--line);cursor:pointer;font-weight:700;font-size:12px;color:var(--text);user-select:none;transition:all .15s ease}
  .tab-subgroup-head:hover{background:var(--soft)}
  .tab-subgroup-head.open{border-color:var(--primary)}
  .tab-subgroup-head .tab-sub-ico{flex:0 0 auto;font-size:13px;line-height:1}
  .tab-subgroup-head .tab-sub-label{flex:1;text-align:right}
  .tab-subgroup-head .tab-sub-arrow{font-size:9px;transition:transform .2s ease;flex:0 0 auto}
  .tab-subgroup-head.open .tab-sub-arrow{transform:rotate(180deg)}
  .tab-subchildren{display:flex;flex-direction:column;gap:3px;max-height:0;overflow:hidden;transition:max-height .25s ease;padding-right:10px}
  .tab-subchildren.open{max-height:500px;margin-top:3px}
  .tab-subchildren .tab-child{font-size:11px;padding:6px 9px}

  .hidden{display:none}
  .toast{position:fixed;bottom:18px;right:18px;background:var(--primary);color:#fff;padding:12px 20px;border-radius:12px;opacity:0;transform:translateY(20px);transition:all .3s ease;z-index:9999;box-shadow:0 8px 30px rgba(0,0,0,.3);font-weight:600}
  .toast.show{opacity:1;transform:translateY(0)}
  .link-box{font-family:monospace;direction:ltr;text-align:left;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px;font-size:12px;word-break:break-all}
  .pill{font-size:12px;padding:4px 10px;border-radius:999px;font-weight:700}
  .pill.ok{background:var(--success);color:#fff}.pill.no{background:var(--danger);color:#fff}.pill.gr{background:var(--primary);color:#fff}
  
  /* ===== استایل‌های نتیجه آزمون ===== */
  .mark.correct{color:var(--success);font-weight:700}
  .mark.wrong{color:var(--danger);font-weight:700}
  .mark.partial{color:var(--warning);font-weight:700}
  .mark.excellent{color:var(--success);font-weight:700}
  .mark.good{color:var(--primary);font-weight:700}
  .mark.acceptable{color:var(--warning);font-weight:700}
  .mark.needs-improve{color:var(--danger);font-weight:700}
  .mark.numeric{color:var(--info);font-weight:700;font-size:18px}

  .result-card{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:20px;margin-top:16px;box-shadow:var(--shadow)}
  .result-card .total-score{font-size:24px;font-weight:800;color:var(--primary);text-align:center;padding:16px;background:var(--soft);border:1px solid var(--line);border-radius:12px;margin-bottom:16px}
  .result-table th{background:var(--primary);color:#fff}
  .result-table .status-badge{display:inline-block;padding:5px 14px;border-radius:999px;font-size:13px;font-weight:700}
  .status-badge.correct{background:var(--success);color:#fff}
  .status-badge.wrong{background:var(--danger);color:#fff}
  .status-badge.partial{background:var(--warning);color:#fff}
  .status-badge.excellent{background:var(--success);color:#fff}
  .status-badge.good{background:var(--primary);color:#fff}
  .status-badge.acceptable{background:var(--warning);color:#fff}
  .status-badge.needs-improve{background:var(--danger);color:#fff}

  .weight-input-box{background:var(--soft);border:2px solid var(--success);border-radius:12px;padding:12px 16px;margin-top:10px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
  .weight-input-box label{margin:0;font-size:13px;font-weight:700;color:var(--success)}
  .weight-input-box input{width:70px;padding:8px 10px;border:2px solid var(--success);border-radius:8px;font-size:14px;background:var(--card)}
  .weight-input-box .weight-hint{font-size:12px;color:var(--muted)}
  .weight-total{background:var(--soft);border:2px solid var(--primary);border-radius:12px;padding:12px 20px;margin-top:10px;display:flex;justify-content:space-between;align-items:center;font-size:14px}
  .weight-total .total-value{font-weight:800;color:var(--primary);font-size:20px}
  .weight-total .total-value.valid{color:var(--success)}
  .weight-total .total-value.invalid{color:var(--danger)}
  
  .rich{min-height:90px;border:2px solid var(--line);border-radius:12px;padding:14px;background:var(--card);color:var(--text);font-size:15px;line-height:1.9;transition:border-color .15s ease}
  .rich:focus{outline:none;border-color:var(--primary)}
  .frac{display:inline-flex;flex-direction:column;text-align:center;vertical-align:middle;margin:0 3px;line-height:1.05}
  .frac .fn{display:block;border-bottom:2px solid currentColor;padding:0 5px}
  .frac .fd{display:block;padding:0 5px}
  .shape{display:inline-block;vertical-align:middle;line-height:1;margin:0 2px}
  .shape svg{display:block}
  .ldiv{display:inline-table;border-collapse:collapse;margin:6px 4px;vertical-align:middle}
  .ldiv td{padding:3px 10px;font-size:15px;text-align:center;vertical-align:top}
  .ldiv td.ld-bar{border-right:2px solid currentColor}
  .ldiv td.ld-top{border-bottom:2px solid currentColor;min-width:60px;min-height:20px}
  .ldiv .ld-divisor{vertical-align:bottom;padding-bottom:6px;font-weight:bold}
  .ldiv .ld-dividend{padding:2px 6px;text-align:center}
  .ldiv .ld-work{min-height:26px}

  /* ---- فرمول‌ساز ریاضی (شبیه MathType) ---- */
  .mt-modal-overlay{position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:200;display:flex;align-items:center;justify-content:center;padding:16px}
  .mt-modal-overlay.hidden{display:none}
  .mt-modal{background:var(--card);color:var(--text);border:1px solid var(--line);border-radius:18px;padding:18px;max-width:720px;width:100%;max-height:88vh;overflow:auto;box-shadow:0 20px 60px rgba(0,0,0,.3)}
  .mt-modal-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
  .mt-palette{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:6px}
  .mt-palette button{padding:7px 11px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--text);cursor:pointer;font-family:inherit;font-size:13px;transition:all .15s ease}
  .mt-palette button:hover{background:var(--primary);color:#fff;border-color:var(--primary)}
  .mt-canvas{min-height:80px;font-size:22px;direction:ltr;text-align:center}
  .mt-open-btn{font-weight:700}

  /* ---- دفتر مدیریت کلاسی ---- */
  .lb-menu-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px;margin-top:16px}
  .lb-menu-btn{display:flex;flex-direction:column;align-items:center;gap:6px;padding:22px 14px;border-radius:18px;border:1px solid var(--line);background:var(--card);cursor:pointer;font-family:inherit;text-align:center;transition:transform .15s,box-shadow .15s;box-shadow:0 4px 14px rgba(18,32,48,.10)}
  .lb-menu-btn:hover{transform:translateY(-2px);box-shadow:0 6px 18px rgba(18,32,48,.10);border-color:var(--primary)}
  
  .lb-menu-btn .lb-ico{font-size:32px}
  .lb-menu-btn .lb-t{font-weight:700;font-size:14px}
  .lb-menu-btn small{color:var(--muted);font-size:11px}
  .lb-panel{margin-top:8px}
  .lb-cert-wrap{display:flex;gap:20px;flex-wrap:wrap;align-items:flex-start;margin-top:10px}
  .lb-cert-form{flex:1 1 320px;min-width:280px;display:flex;flex-direction:column;gap:8px}
  .lb-cert-form label{font-weight:700;font-size:13px;margin-top:4px}
  .lb-cert-templates{display:flex;gap:8px;flex-wrap:wrap}
  .lb-cert-tpl-btn{padding:8px 14px;border-radius:10px;border:1.5px solid var(--line);background:#f8fafc;cursor:pointer;font-family:inherit;font-weight:700;font-size:13px}
  .lb-cert-tpl-btn.active{border-color:var(--primary);box-shadow:0 0 0 2px var(--primary) inset}
  .lb-cert-preview-wrap{flex:1 1 380px;min-width:300px;display:flex;justify-content:center}
  .lb-cert-sheet{position:relative;width:100%;max-width:460px;min-height:640px;box-sizing:border-box;padding:30px 22px;border-radius:6px;font-family:tahoma,Arial;text-align:center;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;overflow:visible}
  .lb-cert-sheet::before{content:'';position:absolute;inset:var(--cert-frame-pad,10px);border:2.5px solid var(--cert-accent,#b8860b);border-radius:4px;pointer-events:none}
  .lb-cert-sheet::after{content:'';position:absolute;inset:calc(var(--cert-frame-pad,10px) + 6px);border:1px solid var(--cert-accent,#b8860b);border-radius:2px;pointer-events:none;opacity:.6}
  .lb-cert-bg-layer{position:absolute;inset:0;overflow:hidden;border-radius:6px;z-index:-1}
  .lb-cert-bg-fill{position:absolute;inset:0;background-repeat:no-repeat;background-size:cover;background-position:center;cursor:grab;touch-action:none}
  .lb-cert-bg-fill:active{cursor:grabbing}
  .lb-cert-sheet .cert-numbox{position:absolute;top:24px;right:26px;text-align:right;font-size:10.5px;line-height:1.7;color:#334155;font-family:tahoma,Arial;font-weight:700}
  .lb-cert-sheet .cert-badge{font-size:38px;line-height:1}
  .lb-cert-sheet .cert-kind{font-size:24px;font-weight:800;color:var(--cert-accent,#b8860b);margin:0;max-width:92%;overflow-wrap:break-word;word-break:break-word}
  .lb-cert-sheet .cert-intro{font-size:12.5px;color:#334155;margin:6px 0 0;max-width:88%;overflow-wrap:break-word;word-break:break-word}
  .lb-cert-sheet .cert-name{font-size:26px;font-weight:800;color:#1e293b;margin:4px 0;border-bottom:2px solid var(--cert-accent,#b8860b);padding-bottom:6px;display:inline-block;max-width:92%;overflow-wrap:break-word;word-break:break-word}
  .lb-cert-sheet .cert-reason{font-size:13px;color:#334155;max-width:88%;line-height:1.9;overflow-wrap:break-word;word-break:break-word;white-space:pre-line}
  .lb-cert-sheet .cert-footer{display:flex;justify-content:space-between;width:88%;margin-top:16px;font-size:11.5px;color:#475569;font-weight:700}
  .lb-cert-sheet .cert-sign{display:flex;flex-direction:column;align-items:center;gap:4px;margin-top:14px}
  .lb-cert-sheet .cert-sign img{max-height:70px;max-width:160px;object-fit:contain}
  .lb-cert-sheet .cert-sign span{font-size:11.5px;color:#475569;font-weight:700}
  .lb-cert-gold{background:linear-gradient(135deg,#fffdf5,#fdf6e3);--cert-accent:#b8860b}
  .lb-cert-blue{background:linear-gradient(135deg,#f3f8ff,#e6f0ff);--cert-accent:#1d4ed8}
  .lb-cert-green{background:linear-gradient(135deg,#f3fdf6,#e5f9ec);--cert-accent:#15803d}
  .lb-cert-purple{background:linear-gradient(135deg,#faf5ff,#f1e6ff);--cert-accent:#7e22ce}
  .lb-cert-champion{background:#fdfdfb;--cert-accent:#1d4ed8;padding:14px}
  .lb-cert-champion::before{inset:8px;border:3px solid #1d4ed8;border-radius:10px}
  .lb-cert-champion::after{inset:15px;border:2px solid #b8860b;border-radius:8px;opacity:1}
  .lb-cert-champion .cert-bismillah{font-size:15px;font-weight:700;color:#1d4ed8;margin:2px 0}
  .lb-cert-champion .cert-kind{font-size:30px;color:#1d4ed8}
  .lb-cert-champion .cert-name{border-bottom:2px solid #b8860b}
  .lb-cert-white{background:#ffffff;--cert-accent:#334155}
  .lb-cert-royal{background:#fdfaf5;--cert-accent:#5b21b6}
  .lb-cert-lapis{background:#fdfaf5;--cert-accent:#1e3a8a}
  .lb-cert-emerald{background:#fdfaf5;--cert-accent:#065f46}
  .lb-cert-font-titr .cert-kind,.lb-cert-font-titr .cert-name{font-family:"BTitr","B Titr",tahoma,Arial}
  .lb-cert-font-nazanin .cert-kind,.lb-cert-font-nazanin .cert-name,.lb-cert-font-nazanin .cert-reason,.lb-cert-font-nazanin .cert-intro{font-family:"BNazanin","B Nazanin",tahoma,Arial}
  .lb-cert-font-nastaliq .cert-kind{font-family:"Noto Nastaliq Urdu",tahoma,Arial;font-size:32px}
  .lb-cert-font-nastaliq .cert-name{font-family:"Noto Nastaliq Urdu",tahoma,Arial;font-size:28px}
  .lb-cert-font-nastaliq .cert-reason,.lb-cert-font-nastaliq .cert-intro{font-family:"BNazanin","B Nazanin",tahoma,Arial}
  .lb-cert-font-vazirmatn .cert-kind,.lb-cert-font-vazirmatn .cert-name,.lb-cert-font-vazirmatn .cert-reason,.lb-cert-font-vazirmatn .cert-intro{font-family:"Vazirmatn",tahoma,Arial}
  .lb-cert-font-koodak .cert-kind,.lb-cert-font-koodak .cert-name{font-family:"BKoodak","B Koodak",tahoma,Arial}
  .lb-cert-font-koodak .cert-reason,.lb-cert-font-koodak .cert-intro{font-family:"BNazanin","B Nazanin",tahoma,Arial}
  .lb-cert-font-mitra .cert-kind,.lb-cert-font-mitra .cert-name,.lb-cert-font-mitra .cert-reason,.lb-cert-font-mitra .cert-intro{font-family:"BMitra","B Mitra",tahoma,Arial}
  .lb-cert-font-shik .cert-kind{font-family:"BTitr","B Titr",tahoma,Arial}
  .lb-cert-font-shik .cert-name{font-family:"Noto Nastaliq Urdu",tahoma,Arial;font-size:28px}
  .lb-cert-font-shik .cert-reason,.lb-cert-font-shik .cert-intro{font-family:"BNazanin","B Nazanin",tahoma,Arial}
  .lb-cert-font-shik .cert-numbox,.lb-cert-font-shik .cert-sign span{font-family:"BMitra","B Mitra",tahoma,Arial}
  [data-theme="dark"] .lb-cert-tpl-btn{background:#0f172a}
  .lb-meta-form{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;margin:14px 0}
  .lb-meta-form label{display:block;font-size:12px;color:var(--muted);margin-bottom:3px}
  .lb-meta-form input{width:100%;padding:8px;border:1px solid #cbd5e1;border-radius:8px;font-family:inherit}
  .lb-textarea{width:100%;padding:10px;border:1px solid #cbd5e1;border-radius:8px;font-family:inherit;font-size:14px;resize:vertical;margin-bottom:12px}
  .lb-preview{overflow-x:auto;margin-top:10px;border:1px solid var(--line);border-radius:10px;padding:10px;background:#fff}
  .rc-header-box{background:#fefce8;border:2px solid #eab308;border-radius:10px;padding:14px;margin:10px 0;display:flex;align-items:flex-start;gap:14px;flex-wrap:wrap}
  .rc-photo-wrap{flex:0 0 auto;width:62px;display:flex;flex-direction:column;align-items:center;gap:5px}
  .rc-photo-wrap img#rc-photo-preview{width:62px;height:80px;object-fit:cover;border-radius:6px;border:1px solid #cbd5e1;background:#fff;display:block}
  .rc-photo-placeholder{width:62px;height:80px;border:1.5px dashed #d6c67a;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:9px;color:#a68a1f;text-align:center;background:#fffdf5;padding:3px;box-sizing:border-box}
  .rc-photo-wrap .btn{width:100%;font-size:11px;padding:6px 4px}
  .rc-header-box .lb-meta-form{flex:1;min-width:220px;margin:0}
  .rc-level-badge{display:inline-block;padding:3px 12px;border-radius:20px;font-size:12px;font-weight:700;white-space:nowrap}
  .rc-level-badge.rc-lv-excellent{background:#dcfce7;color:#166534}
  .rc-level-badge.rc-lv-good{background:#dbeafe;color:#1e40af}
  .rc-level-badge.rc-lv-acceptable{background:#fef3c7;color:#92400e}
  .rc-level-badge.rc-lv-needs-improve{background:#fee2e2;color:#991b1b}
  .rc-level-badge.rc-lv-none{background:#f1f5f9;color:#64748b}
  select.rc-level{border-radius:8px;font-weight:700;padding:6px 8px;border:1.5px solid var(--line)}
  [data-theme="dark"] .lb-preview{background:#1e293b}
  .lb-table{width:100%;border-collapse:collapse;font-size:12px}
  .lb-table th,.lb-table td{border:1px solid #94a3b8;padding:6px 8px;text-align:center;min-width:64px}
  .lb-table th:first-child,.lb-table td:first-child{min-width:40px}
  .lb-table th{background:#dbeafe;color:var(--text);font-weight:700}
  [data-theme="dark"] .lb-table th{background:#1e3a5f}
  .lb-table input,.lb-table textarea{width:100%;border:none;background:transparent;text-align:center;font-family:inherit;font-size:12px;padding:2px}
  .lbs-cell-ta{resize:none;overflow:hidden;box-sizing:border-box;line-height:1.5;display:block;min-height:1.6em}
  #lbr-table th{color:#1e293b}
  #lbr-table th.lbr-th-0{background:#e0e7ff}
  #lbr-table th.lbr-th-1{background:#dcfce7}
  #lbr-table th.lbr-th-2{background:#fef3c7}
  #lbr-table th.lbr-th-3{background:#ede9fe}
  #lbr-table th.lbr-th-4{background:#fce7f3}
  #lbr-table th.lbr-th-5{background:#cffafe}
  #lbr-table th.lbr-th-6{background:#ffedd5}
  [data-theme="dark"] #lbr-table th.lbr-th-0{background:#312e81;color:#e0e7ff}
  [data-theme="dark"] #lbr-table th.lbr-th-1{background:#14532d;color:#dcfce7}
  [data-theme="dark"] #lbr-table th.lbr-th-2{background:#78350f;color:#fef3c7}
  [data-theme="dark"] #lbr-table th.lbr-th-3{background:#4c1d95;color:#ede9fe}
  [data-theme="dark"] #lbr-table th.lbr-th-4{background:#831843;color:#fce7f3}
  [data-theme="dark"] #lbr-table th.lbr-th-5{background:#164e63;color:#cffafe}
  [data-theme="dark"] #lbr-table th.lbr-th-6{background:#7c2d12;color:#ffedd5}
  #lbr-table th .lbr-th-ico{display:block;font-size:15px;margin-bottom:2px}
  #lbr-table th .lbr-th-txt{display:block}

  /* ===== جدول حضور و غیاب هفتگی (طرح رنگی پاستلی با ستاره و تزئینات) ===== */
  .lbat-title-wrap{display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:14px;position:relative;flex-wrap:wrap}
  .lbat-title{font-size:22px;font-weight:800;color:#be123c;margin:0}
  .lbat-star{font-size:20px}
  .lbat-star-1{color:#a78bfa}
  .lbat-star-2{color:#f472b6}
  .lbat-deco{font-size:24px;margin-right:auto}
  .lbat-table{border-collapse:collapse}
  .lbat-table th,.lbat-table td{border:1px solid #cbd5e1}
  .lbat-table th.lbat-name-col,.lbat-table td.lbat-name-col{background:#eef2ff;color:#3730a3;font-weight:700;min-width:140px}
  [data-theme="dark"] .lbat-table th.lbat-name-col,[data-theme="dark"] .lbat-table td.lbat-name-col{background:#1e1b4b;color:#e0e7ff}
  .lbat-table th.lbat-row-col,.lbat-table td.lbat-row-col{background:#eef2ff;color:#3730a3;font-weight:700;min-width:34px}
  [data-theme="dark"] .lbat-table th.lbat-row-col,[data-theme="dark"] .lbat-table td.lbat-row-col{background:#1e1b4b;color:#e0e7ff}
  .lbat-table th.lbat-wk1{background:#fbcfe8;color:#9d174d}
  .lbat-table th.lbat-wk2{background:#fed7aa;color:#9a3412}
  .lbat-table th.lbat-wk3{background:#bbf7d0;color:#14532d}
  .lbat-table th.lbat-wk4{background:#bfdbfe;color:#1e3a8a}
  .lbat-table th.lbat-day{font-size:10px;font-weight:600;color:#475569;background:#f8fafc}
  [data-theme="dark"] .lbat-table th.lbat-day{background:#0f172a;color:#cbd5e1}
  .lbat-table td.lbat-wk1-cell{background:#fef7fa}
  .lbat-table td.lbat-wk2-cell{background:#fffaf3}
  .lbat-table td.lbat-wk3-cell{background:#f5fdf8}
  .lbat-table td.lbat-wk4-cell{background:#f5faff}
  [data-theme="dark"] .lbat-table td.lbat-wk1-cell,[data-theme="dark"] .lbat-table td.lbat-wk2-cell,[data-theme="dark"] .lbat-table td.lbat-wk3-cell,[data-theme="dark"] .lbat-table td.lbat-wk4-cell{background:#1e293b}
  .lbat-table input{width:100%;border:none;background:transparent;text-align:center;font-family:inherit;font-size:11px;padding:2px}

  /* ===== گروه‌بندی دانش‌آموزان (کارت‌های رنگی با شکلک حیوانات) ===== */
  .lbgrp-title-wrap{display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:14px}
  .lbgrp-title{font-size:22px;font-weight:800;color:#1e3a8a;margin:0}
  .lbgrp-star{font-size:20px;color:#facc15}
  .lbgrp-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:16px}
  @media (max-width:700px){.lbgrp-grid{grid-template-columns:1fr}}
  .lbgrp-card{border:2px dashed #cbd5e1;border-radius:18px;padding:14px;background:#fff}
  [data-theme="dark"] .lbgrp-card{background:#1e293b}
  .lbgrp-card-head{display:flex;align-items:center;gap:8px;margin-bottom:10px}
  .lbgrp-animal{font-size:26px}
  .lbgrp-pill{padding:6px 18px;border-radius:14px;font-weight:800;font-size:15px}
  .lbgrp-card-1{border-color:#86efac}
  .lbgrp-card-1 .lbgrp-pill{background:#dcfce7;color:#166534}
  .lbgrp-card-2{border-color:#f9a8d4}
  .lbgrp-card-2 .lbgrp-pill{background:#fce7f3;color:#9d174d}
  .lbgrp-card-3{border-color:#fdba74}
  .lbgrp-card-3 .lbgrp-pill{background:#fed7aa;color:#9a3412}
  .lbgrp-card-4{border-color:#93c5fd}
  .lbgrp-card-4 .lbgrp-pill{background:#bfdbfe;color:#1e3a8a}
  .lbgrp-card-5{border-color:#d8b4fe}
  .lbgrp-card-5 .lbgrp-pill{background:#f3e8ff;color:#6b21a8}
  .lbgrp-card-6{border-color:#fde68a}
  .lbgrp-card-6 .lbgrp-pill{background:#fef9c3;color:#854d0e}
  .lbgrp-table th{font-size:11px}
  .lbgrp-addrow{margin-top:8px}
  .lbgrp-card-head{flex-wrap:wrap}
  .lbgrp-name-input{outline:none;font-family:inherit}
  .lbgrp-delgroup{margin-inline-start:auto;padding:4px 10px !important;font-size:13px !important;border-radius:10px !important;box-shadow:none !important}
  .lbgrp-grade-select{padding:9px 14px;border-radius:12px;border:1px solid var(--line);background:var(--card);color:var(--text);font-family:inherit;font-size:14px}
  .lb-table-tight th,.lb-table-tight td{padding:3px 4px;font-size:11px;min-width:38px}
  .lb-table-tight th:first-child,.lb-table-tight td:first-child{min-width:36px}
  .lb-table-tight input{min-width:22px}
  .lb-diag-cell{position:relative;background:linear-gradient(to top left, transparent calc(50% - 1px), #94a3b8 calc(50% - 1px), #94a3b8 calc(50% + 1px), transparent calc(50% + 1px))!important;padding:0!important;height:44px;min-width:70px}
  .lb-diag-cell .lb-diag-top{position:absolute;top:2px;left:6px;font-size:10px;font-weight:700}
  .lb-diag-cell .lb-diag-bottom{position:absolute;bottom:2px;right:6px;font-size:10px;font-weight:700}
  .lb-table-zebra tbody tr:nth-child(odd){background:#f4f6f8}
  [data-theme="dark"] .lb-table-zebra tbody tr:nth-child(odd){background:#243247}
  .lb-resize-wrap{position:relative;display:inline-block;max-width:100%}
  .lb-resize-wrap>.lb-table{width:auto;min-width:100%}
  .lb-resize-handle{position:absolute;left:-6px;bottom:-6px;width:20px;height:20px;background:var(--primary);border:2px solid #fff;border-radius:6px;cursor:nwse-resize;z-index:5;display:flex;align-items:center;justify-content:center;color:#fff;font-size:12px;box-shadow:0 1px 4px rgba(0,0,0,.25);user-select:none;touch-action:none}
  .lb-resize-handle:hover{background:var(--primary-2)}
  .lb-font-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:10px 0}
  .lb-font-toolbar label{font-weight:700;font-size:13px}
  .lb-font-toolbar select,.lb-font-toolbar input[type=number]{padding:6px 8px;border:1px solid #cbd5e1;border-radius:6px;font-family:inherit}
  .lb-pacing-title{display:table;margin:4px auto 16px;padding:9px 28px;border:2px dashed #14b8a6;border-radius:999px;font-weight:800;font-size:16px;color:#0f766e;background:#f0fdfa}
  [data-theme="dark"] .lb-pacing-title{background:#0d2b28;color:#5eead4;border-color:#2dd4bf}
  .lb-pacing-wrap{overflow-x:auto;overflow-y:hidden;border-radius:18px;border:2px solid #14b8a6}
  [data-theme="dark"] .lb-pacing-wrap{border-color:#2dd4bf}
  .lb-pacing-table{width:max-content;min-width:100%;border-collapse:collapse;font-size:11px;margin-bottom:22px}
  .lb-pacing-table th,.lb-pacing-table td{border:1px solid #cbd5e1;padding:4px 6px;text-align:center}
  .lb-pacing-table th{background:#dbeafe;color:var(--text)}
  [data-theme="dark"] .lb-pacing-table th{background:#1e3a5f}
  .lb-pacing-table thead tr:first-child th{background:#fff;color:#000;font-weight:800;padding:9px 6px}
  [data-theme="dark"] .lb-pacing-table thead tr:first-child th{background:#0d7d73;color:#fff}
  .lb-pacing-table thead tr:nth-child(2) th{color:#000;font-weight:800;padding:7px 6px;background:#fff}
  .lb-pacing-table thead tr:nth-child(3) th{background:#fff;color:#1e293b;font-weight:700}
  [data-theme="dark"] .lb-pacing-table thead tr:nth-child(3) th{background:#0f172a;color:#e8eef3}

  /* ---- آمار دانش‌آموزان به تفکیک جنسیت ---- */
  .lbg-sheet{max-width:720px;margin:18px auto 0;background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:28px 24px;box-shadow:0 4px 18px rgba(0,0,0,.05)}
  [data-theme="dark"] .lbg-sheet{background:#0f172a;border-color:#334155}
  .lbg-title{text-align:center;font-size:17px;line-height:2.1;font-weight:700;margin:0 0 20px}
  .lbg-inline-input{display:inline-block;padding:4px 8px;border:none;border-bottom:2px solid var(--primary);background:transparent;font-family:inherit;font-weight:700;text-align:center;color:inherit;font-size:15px}
  .lbg-inline-input:focus{outline:none;background:rgba(102,126,234,.06)}
  .lbg-table{font-size:14px}
  .lbg-table th,.lbg-table td{padding:10px 12px;font-size:14px}
  .lbg-table th{background:#eef2ff;color:var(--text)}
  [data-theme="dark"] .lbg-table th{background:#1e2a4a}
  .lbg-table input{font-size:14px;font-weight:600;text-align:center}
  .lbg-sum{font-weight:700;background:#f8fafc}
  [data-theme="dark"] .lbg-sum{background:#1a2437}
  .lbg-total-row td{font-weight:800;background:#eef2ff;border-top:2px solid #94a3b8}
  [data-theme="dark"] .lbg-total-row td{background:#1e2a4a}
  .lbg-boxes{display:flex;gap:14px;justify-content:center;flex-wrap:wrap;margin-top:24px}
  .lbg-box{flex:1 1 180px;max-width:220px;background:#f8fafc;border:1px solid #dbe2ea;border-radius:12px;padding:16px 10px;text-align:center}
  [data-theme="dark"] .lbg-box{background:#1a2437;border-color:#334155}
  .lbg-box-main{background:#eef2ff;border-color:var(--primary)}
  [data-theme="dark"] .lbg-box-main{background:#1e2a4a}
  .lbg-box-label{display:block;font-size:12.5px;color:var(--muted);margin-bottom:8px;font-weight:600}
  .lbg-box-val{display:block;font-size:26px;font-weight:800;color:var(--primary)}
  .lb-pacing-table td.lb-subject{background:#fff;color:#0f766e;font-weight:800;white-space:nowrap;padding:4px 10px}
  [data-theme="dark"] .lb-pacing-table td.lb-subject{background:#0f172a;color:#5eead4}
  .lb-pacing-table td.lb-cell{min-width:100px;padding:2px}
  .lb-pacing-input{width:100%;min-height:56px;border:none;background:transparent;resize:vertical;font-family:inherit;font-size:11px;text-align:center;padding:3px;color:inherit}
  .lb-pacing-input:focus{outline:2px solid var(--primary);outline-offset:1px;background:#eef2ff;border-radius:6px}
  .lb-pacing-input::placeholder{color:#94a3b8;font-size:9px}
  .lb-nowruz{background:#16a34a !important;color:#fff;writing-mode:vertical-rl;text-orientation:mixed;font-weight:700;text-align:center}

  /* ---- پنل PDF کلاس آنلاین ---- */
  .cls-pdf-panel{background:#f8fafc;border:1px solid var(--line);border-radius:10px;padding:8px 10px;margin-bottom:10px}
  [data-theme="dark"] .cls-pdf-panel{background:#0f172a}
  #cls-pdf-nav input[type="number"]{padding:4px;border:1px solid #cbd5e1;border-radius:6px}

  /* ---- چیدمان کلاس آنلاین برای معلم (تخته بالا، گفتگو پایین) ---- */
  .cls-wrap{display:flex;flex-direction:column;gap:12px}
  .cls-board-col{width:100%}
  .cls-chat-col{width:100%}

  /* ---- چیدمان کلاس آنلاین برای دانش‌آموز (موبایل): دوربین بالا، تخته وسط، کاربران و گفتگو پایین ---- */
  .cls-stack{display:flex;flex-direction:column;gap:12px}
  .cls-sec{border:1px solid var(--line);border-radius:14px;overflow:hidden;background:var(--card)}
  .cls-sec-head{display:flex;align-items:center;gap:8px;padding:10px 14px;background:#0f172a;color:#fff;font-weight:700;font-size:14px;cursor:default}
  .cls-sec-head.tap{cursor:pointer;user-select:none}
  .cls-sec-head .cls-chevron{margin-right:auto;transition:transform .2s;font-size:12px;opacity:.85}
  .cls-sec-head.open .cls-chevron{transform:rotate(180deg)}
  .cls-badge-count{background:#2563eb;color:#fff;border-radius:999px;padding:1px 8px;font-size:12px;font-weight:700}
  .cls-board-box{width:100%;background:#fff;padding:8px}
  #cls-cam-pip .cls-cam-placeholder{color:#e5e7eb;font-size:10px;line-height:1.3;text-align:center;padding:4px}
  .cls-users-list{max-height:220px;overflow:auto;padding:10px 14px}
  .cls-users-list.hidden{display:none}
  .cls-user-row{display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--line);font-size:14px}
  .cls-user-row:last-child{border-bottom:none}
  .cls-user-row .u-dot{width:8px;height:8px;border-radius:50%;background:#16a34a;flex:0 0 auto}
  .cls-user-row.role-teacher{font-weight:700;color:var(--primary)}
  .cls-chat-wrap{padding:10px 14px}
  .cls-chat-wrap.hidden{display:none}

  .mt-ph{display:inline-block;min-width:18px;min-height:1.1em;border:1px dashed #94a3b8;border-radius:4px;padding:0 3px;outline:none}
  .mt-ph:empty:before{content:attr(data-ph);color:#94a3b8;font-size:.7em}
  .mt-ph:focus{border-color:var(--primary-2);border-style:solid}

  .mt-frac{display:inline-flex;flex-direction:column;text-align:center;vertical-align:middle;margin:0 4px;line-height:1.1}
  .mt-frac .mt-num{display:block;border-bottom:2px solid currentColor;padding:0 4px}
  .mt-frac .mt-den{display:block;padding:0 4px}

  .mt-pow, .mt-sub{display:inline-block;vertical-align:middle;margin:0 3px}
  .mt-pow sup, .mt-sub sub{font-size:.68em}

  .mt-root{display:inline-flex;align-items:flex-start;vertical-align:middle;margin:0 4px}
  .mt-root .mt-idx{font-size:.6em;position:relative;top:.3em}
  .mt-root .mt-radsign{font-size:1.1em;padding:0 1px}
  .mt-root .mt-rad{text-decoration:overline;padding:0 3px}

  .mt-op{display:inline-flex;align-items:center;vertical-align:middle;margin:0 4px}
  .mt-op-stack{display:inline-flex;flex-direction:column;align-items:center;text-align:center;margin-left:4px}
  .mt-op-over,.mt-op-under{font-size:.55em;min-height:1em}
  .mt-op-sign{font-size:1.6em;line-height:1}

  .mt-lim{display:inline-flex;align-items:center;vertical-align:middle;margin:0 4px}
  .mt-lim-stack{display:inline-flex;flex-direction:column;align-items:center;text-align:center;margin-left:4px}
  .mt-lim-word{font-size:.7em}
  .mt-lim-under{font-size:.55em}

  .mt-matrix{display:inline-table;border-collapse:collapse;vertical-align:middle;margin:0 5px;border-left:2px solid currentColor;border-right:2px solid currentColor}
  .mt-matrix td{padding:4px 10px;text-align:center}

  .mt-paren{display:inline-flex;align-items:center;vertical-align:middle}
  .mt-paren-sign{font-size:1.4em}

  
  /* ---- اسکنر حرفه‌ای ---- */
  .upload-zone{border:2px dashed var(--primary);border-radius:18px;padding:44px 20px;text-align:center;cursor:pointer;transition:all .2s ease;background:var(--soft);margin-bottom:16px}
  .upload-zone:hover{border-color:var(--primary-2);transform:scale(1.01)}
  .upload-zone.dragover{border-color:var(--primary);background:var(--soft-2);transform:scale(1.02)}
  .upload-icon{font-size:48px;margin-bottom:12px}
  .filter-presets{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap}
  .filter-btn{padding:10px 20px;border:1px solid var(--line);border-radius:12px;background:var(--card);color:var(--text);cursor:pointer;font-size:13px;font-weight:700;transition:all .15s ease}
  .filter-btn:hover{background:var(--soft)}
  .filter-btn.active{background:var(--primary);color:#fff;border-color:var(--primary)}
  .scan-settings{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:16px}
  .setting-group{background:var(--card);border-radius:16px;padding:16px;border:1px solid var(--line);box-shadow:var(--shadow)}
  .setting-group label{display:block;font-weight:700;margin-bottom:10px;font-size:13px;color:var(--text)}
  .setting-group input[type=range]{width:100%;height:8px;-webkit-appearance:none;background:var(--line);border-radius:4px;outline:none}
  .setting-group input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:22px;height:22px;background:var(--primary);border-radius:50%;cursor:pointer}
  .setting-value{float:left;font-weight:700;color:var(--primary-2);font-size:14px;margin-top:4px}
  .scan-preview{background:var(--card);border-radius:18px;padding:20px;text-align:center;overflow:auto;max-height:550px;border:1px solid var(--line);margin-bottom:16px;box-shadow:var(--shadow)}
  .scan-preview canvas{max-width:100%;border-radius:12px;box-shadow:var(--shadow)}
  .scan-toolbar{display:flex;gap:10px;flex-wrap:wrap;justify-content:center}
  .pdf-toolbar{display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-top:10px}
  .pdf-toolbar .btn{flex:0 0 auto}
  .org-field-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}
  .org-field{display:flex;flex-direction:column;gap:4px}
  .org-field label{font-size:12.5px;font-weight:700;color:var(--muted)}
  .org-field input,.org-field select{padding:8px 10px;border:1px solid #ddd;border-radius:8px;font-family:inherit;background:#fffdf5}
  [data-theme="dark"] .org-field input,[data-theme="dark"] .org-field select{background:#1a2437;border-color:#334155;color:#f1f5f9}
  #org-stat-table input,#org-staff-table input,#org-staff-table select,#org-hours-table input{width:100%;box-sizing:border-box;padding:5px 4px;border:1px solid #e2e8f0;border-radius:4px;text-align:center;font-family:inherit}
  #org-stat-table td,#org-staff-table td,#org-hours-table td{white-space:nowrap}

  /* ---- چاپ فرم سازمان عملی: خط‌کشی مشکی و مقیاس مناسب کاغذ ---- */
  @media print{
    body *{visibility:hidden}
    #tab-orgform, #tab-orgform *{visibility:visible}
    #tab-orgform{position:absolute;top:0;right:0;left:0;width:100%}
    .top-nav, .tabs, .subtabs, .row button, #btn-org-save, #btn-org-form, #btn-org-staff-addrow, #btn-org-hours-addrow, .org-row-del-cell{display:none!important}
    @page{size:landscape;margin:8mm}
    #org-stat-table, #org-staff-table, #org-hours-table, #org-special-table{font-size:9px;border-collapse:collapse!important}
    #org-stat-table th, #org-stat-table td, #org-staff-table th, #org-staff-table td, #org-hours-table th, #org-hours-table td, #org-special-table td{border:1px solid #000!important;padding:2px 3px!important}
    .xls-scroll{overflow:visible!important}
    #org-stat-table input,#org-staff-table input,#org-hours-table input,#org-special-table input{border:none!important;font-size:9px!important;padding:0!important}
  }
  
  /* ---- کاهش حجم ---- */
  .resize-options{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:16px;margin-bottom:16px}
  .resize-group{background:var(--card);border-radius:16px;padding:18px;border:1px solid var(--line);box-shadow:var(--shadow)}
  .resize-group label{display:block;font-weight:700;margin-bottom:12px;font-size:14px;color:var(--text)}
  .size-inputs{display:flex;gap:12px;margin-bottom:10px}
  .input-with-label{display:flex;align-items:center;gap:6px}
  .input-with-label input{width:100px;padding:8px 10px;border:1px solid #e2e8f0;border-radius:8px}
  .input-with-label input:focus{border-color:var(--primary-2);outline:none}
  .checkbox-label{display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;font-weight:normal}
  .quality-display{display:flex;justify-content:space-between;align-items:center;margin-top:8px}
  #quality-percent{font-weight:700;color:var(--primary-2);font-size:18px}
  .format-options{display:flex;gap:8px}
  .format-btn{padding:10px 22px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--text);cursor:pointer;font-weight:700;font-size:13px;transition:all .15s ease}
  .format-btn:hover{background:var(--soft)}
  .format-btn.active{background:var(--primary);color:#fff;border-color:var(--primary)}
  .size-options{display:flex;flex-wrap:wrap;gap:12px}
  .size-option{display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px}
  .size-option input[type=radio]{width:auto;cursor:pointer}
  .resize-preview{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin-bottom:16px}
  .resize-item{position:relative;background:var(--card);border-radius:14px;padding:10px;border:1px solid var(--line);text-align:center;transition:transform .15s ease;box-shadow:var(--shadow)}
  .resize-item:hover{transform:translateY(-3px)}
  .resize-item img{max-width:100%;max-height:120px;border-radius:10px}
  .resize-item .size-info{font-size:11px;color:var(--muted);margin-top:8px}
  .resize-item .remove-btn{position:absolute;top:6px;left:6px;background:var(--danger);color:#fff;border:none;border-radius:50%;width:26px;height:26px;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center}
  .resize-toolbar{display:flex;gap:10px;flex-wrap:wrap;justify-content:center}
  
  /* ===== Crop - با پشتیبانی از لمس برای گوشی ===== */
  .crop-area{background:#1e293b;border-radius:12px;padding:16px;margin:16px 0;display:flex;justify-content:center;overflow:hidden}
  #crop-wrapper{position:relative;display:inline-block;max-width:100%}
  #crop-img{display:block}
  #crop-box{position:absolute;border:2px dashed #fff;box-shadow:0 0 0 9999px rgba(0,0,0,.5);cursor:move;top:0;left:0}
  
  /* دسته‌های برش - بزرگ برای گوشی */
  .crop-handle{
    position:absolute;
    width:20px;
    height:20px;
    background:#fff;
    border:2.5px solid #1e293b;
    border-radius:50%;
    z-index:10;
    touch-action:none;
    box-shadow:0 2px 8px rgba(0,0,0,0.3);
  }
  .crop-handle:active{transform:scale(1.2);background:#e0f2fe}
  .crop-nw{top:-8px;left:-8px;cursor:nw-resize}
  .crop-n{top:-8px;left:50%;transform:translateX(-50%);cursor:n-resize}
  .crop-ne{top:-8px;right:-8px;cursor:ne-resize}
  .crop-w{top:50%;left:-8px;transform:translateY(-50%);cursor:w-resize}
  .crop-e{top:50%;right:-8px;transform:translateY(-50%);cursor:e-resize}
  .crop-sw{bottom:-8px;left:-8px;cursor:sw-resize}
  .crop-s{bottom:-8px;left:50%;transform:translateX(-50%);cursor:s-resize}
  .crop-se{bottom:-8px;right:-8px;cursor:se-resize}
  
  /* بزرگتر برای گوشی‌های کوچک */
  @media (max-width:600px){
    .crop-handle{width:28px;height:28px;border-width:3px}
    .crop-nw{top:-12px;left:-12px}
    .crop-n{top:-12px;left:50%;transform:translateX(-50%)}
    .crop-ne{top:-12px;right:-12px}
    .crop-w{top:50%;left:-12px;transform:translateY(-50%)}
    .crop-e{top:50%;right:-12px;transform:translateY(-50%)}
    .crop-sw{bottom:-12px;left:-12px}
    .crop-s{bottom:-12px;left:50%;transform:translateX(-50%)}
    .crop-se{bottom:-12px;right:-12px}
  }
  
  .crop-options{margin-bottom:12px}
  .crop-ratios{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .crop-ratios span{font-weight:600;font-size:14px}
  .ratio-btn{padding:6px 14px;border:2px solid #e2e8f0;border-radius:6px;background:#fff;cursor:pointer;font-size:13px}
  .ratio-btn:hover{border-color:var(--primary-2)}
  .ratio-btn.active{background:var(--primary);color:#fff;border-color:var(--primary)}
  .crop-actions{display:flex;gap:10px;flex-wrap:wrap;justify-content:center}
  
  /* ---- برنامه هفتگی (نسخه‌ی پیشرفته: نوار رنگی کنار هر روز، تایپوگرافی بهتر، هایلایت امروز) ---- */
  .schedule-table-wrap{overflow-x:auto;border-radius:18px;background:#fff;margin-bottom:16px;box-shadow:0 10px 30px rgba(15,23,42,.10),0 2px 8px rgba(15,23,42,.06);border:2px solid #000}
  [data-theme="dark"] .schedule-table-wrap{background:#1e293b;border-color:#000;box-shadow:0 10px 30px rgba(0,0,0,.35)}
  .schedule-table{width:100%;min-width:760px;border-collapse:separate;border-spacing:0}
  .schedule-table th{padding:16px 10px;font-weight:800;text-align:center;font-size:14px;letter-spacing:.2px;border-bottom:2px solid #000}
  [data-theme="dark"] .schedule-table th{border-color:#000}
  .schedule-table th.sch-corner{background:#fff;color:#1e293b;border:1px solid #e2e8f0;border-radius:18px 0 0 0}
  [data-theme="dark"] .schedule-table th.sch-corner{background:linear-gradient(135deg,#0f172a,#1e293b);color:#fff}
  .schedule-table th.sch-period{background:#f1f5f9;color:#334155;border-left:2px solid #000}
  [data-theme="dark"] .schedule-table th.sch-period{background:#0f172a;color:#e2e8f0;border-color:#000}
  .schedule-table th.sch-period:last-child{border-radius:0 18px 0 0;border-left:none}
  .schedule-table td{padding:12px 8px;text-align:center;font-weight:600;color:#1e293b;border-bottom:2px solid #000;border-left:2px solid #000}
  [data-theme="dark"] .schedule-table td{color:#f1f5f9;border-color:#000}
  .schedule-table tr:last-child td{border-bottom:none}
  .schedule-table tr:last-child td:first-child{border-radius:0 0 0 18px}
  .schedule-table tr:last-child td:last-child{border-radius:0 0 18px 0}
  .schedule-table td:first-child{font-weight:800;text-align:center;font-size:14px;border-left:none;position:relative;padding-right:16px}
  .sch-day-accent{position:absolute;top:8px;bottom:8px;right:2px;width:4px;border-radius:4px}
  .schedule-table td.sch-daylabel-shanbe .sch-day-accent{background:#ef4444}
  .schedule-table td.sch-daylabel-yekshanbe .sch-day-accent{background:#f59e0b}
  .schedule-table td.sch-daylabel-doshshanbe .sch-day-accent{background:#10b981}
  .schedule-table td.sch-daylabel-seshshanbe .sch-day-accent{background:#8b5cf6}
  .schedule-table td.sch-daylabel-chaharshanbe .sch-day-accent{background:#06b6d4}
  /* رنگ پیش‌فرض ردیف‌های روز حذف شد — کاربر خودش با نقطه‌های رنگی رنگ هر ردیف را انتخاب می‌کند */
  .row-color-picker{display:inline-flex;gap:3px;vertical-align:middle;margin-inline-start:6px}
  .row-color-dot{width:13px;height:13px;border-radius:50%;border:1px solid rgba(0,0,0,.25);cursor:pointer;display:inline-block;padding:0;box-sizing:border-box}
  .row-color-dot:hover{transform:scale(1.25)}
  .row-color-dot.active{border:2px solid #1e293b;box-shadow:0 0 0 1px #fff inset}
  .row-color-dot[data-color="pink"]{background:#fbcfe8}
  .row-color-dot[data-color="blue"]{background:#bfdbfe}
  .row-color-dot[data-color="red"]{background:#fecaca}
  .row-color-dot[data-color="yellow"]{background:#fef08a}
  .row-color-dot[data-color="orange"]{background:#fed7aa}
  .row-color-dot[data-color="green"]{background:#bbf7d0}
  .row-color-dot[data-color="none"]{background:#fff;position:relative}
  .row-color-dot[data-color="none"]::after{content:'';position:absolute;inset:2px;border-top:1.5px solid #ef4444;transform:rotate(45deg)}

  /* ---- سوییچ تم برنامهٔ هفتگی ---- */
  .sch-theme-btn{opacity:.6;transition:opacity .15s,transform .15s}
  .sch-theme-btn.active{opacity:1;transform:scale(1.05);box-shadow:0 2px 8px rgba(0,0,0,.15)}

  /* تم پسرانه: آبی/فیروزه‌ای */
  #schedule-table-wrap.theme-boy .schedule-table th.sch-corner{background:linear-gradient(135deg,#1e3a8a,#2563eb)}
  #schedule-table-wrap.theme-boy .schedule-table th.sch-period{background:#eff6ff;color:#1e3a8a}
  [data-theme="dark"] #schedule-table-wrap.theme-boy .schedule-table th.sch-period{background:#0f1f3d;color:#bfdbfe}
  #schedule-table-wrap.theme-boy .sch-day-accent{background:#2563eb!important}
  #schedule-table-wrap.theme-boy td.cell-shanbe{background:#dbeafe}
  #schedule-table-wrap.theme-boy td.cell-yekshanbe{background:#e0f2fe}
  #schedule-table-wrap.theme-boy td.cell-doshshanbe{background:#cffafe}
  #schedule-table-wrap.theme-boy td.cell-seshshanbe{background:#e0e7ff}
  #schedule-table-wrap.theme-boy td.cell-chaharshanbe{background:#dbeafe}
  [data-theme="dark"] #schedule-table-wrap.theme-boy td.cell-shanbe,[data-theme="dark"] #schedule-table-wrap.theme-boy td.cell-yekshanbe,[data-theme="dark"] #schedule-table-wrap.theme-boy td.cell-doshshanbe,[data-theme="dark"] #schedule-table-wrap.theme-boy td.cell-seshshanbe,[data-theme="dark"] #schedule-table-wrap.theme-boy td.cell-chaharshanbe{background:#132743}

  /* تم دخترانه: صورتی/بنفش */
  #schedule-table-wrap.theme-girl .schedule-table th.sch-corner{background:linear-gradient(135deg,#9d174d,#db2777)}
  #schedule-table-wrap.theme-girl .schedule-table th.sch-period{background:#fdf2f8;color:#9d174d}
  [data-theme="dark"] #schedule-table-wrap.theme-girl .schedule-table th.sch-period{background:#3d0f27;color:#fbcfe8}
  #schedule-table-wrap.theme-girl .sch-day-accent{background:#db2777!important}
  #schedule-table-wrap.theme-girl td.cell-shanbe{background:#fce7f3}
  #schedule-table-wrap.theme-girl td.cell-yekshanbe{background:#fdf2f8}
  #schedule-table-wrap.theme-girl td.cell-doshshanbe{background:#fae8ff}
  #schedule-table-wrap.theme-girl td.cell-seshshanbe{background:#f3e8ff}
  #schedule-table-wrap.theme-girl td.cell-chaharshanbe{background:#ffe4e6}
  [data-theme="dark"] #schedule-table-wrap.theme-girl td.cell-shanbe,[data-theme="dark"] #schedule-table-wrap.theme-girl td.cell-yekshanbe,[data-theme="dark"] #schedule-table-wrap.theme-girl td.cell-doshshanbe,[data-theme="dark"] #schedule-table-wrap.theme-girl td.cell-seshshanbe,[data-theme="dark"] #schedule-table-wrap.theme-girl td.cell-chaharshanbe{background:#3d1730}

  /* ===== تم پاستلی کودکانه (الهام‌گرفته از برنامه هفتگی رنگی با ساعت/کتاب/شکلک‌ها) ===== */
  #schedule-table-wrap.theme-colorful{border-radius:22px}
  #schedule-table-wrap.theme-colorful .schedule-table th.sch-corner{background:#fecdd3;color:#9f1239}
  [data-theme="dark"] #schedule-table-wrap.theme-colorful .schedule-table th.sch-corner{background:#4c0519;color:#fecdd3}
  #schedule-table-wrap.theme-colorful .schedule-table th.sch-period:nth-child(2){background:#fbcfe8;color:#9d174d}
  #schedule-table-wrap.theme-colorful .schedule-table th.sch-period:nth-child(3){background:#fed7aa;color:#9a3412}
  #schedule-table-wrap.theme-colorful .schedule-table th.sch-period:nth-child(4){background:#bfdbfe;color:#1e3a8a}
  #schedule-table-wrap.theme-colorful .schedule-table th.sch-period:nth-child(5){background:#bbf7d0;color:#14532d}
  #schedule-table-wrap.theme-colorful .schedule-table th.sch-period:nth-child(6){background:#ddd6fe;color:#5b21b6}
  [data-theme="dark"] #schedule-table-wrap.theme-colorful .schedule-table th.sch-period{color:#f1f5f9}
  [data-theme="dark"] #schedule-table-wrap.theme-colorful .schedule-table th.sch-period:nth-child(2){background:#4a1d34}
  [data-theme="dark"] #schedule-table-wrap.theme-colorful .schedule-table th.sch-period:nth-child(3){background:#4a2c12}
  [data-theme="dark"] #schedule-table-wrap.theme-colorful .schedule-table th.sch-period:nth-child(4){background:#12294a}
  [data-theme="dark"] #schedule-table-wrap.theme-colorful .schedule-table th.sch-period:nth-child(5){background:#0f3a24}
  [data-theme="dark"] #schedule-table-wrap.theme-colorful .schedule-table th.sch-period:nth-child(6){background:#2e1a4a}
  #schedule-table-wrap.theme-colorful td.cell-shanbe{background:#fef7fa}
  #schedule-table-wrap.theme-colorful td.cell-yekshanbe{background:#fffaf3}
  #schedule-table-wrap.theme-colorful td.cell-doshshanbe{background:#f5faff}
  #schedule-table-wrap.theme-colorful td.cell-seshshanbe{background:#f5fdf8}
  #schedule-table-wrap.theme-colorful td.cell-chaharshanbe{background:#f9f7ff}
  [data-theme="dark"] #schedule-table-wrap.theme-colorful td.cell-shanbe,[data-theme="dark"] #schedule-table-wrap.theme-colorful td.cell-yekshanbe,[data-theme="dark"] #schedule-table-wrap.theme-colorful td.cell-doshshanbe,[data-theme="dark"] #schedule-table-wrap.theme-colorful td.cell-seshshanbe,[data-theme="dark"] #schedule-table-wrap.theme-colorful td.cell-chaharshanbe{background:#1e293b}
  .sch-decor-corner{position:relative;text-align:center;font-size:26px;padding:6px 10px;margin-top:-6px;line-height:1}
  .sch-decor-corner.hidden{display:none}
  .sch-decor-left{float:right}
  .sch-decor-right{float:left}
  #schedule-table-wrap::after{content:"";display:block;clear:both}

  .schedule-table tr.sch-today td{box-shadow:inset 0 0 0 2px var(--primary)}
  .schedule-table tr.sch-today td:first-child .sch-today-badge{position:absolute;top:2px;left:6px;font-size:9px;background:var(--primary);color:#fff;padding:1px 7px;border-radius:8px;font-weight:700}
  .schedule-table textarea{background:transparent;border:none;width:100%;min-height:50px;text-align:center;font-family:inherit;font-size:13px;color:inherit;resize:vertical;line-height:1.5}
  .schedule-table textarea:focus{outline:2px solid var(--primary);outline-offset:2px;border-radius:8px}
  .schedule-table textarea::placeholder{color:#94a3b8;font-style:italic}
  
  /* ---- ترجمه ---- */
  .tl-lang-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:16px}
  .tl-lang-row select{padding:9px 10px;border:1px solid #ddd;border-radius:8px;font-family:inherit;font-size:14px;background:#fff}
  [data-theme="dark"] .tl-lang-row select{background:#1e293b;border-color:#475569;color:#e2e8f0}
  .tl-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
  .tl-grid textarea{width:100%;padding:12px;border:1px solid #ddd;border-radius:8px;resize:vertical;font-family:inherit;font-size:14px}
  [data-theme="dark"] .tl-grid textarea{background:#1e293b;border-color:#475569;color:#e2e8f0}
  .tl-grid textarea[readonly]{background:#f8fafc}
  [data-theme="dark"] .tl-grid textarea[readonly]{background:#0f172a}
  @media (max-width:640px){ .tl-grid{grid-template-columns:1fr} }

  /* ---- جدول‌ساز: شبیه اکسل واقعی ---- */
  .xls-wrap{border:1px solid #b7b7b7;border-radius:8px;overflow:hidden;background:#fff;box-shadow:0 2px 10px rgba(0,0,0,.06)}
  [data-theme="dark"] .xls-wrap{background:#1e293b;border-color:#475569}
  .xls-scroll{overflow:auto;max-height:520px}
  .xls-grid{border-collapse:collapse;width:100%;font-family:'Vazirmatn',Tahoma,sans-serif;font-size:13px}
  .xls-grid th, .xls-grid td{border:1px solid #d4d4d4;padding:0;height:32px;min-width:90px}
  [data-theme="dark"] .xls-grid th, [data-theme="dark"] .xls-grid td{border-color:#3f4b5c}
  .xls-colhead{background:#f3f3f3;color:#616161;text-align:center;font-weight:600;font-size:12px;position:sticky;top:0;z-index:3;user-select:none}
  [data-theme="dark"] .xls-colhead{background:#0f172a;color:#94a3b8}
  .xls-corner{background:#f3f3f3;position:sticky;right:0;top:0;z-index:4}
  [data-theme="dark"] .xls-corner{background:#0f172a}
  .xls-rowhead{background:#f3f3f3;color:#616161;text-align:center;font-weight:600;font-size:12px;position:sticky;right:0;z-index:2;min-width:36px;width:36px}
  [data-theme="dark"] .xls-rowhead{background:#0f172a;color:#94a3b8}
  .xls-titlerow th{background:#e8eaf6;padding:0}
  [data-theme="dark"] .xls-titlerow th{background:#312e50}
  .xls-titlerow input{width:100%;height:34px;border:none;background:transparent;text-align:center;font-weight:700;color:#1e293b;padding:0 6px;font-family:inherit;font-size:13px}
  [data-theme="dark"] .xls-titlerow input{color:#e2e8f0}
  .xls-titlerow input:focus{outline:2px solid var(--primary);outline-offset:-2px;background:#fff}
  .xls-grid td input{width:100%;height:32px;border:none;background:transparent;text-align:center;padding:0 6px;font-family:inherit;font-size:13px;color:#1e293b}
  [data-theme="dark"] .xls-grid td input{color:#e2e8f0}
  .xls-grid td input:focus{outline:2px solid var(--primary);outline-offset:-2px;background:#eef2ff;position:relative;z-index:1}
  .xls-grid tbody tr:nth-child(even) td{background:#fafbfc}
  [data-theme="dark"] .xls-grid tbody tr:nth-child(even) td{background:#243044}
  .xls-avgrow td{background:#e2efda !important;font-weight:700;color:#375623;text-align:center}
  [data-theme="dark"] .xls-avgrow td{background:#22381f !important;color:#c8e6c9}
  .xls-avgrow td:first-child{text-align:center}
  
  .ai-chat-container{background:#fff;border-radius:16px;border:1px solid #e5e7eb;overflow:hidden;display:flex;flex-direction:column;height:min(78vh,900px)}
  [data-theme="dark"] .ai-chat-container{background:#212121;border-color:#333}
  .ai-header{display:flex;align-items:center;gap:10px;padding:10px 16px;background:#fff;border-bottom:1px solid #ececec;color:#1f2937}
  [data-theme="dark"] .ai-header{background:#212121;border-color:#2f2f2f;color:#ececec}
  .ai-avatar{width:28px;height:28px;background:#10a37f;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0;color:#fff}
  [data-theme="dark"] .ai-avatar{background:#19c37d}
  .ai-title{flex:1;min-width:0}
  .ai-title h3{margin:0;font-size:14.5px;font-weight:600}
  .ai-status{font-size:11px;opacity:.55}
  .ai-mode-select select{padding:8px 12px;border-radius:8px;border:1px solid #e5e7eb;background:#fff;color:#333;font-size:13px;font-weight:600;cursor:pointer}
  .ai-messages{flex:1;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:22px 16px;display:flex;flex-direction:column;gap:26px;background:#fff}
  [data-theme="dark"] .ai-messages{background:#212121}
  .ai-message{display:flex;gap:0;max-width:768px;width:100%;margin:0 auto}
  .ai-message.user{flex-direction:row-reverse;align-self:center;justify-content:flex-start}
  .ai-message.ai{align-self:center;width:100%}
  .ai-message-avatar{display:none}
  .ai-message-content{background:transparent;border-radius:0;padding:0;box-shadow:none;border:none;min-width:0;flex:1}
  [data-theme="dark"] .ai-message-content{color:#ececec}
  .ai-message.user .ai-message-content{background:#f4f4f5;color:#1f2937;border-radius:20px;padding:10px 16px;flex:0 1 auto;max-width:85%}
  [data-theme="dark"] .ai-message.user .ai-message-content{background:#2f2f2f;color:#ececec}
  .ai-message-text{line-height:1.75;font-size:15.5px;white-space:pre-wrap;user-select:text;word-break:break-word}
  .ai-copy-btn{display:inline-flex;align-items:center;gap:4px;margin-top:8px;padding:3px 9px;font-size:11px;font-weight:600;border-radius:999px;border:1px solid #e5e7eb;background:#fff;color:#6b7280;cursor:pointer;transition:all .15s}
  [data-theme="dark"] .ai-copy-btn{background:#2a2a2a;border-color:#404040;color:#a3a3a3}
  .ai-copy-btn:hover{background:#10a37f;color:#fff;border-color:#10a37f}
  .ai-del-btn{display:inline-flex;align-items:center;gap:4px;margin-top:8px;margin-inline-start:6px;padding:3px 9px;font-size:11px;font-weight:600;border-radius:999px;border:1px solid #fecaca;background:#fff;color:#dc2626;cursor:pointer;transition:all .15s}
  [data-theme="dark"] .ai-del-btn{background:#2a2a2a}
  .ai-del-btn:hover{background:#dc2626;color:#fff;border-color:#dc2626}
  .ai-typing-dots{display:flex;gap:4px;padding:8px 0}
  .ai-typing-dots span{width:7px;height:7px;background:#10a37f;border-radius:50%;animation:typingBounce 1.4s infinite ease-in-out}
  .ai-typing-dots span:nth-child(1){animation-delay:-.32s}
  .ai-typing-dots span:nth-child(2){animation-delay:-.16s}
  @keyframes typingBounce{0%,80%,100%{transform:scale(.6);opacity:.4}40%{transform:scale(1);opacity:1}}
  .ai-input-area{display:flex;gap:8px;padding:14px 16px;padding-bottom:max(14px,env(safe-area-inset-bottom));border-top:1px solid #ececec;background:#fff;align-items:flex-end;max-width:768px;width:100%;margin:0 auto;box-sizing:border-box}
  [data-theme="dark"] .ai-input-area{background:#212121;border-color:#2f2f2f}
  .ai-input-area textarea{flex:1;padding:12px 16px;border:1px solid #e5e7eb;border-radius:24px;resize:none;font-size:16px;line-height:1.4;max-height:120px;font-family:inherit;background:#f4f4f5}
  [data-theme="dark"] .ai-input-area textarea{background:#2f2f2f;border-color:#404040;color:#ececec}
  .ai-input-area textarea:focus{border-color:#10a37f;outline:none;background:#fff}
  [data-theme="dark"] .ai-input-area textarea:focus{background:#2f2f2f}
  .ai-send-btn{width:38px;height:38px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:16px;padding:0;flex-shrink:0}
  #btn-ai-send{background:#10a37f;border-color:#10a37f;color:#fff}
  #btn-ai-send:hover{background:#0d8f6f}
  .ai-attach-preview{display:flex;align-items:center;gap:10px;padding:8px 16px;background:#f8fafc;border-top:1px solid #ececec;animation:clsDrawerOpen .15s ease-out;max-width:768px;width:100%;margin:0 auto;box-sizing:border-box}
  [data-theme="dark"] .ai-attach-preview{background:#2a2a2a;border-color:#2f2f2f}
  .ai-attach-preview span{font-size:12.5px;color:#475569;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  [data-theme="dark"] .ai-attach-preview span{color:#d4d4d4}
  .ai-attach-remove{flex:0 0 auto;width:26px;height:26px;border-radius:50%;border:1px solid #e5e7eb;background:#fff;color:#dc2626;font-size:13px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .15s}
  [data-theme="dark"] .ai-attach-remove{background:#212121;border-color:#404040}
  .ai-attach-remove:hover{background:#dc2626;color:#fff;border-color:#dc2626}
  @media(max-width:640px){
    .ai-chat-container{height:calc(100vh - 165px);min-height:480px;border-radius:12px}
    .ai-header{padding:9px 12px}
    .ai-avatar{width:26px;height:26px;font-size:13px}
    .ai-title h3{font-size:13.5px}
    .ai-messages{padding:16px 10px;gap:20px}
    .ai-message.user .ai-message-content{max-width:92%}
    .ai-input-area{padding:10px}
    .ai-input-area textarea{padding:10px 14px}
  }
  
  .cls-options-drawer{display:flex;flex-direction:column;gap:8px;padding:10px;margin-bottom:12px;background:#f8fafc;border:1px solid var(--line);border-radius:12px;animation:clsDrawerOpen .18s ease-out}
  [data-theme="dark"] .cls-options-drawer{background:#1e293b}
  @keyframes clsDrawerOpen{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:translateY(0)}}
  .cls-opt-btn{width:100%;justify-content:flex-start;text-align:right;padding:11px 14px;font-size:14px}
  .t-cam-pip{position:fixed;bottom:18px;left:18px;width:200px;height:150px;object-fit:cover;border-radius:12px;border:2px solid #fff;box-shadow:0 4px 16px rgba(0,0,0,.4);background:#000;z-index:45}
  .t-cam-oncanvas{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:10px;border:1px solid var(--line);background:#000;z-index:5}
  .t-cam-corner{position:absolute;bottom:10px;left:10px;width:150px;height:112px;object-fit:cover;border-radius:10px;border:2px solid #fff;box-shadow:0 4px 16px rgba(0,0,0,.4);background:#000;z-index:6}
  @media(max-width:640px){
    .cls-wrap{flex-direction:column}
    .t-cam-pip{width:110px;height:82px;bottom:14px;left:10px}
    .t-cam-corner{width:100px;height:75px;bottom:8px;left:8px}
  }

  /* ---- ساخت آزمون (برگه چاپی) ---- */
  #es-print-area{background:#fff;padding:16px;border:1px solid var(--line);border-radius:12px;font-family:'B Nazanin','Tahoma',sans-serif;font-weight:bold;overflow-x:auto;-webkit-overflow-scrolling:touch}
  [data-theme="dark"] #es-print-area{background:#1e293b}
  .es-header-table{width:100%;min-width:640px;border-collapse:collapse;table-layout:fixed}
  .es-header-table td{border:1px solid #000;padding:6px 8px;vertical-align:top}
  .es-header-table input{border:none;background:transparent;width:100%;font-family:inherit;font-weight:bold;font-size:14px;padding:2px 0;color:inherit}
  .es-header-table input:focus{outline:none;background:#fffbe6}
  [data-theme="dark"] .es-header-table input:focus{background:#334155}
  .es-header-table input::placeholder,.es-main-table input::placeholder,.es-main-table textarea::placeholder{color:#64748b;opacity:1;font-weight:normal}
  [data-theme="dark"] .es-header-table input::placeholder,[data-theme="dark"] .es-main-table input::placeholder,[data-theme="dark"] .es-main-table textarea::placeholder{color:#94a3b8}
  .es-header-table td span{font-size:13.5px;font-weight:bold;display:inline-block;margin-left:4px}
  .es-header-table select,.es-main-table select{border:none;background:transparent;font-family:inherit;font-size:13.5px;font-weight:bold;color:inherit;cursor:pointer}
  .es-header-table select:focus,.es-main-table select:focus{outline:none}
  .es-hdr-org input{text-align:center;font-weight:bold}
  .es-blank{border-bottom:1px dotted #000!important}
  #es-print-area{--es-font-size:12pt}
  .es-main-table{width:100%;min-width:640px;border-collapse:collapse;margin-top:6px}
  .es-main-table th,.es-main-table td{border:1px solid #000;padding:8px;vertical-align:top;font-size:var(--es-font-size,12pt)}
  .es-main-table thead th{background:#f1f5f9;color:var(--text);font-weight:bold;text-align:center}
  [data-theme="dark"] .es-main-table thead th{background:#334155}
  .es-col-num{width:56px;text-align:center;font-weight:bold}
  .es-col-mark{width:80px;text-align:center}
  .es-q-cell{position:relative}
  .es-q{width:100%;position:relative;font-family:inherit;font-weight:bold;font-size:var(--es-font-size,12pt);outline:none;white-space:pre-wrap;word-break:break-word}
  .es-q:focus{background:#fffbe6}
  [data-theme="dark"] .es-q:focus{background:#334155}
  .es-q table{border-collapse:collapse;margin:6px 0}
  .es-q table td{border:1px solid #000;padding:8px;min-width:36px;font-size:inherit}
  .es-item{position:absolute;border:1px dashed #cbd5e1;border-radius:8px;padding:6px;background:#fff;box-sizing:border-box;z-index:2}
  [data-theme="dark"] .es-item{border-color:#404040;background:#1e293b}
  .es-item-toolbar{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:5px}
  .es-item-toolbar button{background:#f1f5f9;border:1px solid #e2e8f0;border-radius:5px;color:#334155;cursor:pointer;font-size:10.5px;padding:3px 6px;white-space:nowrap}
  .es-item-toolbar .es-item-del{background:#fee2e2;color:#dc2626;border-color:#fecaca}
  [data-theme="dark"] .es-item-toolbar button{background:#262626;border-color:#404040;color:#a3a3a3}
  [data-theme="dark"] .es-item-toolbar .es-item-del{background:#450a0a;color:#fca5a5;border-color:#7f1d1d}
  .es-item-handle{cursor:move;background:#eef2ff!important;color:#4338ca!important;border-color:#c7d2fe!important;touch-action:none}
  [data-theme="dark"] .es-item-handle{background:#312e81!important;color:#c7d2fe!important;border-color:#4338ca!important}
  .es-item table{width:100%;border-collapse:collapse;margin:0}
  .es-item table td{border:1px solid #000;padding:8px;min-width:24px;font-size:inherit}
  .es-item img{max-width:100%;display:block;border-radius:4px;pointer-events:none}
  .es-answer-space{width:100%;box-sizing:border-box;margin-top:4px;border-top:1px dashed #cbd5e1;position:relative}
  .es-answer-space:before{content:'محل پاسخ';position:absolute;top:2px;right:4px;font-size:9px;font-weight:normal;color:#94a3b8}
  [data-theme="dark"] .es-answer-space{border-color:#404040}
  .es-q-tools{display:flex;gap:4px;align-items:center;flex-wrap:wrap;margin-top:6px}
  .es-q-tools button{background:none;border:1px solid #e2e8f0;border-radius:6px;color:#475569;cursor:pointer;font-size:11px;padding:2px 7px}
  [data-theme="dark"] .es-q-tools button{border-color:#404040;color:#a3a3a3}
  .es-space-ctrl{display:inline-flex;align-items:center;gap:4px;margin-inline-start:6px;font-size:11px;color:#475569}
  [data-theme="dark"] .es-space-ctrl{color:#a3a3a3}
  .es-space-btn{background:none;border:1px solid #e2e8f0;border-radius:6px;color:#475569;cursor:pointer;font-size:11px;padding:2px 7px;line-height:1}
  [data-theme="dark"] .es-space-btn{border-color:#404040;color:#a3a3a3}
  .es-space-val{min-width:24px;text-align:center;display:inline-block;font-weight:bold}
  .es-main-table input.es-mark{width:100%;border:none;text-align:center;font-family:inherit;font-weight:bold;font-size:var(--es-font-size,12pt);background:transparent;color:inherit}
  .es-row-del{width:100%;background:none;border:none;color:#dc2626;cursor:pointer;font-size:15px}
  .es-row-move{width:auto;background:none;border:none;color:#475569;cursor:pointer;font-size:14px;padding:1px 3px}
  [data-theme="dark"] .es-row-move{color:#a3a3a3}
  .es-row-move:disabled{opacity:.3;cursor:default}
  .es-pagefoot{text-align:center;font-weight:bold;margin-top:8px;font-size:14px}
  .es-tbl-wrap{display:inline-block;max-width:100%;width:70%;margin:6px 0;border:1px dashed #cbd5e1;border-radius:8px;padding:6px;vertical-align:top;box-sizing:border-box}
  [data-theme="dark"] .es-tbl-wrap{border-color:#404040}
  .es-tbl-toolbar{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:5px}
  .es-tbl-toolbar button{background:#f1f5f9;border:1px solid #e2e8f0;border-radius:5px;color:#334155;cursor:pointer;font-size:10.5px;padding:3px 6px;white-space:nowrap}
  .es-tbl-toolbar .es-tbl-del{background:#fee2e2;color:#dc2626;border-color:#fecaca}
  [data-theme="dark"] .es-tbl-toolbar button{background:#262626;border-color:#404040;color:#a3a3a3}
  [data-theme="dark"] .es-tbl-toolbar .es-tbl-del{background:#450a0a;color:#fca5a5;border-color:#7f1d1d}
  .es-tbl-wrap table{width:100%;border-collapse:collapse;margin:0}
  .es-tbl-wrap table td{border:1px solid #000;padding:8px;min-width:24px;font-size:inherit}
  @media print{
    body *{visibility:hidden}
    #es-print-area, #es-print-area *{visibility:visible}
    #es-print-area{position:absolute;top:0;right:0;left:0;width:100%;padding:0;border:none;border-radius:0;margin:0}
    .es-main-table tr{page-break-inside:avoid}
    .es-row-move,.es-row-del{display:none!important}
    .es-q,.es-main-table input.es-mark,.es-header-table input,.es-header-table select,.es-main-table select{color:#000!important}
    .es-q-tools{display:none!important}
    .es-answer-space{border-top:none!important}
    .es-answer-space:before{display:none!important}
    .es-tbl-wrap{border:none!important;padding:0!important}
    .es-tbl-toolbar{display:none!important}
    .es-item{border:none!important;padding:0!important}
    .es-item-toolbar{display:none!important}
  }

  /* ---- Timer ---- */
  .exam-timer{background:linear-gradient(135deg,#1a1a2e,#16213e);color:#fff;border-radius:16px;padding:20px;text-align:center;margin-bottom:16px;border:2px solid #0f3460}
  .exam-timer .timer-display{font-size:48px;font-weight:700;font-family:monospace;letter-spacing:4px;color:#00d2ff;text-shadow:0 0 20px rgba(0,210,255,0.3)}
  .exam-timer .timer-label{font-size:14px;color:#94a3b8;margin-top:4px}
  .exam-timer.warning .timer-display{color:#f59e0b;text-shadow:0 0 20px rgba(245,158,11,0.3)}
  .exam-timer.danger .timer-display{color:#ef4444;text-shadow:0 0 20px rgba(239,68,68,0.3);animation:blink 1s ease-in-out infinite}
  @keyframes blink{0%,100%{opacity:1}50%{opacity:0.3}}
  
  /* ---- Exam Time Status ---- */
  .exam-time-status{padding:12px 16px;border-radius:10px;margin-bottom:16px;font-weight:600;display:flex;align-items:center;gap:10px}
  .exam-time-status.valid{background:#dcfce7;color:#166534;border:1px solid #bbf7d0}
  .exam-time-status.invalid{background:#fee2e2;color:#991b1b;border:1px solid #fecaca}
  .exam-time-status.waiting{background:#fef3c7;color:#92400e;border:1px solid #fde68a}
  .exam-time-status .time-icon{font-size:24px}
`;

const FONT_LINK = `<link rel="preconnect" href="https://cdn.jsdelivr.net"><link href="https://cdn.jsdelivr.net/gh/rastikerdar/vazirmatn@v33.003/Vazirmatn-font-face.css" rel="stylesheet"><link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Noto+Nastaliq+Urdu:wght@400..700&display=swap" rel="stylesheet">`;

function pageHeader() {
  return `<div class="header"><h1>${esc(APP_TITLE)}</h1><h2>${esc(APP_DESIGNER)}</h2></div>`;
}

function teacherHeader() {
  return `<div class="header teacher-header">
    <div class="th-topbar">
      <div class="th-clock" id="th-clock">--:--:--</div>
      <div class="th-en-badge">Teacher's Educational Assistant</div>
    </div>
    <h1>${esc(APP_TITLE)}</h1>
    <div class="th-designer">🎨 ${esc(APP_DESIGNER)} <span class="en">Designer: Nader Akshik</span></div>
  </div>`;
}

/* ------------------------- صفحه اصلی ------------------------- */

function landingPage() {
  return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(APP_TITLE)}</title>
  ${FONT_LINK}<style>${SHARED_CSS}</style></head><body><div class="wrap">
  ${pageHeader()}
  <div class="card">
    <p>دانش‌آموز گرامی، برای شرکت در آزمون از <b>لینک اختصاصی</b> که معلم برای شما ارسال کرده استفاده کنید.</p>
    <p class="muted">هر دانش‌آموز یک لینک منحصربه‌فرد دارد.</p>
    <hr style="border:none;border-top:1px solid var(--line);margin:14px 0">
    <a class="btn" href="/teacher">ورود معلم</a>
  </div></div></body></html>`;
}

function notFoundPage() {
  return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">
  ${FONT_LINK}<style>${SHARED_CSS}</style></head><body><div class="wrap">
  ${pageHeader()}<div class="card"><h2>صفحه یافت نشد</h2><a class="btn" href="/">بازگشت</a></div></div></body></html>`;
}

/* ------------------------- صفحه دانش‌آموز ------------------------- */

async function studentPage(env, id) {
  const student = await env.EXAM_KV.get("student:" + id);
  if (!student) {
    return html(
      `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">${FONT_LINK}<style>${SHARED_CSS}</style></head>
      <body><div class="wrap">${pageHeader()}<div class="card"><h2>لینک نامعتبر است</h2>
      <p class="muted">این لینک معتبر نیست یا حذف شده است. لطفاً با معلم خود تماس بگیرید.</p></div></div></body></html>`,
      404
    );
  }

  return html(`<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>آزمون</title>${FONT_LINK}<style>${SHARED_CSS}</style></head>
  <body><div class="wrap">
    ${pageHeader()}
    <div class="card" id="hdr2"></div>

    <!-- مرحله ۰: انتخاب آزمون یا کاربرگ -->
    <div class="card hidden" id="step-choice">
      <h3>👋 خوش آمدید</h3>
      <p class="muted">یکی از گزینه‌های زیر را انتخاب کنید:</p>
      <div class="row" style="gap:14px;flex-wrap:wrap">
        <button class="btn" id="btn-choice-exam" style="flex:1;min-width:200px;padding:22px 16px;font-size:16px">📝 ورود به آزمون</button>
        <button class="btn sec" id="btn-choice-worksheet" style="flex:1;min-width:200px;padding:22px 16px;font-size:16px">📓 ورود به کاربرگ</button>
        <button class="btn sec" id="btn-choice-reportcard" style="flex:1;min-width:200px;padding:22px 16px;font-size:16px">🗓️ مشاهده کارنامه ماهیانه</button>
      </div>
    </div>

    <!-- کارنامه ماهیانه -->
    <div class="card hidden" id="step-reportcard">
      <h3>🗓️ کارنامه ماهیانه</h3>
      <div class="row" style="align-items:center">
        <label style="flex:0 0 auto">ماه:</label>
        <select id="rc-view-month" style="flex:0 0 auto;min-width:140px"></select>
      </div>
      <div id="rc-view-content" style="margin-top:14px"></div>
      <div class="row hidden" id="rc-view-download-row" style="margin-top:10px;flex-wrap:wrap;gap:8px">
        <button class="btn sec sm" id="btn-rc-view-word">📄 دانلود Word</button>
        <button class="btn sec sm" id="btn-rc-view-pdf">🖨️ چاپ / دانلود PDF</button>
      </div>
      <button class="btn sec" id="btn-rc-view-back" style="margin-top:14px">↩️ بازگشت</button>
    </div>

    <!-- مرحله ۱: اطلاعات دانش‌آموز -->
    <div class="card hidden" id="step-info">
      <h3>📝 اطلاعات دانش‌آموز</h3>
      <div class="row">
        <div><label>نام و نام خانوادگی *</label><input id="f-name" autocomplete="off"></div>
        <div><label>نام پدر *</label><input id="f-father" autocomplete="off"></div>
      </div>
      <div class="row">
        <div><label>کد ملی *</label><input id="f-nid" inputmode="numeric" autocomplete="off"></div>
        <div><label>تاریخ آزمون *</label><input id="f-date" autocomplete="off" placeholder="مثال: 1404/01/15"></div>
      </div>
      <p class="muted" id="info-err" style="color:var(--danger)"></p>
      <button class="btn" id="btn-enter">🚀 ورود به آزمون</button>
    </div>

    <!-- مرحله ۲: سوالات با تایمر -->
    <div class="card hidden" id="step-exam">
      <div class="exam-timer" id="timer-container">
        <div class="timer-display" id="timer-display">00:00</div>
        <div class="timer-label">⏱️ زمان باقیمانده</div>
      </div>
      <h3>📝 سوالات آزمون</h3>
      <div id="q-progress" class="muted" style="margin-bottom:10px;font-weight:600"></div>
      <div id="questions"></div>
      <button class="btn sec" id="btn-submit" style="margin-top:16px">✅ ثبت نهایی پاسخنامه</button>
    </div>

    <!-- مرحله ۳: نتیجه -->
    <div class="card hidden" id="step-done"></div>
  </div>
  <div class="toast" id="toast"></div>
  <script>
    const ID = ${JSON.stringify(id)};
    let DATA = null;
    let timerInterval = null;
    let remainingSeconds = 0;
    let isTimerExpired = false;

    function toast(m){const t=document.getElementById('toast');t.textContent=m;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2500);}
    function esc(s){const d=document.createElement('div');d.textContent=s==null?'':s;return d.innerHTML;}
    function typeLabel(t){return {descriptive:'تشریحی',multiple:'چهارگزینه‌ای',truefalse:'صحیح/غلط',short:'کوتاه‌پاسخ'}[t]||t;}
    function qHtml(q){return q.rich?(q.text||''):esc(q.text);}
    function ansText(q,ans){
      if(q.type==='multiple'){const idx=parseInt(ans,10);return isNaN(idx)?'':(['الف','ب','ج','د'][idx]+') '+esc((q.options&&q.options[idx])||''));}
      if(q.type==='truefalse'){return ans==='true'?'صحیح':(ans==='false'?'غلط':'');}
      return esc(ans);
    }

    function formatTime(seconds){
      const m = Math.floor(seconds / 60);
      const s = seconds % 60;
      return String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0');
    }

    function startTimer(seconds){
      remainingSeconds = seconds;
      isTimerExpired = false;
      const display = document.getElementById('timer-display');
      const container = document.getElementById('timer-container');
      
      if(timerInterval) clearInterval(timerInterval);
      
      timerInterval = setInterval(() => {
        remainingSeconds--;
        if(remainingSeconds <= 0){
          clearInterval(timerInterval);
          remainingSeconds = 0;
          isTimerExpired = true;
          container.className = 'exam-timer danger';
          display.textContent = '00:00';
          toast('⏰ زمان آزمون به پایان رسید! پاسخ‌ها به‌طور خودکار ثبت شدند.');
          document.getElementById('btn-submit').disabled = true;
          document.getElementById('btn-submit').textContent = '⏰ زمان تمام شد';
          submitExam(true);
          return;
        }
        
        display.textContent = formatTime(remainingSeconds);
        
        if(remainingSeconds <= 60){
          container.className = 'exam-timer danger';
        } else if(remainingSeconds <= 300){
          container.className = 'exam-timer warning';
        } else {
          container.className = 'exam-timer';
        }
      }, 1000);
    }

    async function load(){
      const r = await fetch('/api/exam/'+encodeURIComponent(ID));
      const d = await r.json();
      
      if(!d.ok){
        document.body.innerHTML = '<div class="wrap"><div class="card" style="text-align:center;padding:40px"><div style="font-size:48px;margin-bottom:16px">❌</div><h2 style="color:var(--danger)">'+esc(d.error)+'</h2><p class="muted">لطفاً با معلم خود تماس بگیرید.</p><a href="/" class="btn" style="margin-top:16px">بازگشت به صفحه اصلی</a></div></div>';
        return;
      }
      
      DATA = d;
      document.getElementById('hdr2').innerHTML = '<h3 style="margin:0">'+esc(d.meta.school || '')+'</h3>';
      
      const headerInfo = document.createElement('div');
      headerInfo.style.cssText = 'padding:12px;background:var(--card);border:1px solid var(--line);border-radius:8px;margin-bottom:16px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px';
      headerInfo.innerHTML = '<span><b>📝</b> '+esc(d.meta.examName || 'آزمون')+'</span><span><b>👨‍🏫</b> '+esc(d.meta.teacher || '')+'</span><span><b>⏱️</b> '+esc(d.meta.examDuration || '30')+' دقیقه</span>';
      document.getElementById('hdr2').after(headerInfo);
      
      if (d.submitted) {
        if(d.isExpired){
          toast('⏰ زمان آزمون به پایان رسیده است');
        }
      }

      document.getElementById('step-choice').classList.remove('hidden');
      document.getElementById('btn-choice-exam').onclick=function(){
        document.getElementById('step-choice').classList.add('hidden');
        if (d.submitted) {
          renderResult(d.result);
        } else {
          document.getElementById('step-info').classList.remove('hidden');
          try {
            const now = new Date();
            document.getElementById('f-date').value = now.toLocaleDateString('fa-IR', {year:'numeric', month:'2-digit', day:'2-digit'}).replace(/\\//g, '/');
          } catch(e) {}
        }
      };
      document.getElementById('btn-choice-worksheet').onclick=function(){
        location.href = '/w/' + encodeURIComponent(ID);
      };
      document.getElementById('btn-choice-reportcard').onclick=async function(){
        document.getElementById('step-choice').classList.add('hidden');
        document.getElementById('step-reportcard').classList.remove('hidden');
        await loadReportCardMonths();
      };
      document.getElementById('btn-rc-view-back').onclick=function(){
        document.getElementById('step-reportcard').classList.add('hidden');
        document.getElementById('step-choice').classList.remove('hidden');
      };
    }

    // ===== مشاهده‌ی کارنامه‌ی ماهیانه توسط دانش‌آموز =====
    const RC_MONTHS=['مهر','آبان','آذر','دی','بهمن','اسفند','فروردین','اردیبهشت'];
    const RC_LEVEL_LABELS={excellent:'خیلی خوب',good:'خوب',acceptable:'قابل‌قبول','needs-improve':'نیاز به تلاش'};
    const RC_FONTS={default:'',titr:"'B Titr','BTitr',Tahoma,Arial",nazanin:"'B Nazanin','BNazanin',Tahoma,Arial"};
    function rcFontFaceCss(fontFamily){
      var css='';
      if(fontFamily&&fontFamily.indexOf('Titr')!==-1)css+='@font-face{font-family:"BTitr";src:url(https://cdn.jsdelivr.net/gh/intuxicated/css-persian@master/fonts/BTitrBold.ttf)}';
      if(fontFamily&&fontFamily.indexOf('Nazanin')!==-1)css+='@font-face{font-family:"BNazanin";src:url(https://cdn.jsdelivr.net/gh/intuxicated/css-persian@master/fonts/BNazanin.ttf)}';
      return css;
    }
    let RC_MONTHS_DATA={};
    let RC_CURRENT_MONTH='';
    async function loadReportCardMonths(){
      const sel=document.getElementById('rc-view-month');
      sel.innerHTML='<option value="">در حال بارگذاری...</option>';
      document.getElementById('rc-view-content').innerHTML='';
      document.getElementById('rc-view-download-row').classList.add('hidden');
      try{
        const res=await fetch('/api/student/reportcard/'+encodeURIComponent(ID));
        const j=await res.json();
        RC_MONTHS_DATA=(j&&j.months)||{};
      }catch(e){ RC_MONTHS_DATA={}; }
      const available=RC_MONTHS.filter(function(m){return RC_MONTHS_DATA[m];});
      sel.innerHTML='';
      if(!available.length){
        sel.innerHTML='<option value="">هنوز کارنامه‌ای ثبت نشده</option>';
        document.getElementById('rc-view-content').innerHTML='<p class="muted">هنوز کارنامه‌ای برای شما ثبت نشده است.</p>';
        return;
      }
      available.forEach(function(m){
        const opt=document.createElement('option');
        opt.value=m; opt.textContent=m;
        sel.appendChild(opt);
      });
      const lastMonth=available[available.length-1];
      sel.value=lastMonth;
      renderReportCardMonth(lastMonth);
    }
    document.getElementById('rc-view-month').addEventListener('change',function(){
      if(this.value)renderReportCardMonth(this.value);
    });
    function renderReportCardMonth(month){
      const rec=RC_MONTHS_DATA[month];
      const el=document.getElementById('rc-view-content');
      const downloadRow=document.getElementById('rc-view-download-row');
      if(!rec){ el.innerHTML='<p class="muted">اطلاعاتی برای این ماه ثبت نشده.</p>'; downloadRow.classList.add('hidden'); return; }
      RC_CURRENT_MONTH=month;
      const photoHtml=rec.photo
        ? '<img src="'+rec.photo+'" style="width:62px;height:80px;object-fit:cover;border-radius:6px;border:1px solid #cbd5e1;background:#fff;display:block">'
        : '<div style="width:62px;height:80px;border:1.5px dashed #d6c67a;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:9px;color:#a68a1f;text-align:center;background:#fffdf5;box-sizing:border-box">بدون عکس</div>';
      let h='<div style="background:#fefce8;border:2px solid #eab308;border-radius:10px;padding:14px;display:flex;align-items:flex-start;gap:14px;flex-wrap:wrap;margin-bottom:12px">';
      h+='<div style="flex:0 0 auto">'+photoHtml+'</div>';
      h+='<div style="flex:1;min-width:200px">';
      h+='<p><b>نام مدرسه:</b> '+esc((rec.meta&&rec.meta.school)||'—')+'</p>';
      h+='<p><b>نام آموزگار:</b> '+esc((rec.meta&&rec.meta.teacher)||'—')+'</p>';
      h+='<p><b>سال تحصیلی:</b> '+esc((rec.meta&&rec.meta.year)||'—')+'</p>';
      h+='<p><b>نام دانش‌آموز:</b> '+esc(rec.name||'—')+'</p>';
      h+='<p><b>تعداد غیبت:</b> '+esc(rec.absence||'۰')+' روز</p>';
      h+='</div></div>';
      h+='<table style="width:100%;border-collapse:collapse;margin-top:10px"><tr><th style="border:1px solid #ccc;padding:6px;background:#f1f5f9">درس</th><th style="border:1px solid #ccc;padding:6px;background:#f1f5f9">ارزشیابی</th><th style="border:1px solid #ccc;padding:6px;background:#f1f5f9">توضیح</th></tr>';
      const data=rec.data||{};
      Object.keys(data).forEach(function(subj){
        const d=data[subj]||{};
        h+='<tr><td style="border:1px solid #ccc;padding:6px">'+esc(subj)+'</td><td style="border:1px solid #ccc;padding:6px;text-align:center">'+rcViewLevelBadgeHtml(d.level)+'</td><td style="border:1px solid #ccc;padding:6px">'+esc(d.note||'')+'</td></tr>';
      });
      h+='</table>';
      if(rec.generalNote)h+='<p style="margin-top:10px"><b>توضیحات کلی معلم:</b><br>'+esc(rec.generalNote)+'</p>';
      el.innerHTML=h;
      downloadRow.classList.remove('hidden');
    }
    const RC_VIEW_LEVEL_COLORS={excellent:{bg:'#dcfce7',color:'#166534'},good:{bg:'#dbeafe',color:'#1e40af'},acceptable:{bg:'#fef3c7',color:'#92400e'},'needs-improve':{bg:'#fee2e2',color:'#991b1b'}};
    function rcViewLevelBadgeHtml(level){
      if(!level)return '<span style="display:inline-block;padding:3px 12px;border-radius:20px;font-size:12px;font-weight:700;background:#f1f5f9;color:#64748b">—</span>';
      const c=RC_VIEW_LEVEL_COLORS[level]||{bg:'#f1f5f9',color:'#64748b'};
      return '<span style="display:inline-block;padding:3px 12px;border-radius:20px;font-size:12px;font-weight:700;background:'+c.bg+';color:'+c.color+'">'+esc(RC_LEVEL_LABELS[level]||'—')+'</span>';
    }
    function rcViewFontFamily(){
      const rec=RC_MONTHS_DATA[RC_CURRENT_MONTH];
      return (rec&&RC_FONTS[rec.font])||undefined;
    }
    document.getElementById('btn-rc-view-word').onclick=function(){
      const rec=RC_MONTHS_DATA[RC_CURRENT_MONTH];
      if(!rec)return;
      const bodyHtml=document.getElementById('rc-view-content').innerHTML;
      const title='کارنامه‌ی توصیفی - ماه '+RC_CURRENT_MONTH;
      const ff=rcViewFontFamily()||'tahoma,Arial';
      const style='<style>'+rcFontFaceCss(ff)+'@page Section1 {size:21cm 29.7cm;margin:1.5cm} div.Section1{page:Section1} body{direction:rtl;font-family:'+ff+';padding:6px}h1,h2,h3{text-align:center}table{width:100%;border-collapse:collapse;margin:10px 0}th,td{border:1px solid #333;padding:6px;text-align:center;font-size:12px;font-family:'+ff+'}th{background:#dbeafe}</style>';
      const blob=new Blob(['<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8">'+style+'<title>'+esc(title)+'</title></head><body><div class="Section1"><h2>'+esc(title)+'</h2>'+bodyHtml+'</div></body></html>'],{type:'application/msword'});
      const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='کارنامه-'+RC_CURRENT_MONTH+'.doc';document.body.appendChild(a);a.click();a.remove();
    };
    document.getElementById('btn-rc-view-pdf').onclick=function(){
      const rec=RC_MONTHS_DATA[RC_CURRENT_MONTH];
      if(!rec)return;
      const bodyHtml=document.getElementById('rc-view-content').innerHTML;
      const title='کارنامه‌ی توصیفی - ماه '+RC_CURRENT_MONTH;
      const ff=rcViewFontFamily()||'tahoma,Arial';
      const style='<style>'+rcFontFaceCss(ff)+'@page{size:A4 portrait;margin:10mm}body{direction:rtl;font-family:'+ff+';padding:6px}h1,h2,h3{text-align:center}table{width:100%;border-collapse:collapse;margin:8px 0}th,td{border:1px solid #333;padding:6px;text-align:center;font-size:12px;font-family:'+ff+'}th{background:#dbeafe}</style>';
      const w=window.open('','_blank');
      if(!w){toast('اجازه‌ی باز کردن پنجره‌ی چاپ داده نشد (popup blocked)');return;}
      w.document.write('<html><head><meta charset="utf-8">'+style+'<title>'+esc(title)+'</title></head><body><h2>'+esc(title)+'</h2>'+bodyHtml+'</body></html>');
      w.document.close();
      setTimeout(function(){w.print();},500);
    };

    function renderResult(res){
      document.getElementById('step-exam').classList.add('hidden');
      const done=document.getElementById('step-done');
      done.classList.remove('hidden');
      
      if(!res.grading || !res.grading.graded){
        done.innerHTML = \`
          <div class="result-card">
            <div style="text-align:center;font-size:48px;margin-bottom:12px">✅</div>
            <h2 style="text-align:center;color:var(--primary)">پاسخنامه‌ی شما با موفقیت ثبت شد</h2>
            <p class="muted" style="text-align:center">پاسخ‌های شما برای معلم ارسال شد. نتیجه‌ی آزمون پس از تصحیح توسط معلم، در این صفحه نمایش داده می‌شود.</p>
          </div>
        \`;
        return;
      }
      
      const g=res.grading;
      const isNumeric = g.marks && Object.values(g.marks).some(v => !isNaN(parseFloat(v)));
      
      const statusIcons = {
        excellent: '🌟',
        good: '✅',
        acceptable: '📌',
        'needs-improve': '📖',
        correct: '✅',
        wrong: '❌',
        partial: '⚠️'
      };
      
      // تغییر: «عالی» به «خیلی خوب»
      const statusLabels = {
        excellent: 'خیلی خوب',
        good: 'خوب',
        acceptable: 'قابل‌قبول',
        'needs-improve': 'نیاز به تلاش',
        correct: 'صحیح',
        wrong: 'غلط',
        partial: 'نیمه‌درست'
      };
      
      // محاسبه نمره کل از 20
      let totalWeight = 0;
      res.questions.forEach(q => {
        totalWeight += (q.weight || 1);
      });
      
      // اگر وزن‌ها جمعش 20 نشده، نرمالایز میکنیم
      const totalWeightNormalized = totalWeight || 20;
      
      let rows = res.questions.map((q, i) => {
        const ans = res.answers[q.id];
        const mark = g.marks[q.id] || '';
        const fb = g.feedback[q.id] || '';
        const weight = q.weight || 1;
        
        let resultCell;
        if(isNumeric){
          const score = parseFloat(mark);
          const scoreText = isNaN(score) ? '—' : score.toFixed(1);
          // نمره از 20 بر اساس وزن سوال
          const maxScore = (weight / totalWeightNormalized) * 20;
          resultCell = \`
            <div style="display:flex;flex-direction:column;align-items:center;gap:4px">
              <span class="mark numeric">\${scoreText} از \${maxScore.toFixed(1)}</span>
            </div>
          \`;
        } else {
          const statusClass = mark || '';
          const icon = statusIcons[mark] || '';
          const label = statusLabels[mark] || mark || '—';
          resultCell = \`<span class="status-badge \${statusClass}">\${icon} \${label}</span>\`;
        }
        
        return \`<tr>
          <td>\${i + 1}</td>
          <td>\${qHtml(q)}\${q.image ? '<br><img src="'+q.image+'" class="imgprev" style="max-width:'+(q.imageWidth||320)+'px;width:100%">' : ''}</td>
          <td>\${ansText(q, ans) || '<i>بدون پاسخ</i>'}</td>
          <td>\${resultCell}</td>
          <td>\${esc(fb) || '—'}</td>
        </tr>\`;
      }).join('');
      
      let totalScore = '';
      if(isNumeric){
        let total = 0;
        res.questions.forEach(q => {
          const score = parseFloat(g.marks[q.id] || 0);
          if (!isNaN(score)) total += score;
        });
        // نمره کل از 20
        const finalScore = Math.min(20, Math.max(0, total));
        const percent = Math.round((finalScore / 20) * 100);
        let gradeIcon = '🌟';
        if(percent >= 80) { gradeIcon = '🌟'; }
        else if(percent >= 60) { gradeIcon = '✅'; }
        else if(percent >= 40) { gradeIcon = '📌'; }
        else { gradeIcon = '📖'; }
        
        totalScore = \`
          <div class="total-score">
            \${gradeIcon} <b>نمره کل: \${finalScore.toFixed(1)} از 20</b> 
            <span style="font-size:14px;font-weight:400;color:var(--muted)">(\${percent}٪)</span>
          </div>
        \`;
      }
      
      done.innerHTML = \`
        <div class="result-card">
          <h2 style="text-align:center;color:var(--primary);margin-bottom:8px">📝 نتیجه آزمون</h2>
          \${totalScore}
          <div style="display:flex;flex-wrap:wrap;gap:8px;padding:12px;background:var(--bg);border-radius:10px;margin-bottom:16px">
            <span><b>👤 نام:</b> \${esc(res.student.name)}</span>
            <span><b>📚 درس:</b> \${esc(res.student.courseName || '')}</span>
            <span><b>📅 تاریخ:</b> \${esc(res.student.examDate || '')}</span>
            <span><b>👨‍👦 نام پدر:</b> \${esc(res.student.fatherName || '')}</span>
          </div>
          <div style="overflow-x:auto">
            <table class="result-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>سوال</th>
                  <th>پاسخ شما</th>
                  <th>نمره</th>
                  <th>بازخورد</th>
                </tr>
              </thead>
              <tbody>\${rows}</tbody>
            </table>
          </div>
          \${g.overall ? \`
            <div style="margin-top:16px;padding:16px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px">
              <b>💬 بازخورد کلی معلم:</b>
              <p style="margin-top:8px;font-size:15px;line-height:1.8">\${esc(g.overall)}</p>
            </div>
          \` : ''}
        </div>
      \`;
    }

    function renderQuestions(){
      const box=document.getElementById('questions');
      if(!DATA.questions.length){box.innerHTML='<p class="muted">هنوز سوالی توسط معلم طراحی نشده است.</p>';document.getElementById('btn-submit').classList.add('hidden');return;}
      box.innerHTML = DATA.questions.map((q,i)=>{
        let body='';
        if(q.type==='multiple'){
          body=(q.options||[]).map((o,oi)=>'<div class="opt-row"><label style="font-weight:400;margin:0"><input type="radio" name="q_'+q.id+'" value="'+oi+'" style="width:auto;margin-left:6px"> '+['الف','ب','ج','د'][oi]+') '+esc(o)+'</label></div>').join('');
        }else if(q.type==='truefalse'){
          body='<div class="opt-row"><label style="font-weight:400;margin:0"><input type="radio" name="q_'+q.id+'" value="true" style="width:auto;margin-left:6px"> ✅ صحیح</label>&nbsp;&nbsp;<label style="font-weight:400;margin:0"><input type="radio" name="q_'+q.id+'" value="false" style="width:auto;margin-left:6px"> ❌ غلط</label></div>';
        }else if(q.type==='short'){
          body='<input type="text" data-q="'+q.id+'" autocomplete="off" placeholder="پاسخ خود را وارد کنید...">';
        }else{
          body='<textarea data-q="'+q.id+'" placeholder="پاسخ خود را بنویسید..."></textarea>'+
            '<div style="margin-top:8px">'+
            '<label class="btn sm secondary" style="display:inline-block;cursor:pointer" for="photo_'+q.id+'">📷 یا عکس پاسخ خود را بارگذاری کنید</label>'+
            '<input type="file" accept="image/*" id="photo_'+q.id+'" data-qphoto="'+q.id+'" class="hidden">'+
            '<span class="muted" id="photostatus_'+q.id+'" style="margin-right:8px"></span>'+
            '<div id="photopreview_'+q.id+'" style="margin-top:8px"></div>'+
            '</div>';
        }
        const img=q.image?'<div><img src="'+q.image+'" class="imgprev" style="max-width:'+(q.imageWidth||320)+'px;width:100%;cursor:zoom-in" onclick="window.open(this.src)" title="برای بزرگ‌نمایی کلیک کنید"><div class="muted" style="font-size:11px;margin-top:2px">🔍 برای بزرگ‌نمایی روی عکس کلیک کنید</div></div>':'';
        const weightInfo = q.weight ? \`<span style="font-size:11px;color:#64748b;margin-right:8px">(وزن: \${q.weight})</span>\` : '';
        const isLast=i===DATA.questions.length-1;
        const nextBtn=isLast?'':'<div style="margin-top:14px"><button type="button" class="btn primary q-next-btn" data-qnext="'+i+'">✅ ثبت و ادامه</button></div>';
        return '<div class="q-block q-step" data-qindex="'+i+'" style="'+(i===0?'':'display:none')+'"><div class="qhead"><b>'+(i+1)+'. '+qHtml(q)+'</b><span class="badge">'+typeLabel(q.type)+weightInfo+'</span></div>'+img+body+nextBtn+'</div>';
      }).join('');
      document.getElementById('btn-submit').classList.toggle('hidden', DATA.questions.length>1);
      updateQProgress(0);
    }

    function updateQProgress(curIdx){
      const el=document.getElementById('q-progress');
      if(!el)return;
      el.textContent = DATA.questions.length>1 ? ('سوال '+(curIdx+1)+' از '+DATA.questions.length) : '';
    }

    function isQuestionAnswered(q){
      if(q.type==='multiple'||q.type==='truefalse'){
        return !!document.querySelector('input[name="q_'+q.id+'"]:checked');
      }
      const el=document.querySelector('[data-q="'+q.id+'"]');
      const hasText = el && el.value.trim()!=='';
      const hasPhoto = !!PHOTO_ANSWERS[q.id];
      return hasText||hasPhoto;
    }

    document.getElementById('questions').addEventListener('click', function(e){
      const btn=e.target.closest('.q-next-btn');
      if(!btn)return;
      const idx=parseInt(btn.dataset.qnext,10);
      const q=DATA.questions[idx];
      if(!isQuestionAnswered(q)){
        toast('⚠️ لطفاً پیش از ادامه، به این سوال پاسخ دهید');
        return;
      }
      const curStep=document.querySelector('.q-step[data-qindex="'+idx+'"]');
      const nextStep=document.querySelector('.q-step[data-qindex="'+(idx+1)+'"]');
      if(curStep)curStep.style.display='none';
      if(nextStep){
        nextStep.style.display='';
        nextStep.scrollIntoView({behavior:'smooth',block:'start'});
      }
      updateQProgress(idx+1);
      if(idx+1===DATA.questions.length-1){
        document.getElementById('btn-submit').classList.remove('hidden');
      }
    });

    // ===== بارگذاری عکس پاسخ (برای سوالات تشریحی) با فشرده‌سازی خودکار زیر ۲ مگابایت =====
    let PHOTO_ANSWERS={};
    function compressImageToUnder2MB(file){
      return new Promise(function(resolve,reject){
        const reader=new FileReader();
        reader.onload=function(ev){
          const img=new Image();
          img.onload=function(){
            let w=img.width,h=img.height;
            const maxDim=2000;
            if(Math.max(w,h)>maxDim){
              const scale=maxDim/Math.max(w,h);
              w=Math.round(w*scale);h=Math.round(h*scale);
            }
            const canvas=document.createElement('canvas');
            canvas.width=w;canvas.height=h;
            const ctx=canvas.getContext('2d');
            ctx.fillStyle='#fff';ctx.fillRect(0,0,w,h);
            ctx.drawImage(img,0,0,w,h);
            let quality=0.9;
            function tryCompress(){
              canvas.toBlob(function(blob){
                if(!blob){reject(new Error('خطا در فشرده‌سازی'));return;}
                if(blob.size<=2*1024*1024||quality<=0.3){
                  const fr=new FileReader();
                  fr.onload=function(){resolve({dataUrl:fr.result,size:blob.size});};
                  fr.readAsDataURL(blob);
                }else{
                  quality-=0.1;
                  tryCompress();
                }
              },'image/jpeg',quality);
            }
            tryCompress();
          };
          img.onerror=function(){reject(new Error('فایل عکس معتبر نیست'));};
          img.src=ev.target.result;
        };
        reader.onerror=function(){reject(new Error('خطا در خواندن فایل'));};
        reader.readAsDataURL(file);
      });
    }
    document.getElementById('questions').addEventListener('change',async function(e){
      const target=e.target;
      if(!target||!target.dataset||!target.dataset.qphoto)return;
      const qid=target.dataset.qphoto;
      const file=target.files[0];
      if(!file)return;
      const statusEl=document.getElementById('photostatus_'+qid);
      const previewEl=document.getElementById('photopreview_'+qid);
      statusEl.textContent='در حال فشرده‌سازی...';
      try{
        const result=await compressImageToUnder2MB(file);
        PHOTO_ANSWERS[qid]=result.dataUrl;
        statusEl.textContent='آماده ✅ (حجم نهایی حدود '+(result.size/1024/1024).toFixed(2)+' مگابایت)';
        previewEl.innerHTML='<img src="'+result.dataUrl+'" style="max-width:220px;border:1px solid #ddd;border-radius:8px">';
      }catch(err){
        statusEl.textContent='خطا در پردازش عکس — لطفاً دوباره تلاش کنید';
      }
    });

    async function submitExam(autoSubmit = false){
      const answers={};
      DATA.questions.forEach(q=>{
        if(q.type==='multiple'||q.type==='truefalse'){
          const sel=document.querySelector('input[name="q_'+q.id+'"]:checked');
          answers[q.id]=sel?sel.value:'';
        }else{
          const el=document.querySelector('[data-q="'+q.id+'"]');
          answers[q.id]=el?el.value:'';
        }
      });
      
      const btn=document.getElementById('btn-submit');
      btn.disabled=true;
      btn.textContent=autoSubmit ? '⏰ ارسال خودکار...' : 'در حال ثبت...';
      
      try {
        const r=await fetch('/api/exam/'+encodeURIComponent(ID)+'/submit',{
          method:'POST',
          headers:{'content-type':'application/json'},
          body:JSON.stringify({...window._student, answers, photoAnswers:PHOTO_ANSWERS})
        });
        const d=await r.json();
        if(d.ok){
          document.getElementById('step-exam').classList.add('hidden');
          renderResult({grading:null});
          if(autoSubmit){
            toast('⏰ زمان تمام شد! پاسخنامه شما به طور خودکار ثبت شد.');
          }
        }else{
          toast(d.error||'خطا در ثبت');
          btn.disabled=false;
          btn.textContent='✅ ثبت نهایی پاسخنامه';
        }
      } catch(e) {
        toast('خطا در اتصال');
        btn.disabled=false;
        btn.textContent='✅ ثبت نهایی پاسخنامه';
      }
    }

    document.getElementById('btn-enter').onclick=()=>{
      const name=document.getElementById('f-name').value.trim();
      const father=document.getElementById('f-father').value.trim();
      const nid=document.getElementById('f-nid').value.trim();
      const date=document.getElementById('f-date').value.trim();
      const err=document.getElementById('info-err');
      if(!name||!father||!nid||!date){err.textContent='لطفاً همه فیلدها را پر کنید.';return;}
      err.textContent='';
      const course=(DATA && DATA.meta && DATA.meta.examName) || '';
      window._student={name,fatherName:father,nationalId:nid,courseName:course,examDate:date};
      document.getElementById('step-info').classList.add('hidden');
      document.getElementById('step-exam').classList.remove('hidden');
      renderQuestions();
      
      if(DATA.duration){
        startTimer(DATA.duration);
      }
    };

    document.getElementById('btn-submit').onclick=()=>{
      if(confirm('آیا از ثبت نهایی پاسخنامه مطمئن هستید؟')) {
        submitExam(false);
      }
    };

    try{ 
      const now = new Date();
      document.getElementById('f-date').value = now.toLocaleDateString('fa-IR', {year:'numeric', month:'2-digit', day:'2-digit'}).replace(/\\//g, '/');
    }catch(e){}
    load();
  </script></body></html>`);
}

/* ------------------------- دریافت و ارسال اطلاعات - صفحه‌ی عمومی لینک اختصاصی ------------------------- */

async function infoLinkPage(env, linkId) {
  return html(`<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>ارسال اطلاعات</title>${FONT_LINK}<style>${SHARED_CSS}
    .info-file-row{display:flex;align-items:center;gap:8px;padding:6px 10px;border:1px solid var(--line);border-radius:8px;margin-top:6px;font-size:13px}
    .info-file-row a{color:var(--primary);text-decoration:none;font-weight:700}
    .info-code-box{background:#fefce8;border:2px dashed #eab308;border-radius:10px;padding:14px;text-align:center;margin-top:10px}
    .info-code-box b{font-size:22px;letter-spacing:2px;color:#92400e}
  </style></head>
  <body><div class="wrap">
    ${pageHeader()}
    <div class="card" id="info-invalid" style="display:none"><h3>لینک نامعتبر است</h3><p class="muted">این لینک معتبر نیست یا حذف شده است.</p></div>

    <div class="card" id="info-main" style="display:none">
      <h3>📨 ارسال اطلاعات به <span id="info-owner-name"></span></h3>
      <p class="muted" id="info-owner-role"></p>

      <div id="info-send-wrap">
        <label>نام شما</label><input id="info-sender-name" placeholder="نام و نام خانوادگی">
        <label>پیام (اختیاری)</label><textarea id="info-message" rows="3" class="lb-textarea" placeholder="پیام خود را بنویسید..."></textarea>
        <label>فایل‌ها (عکس، PDF، Word یا Excel — اختیاری، حداکثر ۶ فایل)</label>
        <input type="file" id="info-files-input" accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx" multiple>
        <div id="info-files-list"></div>
        <p class="muted" id="info-send-status" style="color:var(--danger)"></p>
        <button class="btn" id="btn-info-send" style="margin-top:10px">📤 ارسال</button>
      </div>

      <div id="info-sent-result" class="hidden">
        <div class="info-code-box">
          <p>✅ با موفقیت ارسال شد. کد پیگیری شما:</p>
          <b id="info-sent-code"></b>
          <p class="muted" style="margin-top:8px">این کد را نگه دارید تا بعداً بتوانید پاسخ را ببینید.</p>
        </div>
        <button class="btn sec" id="btn-info-send-another" style="margin-top:10px">✉️ ارسال پیام دیگر</button>
      </div>

      <hr style="margin:22px 0;border:none;border-top:1px solid var(--line)">
      <h3>🔎 پیگیری پیام قبلی</h3>
      <div class="row" style="gap:8px">
        <input id="info-track-code" placeholder="کد پیگیری خود را وارد کنید" style="flex:1">
        <button class="btn sec" id="btn-info-track">مشاهده</button>
      </div>
      <p class="muted" id="info-track-status" style="color:var(--danger)"></p>
      <div id="info-track-result"></div>
    </div>
  </div>
  <script>
    const LINK_ID=${JSON.stringify(linkId)};
    let INFO_FILES=[];
    function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
    function fmtDate(ts){try{return new Date(ts).toLocaleString('fa-IR');}catch(e){return '';}}
    function compressImage(file){
      return new Promise((resolve,reject)=>{
        const rd=new FileReader();
        rd.onload=ev=>{
          const img=new Image();
          img.onload=()=>{
            let w=img.width,h=img.height;const maxDim=2000;
            if(Math.max(w,h)>maxDim){const scale=maxDim/Math.max(w,h);w=Math.round(w*scale);h=Math.round(h*scale);}
            const c=document.createElement('canvas');c.width=w;c.height=h;
            const ctx=c.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,w,h);ctx.drawImage(img,0,0,w,h);
            let quality=0.9;
            (function tryCompress(){
              c.toBlob(function(blob){
                if(!blob){reject(new Error('خطا در فشرده‌سازی'));return;}
                if(blob.size<=1.5*1024*1024||quality<=0.3){
                  const fr=new FileReader();fr.onload=()=>resolve(fr.result);fr.readAsDataURL(blob);
                }else{quality-=0.1;tryCompress();}
              },'image/jpeg',quality);
            })();
          };
          img.onerror=()=>reject(new Error('فایل عکس معتبر نیست'));
          img.src=ev.target.result;
        };
        rd.onerror=()=>reject(new Error('خطا در خواندن فایل'));
        rd.readAsDataURL(file);
      });
    }
    function readAsDataUrl(file){
      return new Promise((resolve,reject)=>{
        const rd=new FileReader();
        rd.onload=()=>resolve(rd.result);
        rd.onerror=()=>reject(new Error('خطا در خواندن فایل'));
        rd.readAsDataURL(file);
      });
    }
    function renderFilesList(){
      document.getElementById('info-files-list').innerHTML=INFO_FILES.map((f,i)=>
        '<div class="info-file-row"><span>📎 '+esc(f.name)+'</span><button type="button" class="btn sm gray" data-i="'+i+'" style="margin-inline-start:auto">حذف</button></div>'
      ).join('');
      document.querySelectorAll('#info-files-list button').forEach(b=>{
        b.onclick=()=>{INFO_FILES.splice(+b.dataset.i,1);renderFilesList();};
      });
    }
    document.getElementById('info-files-input').addEventListener('change',async function(){
      const status=document.getElementById('info-send-status');status.textContent='';
      const files=Array.from(this.files||[]);
      for(const file of files){
        if(INFO_FILES.length>=6){status.textContent='حداکثر ۶ فایل می‌توانید بفرستید.';break;}
        try{
          let dataUrl;
          if(file.type.startsWith('image/'))dataUrl=await compressImage(file);
          else{
            if(file.size>4*1024*1024){status.textContent='حجم فایل «'+file.name+'» بیش از ۴ مگابایت است.';continue;}
            dataUrl=await readAsDataUrl(file);
          }
          INFO_FILES.push({name:file.name,mime:file.type,data:dataUrl});
        }catch(e){status.textContent=e.message||'خطا در بارگذاری فایل';}
      }
      this.value='';
      renderFilesList();
    });
    async function loadMeta(){
      try{
        const r=await fetch('/api/info/link/'+encodeURIComponent(LINK_ID));
        const d=await r.json();
        if(!d.ok){document.getElementById('info-invalid').style.display='';return;}
        document.getElementById('info-owner-name').textContent=d.ownerName;
        document.getElementById('info-owner-role').textContent=d.ownerRole?('('+d.ownerRole+')'):'';
        document.getElementById('info-main').style.display='';
      }catch(e){document.getElementById('info-invalid').style.display='';}
    }
    document.getElementById('btn-info-send').onclick=async function(){
      const status=document.getElementById('info-send-status');status.textContent='';
      const senderName=document.getElementById('info-sender-name').value.trim();
      const message=document.getElementById('info-message').value.trim();
      if(!senderName){status.textContent='نام خود را وارد کنید.';return;}
      if(!message&&!INFO_FILES.length){status.textContent='پیام یا حداقل یک فایل الزامی است.';return;}
      this.disabled=true;this.textContent='در حال ارسال...';
      try{
        const r=await fetch('/api/info/link/'+encodeURIComponent(LINK_ID)+'/send',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({senderName,message,files:INFO_FILES})});
        const d=await r.json();
        if(!d.ok){status.textContent=d.error||'خطا در ارسال';this.disabled=false;this.textContent='📤 ارسال';return;}
        document.getElementById('info-send-wrap').classList.add('hidden');
        document.getElementById('info-sent-result').classList.remove('hidden');
        document.getElementById('info-sent-code').textContent=d.code;
      }catch(e){status.textContent='خطا در ارتباط با سرور';}
      this.disabled=false;this.textContent='📤 ارسال';
    };
    document.getElementById('btn-info-send-another').onclick=function(){
      document.getElementById('info-sender-name').value='';
      document.getElementById('info-message').value='';
      INFO_FILES=[];renderFilesList();
      document.getElementById('info-sent-result').classList.add('hidden');
      document.getElementById('info-send-wrap').classList.remove('hidden');
    };
    function fileRowHtml(f){
      return '<div class="info-file-row">📎 '+esc(f.name)+(f.mime&&f.mime.startsWith('image/')?'':'')+' &nbsp; <a href="'+f.data+'" download="'+esc(f.name)+'">دانلود</a></div>'
        + (f.mime&&f.mime.startsWith('image/') ? '<img src="'+f.data+'" style="max-width:100%;border-radius:8px;margin-top:6px;border:1px solid var(--line)">' : '');
    }
    document.getElementById('btn-info-track').onclick=async function(){
      const status=document.getElementById('info-track-status');status.textContent='';
      document.getElementById('info-track-result').innerHTML='';
      const code=document.getElementById('info-track-code').value.trim().toUpperCase();
      if(!code){status.textContent='کد پیگیری را وارد کنید.';return;}
      try{
        const r=await fetch('/api/info/link/'+encodeURIComponent(LINK_ID)+'/thread/'+encodeURIComponent(code));
        const d=await r.json();
        if(!d.ok){status.textContent=d.error||'پیدا نشد';return;}
        const t=d.thread;
        let h='<div class="card" style="margin-top:10px"><p class="muted">پیام شما در تاریخ '+fmtDate(t.createdAt)+'</p>';
        if(t.message)h+='<p>'+esc(t.message)+'</p>';
        (t.files||[]).forEach(f=>{h+=fileRowHtml(f);});
        if(t.reply){
          h+='<hr style="margin:14px 0;border:none;border-top:1px solid var(--line)"><p class="muted">پاسخ در تاریخ '+fmtDate(t.reply.repliedAt)+'</p>';
          if(t.reply.message)h+='<p>'+esc(t.reply.message)+'</p>';
          (t.reply.files||[]).forEach(f=>{h+=fileRowHtml(f);});
        }else{
          h+='<p class="muted" style="margin-top:10px">هنوز پاسخی ثبت نشده است.</p>';
        }
        h+='</div>';
        document.getElementById('info-track-result').innerHTML=h;
      }catch(e){status.textContent='خطا در ارتباط با سرور';}
    };
    loadMeta();
  </script></body></html>`);
}

/* ------------------------- کاربرگ - صفحه دانش‌آموز ------------------------- */

async function workSheetPage(env, id) {
  const student = await env.EXAM_KV.get("student:" + id);
  if (!student) {
    return html(
      `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">${FONT_LINK}<style>${SHARED_CSS}</style></head>
      <body><div class="wrap">${pageHeader()}<div class="card"><h2>لینک نامعتبر است</h2>
      <p class="muted">این لینک معتبر نیست یا حذف شده است. لطفاً با معلم خود تماس بگیرید.</p></div></div></body></html>`,
      404
    );
  }

  return html(`<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>کاربرگ</title>${FONT_LINK}<style>${SHARED_CSS}</style></head>
  <body><div class="wrap">
    ${pageHeader()}
    <div class="card">
      <h2>🧾 کاربرگ</h2>
      <div id="ws-label" class="muted" style="margin-bottom:14px"></div>

      <div id="ws-teacher-file-box">
        <h3>📄 کاربرگ ارسالی معلم</h3>
        <div id="ws-teacher-file-content" class="muted">در حال بارگذاری...</div>
      </div>

      <hr style="border:none;border-top:1px solid var(--line);margin:18px 0">

      <div id="ws-upload-box">
        <h3>📷 ارسال کاربرگ انجام‌شده</h3>
        <p class="muted">پس از انجام کاربرگ، از آن عکس بگیرید (می‌توانید چند عکس بفرستید) و اینجا بارگذاری کنید.</p>
        <input type="file" id="ws-photo-file" accept="image/*" multiple class="hidden">
        <label class="btn sec" for="ws-photo-file" style="cursor:pointer;display:inline-block">📷 انتخاب عکس(ها)</label>
        <span class="muted" id="ws-photo-status" style="margin-right:8px"></span>
        <div id="ws-photo-preview" style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap"></div>
        <button class="btn primary" id="ws-btn-submit" style="margin-top:14px">✅ ارسال برای معلم</button>
      </div>

      <div id="ws-submitted-box" class="hidden" style="margin-top:18px">
        <h3>✅ کاربرگ شما ارسال شد</h3>
        <div id="ws-submitted-photos" style="display:flex;gap:8px;flex-wrap:wrap"></div>
      </div>

      <div id="ws-feedback-box" class="hidden" style="margin-top:18px;padding:14px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px">
        <h3 style="margin-top:0">💬 بازخورد معلم</h3>
        <div id="ws-feedback-text" style="white-space:pre-wrap;line-height:1.8"></div>
      </div>
    </div>
  </div>

  <div id="ans-photo-modal" class="mt-modal-overlay hidden" onclick="if(event.target===this)closeAnsPhoto()">
    <div style="max-width:95vw;max-height:90vh;position:relative">
      <button class="btn sm gray" style="position:absolute;top:-40px;left:0" onclick="closeAnsPhoto()">✖ بستن</button>
      <img id="ans-photo-modal-img" src="" style="max-width:95vw;max-height:85vh;border-radius:8px;box-shadow:0 8px 30px rgba(0,0,0,.4)">
      <div style="text-align:center;margin-top:10px">
        <a id="ans-photo-modal-dl" href="" download="کاربرگ.jpg" class="btn primary">⬇️ دانلود عکس</a>
      </div>
    </div>
  </div>

  <div class="toast" id="toast"></div>
  <script>
    const ID=${JSON.stringify(id)};
    function toast(msg){const t=document.getElementById('toast');t.textContent=msg;t.style.opacity='1';setTimeout(()=>t.style.opacity='0',2600);}
    async function api(path,opts){const r=await fetch(path,opts);return r.json();}

    window.openAnsPhoto=function(src){
      document.getElementById('ans-photo-modal-img').src=src;
      document.getElementById('ans-photo-modal-dl').href=src;
      document.getElementById('ans-photo-modal').classList.remove('hidden');
    };
    window.closeAnsPhoto=function(){
      document.getElementById('ans-photo-modal').classList.add('hidden');
    };

    let PENDING_PHOTOS=[];

    function compressImageToUnder2MB(file){
      return new Promise(function(resolve,reject){
        const reader=new FileReader();
        reader.onload=function(ev){
          const img=new Image();
          img.onload=function(){
            let w=img.width,h=img.height;
            const maxDim=2000;
            if(Math.max(w,h)>maxDim){
              const scale=maxDim/Math.max(w,h);
              w=Math.round(w*scale);h=Math.round(h*scale);
            }
            const canvas=document.createElement('canvas');
            canvas.width=w;canvas.height=h;
            const ctx=canvas.getContext('2d');
            ctx.fillStyle='#fff';ctx.fillRect(0,0,w,h);
            ctx.drawImage(img,0,0,w,h);
            let quality=0.9;
            function tryCompress(){
              canvas.toBlob(function(blob){
                if(!blob){reject(new Error('خطا در فشرده‌سازی'));return;}
                if(blob.size<=2*1024*1024||quality<=0.3){
                  const fr=new FileReader();
                  fr.onload=function(){resolve(fr.result);};
                  fr.readAsDataURL(blob);
                }else{
                  quality-=0.1;
                  tryCompress();
                }
              },'image/jpeg',quality);
            }
            tryCompress();
          };
          img.onerror=function(){reject(new Error('فایل عکس معتبر نیست'));};
          img.src=ev.target.result;
        };
        reader.onerror=function(){reject(new Error('خطا در خواندن فایل'));};
        reader.readAsDataURL(file);
      });
    }

    function renderPendingPreview(){
      const box=document.getElementById('ws-photo-preview');
      box.innerHTML=PENDING_PHOTOS.map(function(p,i){
        return '<div style="position:relative"><img src="'+p+'" style="width:90px;height:90px;object-fit:cover;border-radius:8px;border:1px solid #ddd">'+
          '<button type="button" data-rm="'+i+'" style="position:absolute;top:-6px;left:-6px;background:#dc2626;color:#fff;border:none;border-radius:50%;width:22px;height:22px;cursor:pointer">✕</button></div>';
      }).join('');
    }
    document.getElementById('ws-photo-preview').addEventListener('click',function(e){
      const btn=e.target.closest('[data-rm]');
      if(!btn)return;
      PENDING_PHOTOS.splice(parseInt(btn.dataset.rm,10),1);
      renderPendingPreview();
    });
    document.getElementById('ws-photo-file').addEventListener('change',async function(e){
      const files=Array.from(e.target.files||[]);
      if(!files.length)return;
      const statusEl=document.getElementById('ws-photo-status');
      statusEl.textContent='در حال فشرده‌سازی...';
      try{
        for(const f of files){
          if(PENDING_PHOTOS.length>=6){toast('حداکثر ۶ عکس مجاز است');break;}
          const dataUrl=await compressImageToUnder2MB(f);
          PENDING_PHOTOS.push(dataUrl);
        }
        renderPendingPreview();
        statusEl.textContent='آماده ✅';
      }catch(err){
        statusEl.textContent='خطا در پردازش عکس — لطفاً دوباره تلاش کنید';
      }
      e.target.value='';
    });

    document.getElementById('ws-btn-submit').onclick=async function(){
      if(!PENDING_PHOTOS.length){toast('لطفاً حداقل یک عکس انتخاب کنید');return;}
      const btn=document.getElementById('ws-btn-submit');
      btn.disabled=true;btn.textContent='در حال ارسال...';
      try{
        const d=await api('/api/worksheet/'+encodeURIComponent(ID)+'/submit',{
          method:'POST',headers:{'content-type':'application/json'},
          body:JSON.stringify({photos:PENDING_PHOTOS})
        });
        if(d.ok){
          toast('کاربرگ شما ارسال شد ✅');
          document.getElementById('ws-upload-box').classList.add('hidden');
          document.getElementById('ws-submitted-box').classList.remove('hidden');
          document.getElementById('ws-submitted-photos').innerHTML=PENDING_PHOTOS.map(function(p){
            return '<img src="'+p+'" style="width:110px;height:110px;object-fit:cover;border-radius:8px;border:1px solid #ddd;cursor:zoom-in" onclick="openAnsPhoto(this.src)" title="برای بزرگ‌نمایی کلیک کنید">';
          }).join('');
        }else{
          toast(d.error||'خطا در ارسال');
          btn.disabled=false;btn.textContent='✅ ارسال برای معلم';
        }
      }catch(err){
        toast('خطا در اتصال');
        btn.disabled=false;btn.textContent='✅ ارسال برای معلم';
      }
    };

    async function load(){
      const d=await api('/api/worksheet/'+encodeURIComponent(ID));
      if(!d.ok){document.getElementById('ws-teacher-file-content').textContent='خطا در بارگذاری اطلاعات';return;}
      document.getElementById('ws-label').textContent=d.label?('دانش‌آموز: '+d.label):'';
      const tBox=document.getElementById('ws-teacher-file-content');
      if(d.teacherFile){
        if(d.teacherFileType==='pdf'){
          tBox.innerHTML='<a class="btn sec" href="'+d.teacherFile+'" download="'+(d.teacherFileName||'کاربرگ.pdf')+'">⬇️ دانلود فایل PDF کاربرگ ('+(d.teacherFileName||'')+')</a>';
        }else{
          tBox.innerHTML='<img src="'+d.teacherFile+'" style="max-width:100%;border-radius:10px;border:1px solid #ddd;cursor:zoom-in" onclick="openAnsPhoto(this.src)" title="برای بزرگ‌نمایی کلیک کنید">'+
            '<br><a href="'+d.teacherFile+'" download="'+(d.teacherFileName||'کاربرگ.jpg')+'" class="btn sm sec" style="margin-top:8px;display:inline-block">⬇️ دانلود عکس کاربرگ</a>';
        }
      }else{
        tBox.textContent='هنوز کاربرگی توسط معلم ارسال نشده است.';
      }
      if(d.studentFiles&&d.studentFiles.length){
        document.getElementById('ws-upload-box').classList.add('hidden');
        document.getElementById('ws-submitted-box').classList.remove('hidden');
        document.getElementById('ws-submitted-photos').innerHTML=d.studentFiles.map(function(p){
          return '<img src="'+p+'" style="width:110px;height:110px;object-fit:cover;border-radius:8px;border:1px solid #ddd;cursor:zoom-in" onclick="openAnsPhoto(this.src)" title="برای بزرگ‌نمایی کلیک کنید">';
        }).join('');
      }
      if(d.feedback){
        document.getElementById('ws-feedback-box').classList.remove('hidden');
        document.getElementById('ws-feedback-text').textContent=d.feedback;
      }
    }
    load();
  </script></body></html>`);
}

/* ------------------------- کلاس آنلاین - صفحه دانش‌آموز ------------------------- */

async function studentClassPage(env, id) {
  const raw = await env.EXAM_KV.get("student:" + id);
  if (!raw) {
    return html(
      `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">${FONT_LINK}<style>${SHARED_CSS}</style></head>
      <body><div class="wrap">${pageHeader()}<div class="card"><h2>لینک نامعتبر است</h2>
      <p class="muted">این لینک کلاس آنلاین معتبر نیست یا حذف شده است. لطفاً با معلم خود تماس بگیرید.</p></div></div></body></html>`,
      404
    );
  }
  const student = JSON.parse(raw);

  return html(`<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>کلاس آنلاین</title>${FONT_LINK}<style>${SHARED_CSS}
    #board{width:100%;background:#fff;border:1px solid var(--line);border-radius:10px;touch-action:none;display:block;margin:0 auto;cursor:zoom-in}
    .cls-status{display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap}
    .dot{width:10px;height:10px;border-radius:50%;background:#dc2626;display:inline-block}
    .dot.on{background:#16a34a}
    #chatBox{height:280px;overflow:auto;border:1px solid var(--line);border-radius:10px;padding:10px;background:#fafafa;display:flex;flex-direction:column;gap:6px}
    .msg{padding:6px 10px;border-radius:10px;max-width:90%;font-size:14px}
    .msg.teacher{background:#eef2ff;align-self:flex-start}
    .msg.student{background:#dcfce7;align-self:flex-end}
    .msg .who{font-size:11px;color:#666;margin-bottom:2px}
    #cls-teacher-video.zoomed{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:min(92vw,520px);height:auto;max-height:82vh;max-width:none;aspect-ratio:auto;object-fit:contain;z-index:41;cursor:zoom-out;box-shadow:0 10px 40px rgba(0,0,0,.5);border-radius:10px}
    #cls-video-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:40}
    #board.zoomed{position:fixed!important;top:50%;left:50%;transform:translate(-50%,-50%);width:min(94vw,900px)!important;height:auto!important;max-height:88vh;z-index:41;cursor:zoom-out;box-shadow:0 10px 40px rgba(0,0,0,.5);border-radius:10px}
    #cls-board-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:40}
  </style></head>
  <body><div class="wrap">
    ${pageHeader()}
    <div class="card">
      <h3>🖥️ کلاس آنلاین${student.label ? " — " + esc(student.label) : ""}</h3>
      <div class="cls-status">
        <span class="dot" id="cls-dot"></span>
        <span id="cls-status-text" class="muted">در حال اتصال به کلاس...</span>
        <span style="flex:1"></span>
        <button class="btn sm sec" id="btn-raise-hand">✋ بلند کردن دست</button>
        <button class="btn sm" id="btn-enable-sound">🔊 فعال‌سازی صدای کلاس</button>
      </div>
      <div class="cls-stack">
        <div class="cls-sec">
          <div class="cls-sec-head">📝 تخته آنلاین</div>
          <div class="cls-board-box" style="position:relative">
            <canvas id="board" width="900" height="500" title="برای بزرگ‌نمایی کلیک کنید"></canvas>
            <div id="cls-board-backdrop" class="hidden"></div>
            <div id="cls-cam-pip" class="t-cam-oncanvas" style="display:flex;align-items:center;justify-content:center;overflow:hidden;padding:0">
              <div id="cls-video-backdrop" class="hidden"></div>
              <img id="cls-teacher-video" class="hidden" title="برای بزرگ‌نمایی کلیک کنید" style="width:100%;height:100%;object-fit:cover;display:block;cursor:zoom-in">
              <div id="cls-cam-placeholder" class="cls-cam-placeholder">🎥 دوربین معلم خاموش است</div>
            </div>
          </div>
          <p class="muted" style="font-size:12px;padding:0 14px 10px">تخته کلاس (و فایل PDF روی آن) توسط معلم کنترل می‌شود. صدای معلم به‌صورت خودکار پخش می‌شود.</p>
        </div>

        <div class="cls-sec">
          <div class="cls-sec-head tap" id="cls-users-toggle">👥 کاربران کلاس <span id="cls-users-count" class="cls-badge-count">۰</span><span class="cls-chevron">▾</span></div>
          <div id="cls-users-list" class="cls-users-list hidden"><span class="muted">کسی متصل نیست</span></div>
        </div>

        <div class="cls-sec">
          <div class="cls-sec-head tap open" id="cls-chat-toggle">💬 گفتگوی کلاس<span class="cls-chevron">▾</span></div>
          <div id="cls-chat-wrap" class="cls-chat-wrap">
            <div id="chatBox"></div>
            <div class="row" style="margin-top:8px">
              <input id="chatInput" placeholder="پیام خود را بنویسید...">
              <button class="btn sm" id="btnSend" style="flex:0 0 auto">ارسال</button>
              <button class="btn sm gray" id="btnFile" style="flex:0 0 auto" title="ارسال فایل">📎</button>
              <input type="file" id="fileInput" style="display:none">
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
  <div class="toast" id="toast"></div>
  <script>
    const ID = ${JSON.stringify(id)};
    const NAME = ${JSON.stringify(student.label || "دانش‌آموز")};
    function toast(m){const t=document.getElementById('toast');t.textContent=m;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2500);}
    function esc(s){const d=document.createElement('div');d.textContent=s==null?'':s;return d.innerHTML;}

    const canvas=document.getElementById('board');
    const ctx=canvas.getContext('2d');
    const BOARD_DEFAULT_W=900, BOARD_DEFAULT_H=560;
    function resizeCanvas(){
      const ratio=canvas.height/canvas.width;
      const containerW=canvas.parentElement.clientWidth;
      if(!containerW)return;
      const maxH=window.innerHeight*0.7; // در گوشی هم جا می‌شود، بدون نیاز به اسکرول زیاد
      let w=containerW, h=w*ratio;
      if(h>maxH){h=maxH;w=h/ratio;}
      canvas.style.width=w+'px';
      canvas.style.height=h+'px';
    }
    function resizeCanvasTo(w,h){
      canvas.width=Math.round(w);
      canvas.height=Math.round(h);
      resizeCanvas();
    }
    resizeCanvas();window.addEventListener('resize',resizeCanvas);

    function drawStroke(s){
      if(!s)return;
      if(s.type==='text'){
        ctx.save();
        ctx.fillStyle=s.color||'#111827';
        ctx.font='bold '+((s.size||3)*7+12)+'px Vazirmatn, Tahoma, sans-serif';
        ctx.textBaseline='top';
        ctx.fillText(s.text||'', s.x*canvas.width, s.y*canvas.height);
        ctx.restore();
        return;
      }
      if(!s.points||s.points.length<2)return;
      ctx.save();
      ctx.strokeStyle=s.erase?'#ffffff':(s.color||'#111827');
      ctx.lineWidth=s.size||3;
      ctx.lineCap='round';ctx.lineJoin='round';
      ctx.beginPath();
      ctx.moveTo(s.points[0][0]*canvas.width,s.points[0][1]*canvas.height);
      for(let i=1;i<s.points.length;i++)ctx.lineTo(s.points[i][0]*canvas.width,s.points[i][1]*canvas.height);
      ctx.stroke();
      ctx.restore();
    }
    function clearBoard(){ctx.clearRect(0,0,canvas.width,canvas.height);}

    // ===== لایه‌ی پس‌زمینه (صفحه‌ی PDF که معلم روی تخته گذاشته) =====
    let boardBgImg=null;
    function updateCamLayout(){
      const vid=document.getElementById('cls-cam-pip');
      if(!vid)return;
      if(boardBgImg){
        vid.classList.remove('t-cam-oncanvas');
        vid.classList.add('t-cam-corner');
      }else{
        vid.classList.remove('t-cam-corner');
        vid.classList.add('t-cam-oncanvas');
      }
    }
    function setBoardBg(dataUrl,w,h){
      if(!dataUrl){
        boardBgImg=null;
        resizeCanvasTo(w||BOARD_DEFAULT_W,h||BOARD_DEFAULT_H);
        ctx.clearRect(0,0,canvas.width,canvas.height);
        updateCamLayout();
        return;
      }
      const img=new Image();
      img.onload=()=>{
        boardBgImg=img;
        resizeCanvasTo(w||img.naturalWidth,h||img.naturalHeight);
        ctx.clearRect(0,0,canvas.width,canvas.height);
        ctx.drawImage(img,0,0,canvas.width,canvas.height);
        updateCamLayout();
      };
      img.src=dataUrl;
    }
    function setBoardBgAndReplay(dataUrl,strokes,w,h){
      if(!dataUrl){
        boardBgImg=null;
        resizeCanvasTo(w||BOARD_DEFAULT_W,h||BOARD_DEFAULT_H);
        ctx.clearRect(0,0,canvas.width,canvas.height);
        (strokes||[]).forEach(drawStroke);
        updateCamLayout();
        return;
      }
      const img=new Image();
      img.onload=()=>{
        boardBgImg=img;
        resizeCanvasTo(w||img.naturalWidth,h||img.naturalHeight);
        ctx.clearRect(0,0,canvas.width,canvas.height);
        ctx.drawImage(img,0,0,canvas.width,canvas.height);
        (strokes||[]).forEach(drawStroke);
        updateCamLayout();
      };
      img.src=dataUrl;
    }

    // ===== پخش صدای زنده معلم با MediaSource =====
    let audioQueue=[], audioPlaying=false, audioWarned=false, audioUnlocked=false;
    (function setupSoundUnlock(){
      const btn=document.getElementById('btn-enable-sound');
      btn.onclick=function(){
        // پخش یک صدای خیلی کوتاه و بی‌صدا برای باز کردن قفل پخش خودکار صدا در مرورگر
        const a=new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=');
        a.play().then(()=>{audioUnlocked=true;btn.classList.add('hidden');pumpAudioQueue();}).catch(()=>{audioUnlocked=true;btn.classList.add('hidden');pumpAudioQueue();});
      };
    })();
    function playAudioChunk(b64, mime){
      audioQueue.push({b64, mime: mime||'audio/webm'});
      if(audioQueue.length>2) audioQueue.splice(0, audioQueue.length-2); // اگر پخش عقب افتاد، فقط تازه‌ترین‌ها را نگه دار تا صدا زنده‌تر بماند و دانش‌آموز از معلم عقب نیفتد
      pumpAudioQueue();
    }
    function pumpAudioQueue(){
      if(!audioUnlocked||audioPlaying||audioQueue.length===0) return;
      const item=audioQueue.shift();
      const a=new Audio('data:'+item.mime+';base64,'+item.b64);
      audioPlaying=true;
      a.onended=()=>{ audioPlaying=false; pumpAudioQueue(); };
      a.onerror=()=>{
        audioPlaying=false;
        if(!audioWarned){
          audioWarned=true;
          toast('مرورگر شما امکان پخش صدای معلم را ندارد؛ لطفاً Chrome را امتحان کنید');
        }
        pumpAudioQueue();
      };
      a.play().catch(()=>{ audioPlaying=false; pumpAudioQueue(); });
    }

    function updateParticipants(list){
      const box=document.getElementById('cls-users-list');
      const countEl=document.getElementById('cls-users-count');
      countEl.textContent=toFaDigitsCls(list.length);
      if(!list.length){box.innerHTML='<span class="muted">کسی متصل نیست</span>';return;}
      box.innerHTML=list.map(function(p){
        const roleCls=p.role==='teacher'?'role-teacher':'';
        const icon=p.role==='teacher'?'👨‍🏫':'👤';
        return '<div class="cls-user-row '+roleCls+'"><span class="u-dot"></span>'+icon+' '+esc(p.name||'')+'</div>';
      }).join('');
    }
    const FA_DIGITS_CLS=['۰','۱','۲','۳','۴','۵','۶','۷','۸','۹'];
    function toFaDigitsCls(n){return String(n).replace(/[0-9]/g,d=>FA_DIGITS_CLS[+d]);}

    (function setupCollapsibleSections(){
      const usersToggle=document.getElementById('cls-users-toggle');
      const usersList=document.getElementById('cls-users-list');
      usersToggle.addEventListener('click',function(){
        usersList.classList.toggle('hidden');
        usersToggle.classList.toggle('open');
      });
      const chatToggle=document.getElementById('cls-chat-toggle');
      const chatWrap=document.getElementById('cls-chat-wrap');
      chatToggle.addEventListener('click',function(){
        chatWrap.classList.toggle('hidden');
        chatToggle.classList.toggle('open');
      });
    })();

    function addChatMsg(entry){
      const box=document.getElementById('chatBox');
      const cls=entry.role==='teacher'?'teacher':'student';
      box.insertAdjacentHTML('beforeend','<div class="msg '+cls+'"><div class="who">'+esc(entry.from)+'</div>'+esc(entry.text)+'</div>');
      box.scrollTop=box.scrollHeight;
    }
    function addFileMsg(f){
      const box=document.getElementById('chatBox');
      const cls=f.role==='teacher'?'teacher':'student';
      let inner;
      if((f.mime||'').indexOf('image/')===0){
        inner='<a href="'+f.data+'" download="'+esc(f.name)+'" target="_blank"><img src="'+f.data+'" style="max-width:180px;max-height:180px;border-radius:8px;display:block"></a>';
      } else {
        inner='<a href="'+f.data+'" download="'+esc(f.name)+'" style="color:#2563eb;text-decoration:underline">📎 '+esc(f.name)+'</a>';
      }
      box.insertAdjacentHTML('beforeend','<div class="msg '+cls+'"><div class="who">'+esc(f.from)+'</div>'+inner+'</div>');
      box.scrollTop=box.scrollHeight;
    }

    let ws=null, checkFailCount=0;
    async function connect(){
      const proto=location.protocol==='https:'?'wss:':'ws:';
      try{
        const chk=await fetch('/api/classroom/ws?check=1&role=student&id='+encodeURIComponent(ID));
        const chkData=await chk.json().catch(()=>({ok:false,error:'پاسخ نامعتبر از سرور'}));
        if(!chkData.ok){
          document.getElementById('cls-status-text').textContent='خطا: '+chkData.error;
          return; // دیگر تلاش مجدد نمی‌کنیم چون مشکل پیکربندی است، نه اتصال موقت
        }
      }catch(e){
        checkFailCount++;
        document.getElementById('cls-status-text').textContent='اتصال به سرور برقرار نشد، در حال تلاش مجدد...';
        setTimeout(connect,2000);
        return;
      }
      ws=new WebSocket(proto+'//'+location.host+'/api/classroom/ws?role=student&id='+encodeURIComponent(ID)+'&name='+encodeURIComponent(NAME));
      ws.onopen=()=>{document.getElementById('cls-dot').classList.add('on');document.getElementById('cls-status-text').textContent='متصل به کلاس آنلاین ✅';};
      ws.onclose=()=>{document.getElementById('cls-dot').classList.remove('on');document.getElementById('cls-status-text').textContent='اتصال قطع شد، در حال تلاش مجدد...';setTimeout(connect,2000);};
      ws.onerror=()=>{try{ws.close();}catch(e){}};
      ws.onmessage=(evt)=>{
        let m;try{m=JSON.parse(evt.data);}catch(e){return;}
        if(m.type==='init'){
          if(m.boardBg){setBoardBgAndReplay(m.boardBg,m.strokes||[],m.boardBgW,m.boardBgH);}
          else{clearBoard();boardBgImg=null;(m.strokes||[]).forEach(drawStroke);}
          (m.chat||[]).forEach(addChatMsg);
          updateParticipants(m.participants||[]);
        }
        else if(m.type==='draw'){drawStroke(m.stroke);}
        else if(m.type==='clear'){ctx.clearRect(0,0,canvas.width,canvas.height);if(boardBgImg)ctx.drawImage(boardBgImg,0,0,canvas.width,canvas.height);}
        else if(m.type==='board-bg'){setBoardBg(m.data,m.w,m.h);}
        else if(m.type==='audio'){playAudioChunk(m.data, m.mime);}
        else if(m.type==='video-frame'){
          const img=document.getElementById('cls-teacher-video');
          img.src=m.data;
          img.classList.remove('hidden');
          document.getElementById('cls-cam-placeholder').classList.add('hidden');
          updateCamLayout();
        }
        else if(m.type==='video-stop'){
          const img=document.getElementById('cls-teacher-video');
          img.classList.add('hidden');
          img.src='';
          document.getElementById('cls-cam-placeholder').classList.remove('hidden');
        }
        else if(m.type==='chat'){addChatMsg(m.entry);}
        else if(m.type==='file'){addFileMsg(m);}
        else if(m.type==='presence'){
          updateParticipants(m.participants||[]);
          if(m.event==='join'&&m.role==='teacher')toast('معلم وارد کلاس شد');
        }
      };
    }
    connect();

    document.getElementById('btnSend').onclick=()=>{
      const inp=document.getElementById('chatInput');
      const text=inp.value.trim();
      if(!text||!ws||ws.readyState!==1)return;
      ws.send(JSON.stringify({type:'chat',text}));
      inp.value='';
    };
    document.getElementById('chatInput').addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('btnSend').click();});
    document.getElementById('btnFile').onclick=()=>{document.getElementById('fileInput').click();};
    document.getElementById('fileInput').addEventListener('change',function(){
      const file=this.files&&this.files[0];
      this.value='';
      if(!file)return;
      if(!ws||ws.readyState!==1){toast('ابتدا باید به کلاس متصل باشید');return;}
      if(file.size>2*1024*1024){toast('حجم فایل باید کمتر از ۲ مگابایت باشد');return;}
      const reader=new FileReader();
      reader.onload=function(){
        ws.send(JSON.stringify({type:'file', name:file.name, mime:file.type, data:reader.result}));
      };
      reader.readAsDataURL(file);
    });
    document.getElementById('btn-raise-hand').onclick=()=>{if(ws&&ws.readyState===1){ws.send(JSON.stringify({type:'raise-hand'}));toast('دستت بلند شد ✋');}};

    // ===== بزرگ‌نمایی دوربین معلم توسط دانش‌آموز =====
    (function(){
      const vid=document.getElementById('cls-teacher-video');
      const backdrop=document.getElementById('cls-video-backdrop');
      function closeZoom(){ vid.classList.remove('zoomed'); backdrop.classList.add('hidden'); }
      function openZoom(){ if(vid.classList.contains('hidden')||!vid.src)return; vid.classList.add('zoomed'); backdrop.classList.remove('hidden'); }
      vid.addEventListener('click',function(){ vid.classList.contains('zoomed')?closeZoom():openZoom(); });
      backdrop.addEventListener('click',closeZoom);
    })();

    // ===== بزرگ‌نمایی تخته (و فایل PDF روی آن) توسط دانش‌آموز =====
    (function(){
      const b=document.getElementById('board');
      const backdrop=document.getElementById('cls-board-backdrop');
      function closeZoom(){ b.classList.remove('zoomed'); backdrop.classList.add('hidden'); }
      function openZoom(){ b.classList.add('zoomed'); backdrop.classList.remove('hidden'); }
      b.addEventListener('click',function(){ b.classList.contains('zoomed')?closeZoom():openZoom(); });
      backdrop.addEventListener('click',closeZoom);
    })();
  </script></body></html>`);
}

/* ------------------------- پنل معلم (کامل) ------------------------- */

function teacherPage() {
  return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(APP_TITLE)}</title>${FONT_LINK}<style>${SHARED_CSS}</style>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
  <script>pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';</script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js"></script>
  </head>
  <body><div class="wrap">
    ${teacherHeader()}

    <div class="card" id="login">
      <h3 id="login-head">🔐 ورود معلم</h3>
      <p class="muted" id="login-hint"></p>
      <label>ورود به عنوان</label>
      <select id="login-role">
        <option value="معلم">👩‍🏫 معلم</option>
        <option value="راهبر آموزشی">🧭 راهبر آموزشی</option>
        <option value="مدیر مدرسه">🏫 مدیر مدرسه</option>
      </select>
      <label>رمز عبور</label><input id="pass" type="password" autocomplete="current-password">
      <p class="muted" id="login-err" style="color:var(--danger)"></p>
      <button class="btn" id="btn-login">ورود</button>
    </div>

    <div id="dash" class="hidden">
      <button class="mobile-menu-btn" id="mobile-menu-btn" type="button">☰ منو</button>
      <div class="tabs-overlay" id="tabs-overlay"></div>
      <div class="dash-flex">
      <div class="tabs" id="tabs-panel">
        <a class="tab active" data-tab="home" href="/teacher?tab=home"><span class="tab-ico">🏠</span><span class="tab-label">صفحه اصلی</span></a>

        <div class="tab-group">
          <div class="tab-parent" data-tab="examonline"><span class="tab-ico">🎓</span><span class="tab-label">آزمون آنلاین</span><span class="tab-arrow">▾</span></div>
          <div class="tab-children" id="tab-children-examonline">
            <a class="tab-child" href="/teacher?tab=examonline&subtab=students">👥 دانش‌آموزان</a>
            <a class="tab-child" href="/teacher?tab=examonline&subtab=questions">📝 طراحی سوالات</a>
            <a class="tab-child" href="/teacher?tab=examonline&subtab=answers">✅ تصحیح و پاسخنامه‌ها</a>
            <a class="tab-child" href="/teacher?tab=examonline&subtab=worksheet">🧾 کاربرگ</a>
          </div>
        </div>

        <a class="tab" data-tab="examsheet" href="/teacher?tab=examsheet"><span class="tab-ico">🖨️</span><span class="tab-label">ساخت آزمون</span></a>
        <a class="tab" data-tab="schedule" href="/teacher?tab=schedule"><span class="tab-ico">📅</span><span class="tab-label">برنامه هفتگی</span></a>

        <div class="tab-group">
          <div class="tab-parent" data-tab="tablesorg"><span class="tab-ico">📊</span><span class="tab-label">جدول‌ساز</span><span class="tab-arrow">▾</span></div>
          <div class="tab-children" id="tab-children-tablesorg">
            <a class="tab-child" href="/teacher?tab=tablesorg&subtab=tables">📊 جدول‌ساز حرفه‌ای</a>
            <a class="tab-child" href="/teacher?tab=tablesorg&subtab=orgform">🏫 سازمان عملی</a>
          </div>
        </div>

        <div class="tab-group">
          <div class="tab-parent" data-tab="imgtools"><span class="tab-ico">🖼️</span><span class="tab-label">ابزار عکس</span><span class="tab-arrow">▾</span></div>
          <div class="tab-children" id="tab-children-imgtools">
            <a class="tab-child" href="/teacher?tab=imgtools&subtab=scan">📷 اسکنر</a>
            <a class="tab-child" href="/teacher?tab=imgtools&subtab=resize">🗜️ کاهش حجم</a>
            <a class="tab-child" href="/teacher?tab=imgtools&subtab=crop">✂️ برش عکس</a>
            <a class="tab-child" href="/teacher?tab=imgtools&subtab=pdf2img">📄 PDF به عکس</a>
            <a class="tab-child" href="/teacher?tab=imgtools&subtab=pdf2word">📘 PDF به Word</a>
          </div>
        </div>

        <div class="tab-group">
          <div class="tab-parent" data-tab="translateai"><span class="tab-ico">🌐</span><span class="tab-label">ترجمه و هوش مصنوعی</span><span class="tab-arrow">▾</span></div>
          <div class="tab-children" id="tab-children-translateai">
            <a class="tab-child" href="/teacher?tab=translateai&subtab=translate">🌐 ترجمه</a>
            <a class="tab-child" href="/teacher?tab=translateai&subtab=ai">🤖 هوش مصنوعی</a>
          </div>
        </div>

        <a class="tab" data-tab="classroom" href="/teacher?tab=classroom"><span class="tab-ico">🖥️</span><span class="tab-label">کلاس آنلاین</span></a>

        <div class="tab-group">
          <div class="tab-parent" data-tab="logbook"><span class="tab-ico">📖</span><span class="tab-label">دفتر مدیریت کلاسی</span><span class="tab-arrow">▾</span></div>
          <div class="tab-children" id="tab-children-logbook">
            <div class="tab-subgroup">
              <div class="tab-subgroup-head" data-sub="lb-lists"><span class="tab-sub-ico">📊</span><span class="tab-sub-label">آمار و لیست دانش‌آموزان</span><span class="tab-sub-arrow">▾</span></div>
              <div class="tab-subchildren" id="tab-subchildren-lb-lists">
                <a class="tab-child" href="/teacher?tab=logbook&lb=roster">👥 لیست اسامی دانش‌آموزان</a>
                <a class="tab-child" href="/teacher?tab=logbook&lb=genderstats">🥧 آمار دانش‌آموزان</a>
                <a class="tab-child" href="/teacher?tab=logbook&lb=passrate">🎯 درصد قبولی دانش‌آموزان</a>
                <a class="tab-child" href="/teacher?tab=logbook&lb=grouping">🧩 گروه‌بندی دانش‌آموزان</a>
              </div>
            </div>
            <div class="tab-subgroup">
              <div class="tab-subgroup-head" data-sub="lb-tables"><span class="tab-sub-ico">📅</span><span class="tab-sub-label">جدول‌ها و برنامه‌ریزی</span><span class="tab-sub-arrow">▾</span></div>
              <div class="tab-subchildren" id="tab-subchildren-lb-tables">
                <a class="tab-child" href="/teacher?tab=logbook&lb=pacing">📈 جدول بودجه‌بندی آموزشی</a>
                <a class="tab-child" href="/teacher?tab=logbook&lb=attendance2">🗓️ جدول حضور و غیاب هفتگی</a>
                <a class="tab-child" href="/teacher?tab=logbook&lb=weekly">📅 برنامه درسی هفتگی (چندپایه)</a>
                <a class="tab-child" href="/teacher?tab=logbook&lb=weekly2">📅 برنامه درسی هفتگی (تک‌پایه)</a>
              </div>
            </div>
            <div class="tab-subgroup">
              <div class="tab-subgroup-head" data-sub="lb-eval"><span class="tab-sub-ico">📶</span><span class="tab-sub-label">ارزشیابی و کارنامه</span><span class="tab-sub-arrow">▾</span></div>
              <div class="tab-subchildren" id="tab-subchildren-lb-eval">
                <a class="tab-child" href="/teacher?tab=logbook&lb=performance">📶 ثبت سطوح عملکرد دانش‌آموز</a>
                <a class="tab-child" href="/teacher?tab=logbook&lb=reportcard">🎓 کارنامه‌ساز</a>
                <a class="tab-child" href="/teacher?tab=logbook&lb=certificate">🏆 تقدیرنامه‌ساز</a>
              </div>
            </div>
            <div class="tab-subgroup">
              <div class="tab-subgroup-head" data-sub="lb-meet"><span class="tab-sub-ico">🤝</span><span class="tab-sub-label">جلسات، صورتجلسات و پرسنل</span><span class="tab-sub-arrow">▾</span></div>
              <div class="tab-subchildren" id="tab-subchildren-lb-meet">
                <a class="tab-child" href="/teacher?tab=logbook&lb=council">💬 صورتجلسه شورای آموزشی اولیا</a>
                <a class="tab-child" href="/teacher?tab=logbook&lb=meetings">🤝 جلسات فردی با اولیا</a>
                <a class="tab-child" href="/teacher?tab=logbook&lb=minutes">🧾 صورتجلسه</a>
                <a class="tab-child" href="/teacher?tab=logbook&lb=staff">🪪 اطلاعات پرسنلی همکاران مدرسه</a>
              </div>
            </div>
          </div>
        </div>

        <a class="tab" data-tab="infoexchange" href="/teacher?tab=infoexchange"><span class="tab-ico">📨</span><span class="tab-label">دریافت و ارسال اطلاعات</span></a>
        <a class="tab" data-tab="settings" href="/teacher?tab=settings"><span class="tab-ico">⚙️</span><span class="tab-label">تنظیمات</span></a>
        <div style="flex:1"></div>
        <div class="tab" id="btn-logout" style="background:#fee2e2;color:#991b1b"><span class="tab-ico">🚪</span><span class="tab-label">خروج</span></div>
      </div>

      <div class="card tab-content" id="tab-home">
        <h3>🏠 صفحه اصلی</h3>
        <p class="muted">به دستیار آموزشی معلم خوش آمدید — یک پنل یکپارچه برای مدیریت کلاس، آزمون‌سازی، دفتر مدیریت کلاسی و ابزارهای هوشمند آموزشی. با کلیک روی هرکدام از بخش‌های زیر، همان بخش در یک تب جدید مرورگر باز می‌شود:</p>
        <div class="home-grid">
          <a class="home-card" href="/teacher?tab=examonline">
            <h4>🎓 آزمون آنلاین</h4>
            <ul>
              <li>👥 دانش‌آموزان</li>
              <li>📝 طراحی سوالات</li>
              <li>✅ تصحیح و پاسخنامه‌ها</li>
              <li>🧾 کاربرگ</li>
            </ul>
          </a>
          <a class="home-card" href="/teacher?tab=examsheet">
            <h4>🖨️ ساخت آزمون</h4>
            <ul><li>طراحی و چاپ برگه آزمون با خروجی Word و PDF</li></ul>
          </a>
          <a class="home-card" href="/teacher?tab=schedule">
            <h4>📅 برنامه هفتگی</h4>
            <ul><li>ساخت و چاپ برنامه هفتگی کلاس</li></ul>
          </a>
          <a class="home-card" href="/teacher?tab=tablesorg">
            <h4>📊 جدول‌ساز</h4>
            <ul>
              <li>📊 جدول‌ساز حرفه‌ای</li>
              <li>🏫 سازمان عملی</li>
            </ul>
          </a>
          <a class="home-card" href="/teacher?tab=imgtools">
            <h4>🖼️ ابزار عکس</h4>
            <ul>
              <li>📷 اسکنر</li>
              <li>🗜️ کاهش حجم</li>
              <li>✂️ برش عکس</li>
              <li>📄 PDF به عکس</li>
              <li>📘 PDF به Word</li>
            </ul>
          </a>
          <a class="home-card" href="/teacher?tab=translateai">
            <h4>🌐 ترجمه و هوش مصنوعی</h4>
            <ul>
              <li>🌐 ترجمه</li>
              <li>🤖 هوش مصنوعی</li>
            </ul>
          </a>
          <a class="home-card" href="/teacher?tab=classroom">
            <h4>🖥️ کلاس آنلاین</h4>
            <ul><li>برگزاری کلاس آنلاین با تخته، چت و وبکم</li></ul>
          </a>
          <a class="home-card" href="/teacher?tab=logbook">
            <h4>📖 دفتر مدیریت کلاسی</h4>
            <ul>
              <li>📊 بودجه‌بندی آموزشی، 👨‍🎓 لیست اسامی</li>
              <li>📋 غیبت، 📈 عملکرد، 🎓 کارنامه‌ساز</li>
              <li>🗣️ صورتجلسه، 🧑‍🏫 اطلاعات همکاران</li>
              <li>📅 برنامه هفتگی، 🏆 تقدیرنامه‌ساز</li>
            </ul>
          </a>
          <a class="home-card" href="/teacher?tab=settings">
            <h4>⚙️ تنظیمات</h4>
            <ul><li>تنظیمات حساب و پنل</li></ul>
          </a>
        </div>
      </div>

      <div class="card tab-content hidden" id="tab-examonline">
        <h3>🎓 آزمون آنلاین</h3>
        <p class="muted">دانش‌آموزان، طراحی سوالات، و تصحیح و پاسخنامه‌ها — همه در یک‌جا</p>
        <div class="subtabs" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;border-bottom:2px solid #e2e8f0;padding-bottom:12px">
          <div class="subtab active" data-subtab="students">👥 دانش‌آموزان</div>
          <div class="subtab" data-subtab="questions">📝 طراحی سوالات</div>
          <div class="subtab" data-subtab="answers">✅ تصحیح و پاسخنامه‌ها</div>
          <div class="subtab" data-subtab="worksheet">🧾 کاربرگ</div>
        </div>

      <div class="subtab-content" id="tab-students">
        <h3>👨‍🎓 ساخت دانش‌آموز جدید</h3>
        <div class="row" style="align-items:center">
          <input id="new-label" placeholder="نام دانش‌آموز (اختیاری)">
          <select id="new-grade" style="flex:0 0 auto;min-width:150px">
            <option value="0">پایه اول دبستان</option>
            <option value="1">پایه دوم دبستان</option>
            <option value="2">پایه سوم دبستان</option>
            <option value="3">پایه چهارم دبستان</option>
            <option value="4">پایه پنجم دبستان</option>
            <option value="5">پایه ششم دبستان</option>
          </select>
          <label class="btn sec sm" style="flex:0 0 auto;cursor:pointer">📷 عکس پروفایل<input type="file" accept="image/*" id="new-student-photo" style="display:none"></label>
          <img id="new-student-photo-preview" class="hidden" style="width:36px;height:36px;border-radius:50%;object-fit:cover;flex:0 0 auto">
          <button class="btn" id="btn-add-student" style="flex:0 0 auto">➕ ساخت لینک اختصاصی</button>
        </div>
        <p class="muted">برای هر دانش‌آموز یک UUID و لینک جداگانه ساخته می‌شود. عکس پروفایل اختیاری است (حداکثر ۲ مگابایت).</p>
        <div class="row" style="align-items:center;margin-top:10px">
          <label style="flex:0 0 auto">نمایش دانش‌آموزان پایه:</label>
          <select id="students-filter-grade" style="flex:0 0 auto;min-width:150px">
            <option value="0">پایه اول دبستان</option>
            <option value="1">پایه دوم دبستان</option>
            <option value="2">پایه سوم دبستان</option>
            <option value="3">پایه چهارم دبستان</option>
            <option value="4">پایه پنجم دبستان</option>
            <option value="5">پایه ششم دبستان</option>
            <option value="all">همه‌ی پایه‌ها</option>
          </select>
        </div>
        <div id="students-list"></div>
      </div>

      <div class="subtab-content hidden" id="tab-questions">
        <h3>📝 سربرگ آزمون</h3>
        <div class="row">
          <div><label>🏫 نام مدرسه</label><input id="m-school" placeholder="نام مدرسه"></div>
          <div><label>👨‍🏫 نام آموزگار</label><input id="m-teacher" placeholder="نام آموزگار"></div>
        </div>
        <div class="row">
          <div><label>📝 نام آزمون</label><input id="m-exam-name" placeholder="نام آزمون"></div>
          <div><label>🎓 مقطع تحصیلی</label>
            <select id="m-grade-level">
              <option value="elementary">ابتدایی (توصیفی)</option>
              <option value="middle">متوسطه اول (نمره‌ای)</option>
              <option value="high">متوسطه دوم (نمره‌ای)</option>
            </select>
            <span class="muted" style="font-size:12px">نوع ارزیابی: ابتدایی توصیفی، متوسطه نمره‌ای</span>
          </div>
        </div>
        <div class="row">
          <div><label>⏱️ مدت زمان (دقیقه)</label>
            <input id="m-exam-duration" type="number" min="1" max="180" value="30">
            <span class="muted" style="font-size:12px">مدت زمان آزمون به دقیقه</span>
          </div>
        </div>
        <div id="exam-time-status-display" class="exam-time-status valid">
          <span class="time-icon">⏱️</span>
          <span>مدت زمان: <span id="duration-display">30</span> دقیقه</span>
        </div>
        <hr style="border:none;border-top:1px solid var(--line);margin:14px 0">
        <h3>📋 سوالات</h3>
        <div id="q-list"></div>
        <div class="row" style="margin-top:12px">
          <button class="btn gray sm" data-add="descriptive" style="flex:0 0 auto">➕ تشریحی</button>
          <button class="btn gray sm" data-add="multiple" style="flex:0 0 auto">➕ چهارگزینه‌ای</button>
          <button class="btn gray sm" data-add="truefalse" style="flex:0 0 auto">➕ صحیح/غلط</button>
          <button class="btn gray sm" data-add="short" style="flex:0 0 auto">➕ کوتاه‌پاسخ</button>
          <button class="btn sec sm" onclick="distributeWeights()" style="flex:0 0 auto">⚖️ تقسیم مساوی وزن‌ها</button>
          <button class="btn sec sm" id="btn-ai-suggest-q" style="flex:0 0 auto">🤖 پیشنهاد سوال با هوش مصنوعی</button>
        </div>
        <div style="margin-top:16px;display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn" id="btn-save-q">💾 ذخیره سربرگ و سوالات</button>
          <a class="btn sec" id="btn-word-exam" href="/api/teacher/word?type=questions">📄 دانلود برگه آزمون (Word)</a>
        </div>
      </div>

      <div class="subtab-content hidden" id="tab-answers">
        <h3>✅ تصحیح و پاسخنامه‌ها</h3>
        <div class="grading-type-selector" style="margin-bottom:16px;padding:12px;background:#f0f9ff;border-radius:8px;">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
            <input type="radio" name="grading-type" value="descriptive" checked style="width:auto">
            <span>📝 تصحیح توصیفی (ابتدایی)</span>
          </label>
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-top:8px">
            <input type="radio" name="grading-type" value="numeric" style="width:auto">
            <span>🔢 تصحیح نمره‌ای (متوسطه اول و دوم)</span>
          </label>
        </div>
        <div class="row" style="align-items:center;flex-wrap:wrap;gap:10px">
          <div style="flex:1;min-width:220px">
            <label>👤 انتخاب دانش‌آموز</label>
            <select id="ans-student-select"><option value="">— یک دانش‌آموز را انتخاب کنید —</option></select>
          </div>
          <button class="btn gray sm" id="btn-refresh-ans" style="flex:0 0 auto;margin-top:20px">🔄 به‌روزرسانی</button>
        </div>
        <div id="answers-list" style="margin-top:14px"></div>
      </div>

      <div class="subtab-content hidden" id="tab-worksheet">
        <h3>🧾 کاربرگ</h3>
        <p class="muted">برای هر دانش‌آموز یک کاربرگ (عکس یا PDF) بارگذاری کنید. دانش‌آموز پس از انجام کاربرگ، عکس آن را برای شما ارسال می‌کند و شما می‌توانید زیر آن بازخورد بنویسید.</p>
        <div class="row" style="align-items:center;flex-wrap:wrap;gap:10px">
          <div style="flex:1;min-width:220px">
            <label>👤 انتخاب دانش‌آموز</label>
            <select id="ws-student-select"><option value="">— یک دانش‌آموز را انتخاب کنید —</option></select>
          </div>
          <button class="btn gray sm" id="btn-refresh-ws" style="flex:0 0 auto;margin-top:20px">🔄 به‌روزرسانی</button>
        </div>
        <div id="worksheet-list" style="margin-top:14px"></div>
      </div>

      </div>

      <div id="ans-photo-modal" class="mt-modal-overlay hidden" onclick="if(event.target===this)closeAnsPhoto()">
        <div style="max-width:95vw;max-height:90vh;position:relative">
          <button class="btn sm gray" style="position:absolute;top:-40px;left:0" onclick="closeAnsPhoto()">✖ بستن</button>
          <img id="ans-photo-modal-img" src="" style="max-width:95vw;max-height:85vh;border-radius:8px;box-shadow:0 8px 30px rgba(0,0,0,.4)">
          <div style="text-align:center;margin-top:10px">
            <a id="ans-photo-modal-dl" href="" download="پاسخ.jpg" class="btn primary">⬇️ دانلود عکس</a>
          </div>
        </div>
      </div>

      <div id="mt-modal-overlay" class="mt-modal-overlay hidden">
        <div class="mt-modal">
          <div class="mt-modal-head">
            <b>🧮 فرمول‌ساز ریاضی</b>
            <button type="button" class="btn sm gray" onclick="closeMathBuilder()">✖ بستن</button>
          </div>
          <div class="mt-palette">
            <span class="grp-label">قالب‌ها:</span>
            <button type="button" onmousedown="event.preventDefault()" onclick="mtInsertFrac()">کسر <span style="font-size:11px">a/b</span></button>
            <button type="button" onmousedown="event.preventDefault()" onclick="mtInsertPow()">توان xⁿ</button>
            <button type="button" onmousedown="event.preventDefault()" onclick="mtInsertSub()">زیرنویس xₙ</button>
            <button type="button" onmousedown="event.preventDefault()" onclick="mtInsertRoot()">رادیکال ⁿ√</button>
            <button type="button" onmousedown="event.preventDefault()" onclick="mtInsertBigOp('\u2211')">جمع ∑</button>
            <button type="button" onmousedown="event.preventDefault()" onclick="mtInsertBigOp('\u220f')">حاصل‌ضرب ∏</button>
            <button type="button" onmousedown="event.preventDefault()" onclick="mtInsertBigOp('\u222b')">انتگرال ∫</button>
            <button type="button" onmousedown="event.preventDefault()" onclick="mtInsertLim()">حد lim</button>
            <button type="button" onmousedown="event.preventDefault()" onclick="mtInsertMatrix(2)">ماتریس ۲×۲</button>
            <button type="button" onmousedown="event.preventDefault()" onclick="mtInsertMatrix(3)">ماتریس ۳×۳</button>
            <button type="button" onmousedown="event.preventDefault()" onclick="mtInsertParen('(',')')">پرانتز ( )</button>
            <button type="button" onmousedown="event.preventDefault()" onclick="mtInsertParen('[',']')">کروشه [ ]</button>
            <button type="button" onmousedown="event.preventDefault()" onclick="mtInsertParen('{','}')">آکولاد { }</button>
            <button type="button" onmousedown="event.preventDefault()" onclick="mtInsertDiv()">تقسیم چکشی</button>
          </div>
          <div class="mt-palette">
            <span class="grp-label">علائم:</span>
            <span id="mt-sym-row"></span>
          </div>
          <p class="muted" style="margin:4px 0">روی هر جای فرمول کلیک کنید تا نشانگر آنجا برود، سپس قالب بعدی را از بالا اضافه کنید (امکان تودرتو کردن قالب‌ها وجود دارد). اعداد به‌صورت خودکار فارسی نوشته می‌شوند.</p>
          <div id="mt-canvas" class="mt-canvas rich" contenteditable="true" dir="rtl"></div>
          <div class="row" style="margin-top:12px">
            <button class="btn primary" onclick="mtInsertIntoQuestion()">➕ درج در سوال</button>
            <button class="btn gray" onclick="document.getElementById('mt-canvas').innerHTML=''">🗑️ پاک کردن فرمول</button>
          </div>
        </div>
      </div>

      <div id="aiq-modal-overlay" class="mt-modal-overlay hidden">
        <div class="mt-modal" style="max-width:680px">
          <div class="mt-modal-head">
            <b>🤖 پیشنهاد سوال با هوش مصنوعی</b>
            <button type="button" class="btn sm gray" onclick="closeAiQSuggest()">✖ بستن</button>
          </div>

          <div id="aiq-form-box">
            <label>📚 موضوع / محتوای سوالات</label>
            <textarea id="aiq-topic" rows="3" placeholder="مثلاً: جمع و تفریق اعداد دو رقمی برای پایه دوم دبستان"></textarea>
            <div class="row" style="margin-top:10px;flex-wrap:wrap;gap:10px">
              <div style="flex:1 1 160px">
                <label>🔢 تعداد سوال (۱ تا ۱۰)</label>
                <input type="number" id="aiq-count" min="1" max="10" value="3">
              </div>
              <div style="flex:1 1 200px">
                <label>❓ نوع سوال</label>
                <select id="aiq-type">
                  <option value="auto">خودکار (متنوع)</option>
                  <option value="descriptive">تشریحی</option>
                  <option value="multiple">چهارگزینه‌ای</option>
                  <option value="truefalse">صحیح / غلط</option>
                  <option value="short">کوتاه‌پاسخ</option>
                </select>
              </div>
            </div>
            <div class="row" style="margin-top:14px">
              <button class="btn primary" id="btn-aiq-generate">✨ دریافت پیشنهاد سوال</button>
            </div>
            <p class="muted" id="aiq-status" style="margin-top:8px"></p>
          </div>

          <div id="aiq-preview-wrap" class="hidden" style="margin-top:14px">
            <h4 style="margin-bottom:8px">📋 پیش‌نمایش سوالات پیشنهادی — پیش از افزودن، تأیید یا ویرایش کنید</h4>
            <div id="aiq-preview-list"></div>
            <div class="row" style="margin-top:12px;flex-wrap:wrap;gap:8px">
              <button class="btn primary" id="btn-aiq-add-selected">➕ افزودن سوالات انتخاب‌شده به آزمون</button>
              <button class="btn gray sm" id="btn-aiq-regenerate">🔁 تولید دوباره</button>
              <button class="btn gray sm" onclick="closeAiQSuggest()">✖ انصراف</button>
            </div>
          </div>
        </div>
      </div>

      <div class="card tab-content hidden" id="tab-examsheet">
        <h3 id="es-page-title">🖨️ ساخت آزمون (برگه چاپی)</h3>
        <p class="muted" id="es-page-desc">دقیقاً مثل برگه رسمی آزمون: سربرگ، مشخصات دانش‌آموز و جدول ردیف/سؤال/بارم. سؤال‌ها را اضافه کنید، ذخیره کنید و در پایان چاپ یا دانلود بگیرید.</p>

        <div id="es-print-area">
          <table class="es-header-table">
            <tr>
              <td><span>نام و نام‌خانوادگی:</span><input class="es-blank"></td>
              <td class="es-hdr-org"><input id="es-org1" placeholder="وزارت آموزش و پرورش جمهوری اسلامی ایران" value="وزارت آموزش و پرورش جمهوری اسلامی ایران"></td>
              <td><span>تاریخ آزمون:</span><input id="es-date"></td>
            </tr>
            <tr>
              <td><span>نام پدر:</span><input class="es-blank"></td>
              <td class="es-hdr-org"><input id="es-org2" placeholder="آموزش و پرورش ناحیه / منطقه ..."></td>
              <td><span>زمان آزمون:</span><input id="es-time"></td>
            </tr>
            <tr>
              <td><span>رشته / پایه:</span><input id="es-grade" placeholder="مثال: دهم انسانی"></td>
              <td><span>سال تحصیلی:</span><input id="es-schoolyear" placeholder="مثال: 1404-1403"></td>
              <td>
                <select id="es-examtitle">
                  <option value="آزمون نوبت اول">آزمون نوبت اول</option>
                  <option value="آزمون نوبت دوم">آزمون نوبت دوم</option>
                  <option value="ارزشیابی">ارزشیابی</option>
                </select>
                <input id="es-examtitle-extra" placeholder="توضیح تکمیلی" style="margin-top:3px">
              </td>
            </tr>
          </table>

          <table class="es-header-table" style="margin-top:6px">
            <tr>
              <td><span>نام درس:</span><input id="es-course" placeholder="نام درس"></td>
              <td>
                <select id="es-teacher-label" style="width:auto;flex:0 0 auto;font-weight:700;font-size:12.5px">
                  <option value="نام دبیر">نام دبیر:</option>
                  <option value="نام آموزگار">نام آموزگار:</option>
                </select>
                <input id="es-teacher" placeholder="نام">
              </td>
            </tr>
          </table>

          <table class="es-main-table" id="es-main-table">
            <thead><tr>
              <th class="es-col-num">ردیف</th><th>سؤال</th>
              <th class="es-col-mark">
                <select id="es-mark-label">
                  <option value="بارم">بارم</option>
                  <option value="بازخورد معلم">بازخورد معلم</option>
                </select>
              </th>
            </tr></thead>
            <tbody id="es-rows"></tbody>
          </table>

          <div class="es-pagefoot">صفحه ۱</div>
        </div>

        <div class="row" style="margin-top:16px;align-items:center">
          <button class="btn" id="btn-es-addrow">➕ افزودن سؤال</button>
          <button class="btn sec" id="btn-esai-suggest">🤖 پیشنهاد سوال با هوش مصنوعی</button>
          <button class="btn success" id="btn-es-save">💾 ذخیره</button>
          <button class="btn sec" id="btn-es-word">📄 دانلود Word</button>
          <button class="btn gray" id="btn-es-pdf">📕 دانلود PDF</button>
          <label style="display:flex;align-items:center;gap:6px;font-size:13px;font-weight:600">🔤 اندازه فونت:
            <input type="number" id="es-font-size" min="8" max="36" step="1" value="12" style="width:60px;padding:6px;border:1px solid #ddd;border-radius:6px">
          </label>
        </div>
      </div>

      <div id="esai-modal-overlay" class="mt-modal-overlay hidden">
        <div class="mt-modal" style="max-width:680px">
          <div class="mt-modal-head">
            <b>🤖 پیشنهاد سوال با هوش مصنوعی</b>
            <button type="button" class="btn sm gray" onclick="closeEsAiSuggest()">✖ بستن</button>
          </div>

          <div id="esai-form-box">
            <label>📚 موضوع / محتوای سوالات</label>
            <textarea id="esai-topic" rows="3" placeholder="مثلاً: فصل سوم علوم پایه پنجم، گردش خون"></textarea>
            <div class="row" style="margin-top:10px;flex-wrap:wrap;gap:10px">
              <div style="flex:1 1 160px">
                <label>🔢 تعداد سوال (۱ تا ۱۰)</label>
                <input type="number" id="esai-count" min="1" max="10" value="5">
              </div>
              <div style="flex:1 1 200px">
                <label>❓ سبک سوال</label>
                <select id="esai-style">
                  <option value="auto">خودکار (متنوع)</option>
                  <option value="descriptive">تشریحی</option>
                  <option value="multiple">چهارگزینه‌ای (متنی)</option>
                  <option value="truefalse">صحیح / غلط</option>
                  <option value="short">کوتاه‌پاسخ</option>
                  <option value="fillblank">جای‌خالی</option>
                </select>
              </div>
              <div style="flex:1 1 140px">
                <label>⚖️ بارم پیشنهادی هر سؤال</label>
                <input type="number" id="esai-mark" min="0" step="0.25" value="1">
              </div>
            </div>
            <div class="row" style="margin-top:14px">
              <button class="btn primary" id="btn-esai-generate">✨ دریافت پیشنهاد سوال</button>
            </div>
            <p class="muted" id="esai-status" style="margin-top:8px"></p>
          </div>

          <div id="esai-preview-wrap" class="hidden" style="margin-top:14px">
            <h4 style="margin-bottom:8px">📋 پیش‌نمایش سوالات پیشنهادی — پیش از افزودن، تأیید یا ویرایش کنید</h4>
            <div id="esai-preview-list"></div>
            <div class="row" style="margin-top:12px;flex-wrap:wrap;gap:8px">
              <button class="btn primary" id="btn-esai-add-selected">➕ افزودن سوالات انتخاب‌شده به آزمون</button>
              <button class="btn gray sm" id="btn-esai-regenerate">🔁 تولید دوباره</button>
              <button class="btn gray sm" onclick="closeEsAiSuggest()">✖ انصراف</button>
            </div>
          </div>
        </div>
      </div>

      <div class="card tab-content hidden" id="tab-schedule">
        <h3 id="schedule-title">📅 برنامه هفتگی</h3>
        <div class="row" style="margin-bottom:16px;align-items:center;gap:10px;flex-wrap:wrap">
          <span style="font-weight:700">🎨 تم رنگی:</span>
          <button class="btn sm sch-theme-btn active" data-theme="default">🌈 پیش‌فرض</button>
          <button class="btn sm sch-theme-btn" data-theme="boy">💙 پسرانه</button>
          <button class="btn sm sch-theme-btn" data-theme="girl">💗 دخترانه</button>
          <button class="btn sm sch-theme-btn" data-theme="colorful">🖍️ پاستلی کودکانه</button>
        </div>
        <div class="row" style="margin-bottom:16px;align-items:center;gap:10px;flex-wrap:wrap">
          <span style="font-weight:700">🔤 فونت جدول:</span>
          <select id="sch-font" style="padding:8px;border:1px solid #ddd;border-radius:6px">
            <option value="default">پیش‌فرض</option>
            <option value="nazanin">B Nazanin</option>
            <option value="titr">B Titr</option>
          </select>
          <span style="font-weight:700">📏 اندازه فونت:</span>
          <input type="number" id="sch-font-size" min="8" max="40" step="1" value="14" style="width:70px;padding:8px;border:1px solid #ddd;border-radius:6px">
          <span class="muted">با زدن اینتر داخل هر خانه، متن به خط بعد می‌رود و ارتفاع خانه بزرگ‌تر می‌شود.</span>
        </div>
        <div class="row" style="margin-bottom:16px">
          <input id="sch-school" placeholder="نام مدرسه" style="flex:1">
          <input id="sch-year" placeholder="سال تحصیلی" style="flex:1">
        </div>
        <div class="row" style="margin-bottom:16px">
          <input id="sch-topic" placeholder="موضوع" style="flex:1">
          <input id="sch-principal" placeholder="نام مدیر" style="flex:1">
        </div>
        <div class="row" style="margin-bottom:16px">
          <input id="sch-class" placeholder="نام کلاس" style="flex:1">
          <input id="sch-teacher" placeholder="نام آموزگار" style="flex:1">
        </div>
        <div class="schedule-table-wrap" id="schedule-table-wrap">
          <table class="schedule-table" id="schedule-table">
            <thead><tr><th class="sch-corner">روز / زنگ</th><th class="sch-period">🔔 زنگ اول</th><th class="sch-period">🔔 زنگ دوم</th><th class="sch-period">🔔 زنگ سوم</th><th class="sch-period">🔔 زنگ چهارم</th><th class="sch-period">🔔 زنگ پنجم</th></tr></thead>
            <tbody id="schedule-body"></tbody>
          </table>
          <div class="sch-decor-corner sch-decor-left hidden">🪴📚</div>
          <div class="sch-decor-corner sch-decor-right hidden">✏️🖍️</div>
        </div>
        <button class="btn primary" id="btn-gen-schedule">🔄 ساخت جدول</button>
        <button class="btn" id="btn-print-schedule">🖨️ چاپ</button>
        <button class="btn sec" id="btn-word-schedule">📄 دانلود Word</button>
        <button class="btn gray" id="btn-pdf-schedule">📕 دانلود PDF</button>
        <button class="btn" id="btn-save-schedule">💾 ذخیره در سرور</button>
      </div>

      <div class="card tab-content hidden" id="tab-tablesorg">
        <h3>📊 جدول‌ساز</h3>
        <div class="subtabs" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;border-bottom:2px solid #e2e8f0;padding-bottom:12px">
          <div class="subtab active" data-subtab="tables">📊 جدول‌ساز حرفه‌ای</div>
          <div class="subtab" data-subtab="orgform">🏫 سازمان عملی</div>
        </div>

      <div class="subtab-content" id="tab-tables">
        <h3>📊 جدول‌ساز حرفه‌ای</h3>
        <div class="row" style="margin-bottom:16px">
          <div><label style="display:block;margin-bottom:4px">تعداد سطر:</label><input type="number" id="tbl-rows" value="5" min="1" max="50" style="width:100px;padding:8px;border:1px solid #ddd;border-radius:6px"></div>
          <div><label style="display:block;margin-bottom:4px">تعداد ستون:</label><input type="number" id="tbl-cols" value="4" min="1" max="20" style="width:100px;padding:8px;border:1px solid #ddd;border-radius:6px"></div>
          <div><label style="display:block;margin-bottom:4px">عنوان جدول:</label><input type="text" id="tbl-title" placeholder="مثال: لیست نمرات" style="width:200px;padding:8px;border:1px solid #ddd;border-radius:6px"></div>
          <div><label style="display:block;margin-bottom:4px">فونت جدول:</label><select id="tbl-font" style="padding:8px;border:1px solid #ddd;border-radius:6px"><option value="default">پیش‌فرض</option><option value="titr">B Titr</option></select></div>
        </div>
        <label style="display:flex;align-items:center;gap:8px;margin-bottom:12px;cursor:pointer">
          <input type="checkbox" id="tbl-avg-check" checked>
          <span>📈 محاسبه خودکار میانگین (ستون‌های عددی) — به‌صورت زنده و با فرمول واقعی اکسل</span>
        </label>
        <div class="row" style="margin-bottom:12px">
          <input type="file" id="tbl-pdf-file" accept="application/pdf" class="hidden">
          <button class="btn secondary" id="btn-tbl-import-pdf">📥 وارد کردن جدول از PDF</button>
          <span class="muted" id="tbl-pdf-status"></span>
        </div>
        <div class="xls-wrap">
          <div class="xls-scroll">
            <table class="xls-grid" id="custom-table">
              <thead id="custom-table-head"></thead>
              <tbody id="custom-table-body"></tbody>
              <tfoot id="custom-table-foot"></tfoot>
            </table>
          </div>
        </div>
        <div class="row" style="margin-top:12px">
          <button class="btn primary" id="btn-gen-table">🔄 ساخت جدول</button>
          <button class="btn sec" id="btn-tbl-add-row">➕ افزودن ردیف</button>
          <button class="btn success" id="btn-save-table">💾 ذخیره</button>
          <button class="btn sec" id="btn-word-table">📄 دانلود Word</button>
          <button class="btn danger" id="btn-pdf-table">📕 دانلود PDF</button>
          <button class="btn gray" id="btn-excel-table">📊 دانلود Excel واقعی (xlsx)</button>
        </div>
        <p class="muted" style="margin-top:6px">نکته: زدن دوباره‌ی «ساخت جدول» کل جدول را از نو می‌سازد و اطلاعات فعلی پاک می‌شود؛ برای افزودن سطر بدون پاک‌شدن اطلاعات، از دکمه‌ی «افزودن ردیف» استفاده کنید. برای حذف یک ستون، روی دکمه‌ی ✖ کنار عنوان همان ستون بزنید.</p>
      </div>

      <div class="subtab-content hidden" id="tab-orgform">
        <h3>🏫 فرم سازمان عملی</h3>
        <p class="muted">اطلاعات را همین‌جا پر کنید؛ در پایان با یک کلیک فایل اکسل رسمی (با فرمول، دراپ‌داون و هدر ثابت) دقیقاً با همین اطلاعات ساخته می‌شود.</p>
        <div class="org-field" style="max-width:220px;margin-bottom:10px"><label>فونت فرم</label><select id="org-font"><option value="default">پیش‌فرض</option><option value="titr">B Titr</option></select></div>

        <h4 style="margin-top:20px">۱) مشخصات آموزشگاه</h4>
        <div class="org-field-grid">
          <div class="org-field"><label>سال تحصیلی</label><input type="text" id="org-year" placeholder="مثال: 1404-1405"></div>
          <div class="org-field"><label>فرم شماره</label><input type="text" id="org-formno"></div>
          <div class="org-field"><label>منطقه</label><input type="text" id="org-region"></div>
          <div class="org-field"><label>نام آموزشگاه</label><input type="text" id="org-school"></div>
          <div class="org-field"><label>کد آموزشگاه</label><input type="text" id="org-schoolcode"></div>
          <div class="org-field"><label>نام مدیر</label><input type="text" id="org-principal"></div>
          <div class="org-field"><label>جنسیت</label><select id="org-gender"><option value=""></option><option>پسر</option><option>دختر</option><option>مختلط</option></select></div>
          <div class="org-field"><label>مقطع</label><input type="text" id="org-level"></div>
          <div class="org-field"><label>کد فضا</label><input type="text" id="org-spacecode"></div>
          <div class="org-field"><label>نوع اداره</label><select id="org-adminType"><option value=""></option><option>دولتی</option><option>غیردولتی</option></select></div>
          <div class="org-field"><label>وضعیت ساختمان</label><input type="text" id="org-buildingStatus" placeholder="مثال: ملکی"></div>
          <div class="org-field"><label>وضعیت</label><input type="text" id="org-status" placeholder="مثال: فعال"></div>
          <div class="org-field"><label>نوع ساختمان</label><select id="org-buildingType"><option value=""></option><option>آجری</option><option>بتنی</option><option>سایر</option></select></div>
          <div class="org-field"><label>شماره تلفن</label><input type="text" id="org-phone"></div>
        </div>
        <div class="org-field" style="margin-top:10px"><label>نشانی آموزشگاه</label><input type="text" id="org-address" style="width:100%"></div>

        <h4 style="margin-top:24px">۲) آمار کلاس‌ها و دانش‌آموزان به تفکیک پایه</h4>
        <div class="xls-wrap">
          <div class="xls-scroll">
            <table class="xls-grid" id="org-stat-table">
              <thead>
                <tr><th rowspan="2">پایه</th><th colspan="4">کلاس</th><th colspan="3">دانش‌آموزان</th></tr>
                <tr><th>پسرانه</th><th>دخترانه</th><th>مختلط</th><th>جمع</th><th>پسر</th><th>دختر</th><th>جمع</th></tr>
              </thead>
              <tbody id="org-stat-body"></tbody>
              <tfoot id="org-stat-foot"></tfoot>
            </table>
          </div>
        </div>

        <h4 style="margin-top:24px">تعداد دانش‌آموزان خاص</h4>
        <table class="xls-grid" id="org-special-table" style="max-width:420px">
          <tbody id="org-special-body"></tbody>
        </table>

        <h4 style="margin-top:24px">۳) اطلاعات پرسنل</h4>
        <div class="xls-wrap">
          <div class="xls-scroll">
            <table class="xls-grid" id="org-staff-table">
              <thead><tr><th>ردیف</th><th>کد پرسنلی</th><th>نام</th><th>نام خانوادگی</th><th>کد ملی</th><th>مدرک</th><th>رشته تحصیلی</th><th>سابقه</th><th>نوع استخدام / وضعیت</th><th>پست سازمانی</th><th>آدرس</th><th>تلفن</th><th>حذف</th></tr></thead>
              <tbody id="org-staff-body"></tbody>
            </table>
          </div>
        </div>
        <button class="btn sm secondary" id="btn-org-staff-addrow" style="margin-top:8px">➕ افزودن ردیف</button>

        <h4 style="margin-top:24px">۴) ساعات موظف / غیرموظف معلمان به تفکیک پایه</h4>
        <p class="muted">می‌توانید اسامی و کد پرسنلی را از یک ستون کپی و در اولین خانه پیست کنید (مثل بقیه جدول‌های برنامه).</p>
        <div class="xls-wrap">
          <div class="xls-scroll">
            <table class="xls-grid" id="org-hours-table">
              <thead>
                <tr><th rowspan="2">ردیف</th><th rowspan="2">کد پرسنلی</th><th rowspan="2">نام و نام خانوادگی</th><th colspan="3">پایه اول</th><th colspan="3">پایه دوم</th><th colspan="3">پایه سوم</th><th colspan="3">پایه چهارم</th><th colspan="3">پایه پنجم</th><th colspan="3">پایه ششم</th><th colspan="3">چندپایه</th><th colspan="3">جمع</th><th rowspan="2">حذف</th></tr>
                <tr><th>موظف</th><th>غ‌موظف</th><th>جمع</th><th>موظف</th><th>غ‌موظف</th><th>جمع</th><th>موظف</th><th>غ‌موظف</th><th>جمع</th><th>موظف</th><th>غ‌موظف</th><th>جمع</th><th>موظف</th><th>غ‌موظف</th><th>جمع</th><th>موظف</th><th>غ‌موظف</th><th>جمع</th><th>موظف</th><th>غ‌موظف</th><th>جمع</th><th>موظف</th><th>غ‌موظف</th><th>جمع</th></tr>
              </thead>
              <tbody id="org-hours-body"></tbody>
            </table>
          </div>
        </div>
        <button class="btn sm secondary" id="btn-org-hours-addrow" style="margin-top:8px">➕ افزودن ردیف</button>

        <div class="row" style="margin-top:20px">
          <button class="btn success" id="btn-org-save">💾 ذخیره</button>
          <button class="btn primary" id="btn-org-form">📥 ساخت و دانلود فرم سازمان عملی</button>
          <button class="btn secondary" id="btn-org-print">🖨️ چاپ</button>
        </div>
      </div>

      </div>

      <div class="card tab-content hidden" id="tab-imgtools">
        <h3>🖼️ ابزار عکس</h3>
        <p class="muted">اسکنر، کاهش حجم، برش و تبدیل PDF به عکس — همه در یک‌جا</p>
        <div class="subtabs" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;border-bottom:2px solid #e2e8f0;padding-bottom:12px">
          <div class="subtab active" data-subtab="scan">📷 اسکنر</div>
          <div class="subtab" data-subtab="resize">🗜️ کاهش حجم</div>
          <div class="subtab" data-subtab="crop">✂️ برش عکس</div>
          <div class="subtab" data-subtab="pdf2img">📄 PDF به عکس</div>
          <div class="subtab" data-subtab="pdf2word">📘 PDF به Word</div>
        </div>

      <div class="subtab-content" id="tab-scan">
        <h3>📷 اسکنر حرفه‌ای (مشابه CamScanner)</h3>
        <p class="muted">عکس‌های خود را با کیفیت بالا اسکن کنید، یا یک فایل PDF بدهید تا صفحاتش خودکار به عکس تبدیل و اضافه شوند</p>
        <div class="upload-zone" id="scan-drop-zone">
          <input type="file" accept="image/*,application/pdf" id="scan-file" class="hidden">
          <div class="upload-icon">📷</div>
          <p>عکس یا فایل PDF را اینجا رها کنید یا کلیک کنید</p>
          <span class="muted">فرمت‌های مجاز: JPG, PNG, WEBP, PDF (هر صفحه PDF به‌صورت خودکار تبدیل به عکس می‌شود)</span>
        </div>
        <div id="scan-pdf-nav" class="hidden" style="display:flex;align-items:center;justify-content:center;gap:10px;margin:10px 0;background:#eef2ff;border:1px solid #c7d2fe;border-radius:8px;padding:8px 12px">
          <button type="button" class="btn sm secondary" id="btn-scan-pdf-prev">◀ صفحه قبل</button>
          <span id="scan-pdf-pageinfo" style="font-weight:bold">صفحه ۱ از ۱</span>
          <button type="button" class="btn sm secondary" id="btn-scan-pdf-next">صفحه بعد ▶</button>
        </div>
        <div id="scan-warp-stage" class="hidden">
          <div id="scan-warp-wrapper" style="position:relative;max-width:100%;display:inline-block;touch-action:none;user-select:none">
            <img id="scan-warp-img" src="" style="width:100%;max-width:500px;display:block;border-radius:8px" draggable="false">
            <svg id="scan-warp-svg" style="position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none">
              <polygon id="scan-warp-poly" points="" style="fill:rgba(102,126,234,0.25);stroke:#667eea;stroke-width:2"></polygon>
            </svg>
            <div class="scan-warp-handle" data-corner="tl" style="position:absolute;width:26px;height:26px;margin:-13px;border-radius:50%;background:#667eea;border:3px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.4);cursor:grab;touch-action:none"></div>
            <div class="scan-warp-handle" data-corner="tr" style="position:absolute;width:26px;height:26px;margin:-13px;border-radius:50%;background:#667eea;border:3px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.4);cursor:grab;touch-action:none"></div>
            <div class="scan-warp-handle" data-corner="br" style="position:absolute;width:26px;height:26px;margin:-13px;border-radius:50%;background:#667eea;border:3px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.4);cursor:grab;touch-action:none"></div>
            <div class="scan-warp-handle" data-corner="bl" style="position:absolute;width:26px;height:26px;margin:-13px;border-radius:50%;background:#667eea;border:3px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.4);cursor:grab;touch-action:none"></div>
          </div>
          <p class="muted" style="margin-top:8px">۴ گوشهٔ آبی رو دقیقاً روی ۴ گوشهٔ سند بکشید تا بعد از برش، سند کاملاً صاف و بدون کجی دربیاد.</p>
          <div class="scan-toolbar">
            <button class="btn secondary" id="btn-scan-autodetect">🔍 تشخیص خودکار لبه‌ها</button>
            <button class="btn primary" id="btn-scan-warp-apply">✅ برش و صاف‌کردن سند</button>
            <button class="btn gray" id="btn-scan-warp-skip">➡️ رد شدن (بدون برش)</button>
          </div>
        </div>
        <div id="scan-controls" class="hidden">
          <div class="filter-presets">
            <button class="filter-btn active" data-filter="original">اصلی</button>
            <button class="filter-btn" data-filter="color">رنگی</button>
            <button class="filter-btn" data-filter="gray">خاکستری</button>
            <button class="filter-btn" data-filter="bw">سیاه/سفید</button>
            <button class="filter-btn" data-filter="document">سند</button>
            <button class="filter-btn" data-filter="enhance">بهبود</button>
            <button class="filter-btn" data-filter="textoenhance">📝 تقویت متن</button>
            <button class="filter-btn" data-filter="removeshadow">🌫️ حذف سایه</button>
            <button class="filter-btn" data-filter="whitenbg">🧹 سفید کردن پس‌زمینه</button>
          </div>
          <div class="scan-settings">
            <div class="setting-group"><label>🔆 روشنایی</label><input type="range" id="scan-bright" min="-100" max="100" value="0"><span class="setting-value" id="bright-val">0</span></div>
            <div class="setting-group"><label>◐ کنتراست</label><input type="range" id="scan-contrast" min="-50" max="50" value="0"><span class="setting-value" id="contrast-val">0</span></div>
            <div class="setting-group"><label>🎯 وضوح</label><input type="range" id="scan-sharp" min="0" max="100" value="0"><span class="setting-value" id="sharp-val">0</span></div>
            <div class="setting-group"><label>🔵 اشباع رنگ</label><input type="range" id="scan-saturation" min="-100" max="100" value="0"><span class="setting-value" id="saturation-val">0</span></div>
          </div>
          <div class="scan-preview"><canvas id="scan-canvas"></canvas></div>
          <div class="scan-toolbar">
            <button class="btn secondary" id="btn-rescan-warp">🔲 برش مجدد سند</button>
            <button class="btn secondary" id="btn-rotate-l">↶ چرخش چپ</button>
            <button class="btn secondary" id="btn-rotate-r">↷ چرخش راست</button>
            <button class="btn secondary" id="btn-scan-autoenhance">✨ روشن‌سازی خودکار</button>
            <div class="setting-group" style="display:inline-flex;align-items:center;gap:6px;margin:0 8px"><label style="margin:0">📦 کیفیت خروجی</label><input type="range" id="scan-out-quality" min="30" max="100" value="90" style="width:100px"><span class="setting-value" id="scan-out-quality-val">90%</span></div>
            <button class="btn primary" id="btn-dl-img">💾 دانلود عکس</button>
            <button class="btn success" id="btn-dl-pdf">📄 دانلود PDF</button>
            <button class="btn secondary" id="btn-reset-scan">🔄 بازنشانی فیلترها</button>
            <button class="btn danger" id="btn-remove-scan">🗑️ حذف عکس</button>
          </div>
        </div>
      </div>

      <div class="subtab-content hidden" id="tab-resize">
        <h3>🗜️ کاهش حجم عکس</h3>
        <p class="muted">عکس‌ها را با کیفیت دلخواه فشرده کنید</p>
        <div class="upload-zone" id="resize-drop-zone">
          <input type="file" accept="image/*" id="resize-file" class="hidden" multiple>
          <div class="upload-icon">🖼️</div>
          <p>عکس را اینجا رها کنید یا کلیک کنید</p>
          <span class="muted">می‌توانید چند عکس انتخاب کنید</span>
        </div>
        <div id="resize-controls" class="hidden">
          <div class="resize-options">
            <div class="resize-group"><label>📊 کیفیت تصویر</label><input type="range" id="resize-quality" min="10" max="100" value="85"><div class="quality-display"><span id="quality-percent">85%</span><span class="muted" id="quality-estimate">حدود 500 کیلوبایت</span></div></div>
            <div class="resize-group"><label>📏 اندازه خروجی</label><div class="size-options"><label class="size-option"><input type="radio" name="resize-size" value="original" checked> حفظ اندازه اصلی</label><label class="size-option"><input type="radio" name="resize-size" value="1920"> 1920px (بزرگ)</label><label class="size-option"><input type="radio" name="resize-size" value="1280"> 1280px (متوسط)</label><label class="size-option"><input type="radio" name="resize-size" value="800"> 800px (کوچک)</label></div></div>
            <div class="resize-group"><label>📐 فرمت خروجی</label><div class="format-options"><button class="format-btn active" data-format="jpeg">JPEG</button><button class="format-btn" data-format="png">PNG</button><button class="format-btn" data-format="webp">WEBP</button></div></div>
            <div class="resize-group" id="resize-total-info" style="background:#e0f2fe;border:2px solid #93c5fd"><label>📦 اطلاعات کلی</label><div style="display:flex;justify-content:space-between;margin-top:8px"><div><span class="muted">حجم اصلی:</span> <strong id="total-original-size">-</strong></div><div><span class="muted">حجم جدید:</span> <strong id="total-new-size" style="color:#10b981">-</strong></div><div><span class="muted">کاهش:</span> <strong id="total-reduction" style="color:#059669">-</strong></div></div></div>
          </div>
          <div class="resize-preview" id="resize-preview"></div>
          <div class="resize-toolbar"><button class="btn primary" id="btn-resize-all">⚡ فشرده‌سازی همه (دانلود جداگانه)</button><button class="btn sec" id="btn-resize-zip">📦 دانلود همه به‌صورت ZIP</button><button class="btn secondary" id="btn-clear-resize">🗑️ پاک کردن</button></div>
        </div>
      </div>

      <div class="subtab-content hidden" id="tab-crop">
        <h3>✂️ برش عکس</h3>
        <p class="muted">عکس‌های خود را برش بزنید و دانلود کنید (قابل استفاده در گوشی و کامپیوتر)</p>
        <div class="upload-zone" id="crop-drop-zone">
          <input type="file" accept="image/*" id="crop-file" class="hidden">
          <div class="upload-icon">🖼️</div>
          <p>عکس را اینجا رها کنید یا کلیک کنید</p>
          <span class="muted">یک عکس برای برش انتخاب کنید</span>
        </div>
        <div id="crop-controls" class="hidden">
          <div class="crop-area"><div id="crop-wrapper"><img id="crop-img" src="" alt="برش"><div id="crop-box"><div class="crop-handle crop-nw"></div><div class="crop-handle crop-n"></div><div class="crop-handle crop-ne"></div><div class="crop-handle crop-w"></div><div class="crop-handle crop-e"></div><div class="crop-handle crop-sw"></div><div class="crop-handle crop-s"></div><div class="crop-handle crop-se"></div></div></div></div>
          <div class="crop-options">
            <div class="crop-ratios">
              <span>نسبت تصویر:</span>
              <button class="ratio-btn active" data-ratio="free">آزاد</button>
              <button class="ratio-btn" data-ratio="1:1">۱:۱ (مربع)</button>
              <button class="ratio-btn" data-ratio="4:3">۴:۳</button>
              <button class="ratio-btn" data-ratio="3:4">۳:۴ (عمودی)</button>
              <button class="ratio-btn" data-ratio="16:9">۱۶:۹ (عریض)</button>
              <button class="ratio-btn" data-ratio="210:297">A4 (عمودی)</button>
            </div>
          </div>
          <div class="crop-actions"><button class="btn danger" id="btn-crop-delete">🗑️ حذف عکس</button><button class="btn secondary" id="btn-crop-reset">↩️ بازنشانی</button><button class="btn primary" id="btn-crop-download">💾 دانلود عکس</button></div>
        </div>
      </div>

      <div class="subtab-content hidden" id="tab-pdf2img">
        <h3>📄 تبدیل PDF به عکس</h3>
        <p class="muted">صفحات PDF را به تصاویر با کیفیت تبدیل کنید</p>
        <div class="upload-zone" id="pdf-drop-zone">
          <input type="file" accept="application/pdf" id="pdf-file" class="hidden">
          <div class="upload-icon">📄</div>
          <p>فایل PDF را اینجا رها کنید یا کلیک کنید</p>
          <span class="muted">فایل PDF برای تبدیل انتخاب کنید</span>
        </div>
        <div id="pdf-controls" class="hidden">
          <div class="pdf-info" style="margin-bottom:16px;padding:12px;background:#f0f9ff;border-radius:8px">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <div><strong id="pdf-name">فایل PDF</strong><span class="muted" style="margin-right:12px">تعداد صفحات: <strong id="pdf-pages-count">0</strong></span></div>
              <button class="btn sm danger" id="pdf-remove">🗑️ حذف</button>
            </div>
          </div>
          <div class="pdf-options" style="margin-bottom:16px">
            <div class="pdf-option-group"><label>انتخاب صفحات:</label><div class="pdf-page-select"><button class="pdf-select-btn active" data-pages="all">همه صفحات</button><button class="pdf-select-btn" data-pages="odd">صفحات فرد</button><button class="pdf-select-btn" data-pages="even">صفحات زوج</button><button class="pdf-select-btn" data-pages="range">محدوده</button></div><input type="text" id="pdf-range" placeholder="مثال: 1,3,5-10" style="margin-top:8px" class="hidden"></div>
            <div class="pdf-option-group" style="margin-top:12px"><label>DPI (کیفیت تصویر):</label><div class="pdf-dpi-select"><button class="pdf-dpi-btn" data-dpi="72">72 DPI<small>پیش‌نمایش</small></button><button class="pdf-dpi-btn active" data-dpi="150">150 DPI<small>متوسط</small></button><button class="pdf-dpi-btn" data-dpi="300">300 DPI<small>بالا</small></button></div></div>
            <div class="pdf-option-group" style="margin-top:12px"><label>🔄 چرخش تصویر:</label><div class="pdf-rotate-select"><button class="btn sm secondary" id="btn-pdf-rotate-l">↶ چرخش چپ</button><button class="btn sm secondary" id="btn-pdf-rotate-r">↷ چرخش راست</button><span class="muted" style="margin-right:8px">زاویهٔ فعلی: <strong id="pdf-rotate-val">۰</strong> درجه</span></div></div>
            <div class="pdf-option-group" style="margin-top:12px"><label>فرمت خروجی:</label><div class="pdf-format-select"><button class="pdf-format-btn" data-format="png">PNG</button><button class="pdf-format-btn active" data-format="jpeg">JPEG</button></div><div id="jpeg-quality-group" style="margin-top:8px"><label>📦 کیفیت خروجی:</label><input type="range" id="jpeg-quality" min="50" max="100" value="85" style="width:150px"><span id="jpeg-quality-val">85%</span></div></div>
          </div>
          <div class="pdf-preview" id="pdf-preview" style="margin-bottom:16px"></div>
          <div class="pdf-toolbar"><button class="btn primary" id="btn-pdf-render-all">⚡ رندر همه صفحات</button><button class="btn secondary" id="btn-pdf-download-zip">📦 دانلود ZIP</button><button class="btn gray" id="btn-pdf-clear-previews">🗑️ پاک کردن پیش‌نمایش‌ها</button></div>
        </div>
      </div>

      <div class="subtab-content hidden" id="tab-pdf2word">
        <h3>📝 تبدیل PDF به Word (قابل ویرایش)</h3>
        <p class="muted">متن PDF استخراج و در قالب یک فایل Word قابل‌ویرایش (.doc) قرار می‌گیرد. توجه: چون PDF ساختار متنی استاندارد ندارد، ممکن است چیدمان دقیق صفحه (جدول‌ها، ستون‌بندی، تصاویر) کاملاً حفظ نشود؛ اما متن به‌صورت کامل و قابل ویرایش استخراج می‌شود.</p>
        <div class="upload-zone" id="pdf2word-drop-zone">
          <input type="file" accept="application/pdf" id="pdf2word-file" class="hidden">
          <div class="upload-icon">📝</div>
          <p>فایل PDF را اینجا رها کنید یا کلیک کنید</p>
          <span class="muted">فایل PDF برای تبدیل به Word انتخاب کنید</span>
        </div>
        <div id="pdf2word-controls" class="hidden">
          <div class="pdf-info" style="margin-bottom:16px;padding:12px;background:#f0f9ff;border-radius:8px">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <div><strong id="pdf2word-name">فایل PDF</strong><span class="muted" style="margin-right:12px">تعداد صفحات: <strong id="pdf2word-pages-count">0</strong></span></div>
              <button class="btn sm danger" id="pdf2word-remove">🗑️ حذف</button>
            </div>
          </div>
          <div id="pdf2word-status" class="muted" style="margin-bottom:12px"></div>
          <div class="pdf-toolbar"><button class="btn primary" id="btn-pdf2word-convert">⚡ استخراج و ساخت Word</button><button class="btn success hidden" id="btn-pdf2word-download">💾 دانلود فایل Word</button></div>
        </div>
      </div>

      </div>

      <div class="card tab-content hidden" id="tab-translateai">
        <h3>🌐 ترجمه و هوش مصنوعی</h3>
        <div class="subtabs" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;border-bottom:2px solid #e2e8f0;padding-bottom:12px">
          <div class="subtab active" data-subtab="translate">🌐 ترجمه</div>
          <div class="subtab" data-subtab="ai">🤖 هوش مصنوعی</div>
        </div>

      <div class="subtab-content" id="tab-translate">
        <h3>🌐 ترجمه متن (با هوش مصنوعی)</h3>
        <p class="muted">ترجمه‌ی حرفه‌ای و طبیعی بین زبان‌ها — با تشخیص خودکار زبان، انتخاب لحن، و بازبینی کیفیت ترجمه</p>
        <div class="tl-lang-row">
          <select id="tl-from">
            <option value="auto">🔍 تشخیص خودکار زبان</option>
            <option value="fa">فارسی</option>
            <option value="en">انگلیسی</option>
            <option value="ar">عربی</option>
            <option value="fr">فرانسوی</option>
            <option value="de">آلمانی</option>
            <option value="tr">ترکی استانبولی</option>
            <option value="es">اسپانیایی</option>
            <option value="it">ایتالیایی</option>
            <option value="pt">پرتغالی</option>
            <option value="ru">روسی</option>
            <option value="zh">چینی</option>
            <option value="ja">ژاپنی</option>
            <option value="ko">کره‌ای</option>
            <option value="ur">اردو</option>
            <option value="hi">هندی</option>
            <option value="ps">پشتو</option>
            <option value="ku">کردی (سورانی)</option>
            <option value="az">آذربایجانی</option>
            <option value="hy">ارمنی</option>
          </select>
          <button class="btn sm" onclick="tlSwap()" title="جابه‌جایی زبان مبدا و مقصد">⇄</button>
          <select id="tl-to">
            <option value="en">انگلیسی</option>
            <option value="fa">فارسی</option>
            <option value="ar">عربی</option>
            <option value="fr">فرانسوی</option>
            <option value="de">آلمانی</option>
            <option value="tr">ترکی استانبولی</option>
            <option value="es">اسپانیایی</option>
            <option value="it">ایتالیایی</option>
            <option value="pt">پرتغالی</option>
            <option value="ru">روسی</option>
            <option value="zh">چینی</option>
            <option value="ja">ژاپنی</option>
            <option value="ko">کره‌ای</option>
            <option value="ur">اردو</option>
            <option value="hi">هندی</option>
            <option value="ps">پشتو</option>
            <option value="ku">کردی (سورانی)</option>
            <option value="az">آذربایجانی</option>
            <option value="hy">ارمنی</option>
          </select>
          <select id="tl-tone" title="لحن ترجمه">
            <option value="neutral">🎯 لحن عادی</option>
            <option value="formal">🎩 رسمی / اداری</option>
            <option value="informal">💬 محاوره‌ای</option>
            <option value="academic">📘 علمی / آکادمیک</option>
            <option value="simple">🧒 ساده و روان (کودکانه)</option>
          </select>
        </div>
        <div style="margin-bottom:8px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <input type="file" id="tl-img-file" accept="image/*" class="hidden">
          <input type="file" id="tl-pdf-file" accept="application/pdf" class="hidden">
          <button class="btn sm sec" id="btn-tl-from-img">📷 گرفتن متن از عکس</button>
          <button class="btn sm sec" id="btn-tl-from-pdf">📄 گرفتن متن از PDF</button>
          <span class="muted" id="tl-extract-status" style="font-size:12px"></span>
        </div>
        <div class="tl-grid">
          <div>
            <label>متن ورودی:</label>
            <textarea id="tl-input" rows="9" dir="rtl" placeholder="متن خود را اینجا بنویسید یا بچسبانید، یا از عکس/PDF بگیرید..."></textarea>
            <div class="muted" style="font-size:12px;margin-top:4px" id="tl-input-count">۰ کاراکتر</div>
          </div>
          <div>
            <label>ترجمه:</label>
            <textarea id="tl-output" rows="9" dir="ltr" readonly placeholder="ترجمه اینجا نمایش داده می‌شود..."></textarea>
            <div class="muted" style="font-size:12px;margin-top:4px" id="tl-output-count">۰ کاراکتر</div>
          </div>
        </div>
        <div style="margin-top:16px;display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn primary" id="btn-translate">🌐 ترجمه کن</button>
          <button class="btn sec" id="btn-translate-back">🔁 بازبینی (ترجمه معکوس)</button>
          <button class="btn" onclick="tlCopy()">📋 کپی ترجمه</button>
          <button class="btn gray" onclick="tlClear()">🗑️ پاک کردن</button>
        </div>
        <div id="tl-back-box" class="hidden" style="margin-top:14px;padding:12px 14px;background:#f8fafc;border:1px dashed #cbd5e1;border-radius:10px">
          <div style="font-size:12px;font-weight:700;color:#475569;margin-bottom:6px">🔁 بازترجمه به زبان مبدا (برای بررسی صحت و طبیعی‌بودن ترجمه)</div>
          <div id="tl-back-text" style="font-size:14px;color:#334155"></div>
        </div>
        <p class="muted" style="font-size:12px;margin-top:10px">💡 نکته: اگر متن شامل اصطلاح تخصصی یا آموزشی خاصی است، آن را داخل پرانتز در متن ورودی توضیح بدهید تا ترجمه دقیق‌تر شود.</p>
      </div>

      <div class="subtab-content hidden" id="tab-ai">
        <div class="ai-chat-container">
          <div class="ai-header">
            <div class="ai-avatar">🤖</div>
            <div class="ai-title"><h3>دستیار هوش مصنوعی</h3><span class="ai-status">آنلاین</span></div>
            <button type="button" class="btn sm gray" id="btn-ai-clear" title="پاک کردن کل گفتگو" style="flex:0 0 auto;width:34px;height:34px;padding:0;border-radius:50%;display:flex;align-items:center;justify-content:center">🗑️</button>
          </div>
          <div id="ai-messages" class="ai-messages">
            <div class="ai-message ai"><div class="ai-message-avatar">🤖</div><div class="ai-message-content"><div class="ai-message-text">سلام! 👋 من دستیار هوش مصنوعی شما هستم. چطور می‌توانم کمکتان کنم؟</div></div></div>
          </div>
          <div class="ai-typing hidden" id="ai-typing">
            <div class="ai-message ai"><div class="ai-message-avatar">🤖</div><div class="ai-message-content"><div class="ai-typing-dots"><span></span><span></span><span></span></div></div></div>
          </div>
          <div id="ai-img-preview" class="hidden ai-attach-preview">
            <img id="ai-img-preview-thumb" style="width:36px;height:36px;object-fit:cover;border-radius:8px;flex:0 0 auto">
            <span>🖼️ تصویر ضمیمه شد</span>
            <button type="button" id="btn-ai-img-remove" class="ai-attach-remove" title="حذف تصویر">✕</button>
          </div>
          <div id="ai-pdf-preview" class="hidden ai-attach-preview">
            <span style="font-size:17px;flex:0 0 auto">📄</span>
            <span id="ai-pdf-preview-name">فایل PDF ضمیمه شد</span>
            <button type="button" id="btn-ai-pdf-remove" class="ai-attach-remove" title="حذف فایل">✕</button>
          </div>
          <div class="ai-input-area">
            <input type="file" id="ai-img-file" accept="image/*" class="hidden">
            <input type="file" id="ai-pdf-file" accept="application/pdf" class="hidden">
            <button type="button" class="btn gray ai-send-btn" id="btn-ai-img-pick" title="پیوست عکس">📷</button>
            <button type="button" class="btn gray ai-send-btn" id="btn-ai-pdf-pick" title="پیوست PDF">📄</button>
            <textarea id="ai-input" placeholder="پیام خود را بنویسید..." rows="1"></textarea>
            <button class="btn primary ai-send-btn" id="btn-ai-send"><span>➤</span></button>
          </div>
        </div>
      </div>

      </div>

      <div class="card tab-content hidden" id="tab-classroom">
        <h3>🖥️ کلاس آنلاین</h3>
        <div class="cls-status" style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <span class="dot" id="tdot" style="width:10px;height:10px;border-radius:50%;background:#dc2626;display:inline-block;flex:0 0 auto"></span>
          <span id="t-cls-status" class="muted" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">کلاس آنلاین شروع نشده</span>
          <button type="button" class="btn sm sec" id="btn-cls-options-toggle" style="flex:0 0 auto">⚙️ گزینه‌ها</button>
        </div>
        <div id="cls-options-drawer" class="cls-options-drawer hidden">
          <button class="btn sm cls-opt-btn" id="btn-cls-start">▶️ شروع کلاس</button>
          <button class="btn sm gray hidden cls-opt-btn" id="btn-cls-stop">⏹️ پایان کلاس</button>
          <button class="btn sm sec hidden cls-opt-btn" id="btn-mic-toggle">🎙️ روشن کردن میکروفون</button>
          <button class="btn sm sec hidden cls-opt-btn" id="btn-cam-toggle">📷 روشن کردن تصویر</button>
          <button class="btn sm sec hidden cls-opt-btn" id="btn-cam-flip">🔄 چرخش دوربین</button>
        </div>

        <div class="cls-wrap">
          <div class="cls-board-col" style="position:relative">
            <div class="t-board-wrap" style="position:relative">
              <canvas id="t-board" width="900" height="500" style="width:100%;background:#fff;border:1px solid var(--line);border-radius:10px;touch-action:none;display:block;cursor:crosshair"></canvas>
              <video id="t-cam-preview" autoplay muted playsinline class="hidden t-cam-oncanvas"></video>
            </div>
            <img id="t-board-zoom-img" class="hidden" style="position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:min(94vw,900px);height:auto;max-height:88vh;object-fit:contain;z-index:41;cursor:zoom-out;box-shadow:0 10px 40px rgba(0,0,0,.5);border-radius:10px;background:#fff">
            <div id="t-board-zoom-backdrop" class="hidden" style="position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:40"></div>
            <div class="row" style="margin-top:8px;flex-wrap:wrap">
              <input type="range" id="brd-size" min="1" max="20" value="3" style="flex:1;min-width:80px">
              <button class="btn sm gray" id="brd-tool-eraser" style="flex:0 0 auto">🧽 پاک‌کن</button>
              <button class="btn sm danger" id="brd-clear" style="flex:0 0 auto">🗑️ پاک کردن یادداشت‌ها</button>
              <button class="btn sm sec" id="brd-zoom" style="flex:0 0 auto" title="بزرگ‌نمایی تخته">🔍 بزرگ‌نمایی</button>
            </div>

            <div class="cls-pdf-panel" id="cls-pdf-panel" style="margin-top:12px">
              <div class="row" style="align-items:center;flex-wrap:wrap">
                <label class="btn sm sec" style="cursor:pointer;flex:0 0 auto">📄 افزودن PDF<input type="file" accept="application/pdf" id="cls-pdf-file" style="display:none"></label>
                <span id="cls-pdf-name" class="muted" style="font-size:12px"></span>
                <button class="btn sm danger hidden" id="cls-pdf-remove-file" style="flex:0 0 auto">🗑️ حذف فایل PDF</button>
              </div>
              <div id="cls-pdf-nav" class="row hidden" style="align-items:center;margin-top:6px;flex-wrap:wrap">
                <button class="btn sm gray" id="cls-pdf-prev" style="flex:0 0 auto">◀ قبلی</button>
                <span style="flex:0 0 auto">صفحه <input type="number" id="cls-pdf-pagenum" min="1" value="1" style="width:60px;text-align:center"> از <span id="cls-pdf-total">1</span></span>
                <button class="btn sm gray" id="cls-pdf-next" style="flex:0 0 auto">بعدی ▶</button>
                <button class="btn sm primary" id="cls-pdf-show" style="flex:0 0 auto">🖼️ نمایش این صفحه روی تخته</button>
                <button class="btn sm danger" id="cls-pdf-remove-bg" style="flex:0 0 auto">حذف PDF از تخته</button>
              </div>
            </div>

            <p class="muted" style="font-size:12px;margin-top:6px">روی تخته با خط مشکی بکشید؛ ترسیم برای همه دانش‌آموزان متصل به‌صورت زنده نمایش داده می‌شود. وقتی دوربین روشن باشد و PDF روی تخته نباشد، تصویر دقیقاً روی تخته نمایش داده می‌شود؛ به‌محض نمایش PDF، تصویر کوچک می‌شود تا PDF کامل دیده شود.</p>
          </div>
          <div class="cls-chat-col">
            <h4 style="margin:0 0 6px">👥 حاضرین (<span id="cls-online-count">0</span>)</h4>
            <div id="cls-participants" class="muted" style="font-size:13px;max-height:110px;overflow:auto;margin-bottom:10px"></div>
            <div id="t-chatBox" style="height:220px;overflow:auto;border:1px solid var(--line);border-radius:10px;padding:10px;background:#fafafa;display:flex;flex-direction:column;gap:6px"></div>
            <div class="row" style="margin-top:8px">
              <input id="t-chatInput" placeholder="پیام به کلاس...">
              <button class="btn sm" id="t-btnSend" style="flex:0 0 auto">ارسال</button>
              <button class="btn sm gray" id="t-btnFile" style="flex:0 0 auto" title="ارسال فایل">📎</button>
              <input type="file" id="t-fileInput" style="display:none">
            </div>
          </div>
        </div>

        <hr style="border:none;border-top:1px solid var(--line);margin:16px 0">
        <h4>🔗 لینک‌های اختصاصی ورود دانش‌آموزان به کلاس</h4>
        <p class="muted">برای هر دانش‌آموزی که در تب «دانش‌آموزان» ساخته‌اید، یک لینک اختصاصی کلاس آنلاین وجود دارد؛ کافیست دانش‌آموز روی لینک بزند تا مستقیم وارد کلاس شود.</p>
        <div id="cls-links-list"></div>
      </div>

      <div class="card tab-content hidden" id="tab-logbook">
        <div id="lb-menu">
          <h3>📖 دفتر مدیریت کلاسی</h3>
          <p class="muted">مجموعه‌ی فرم‌های اداری و آموزشی معلم؛ هرکدام را انتخاب کنید تا وارد شوید. همه قابل دانلود Word، Excel و چاپ/PDF هستند.</p>
          <div class="lb-menu-grid">
            <button class="lb-menu-btn" data-lb="pacing"><span class="lb-ico">📈</span><span class="lb-t">جدول بودجه‌بندی آموزشی</span><small>پایه‌های اول تا ششم</small></button>
            <button class="lb-menu-btn" data-lb="roster"><span class="lb-ico">👥</span><span class="lb-t">لیست اسامی دانش‌آموزان</span></button>
            <button class="lb-menu-btn" data-lb="genderstats"><span class="lb-ico">🥧</span><span class="lb-t">آمار دانش‌آموزان</span><small>به تفکیک جنسیت</small></button>
            <button class="lb-menu-btn" data-lb="passrate"><span class="lb-ico">🎯</span><span class="lb-t">درصد قبولی دانش‌آموزان</span><small>نمودار به تفکیک پایه</small></button>
            <button class="lb-menu-btn" data-lb="attendance2"><span class="lb-ico">🗓️</span><span class="lb-t">جدول حضور و غیاب هفتگی</span><small>به تفکیک هفته و روز، به تفکیک ماه</small></button>
            <button class="lb-menu-btn" data-lb="grouping"><span class="lb-ico">🧩</span><span class="lb-t">گروه‌بندی دانش‌آموزان</span><small>تا ۶ گروه رنگی</small></button>
            <button class="lb-menu-btn" data-lb="performance"><span class="lb-ico">📶</span><span class="lb-t">ثبت سطوح عملکرد دانش‌آموز</span></button>
            <button class="lb-menu-btn" data-lb="reportcard"><span class="lb-ico">🎓</span><span class="lb-t">کارنامه‌ساز</span><small>ارزشیابی توصیفی هر دانش‌آموز</small></button>
            <button class="lb-menu-btn" data-lb="council"><span class="lb-ico">💬</span><span class="lb-t">صورتجلسه شورای آموزشی اولیا</span></button>
            <button class="lb-menu-btn" data-lb="meetings"><span class="lb-ico">🤝</span><span class="lb-t">جلسات فردی با اولیا</span></button>
            <button class="lb-menu-btn" data-lb="weekly"><span class="lb-ico">📅</span><span class="lb-t">برنامه درسی هفتگی (چندپایه)</span></button>
            <button class="lb-menu-btn" data-lb="weekly2"><span class="lb-ico">📅</span><span class="lb-t">برنامه درسی هفتگی (تک‌پایه)</span></button>
            <button class="lb-menu-btn" data-lb="staff"><span class="lb-ico">🪪</span><span class="lb-t">اطلاعات پرسنلی همکاران مدرسه</span></button>
            <button class="lb-menu-btn" data-lb="minutes"><span class="lb-ico">🧾</span><span class="lb-t">صورتجلسه</span><small>فرم عمومی صورتجلسه مدرسه</small></button>
            <button class="lb-menu-btn" data-lb="certificate"><span class="lb-ico">🏆</span><span class="lb-t">تقدیرنامه‌ساز</span><small>قالب آماده برای چاپ با اسم و دلیل تشویق</small></button>
          </div>
        </div>

        <!-- ===== ۱. جدول بودجه‌بندی آموزشی ===== -->
        <div class="lb-panel hidden" id="lb-panel-pacing">
          <button class="btn sm gray lb-back-btn">← بازگشت به دفتر</button>
          <h3>📈 جدول بودجه‌بندی آموزشی</h3>
          <div class="lb-meta-form">
            <div><label>نام مدرسه</label><input id="lbp-school" placeholder="......................."></div>
            <div><label>نام آموزگار</label><input id="lbp-teacher" placeholder="......................."></div>
            <div><label>سال تحصیلی</label><input id="lbp-year" placeholder="......................."></div>
          </div>
          <div class="row" style="align-items:center;flex-wrap:wrap;gap:10px">
            <label style="flex:0 0 auto">پایه تحصیلی:</label>
            <select id="lbp-grade-select" style="flex:0 0 auto;min-width:180px">
              <option value="0">پایه اول دبستان</option>
              <option value="1">پایه دوم دبستان</option>
              <option value="2">پایه سوم دبستان</option>
              <option value="3">پایه چهارم دبستان</option>
              <option value="4">پایه پنجم دبستان</option>
              <option value="5">پایه ششم دبستان</option>
            </select>
            <label style="flex:0 0 auto">نوبت نمایش:</label>
            <select id="lbp-term-select" style="flex:0 0 auto;min-width:170px">
              <option value="both">هر دو نوبت</option>
              <option value="t1">نوبت اول (مهر تا دی)</option>
              <option value="t2">نوبت دوم (بهمن تا اردیبهشت)</option>
            </select>
          </div>
          <p class="muted">در هر خانه‌ی جدول: شماره درس، صفحات کتاب، زمان تدریس و توضیحات معلم یادداشت می‌شود.</p>
          <div id="lb-pacing-preview" class="lb-preview"></div>
          <div class="row" style="margin-top:12px">
            <button class="btn primary" id="btn-lbp-save">💾 ذخیره</button>
            <button class="btn sec" id="btn-lbp-ai-fill">✨ پر کردن پیشنهادی با هوش مصنوعی (این پایه)</button>
            <button class="btn primary" id="btn-lb-pacing-word">📄 دانلود Word (این پایه)</button>
            <button class="btn sec" id="btn-lb-pacing-excel">📊 دانلود Excel (این پایه)</button>
            <button class="btn gray" id="btn-lb-pacing-pdf">🖨️ چاپ / دانلود PDF (این پایه)</button>
            <button class="btn danger" type="button" onclick="lbClearContainer('lb-pacing-preview')">🗑️ پاک کردن جدول</button>
          </div>
        </div>

        <!-- ===== ۲. لیست اسامی دانش‌آموزان ===== -->
        <div class="lb-panel hidden" id="lb-panel-roster">
          <button class="btn sm gray lb-back-btn">← بازگشت به دفتر</button>
          <h3>👨‍🎓 جدول لیست اسامی دانش‌آموزان</h3>
          <div class="lb-meta-form">
            <div><label>نام مدرسه</label><input id="lbr-school" placeholder="......................."></div>
            <div><label>نام آموزگار</label><input id="lbr-teacher" placeholder="......................."></div>
            <div><label>پایه تحصیلی</label><input id="lbr-grade" placeholder="......................."></div>
            <div><label>سال تحصیلی</label><input id="lbr-year" placeholder="......................."></div>
          </div>
          <div class="row">
            <label>تعداد ردیف: </label><input type="number" id="lbr-rows" value="30" min="1" max="100" style="width:90px">
            <button class="btn sm sec" id="btn-lbr-build">🔄 ساخت جدول</button>
            <button class="btn sm gray" id="btn-lbr-addrow">➕ افزودن ردیف (ادامه اسامی)</button>
          </div>
          <div class="lb-preview"><table class="lb-table" id="lbr-table"></table></div>
          <div class="row" style="margin-top:12px">
            <button class="btn primary" id="btn-lbr-save">💾 ذخیره</button>
            <button class="btn primary" id="btn-lb-roster-word">📄 دانلود Word</button>
            <button class="btn sec" id="btn-lb-roster-excel">📊 دانلود Excel</button>
            <button class="btn gray" id="btn-lb-roster-pdf">🖨️ چاپ / دانلود PDF</button>
            <button type="button" class="btn sm sec" id="btn-lbr-print-opts-toggle" title="تنظیمات چاپ" style="flex:0 0 auto">🔧</button>
            <button class="btn danger" type="button" onclick="lbClearContainer('lbr-table')">🗑️ پاک کردن جدول</button>
          </div>
          <div id="lbr-print-opts-drawer" class="cls-options-drawer hidden">
            <div class="row" style="align-items:center;flex-wrap:wrap;gap:8px">
              <label style="flex:0 0 auto">جهت صفحه:</label>
              <select id="lbr-print-orientation" style="flex:0 0 auto;min-width:130px">
                <option value="landscape" selected>افقی (Landscape)</option>
                <option value="portrait">عمودی (Portrait)</option>
              </select>
              <label style="flex:0 0 auto">فونت:</label>
              <select id="lbr-print-font" style="flex:0 0 auto;min-width:130px">
                <option value="default" selected>پیش‌فرض</option>
                <option value="nazanin">B Nazanin</option>
                <option value="mitra">B Mitra</option>
                <option value="titr">B Titr</option>
              </select>
              <label style="flex:0 0 auto">اندازه فونت:</label>
              <input type="number" id="lbr-print-fontsize" value="10" min="6" max="24" style="width:70px">
              <button class="btn sm primary" id="btn-lbr-print-custom" style="flex:0 0 auto">🖨️ چاپ با این تنظیمات</button>
              <button class="btn sm sec" id="btn-lbr-word-custom" style="flex:0 0 auto">📄 دانلود Word با این تنظیمات</button>
            </div>
          </div>
        </div>

        <!-- ===== آمار دانش‌آموزان به تفکیک جنسیت ===== -->
        <div class="lb-panel hidden" id="lb-panel-genderstats">
          <button class="btn sm gray lb-back-btn">← بازگشت به دفتر</button>
          <div class="lbg-sheet">
            <h3 class="lbg-title">آمار دانش‌آموزان مدرسه
              <input id="lbg-school" class="lbg-inline-input" placeholder="......................." style="width:180px">
              به تفکیک جنسیت سال تحصیلی
              <input id="lbg-year" class="lbg-inline-input" placeholder="......................." style="width:110px">
            </h3>
            <div class="lb-preview">
              <table class="lb-table lbg-table" id="lbg-table">
                <thead><tr><th>پایه</th><th>پسر</th><th>دختر</th><th>مجموع</th></tr></thead>
                <tbody id="lbg-tbody">
                  <tr data-grade="1"><td>اول<span class="row-color-picker" data-grade="1"><button type="button" class="row-color-dot" data-color="none" data-grade="1" title="بدون رنگ"></button><button type="button" class="row-color-dot" data-color="pink" data-grade="1" title="صورتی"></button><button type="button" class="row-color-dot" data-color="blue" data-grade="1" title="آبی"></button><button type="button" class="row-color-dot" data-color="red" data-grade="1" title="قرمز"></button><button type="button" class="row-color-dot" data-color="yellow" data-grade="1" title="زرد"></button><button type="button" class="row-color-dot" data-color="orange" data-grade="1" title="نارنجی"></button><button type="button" class="row-color-dot" data-color="green" data-grade="1" title="سبز"></button></span></td><td><input type="text" inputmode="numeric" maxlength="3" class="lbg-boy" data-grade="1"></td><td><input type="text" inputmode="numeric" maxlength="3" class="lbg-girl" data-grade="1"></td><td class="lbg-sum" data-grade="1">۰</td></tr>
                  <tr data-grade="2"><td>دوم<span class="row-color-picker" data-grade="2"><button type="button" class="row-color-dot" data-color="none" data-grade="2" title="بدون رنگ"></button><button type="button" class="row-color-dot" data-color="pink" data-grade="2" title="صورتی"></button><button type="button" class="row-color-dot" data-color="blue" data-grade="2" title="آبی"></button><button type="button" class="row-color-dot" data-color="red" data-grade="2" title="قرمز"></button><button type="button" class="row-color-dot" data-color="yellow" data-grade="2" title="زرد"></button><button type="button" class="row-color-dot" data-color="orange" data-grade="2" title="نارنجی"></button><button type="button" class="row-color-dot" data-color="green" data-grade="2" title="سبز"></button></span></td><td><input type="text" inputmode="numeric" maxlength="3" class="lbg-boy" data-grade="2"></td><td><input type="text" inputmode="numeric" maxlength="3" class="lbg-girl" data-grade="2"></td><td class="lbg-sum" data-grade="2">۰</td></tr>
                  <tr data-grade="3"><td>سوم<span class="row-color-picker" data-grade="3"><button type="button" class="row-color-dot" data-color="none" data-grade="3" title="بدون رنگ"></button><button type="button" class="row-color-dot" data-color="pink" data-grade="3" title="صورتی"></button><button type="button" class="row-color-dot" data-color="blue" data-grade="3" title="آبی"></button><button type="button" class="row-color-dot" data-color="red" data-grade="3" title="قرمز"></button><button type="button" class="row-color-dot" data-color="yellow" data-grade="3" title="زرد"></button><button type="button" class="row-color-dot" data-color="orange" data-grade="3" title="نارنجی"></button><button type="button" class="row-color-dot" data-color="green" data-grade="3" title="سبز"></button></span></td><td><input type="text" inputmode="numeric" maxlength="3" class="lbg-boy" data-grade="3"></td><td><input type="text" inputmode="numeric" maxlength="3" class="lbg-girl" data-grade="3"></td><td class="lbg-sum" data-grade="3">۰</td></tr>
                  <tr data-grade="4"><td>چهارم<span class="row-color-picker" data-grade="4"><button type="button" class="row-color-dot" data-color="none" data-grade="4" title="بدون رنگ"></button><button type="button" class="row-color-dot" data-color="pink" data-grade="4" title="صورتی"></button><button type="button" class="row-color-dot" data-color="blue" data-grade="4" title="آبی"></button><button type="button" class="row-color-dot" data-color="red" data-grade="4" title="قرمز"></button><button type="button" class="row-color-dot" data-color="yellow" data-grade="4" title="زرد"></button><button type="button" class="row-color-dot" data-color="orange" data-grade="4" title="نارنجی"></button><button type="button" class="row-color-dot" data-color="green" data-grade="4" title="سبز"></button></span></td><td><input type="text" inputmode="numeric" maxlength="3" class="lbg-boy" data-grade="4"></td><td><input type="text" inputmode="numeric" maxlength="3" class="lbg-girl" data-grade="4"></td><td class="lbg-sum" data-grade="4">۰</td></tr>
                  <tr data-grade="5"><td>پنجم<span class="row-color-picker" data-grade="5"><button type="button" class="row-color-dot" data-color="none" data-grade="5" title="بدون رنگ"></button><button type="button" class="row-color-dot" data-color="pink" data-grade="5" title="صورتی"></button><button type="button" class="row-color-dot" data-color="blue" data-grade="5" title="آبی"></button><button type="button" class="row-color-dot" data-color="red" data-grade="5" title="قرمز"></button><button type="button" class="row-color-dot" data-color="yellow" data-grade="5" title="زرد"></button><button type="button" class="row-color-dot" data-color="orange" data-grade="5" title="نارنجی"></button><button type="button" class="row-color-dot" data-color="green" data-grade="5" title="سبز"></button></span></td><td><input type="text" inputmode="numeric" maxlength="3" class="lbg-boy" data-grade="5"></td><td><input type="text" inputmode="numeric" maxlength="3" class="lbg-girl" data-grade="5"></td><td class="lbg-sum" data-grade="5">۰</td></tr>
                  <tr data-grade="6"><td>ششم<span class="row-color-picker" data-grade="6"><button type="button" class="row-color-dot" data-color="none" data-grade="6" title="بدون رنگ"></button><button type="button" class="row-color-dot" data-color="pink" data-grade="6" title="صورتی"></button><button type="button" class="row-color-dot" data-color="blue" data-grade="6" title="آبی"></button><button type="button" class="row-color-dot" data-color="red" data-grade="6" title="قرمز"></button><button type="button" class="row-color-dot" data-color="yellow" data-grade="6" title="زرد"></button><button type="button" class="row-color-dot" data-color="orange" data-grade="6" title="نارنجی"></button><button type="button" class="row-color-dot" data-color="green" data-grade="6" title="سبز"></button></span></td><td><input type="text" inputmode="numeric" maxlength="3" class="lbg-boy" data-grade="6"></td><td><input type="text" inputmode="numeric" maxlength="3" class="lbg-girl" data-grade="6"></td><td class="lbg-sum" data-grade="6">۰</td></tr>
                </tbody>
                <tfoot><tr class="lbg-total-row"><td>مجموع کل</td><td id="lbg-foot-boy">۰</td><td id="lbg-foot-girl">۰</td><td id="lbg-foot-all">۰</td></tr></tfoot>
              </table>
            </div>
            <div class="lbg-boxes">
              <div class="lbg-box"><span class="lbg-box-label">تعداد دانش‌آموزان پسر</span><span class="lbg-box-val" id="lbg-total-boy">۰</span></div>
              <div class="lbg-box"><span class="lbg-box-label">تعداد دانش‌آموزان دختر</span><span class="lbg-box-val" id="lbg-total-girl">۰</span></div>
              <div class="lbg-box lbg-box-main"><span class="lbg-box-label">تعداد کل دانش‌آموزان مدرسه</span><span class="lbg-box-val" id="lbg-total-all">۰</span></div>
            </div>
            <div class="row" style="justify-content:center;align-items:center;margin-top:14px;flex-wrap:wrap;gap:8px">
              <span style="font-weight:700">🔤 فونت:</span>
              <select id="lbg-font" style="padding:8px;border:1px solid #ddd;border-radius:6px;width:auto">
                <option value="default">پیش‌فرض</option>
                <option value="titr">B Titr</option>
                <option value="nazanin">B Nazanin</option>
                <option value="mitra">B Mitra</option>
              </select>
              <span style="font-weight:700;margin-right:10px">🔠 اندازه فونت جدول:</span>
              <button type="button" class="btn sm gray" id="btn-lbg-fontsize-dec" style="flex:0 0 auto">➖</button>
              <input type="number" id="lbg-fontsize" value="14" min="8" max="30" style="width:60px;text-align:center">
              <button type="button" class="btn sm gray" id="btn-lbg-fontsize-inc" style="flex:0 0 auto">➕</button>
            </div>
          </div>
          <div class="row" style="margin-top:16px">
            <button class="btn primary" id="btn-lbg-save">💾 ذخیره</button>
            <button class="btn primary" id="btn-lbg-word">📄 دانلود Word</button>
            <button class="btn sec" id="btn-lbg-excel">📊 دانلود Excel</button>
            <button class="btn gray" id="btn-lbg-pdf">🖨️ چاپ / دانلود PDF</button>
            <button type="button" class="btn sm sec" id="btn-lbg-print-opts-toggle" title="تنظیمات چاپ" style="flex:0 0 auto">🔧</button>
            <button class="btn danger" type="button" onclick="lbClearContainer('lbg-table')">🗑️ پاک کردن جدول</button>
          </div>
          <div id="lbg-print-opts-drawer" class="cls-options-drawer hidden">
            <div class="row" style="align-items:center;flex-wrap:wrap;gap:8px">
              <label style="flex:0 0 auto">جهت صفحه:</label>
              <select id="lbg-print-orientation" style="flex:0 0 auto;min-width:130px">
                <option value="portrait" selected>عمودی (Portrait)</option>
                <option value="landscape">افقی (Landscape)</option>
              </select>
              <label style="flex:0 0 auto">اندازه فونت:</label>
              <input type="number" id="lbg-print-fontsize" value="10" min="6" max="24" style="width:70px">
              <button class="btn sm primary" id="btn-lbg-print-custom" style="flex:0 0 auto">🖨️ چاپ با این تنظیمات</button>
              <button class="btn sm sec" id="btn-lbg-word-custom" style="flex:0 0 auto">📄 دانلود Word با این تنظیمات</button>
            </div>
          </div>
        </div>

        <!-- ===== درصد قبولی دانش‌آموزان ===== -->
        <div class="lb-panel hidden" id="lb-panel-passrate">
          <button class="btn sm gray lb-back-btn">← بازگشت به دفتر</button>
          <div class="lbg-sheet">
            <h3 class="lbg-title">نمودار درصد قبولی دانش‌آموزان مدرسه
              <input id="lbpr-school" class="lbg-inline-input" placeholder="......................." style="width:180px">
              سال تحصیلی
              <input id="lbpr-year" class="lbg-inline-input" placeholder="......................." style="width:110px">
            </h3>
            <div class="lb-preview">
              <table class="lb-table lbg-table" id="lbpr-table">
                <thead><tr><th>پایه</th><th>تعداد کل دانش‌آموزان</th><th>تعداد قبول</th><th>درصد قبولی</th></tr></thead>
                <tbody>
                  <tr><td>اول</td><td><input type="text" inputmode="numeric" maxlength="3" class="lbpr-total" data-grade="1"></td><td><input type="text" inputmode="numeric" maxlength="3" class="lbpr-pass" data-grade="1"></td><td class="lbpr-pct" data-grade="1">۰٪</td></tr>
                  <tr><td>دوم</td><td><input type="text" inputmode="numeric" maxlength="3" class="lbpr-total" data-grade="2"></td><td><input type="text" inputmode="numeric" maxlength="3" class="lbpr-pass" data-grade="2"></td><td class="lbpr-pct" data-grade="2">۰٪</td></tr>
                  <tr><td>سوم</td><td><input type="text" inputmode="numeric" maxlength="3" class="lbpr-total" data-grade="3"></td><td><input type="text" inputmode="numeric" maxlength="3" class="lbpr-pass" data-grade="3"></td><td class="lbpr-pct" data-grade="3">۰٪</td></tr>
                  <tr><td>چهارم</td><td><input type="text" inputmode="numeric" maxlength="3" class="lbpr-total" data-grade="4"></td><td><input type="text" inputmode="numeric" maxlength="3" class="lbpr-pass" data-grade="4"></td><td class="lbpr-pct" data-grade="4">۰٪</td></tr>
                  <tr><td>پنجم</td><td><input type="text" inputmode="numeric" maxlength="3" class="lbpr-total" data-grade="5"></td><td><input type="text" inputmode="numeric" maxlength="3" class="lbpr-pass" data-grade="5"></td><td class="lbpr-pct" data-grade="5">۰٪</td></tr>
                  <tr><td>ششم</td><td><input type="text" inputmode="numeric" maxlength="3" class="lbpr-total" data-grade="6"></td><td><input type="text" inputmode="numeric" maxlength="3" class="lbpr-pass" data-grade="6"></td><td class="lbpr-pct" data-grade="6">۰٪</td></tr>
                </tbody>
              </table>
            </div>
            <div style="margin:18px 0 6px;text-align:center">
              <canvas id="lbpr-chart" width="700" height="320" style="max-width:100%;background:#fff;border:1px solid var(--line);border-radius:10px"></canvas>
            </div>
            <p class="muted" style="font-size:12px;text-align:center">رنگ‌بندی نمودار: 🟥 قرمز کم‌رنگ = زیر ۶۰٪ (ضعیف) &nbsp;|&nbsp; 🟦 آبی کم‌رنگ = ۶۰ تا ۸۴٪ (متوسط) &nbsp;|&nbsp; 🟩 سبز کم‌رنگ = ۸۵٪ به بالا (خوب)</p>
            <div class="row" style="justify-content:center;align-items:center;margin-top:10px;flex-wrap:wrap;gap:8px">
              <span style="font-weight:700">🔤 فونت:</span>
              <select id="lbpr-font" style="padding:8px;border:1px solid #ddd;border-radius:6px;width:auto">
                <option value="default">پیش‌فرض</option>
                <option value="titr">B Titr</option>
                <option value="nazanin">B Nazanin</option>
                <option value="mitra">B Mitra</option>
              </select>
              <span style="font-weight:700;margin-right:10px">🔠 اندازه فونت جدول:</span>
              <button type="button" class="btn sm gray" id="btn-lbpr-fontsize-dec" style="flex:0 0 auto">➖</button>
              <input type="number" id="lbpr-fontsize" value="14" min="8" max="30" style="width:60px;text-align:center">
              <button type="button" class="btn sm gray" id="btn-lbpr-fontsize-inc" style="flex:0 0 auto">➕</button>
            </div>
          </div>
          <div class="row" style="margin-top:12px">
            <button class="btn primary" id="btn-lbpr-save">💾 ذخیره</button>
            <button class="btn primary" id="btn-lb-passrate-word">📄 دانلود Word</button>
            <button class="btn sec" id="btn-lb-passrate-excel">📊 دانلود Excel</button>
            <button class="btn gray" id="btn-lb-passrate-pdf">🖨️ چاپ / دانلود PDF</button>
            <button type="button" class="btn sm sec" id="btn-lbpr-print-opts-toggle" title="تنظیمات چاپ" style="flex:0 0 auto">🔧</button>
          </div>
          <div id="lbpr-print-opts-drawer" class="cls-options-drawer hidden">
            <div class="row" style="align-items:center;flex-wrap:wrap;gap:8px">
              <label style="flex:0 0 auto">جهت صفحه:</label>
              <select id="lbpr-print-orientation" style="flex:0 0 auto;min-width:130px">
                <option value="portrait" selected>عمودی (Portrait)</option>
                <option value="landscape">افقی (Landscape)</option>
              </select>
              <label style="flex:0 0 auto">اندازه فونت:</label>
              <input type="number" id="lbpr-print-fontsize" value="10" min="6" max="24" style="width:70px">
              <button class="btn sm primary" id="btn-lbpr-print-custom" style="flex:0 0 auto">🖨️ چاپ با این تنظیمات</button>
              <button class="btn sm sec" id="btn-lbpr-word-custom" style="flex:0 0 auto">📄 دانلود Word با این تنظیمات</button>
            </div>
          </div>
        </div>

        <!-- ===== ۳-۲. جدول حضور و غیاب هفتگی (به تفکیک هفته و روز) ===== -->
        <div class="lb-panel hidden" id="lb-panel-attendance2">
          <button class="btn sm gray lb-back-btn">← بازگشت به دفتر</button>
          <div class="lbat-title-wrap">
            <span class="lbat-star lbat-star-1">✦</span>
            <h3 class="lbat-title">🗓️ جدول حضور و غیاب</h3>
            <span class="lbat-star lbat-star-2">✧</span>
            <span class="lbat-deco">🪴📚🖍️</span>
          </div>
          <div class="lb-meta-form">
            <div><label>کلاس</label><input id="lbat-class" placeholder="......................."></div>
            <div><label>معلم</label><input id="lbat-teacher" placeholder="......................."></div>
            <div><label>ماه</label>
              <select id="lbat-month">
                <option>مهر</option><option>آبان</option><option>آذر</option><option>دی</option><option>بهمن</option><option>اسفند</option><option>فروردین</option><option>اردیبهشت</option><option>خرداد</option>
              </select>
            </div>
            <div><label>سال تحصیلی</label><input id="lbat-year" placeholder="......................."></div>
            <div><label>دوره</label><input id="lbat-course" placeholder="......................."></div>
          </div>
          <div class="row">
            <label>تعداد دانش‌آموز: </label><input type="number" id="lbat-rows" value="20" min="1" max="60" style="width:80px">
            <button class="btn sm sec" id="btn-lbat-build">🔄 ساخت جدول</button>
            <button class="btn sm gray" id="btn-lbat-addrow">➕ افزودن ردیف</button>
          </div>
          <div class="lb-preview"><table class="lb-table lb-table-tight lbat-table" id="lbat-table"></table></div>
          <div class="row" style="align-items:center;flex-wrap:wrap;gap:8px;margin-top:8px">
            <span style="font-weight:700">🔤 فونت:</span>
            <select id="lbat-font" style="padding:8px;border:1px solid #ddd;border-radius:6px;width:auto">
              <option value="default">پیش‌فرض</option>
              <option value="titr">B Titr</option>
              <option value="nazanin">B Nazanin</option>
              <option value="mitra">B Mitra</option>
            </select>
            <span style="font-weight:700;margin-right:10px">🔠 اندازه فونت جدول:</span>
            <button type="button" class="btn sm gray" id="btn-lbat-fontsize-dec" style="flex:0 0 auto">➖</button>
            <input type="number" id="lbat-fontsize" value="11" min="6" max="30" style="width:60px;text-align:center">
            <button type="button" class="btn sm gray" id="btn-lbat-fontsize-inc" style="flex:0 0 auto">➕</button>
          </div>
          <div class="row" style="margin-top:12px">
            <button class="btn primary" id="btn-lbat-save">💾 ذخیره</button>
            <button class="btn primary" id="btn-lb-attendance2-word">📄 دانلود Word</button>
            <button class="btn sec" id="btn-lb-attendance2-excel">📊 دانلود Excel</button>
            <button class="btn gray" id="btn-lb-attendance2-pdf">🖨️ چاپ / دانلود PDF</button>
            <button type="button" class="btn sm sec" id="btn-lbat-print-opts-toggle" title="تنظیمات چاپ" style="flex:0 0 auto">🔧</button>
            <button class="btn danger" type="button" onclick="lbClearContainer('lbat-table')">🗑️ پاک کردن جدول</button>
          </div>
          <div id="lbat-print-opts-drawer" class="cls-options-drawer hidden">
            <div class="row" style="align-items:center;flex-wrap:wrap;gap:8px">
              <label style="flex:0 0 auto">جهت صفحه:</label>
              <select id="lbat-print-orientation" style="flex:0 0 auto;min-width:130px">
                <option value="landscape" selected>افقی (Landscape)</option>
                <option value="portrait">عمودی (Portrait)</option>
              </select>
              <label style="flex:0 0 auto">اندازه فونت:</label>
              <input type="number" id="lbat-print-fontsize" value="10" min="6" max="24" style="width:70px">
              <button class="btn sm primary" id="btn-lbat-print-custom" style="flex:0 0 auto">🖨️ چاپ با این تنظیمات</button>
              <button class="btn sm sec" id="btn-lbat-word-custom" style="flex:0 0 auto">📄 دانلود Word با این تنظیمات</button>
            </div>
          </div>
        </div>

        <!-- ===== ۳-۳. گروه‌بندی دانش‌آموزان (کارت‌های رنگی) ===== -->
        <div class="lb-panel hidden" id="lb-panel-grouping">
          <button class="btn sm gray lb-back-btn">← بازگشت به دفتر</button>
          <div class="lbgrp-title-wrap">
            <span class="lbgrp-star">✦</span>
            <h3 class="lbgrp-title">🧩 گروه‌بندی دانش‌آموزان</h3>
            <span class="lbgrp-star">✧</span>
          </div>
          <div class="lb-meta-form">
            <div><label>نام مدرسه</label><input id="lbgrp-school" placeholder="......................."></div>
            <div><label>نام آموزگار</label><input id="lbgrp-teacher" placeholder="......................."></div>
            <div>
              <label>پایه تحصیلی</label>
              <select id="lbgrp-grade-select" class="lbgrp-grade-select">
                <option value="1">پایه اول</option>
                <option value="2">پایه دوم</option>
                <option value="3">پایه سوم</option>
                <option value="4">پایه چهارم</option>
                <option value="5">پایه پنجم</option>
                <option value="6">پایه ششم</option>
              </select>
            </div>
            <div><label>سال تحصیلی</label><input id="lbgrp-year" placeholder="......................."></div>
          </div>
          <div class="row">
            <label>تعداد نفر هر گروه: </label><input type="number" id="lbgrp-rows" value="10" min="1" max="20" style="width:80px">
            <button class="btn sm sec" id="btn-lbgrp-build">🔄 ساخت جدول‌ها</button>
            <button class="btn sm primary" id="btn-lbgrp-addgroup">➕ افزودن گروه</button>
          </div>
          <div class="lbgrp-grid" id="lbgrp-groups-container"></div>
          <div class="row" style="margin-top:12px">
            <button class="btn primary" id="btn-lbgrp-save">💾 ذخیره</button>
            <button class="btn primary" id="btn-lbgrp-word">📄 دانلود Word</button>
            <button class="btn sec" id="btn-lbgrp-excel">📊 دانلود Excel</button>
            <button class="btn gray" id="btn-lbgrp-pdf">🖨️ چاپ / دانلود PDF</button>
            <button class="btn danger" type="button" id="btn-lbgrp-clear">🗑️ پاک کردن همه گروه‌ها</button>
          </div>
        </div>

        <!-- ===== ۴. ثبت سطوح عملکرد دانش‌آموز ===== -->
        <div class="lb-panel hidden" id="lb-panel-performance">
          <button class="btn sm gray lb-back-btn">← بازگشت به دفتر</button>
          <h3>📈 جدول شماره ۸: ثبت سطوح عملکرد دانش‌آموز</h3>
          <p class="muted">ثبت سطوح عملکرد دانش‌آموز براساس انتظارات آموزشی هر یک از کتب درسی</p>
          <div class="row" style="align-items:center">
            <label style="flex:0 0 auto">پایه تحصیلی:</label>
            <select id="lbf-grade-select" style="flex:0 0 auto;min-width:180px">
              <option value="0">پایه اول دبستان</option>
              <option value="1">پایه دوم دبستان</option>
              <option value="2">پایه سوم دبستان</option>
              <option value="3">پایه چهارم دبستان</option>
              <option value="4">پایه پنجم دبستان</option>
              <option value="5">پایه ششم دبستان</option>
            </select>
          </div>
          <div class="row" style="align-items:center;flex-wrap:wrap;gap:8px">
            <label style="flex:0 0 auto">دانش‌آموز:</label>
            <select id="lbf-student-select" style="flex:0 0 auto;min-width:220px">
              <option value="">— انتخاب دانش‌آموز —</option>
            </select>
            <button class="btn sm sec" id="btn-lbf-new">🆕 دانش‌آموز جدید</button>
            <button class="btn sm danger hidden" id="btn-lbf-delete">🗑️ حذف این دانش‌آموز</button>
          </div>
          <div id="lbf-form-wrap" class="hidden">
            <div class="row" style="align-items:center;gap:14px;margin:10px 0">
              <img id="lbf-photo-preview" class="hidden" style="width:44px;height:44px;border-radius:50%;object-fit:cover;border:1px solid var(--line)">
              <label class="btn sm sec" style="cursor:pointer">📷 عکس پروفایل دانش‌آموز<input type="file" accept="image/*" id="lbf-photo-input" style="display:none"></label>
              <button class="btn sm gray hidden" id="btn-lbf-photo-remove">🗑️ حذف عکس</button>
            </div>
            <div class="lb-meta-form">
              <div><label>نام مدرسه</label><input id="lbf-school" placeholder="......................."></div>
              <div><label>نام آموزگار</label><input id="lbf-teacher" placeholder="......................."></div>
              <div><label>سال تحصیلی</label><input id="lbf-year" placeholder="......................."></div>
              <div><label>نام دانش‌آموز</label><input id="lbf-student-name" placeholder="نام و نام خانوادگی دانش‌آموز"></div>
            </div>
            <div class="row">
              <label>تعداد ستون‌های ثبت عملکرد: </label><input type="number" id="lbf-cols" value="12" min="1" max="60" style="width:80px">
              <button class="btn sm sec" id="btn-lbf-build">🔄 ساخت جدول</button>
            </div>
            <div class="lb-preview" id="lb-performance-preview"></div>
            <p class="muted" style="margin-top:10px">لازم به ذکر است انتظارات آموزشی تمامی پایه‌ها در جدول شماره ۸ ارائه گردیده. آموزگاران بر پایه بر انتظارات پیش‌بینی شده نسبت به تکمیل جدول اقدام می‌نمایند.</p>
            <div class="row" style="align-items:center;flex-wrap:wrap;gap:8px">
              <span style="font-weight:700">🔤 فونت:</span>
              <select id="lbf-font" style="padding:8px;border:1px solid #ddd;border-radius:6px;width:auto">
                <option value="default">پیش‌فرض</option>
                <option value="titr">B Titr</option>
                <option value="nazanin">B Nazanin</option>
                <option value="mitra">B Mitra</option>
              </select>
              <span style="font-weight:700;margin-right:10px">🔠 اندازه فونت جدول:</span>
              <button type="button" class="btn sm gray" id="btn-lbf-fontsize-dec" style="flex:0 0 auto">➖</button>
              <input type="number" id="lbf-fontsize" value="11" min="6" max="30" style="width:60px;text-align:center">
              <button type="button" class="btn sm gray" id="btn-lbf-fontsize-inc" style="flex:0 0 auto">➕</button>
            </div>
            <div class="row" style="margin-top:12px">
              <button class="btn primary" id="btn-lbf-save">💾 ذخیره</button>
              <button class="btn primary" id="btn-lb-performance-word">📄 دانلود Word</button>
              <button class="btn sec" id="btn-lb-performance-excel">📊 دانلود Excel</button>
              <button class="btn gray" id="btn-lb-performance-pdf">🖨️ چاپ / دانلود PDF</button>
              <button type="button" class="btn sm sec" id="btn-lbf-print-opts-toggle" title="تنظیمات چاپ" style="flex:0 0 auto">🔧</button>
              <button class="btn danger" type="button" onclick="lbClearContainer('lb-performance-preview')">🗑️ پاک کردن جدول</button>
            </div>
            <div id="lbf-print-opts-drawer" class="cls-options-drawer hidden">
              <div class="row" style="align-items:center;flex-wrap:wrap;gap:8px">
                <label style="flex:0 0 auto">جهت صفحه:</label>
                <select id="lbf-print-orientation" style="flex:0 0 auto;min-width:130px">
                  <option value="landscape" selected>افقی (Landscape)</option>
                  <option value="portrait">عمودی (Portrait)</option>
                </select>
                <label style="flex:0 0 auto">اندازه فونت:</label>
                <input type="number" id="lbf-print-fontsize" value="10" min="6" max="24" style="width:70px">
                <button class="btn sm primary" id="btn-lbf-print-custom" style="flex:0 0 auto">🖨️ چاپ با این تنظیمات</button>
                <button class="btn sm sec" id="btn-lbf-word-custom" style="flex:0 0 auto">📄 دانلود Word با این تنظیمات</button>
              </div>
            </div>
          </div>
        </div>

        <!-- ===== کارنامه‌ساز ===== -->
        <div class="lb-panel hidden" id="lb-panel-reportcard">
          <button class="btn sm gray lb-back-btn">← بازگشت به دفتر</button>
          <h3>🎓 کارنامه‌ساز (ارزشیابی توصیفی)</h3>
          <p class="muted">تکمیل کارنامه‌ی توصیفی هر دانش‌آموز به تفکیک درس‌های همان پایه</p>
          <div class="row" style="align-items:center">
            <label style="flex:0 0 auto">پایه تحصیلی:</label>
            <select id="rc-grade-select" style="flex:0 0 auto;min-width:180px">
              <option value="0">پایه اول دبستان</option>
              <option value="1">پایه دوم دبستان</option>
              <option value="2">پایه سوم دبستان</option>
              <option value="3">پایه چهارم دبستان</option>
              <option value="4">پایه پنجم دبستان</option>
              <option value="5">پایه ششم دبستان</option>
            </select>
            <label style="flex:0 0 auto">ماه:</label>
            <select id="rc-month-select" style="flex:0 0 auto;min-width:120px">
              <option value="مهر">مهر</option>
              <option value="آبان">آبان</option>
              <option value="آذر">آذر</option>
              <option value="دی">دی</option>
              <option value="بهمن">بهمن</option>
              <option value="اسفند">اسفند</option>
              <option value="فروردین">فروردین</option>
              <option value="اردیبهشت">اردیبهشت</option>
            </select>
          </div>
          <div class="row" style="align-items:center;flex-wrap:wrap;gap:8px">
            <label style="flex:0 0 auto">دانش‌آموز:</label>
            <select id="rc-student-select" style="flex:0 0 auto;min-width:220px">
              <option value="">— انتخاب دانش‌آموز —</option>
            </select>
            <button class="btn sm danger hidden" id="btn-rc-delete">🗑️ حذف این کارنامه</button>
          </div>
          <p class="muted" style="margin:4px 0 0">دانش‌آموز موردنظر را نمی‌بینید؟ ابتدا از بخش «لیست اسامی دانش‌آموزان» او را اضافه کنید؛ فقط کارنامه‌ی دانش‌آموزانی که در همان بخش ثبت شده‌اند در پنل خودشان نمایش داده می‌شود.</p>
          <div id="rc-form-wrap" class="hidden">
            <div class="rc-header-box">
              <div class="rc-photo-wrap">
                <img id="rc-photo-preview" class="hidden">
                <div id="rc-photo-placeholder" class="rc-photo-placeholder">بدون عکس</div>
                <label class="btn sm sec" style="cursor:pointer">📷 بارگذاری عکس<input type="file" accept="image/*" id="rc-photo-input" style="display:none"></label>
                <button class="btn sm gray hidden" id="btn-rc-photo-remove">🗑️ حذف</button>
              </div>
              <div class="lb-meta-form">
                <div><label>نام مدرسه</label><input id="rc-school" placeholder="......................."></div>
                <div><label>نام آموزگار</label><input id="rc-teacher" placeholder="......................."></div>
                <div><label>سال تحصیلی</label><input id="rc-year" placeholder="......................."></div>
                <div><label>نام دانش‌آموز</label><input id="rc-student-name" placeholder="نام و نام خانوادگی دانش‌آموز"></div>
                <div><label>تعداد غیبت (روز)</label><input id="rc-absence" placeholder="۰" style="width:80px"></div>
              </div>
            </div>
            <div class="lb-preview" id="rc-subjects-preview"></div>
            <label style="margin-top:10px;display:block">توضیحات کلی معلم درباره‌ی روند یادگیری و رفتار دانش‌آموز</label>
            <textarea id="rc-general-note" rows="4" class="lb-textarea" placeholder="توضیحات کلی، نقاط قوت و پیشنهاد برای بهبود..."></textarea>
            <p class="muted" style="font-size:12px;margin-top:6px">سطوح ارزشیابی: خیلی خوب | خوب | قابل‌قبول | نیاز به تلاش</p>
            <div class="row" style="justify-content:center;align-items:center;margin-top:10px;flex-wrap:wrap;gap:8px">
              <span style="font-weight:700">🔤 فونت:</span>
              <select id="rc-font" style="padding:8px;border:1px solid #ddd;border-radius:6px;width:auto">
                <option value="default">پیش‌فرض</option>
                <option value="titr">B Titr</option>
                <option value="nazanin">B Nazanin</option>
                <option value="mitra">B Mitra</option>
              </select>
              <span style="font-weight:700;margin-right:10px">🔠 اندازه فونت جدول:</span>
              <button type="button" class="btn sm gray" id="btn-rc-fontsize-dec" style="flex:0 0 auto">➖</button>
              <input type="number" id="rc-fontsize" value="12" min="6" max="30" style="width:60px;text-align:center">
              <button type="button" class="btn sm gray" id="btn-rc-fontsize-inc" style="flex:0 0 auto">➕</button>
            </div>
            <div class="row" style="margin-top:12px">
              <button class="btn primary" id="btn-rc-save">💾 ذخیره</button>
              <button class="btn primary" id="btn-rc-word">📄 دانلود Word</button>
              <button class="btn sec" id="btn-rc-excel">📊 دانلود Excel</button>
              <button class="btn gray" id="btn-rc-pdf">🖨️ چاپ / دانلود PDF</button>
              <button type="button" class="btn sm sec" id="btn-rc-print-opts-toggle" title="تنظیمات چاپ" style="flex:0 0 auto">🔧</button>
            </div>
            <div id="rc-print-opts-drawer" class="cls-options-drawer hidden">
              <div class="row" style="align-items:center;flex-wrap:wrap;gap:8px">
                <label style="flex:0 0 auto">جهت صفحه:</label>
                <select id="rc-print-orientation" style="flex:0 0 auto;min-width:130px">
                  <option value="portrait" selected>عمودی (Portrait)</option>
                  <option value="landscape">افقی (Landscape)</option>
                </select>
                <label style="flex:0 0 auto">اندازه فونت:</label>
                <input type="number" id="rc-print-fontsize" value="10" min="6" max="24" style="width:70px">
                <button class="btn sm primary" id="btn-rc-print-custom" style="flex:0 0 auto">🖨️ چاپ با این تنظیمات</button>
                <button class="btn sm sec" id="btn-rc-word-custom" style="flex:0 0 auto">📄 دانلود Word با این تنظیمات</button>
              </div>
            </div>
          </div>
        </div>

        <!-- ===== ۵. صورتجلسه شورای آموزشی اولیا ===== -->
        <div class="lb-panel hidden" id="lb-panel-council">
          <button class="btn sm gray lb-back-btn">← بازگشت به دفتر</button>
          <h3>🗣️ جدول شماره ۱: جلسات شورای آموزشی اولیا</h3>
          <div class="lb-meta-form">
            <div><label>تاریخ برگزاری</label><input id="lbc-date" placeholder="......................."></div>
            <div><label>موضوع جلسه</label><input id="lbc-topic" placeholder="......................."></div>
            <div><label>شماره جلسه</label><input id="lbc-num" placeholder="......................."></div>
            <div><label>ساعت تشکیل</label><input id="lbc-time" placeholder="......................."></div>
          </div>
          <label>۱- خلاصه مباحث مطرح شده</label>
          <textarea id="lbc-summary" rows="5" class="lb-textarea" placeholder="شرح مباحث و موضوعات مطرح‌شده در جلسه..."></textarea>
          <label>۲- تصمیمات و پیشنهادهای ارائه‌شده</label>
          <textarea id="lbc-decisions" rows="5" class="lb-textarea" placeholder="مصوبات، پیشنهادها و راهکارهای آموزشی..."></textarea>
          <div class="row">
            <label>۳- تعداد اعضای جلسه: </label><input type="number" id="lbc-rows" value="10" min="1" max="40" style="width:80px">
            <button class="btn sm sec" id="btn-lbc-build">🔄 ساخت جدول اعضا</button>
            <button class="btn sm gray" id="btn-lbc-addrow">➕ افزودن ردیف</button>
          </div>
          <div class="lb-preview"><table class="lb-table" id="lbc-table"></table></div>
          <p style="margin-top:10px"><b>امضاء و تأیید مدیر مدرسه:</b> .......................</p>
          <div class="row" style="align-items:center;flex-wrap:wrap;gap:8px">
            <span style="font-weight:700">🔤 فونت:</span>
            <select id="lbc-font" style="padding:8px;border:1px solid #ddd;border-radius:6px;width:auto">
              <option value="default">پیش‌فرض</option>
              <option value="titr">B Titr</option>
              <option value="nazanin">B Nazanin</option>
              <option value="mitra">B Mitra</option>
            </select>
            <span style="font-weight:700;margin-right:10px">🔠 اندازه فونت جدول:</span>
            <button type="button" class="btn sm gray" id="btn-lbc-fontsize-dec" style="flex:0 0 auto">➖</button>
            <input type="number" id="lbc-fontsize" value="12" min="6" max="30" style="width:60px;text-align:center">
            <button type="button" class="btn sm gray" id="btn-lbc-fontsize-inc" style="flex:0 0 auto">➕</button>
          </div>
          <div class="row" style="margin-top:12px">
            <button class="btn primary" id="btn-lbc-save">💾 ذخیره</button>
            <button class="btn primary" id="btn-lb-council-word">📄 دانلود Word</button>
            <button class="btn sec" id="btn-lb-council-excel">📊 دانلود Excel</button>
            <button class="btn gray" id="btn-lb-council-pdf">🖨️ چاپ / دانلود PDF</button>
            <button type="button" class="btn sm sec" id="btn-lbc-print-opts-toggle" title="تنظیمات چاپ" style="flex:0 0 auto">🔧</button>
            <button class="btn danger" type="button" onclick="lbClearContainer('lbc-table')">🗑️ پاک کردن جدول</button>
          </div>
          <div id="lbc-print-opts-drawer" class="cls-options-drawer hidden">
            <div class="row" style="align-items:center;flex-wrap:wrap;gap:8px">
              <label style="flex:0 0 auto">جهت صفحه:</label>
              <select id="lbc-print-orientation" style="flex:0 0 auto;min-width:130px">
                <option value="portrait" selected>عمودی (Portrait)</option>
                <option value="landscape">افقی (Landscape)</option>
              </select>
              <label style="flex:0 0 auto">اندازه فونت:</label>
              <input type="number" id="lbc-print-fontsize" value="10" min="6" max="24" style="width:70px">
              <button class="btn sm primary" id="btn-lbc-print-custom" style="flex:0 0 auto">🖨️ چاپ با این تنظیمات</button>
              <button class="btn sm sec" id="btn-lbc-word-custom" style="flex:0 0 auto">📄 دانلود Word با این تنظیمات</button>
            </div>
          </div>
        </div>

        <!-- ===== ۶. جلسات فردی با اولیا ===== -->
        <div class="lb-panel hidden" id="lb-panel-meetings">
          <button class="btn sm gray lb-back-btn">← بازگشت به دفتر</button>
          <h3>🤝 جدول ۱۰ - جلسات فردی با اولیا</h3>
          <div class="lb-meta-form">
            <div><label>نام مدرسه</label><input id="lbm-school" placeholder="......................."></div>
            <div><label>نام آموزگار</label><input id="lbm-teacher" placeholder="......................."></div>
            <div><label>پایه تحصیلی</label><input id="lbm-grade" placeholder="......................."></div>
            <div><label>سال تحصیلی</label><input id="lbm-year" placeholder="......................."></div>
          </div>
          <div class="row">
            <label>تعداد ردیف: </label><input type="number" id="lbm-rows" value="15" min="1" max="60" style="width:80px">
            <button class="btn sm sec" id="btn-lbm-build">🔄 ساخت جدول</button>
            <button class="btn sm gray" id="btn-lbm-addrow">➕ افزودن ردیف (ادامه جلسات)</button>
          </div>
          <div class="lb-preview"><table class="lb-table" id="lbm-table"></table></div>
          <div class="row" style="margin-top:12px">
            <button class="btn primary" id="btn-lbm-save">💾 ذخیره</button>
            <button class="btn primary" id="btn-lb-meetings-word">📄 دانلود Word</button>
            <button class="btn sec" id="btn-lb-meetings-excel">📊 دانلود Excel</button>
            <button class="btn gray" id="btn-lb-meetings-pdf">🖨️ چاپ / دانلود PDF</button>
            <button class="btn danger" type="button" onclick="lbClearContainer('lbm-table')">🗑️ پاک کردن جدول</button>
          </div>
        </div>

        <!-- ===== ۷. برنامه درسی هفتگی (ویژه چندپایه) ===== -->
        <div class="lb-panel hidden" id="lb-panel-weekly">
          <button class="btn sm gray lb-back-btn">← بازگشت به دفتر</button>
          <h3>📅 جدول ۱-۳-۱ ـ برنامه درسی هفتگی (ویژه چندپایه)</h3>
          <div class="lb-meta-form">
            <div><label>نام مدرسه</label><input id="lbw-school" placeholder="......................."></div>
            <div><label>نام آموزگار</label><input id="lbw-teacher" placeholder="......................."></div>
            <div><label>کلاس</label><input id="lbw-class" placeholder="......................."></div>
          </div>
          <div class="row" style="flex-wrap:wrap;gap:10px;align-items:center">
            <label style="flex:0 0 auto">پایه‌هایی که تدریس می‌کنید:</label>
            <label style="flex:0 0 auto"><input type="checkbox" class="lbw-grade-chk" checked> اول</label>
            <label style="flex:0 0 auto"><input type="checkbox" class="lbw-grade-chk" checked> دوم</label>
            <label style="flex:0 0 auto"><input type="checkbox" class="lbw-grade-chk" checked> سوم</label>
            <label style="flex:0 0 auto"><input type="checkbox" class="lbw-grade-chk" checked> چهارم</label>
            <label style="flex:0 0 auto"><input type="checkbox" class="lbw-grade-chk" checked> پنجم</label>
            <label style="flex:0 0 auto"><input type="checkbox" class="lbw-grade-chk" checked> ششم</label>
            <button class="btn sm sec" id="btn-lbw-build">🔄 ساخت جدول</button>
          </div>
          <div class="lb-font-toolbar">
            <label>فونت جدول:</label>
            <select id="lbw-font">
              <option value="bnazanin">B Nazanin Bold</option>
              <option value="bmitra">B Mitra</option>
            </select>
            <label>اندازه فونت:</label>
            <input type="number" id="lbw-font-size" min="8" max="40" step="1" value="12" style="width:70px">
            <span class="muted">با زدن اینتر داخل هر خانه، متن به خط بعد می‌رود و ارتفاع خانه بزرگ‌تر می‌شود.</span>
          </div>
          <div class="lb-preview" id="lb-weekly-preview"></div>
          <div class="row" style="margin-top:12px">
            <button class="btn primary" id="btn-lbw-save">💾 ذخیره</button>
            <button class="btn primary" id="btn-lb-weekly-word">📄 دانلود Word</button>
            <button class="btn sec" id="btn-lb-weekly-excel">📊 دانلود Excel</button>
            <button class="btn gray" id="btn-lb-weekly-pdf">🖨️ چاپ / دانلود PDF</button>
            <button type="button" class="btn sm sec" id="btn-lbw-print-opts-toggle" title="تنظیمات چاپ" style="flex:0 0 auto">🔧</button>
            <button class="btn danger" type="button" onclick="lbClearContainer('lb-weekly-preview')">🗑️ پاک کردن جدول</button>
          </div>
          <div id="lbw-print-opts-drawer" class="cls-options-drawer hidden">
            <div class="row" style="align-items:center;flex-wrap:wrap;gap:8px">
              <label style="flex:0 0 auto">جهت صفحه:</label>
              <select id="lbw-print-orientation" style="flex:0 0 auto;min-width:130px">
                <option value="portrait" selected>عمودی (Portrait)</option>
                <option value="landscape">افقی (Landscape)</option>
              </select>
              <button class="btn sm primary" id="btn-lbw-print-custom" style="flex:0 0 auto">🖨️ چاپ با این تنظیمات</button>
              <button class="btn sm sec" id="btn-lbw-word-custom" style="flex:0 0 auto">📄 دانلود Word با این تنظیمات</button>
            </div>
          </div>
        </div>

        <!-- ===== ۸. برنامه درسی هفتگی (کلاس تک‌پایه) ===== -->
        <div class="lb-panel hidden" id="lb-panel-weekly2">
          <button class="btn sm gray lb-back-btn">← بازگشت به دفتر</button>
          <h3>🗓️ جدول ۳- برنامه درسی هفتگی (کلاس تک پایه)</h3>
          <div class="lb-meta-form">
            <div><label>نام مدرسه</label><input id="lbw2-school" placeholder="......................."></div>
            <div><label>نام آموزگار</label><input id="lbw2-teacher" placeholder="......................."></div>
            <div><label>پایه</label><input id="lbw2-grade" placeholder="......................."></div>
            <div><label>کلاس</label><input id="lbw2-class" placeholder="......................."></div>
          </div>
          <div class="lb-font-toolbar">
            <label>فونت جدول:</label>
            <select id="lbw2-font">
              <option value="bnazanin">B Nazanin Bold</option>
              <option value="bmitra">B Mitra</option>
            </select>
            <label>اندازه فونت:</label>
            <input type="number" id="lbw2-font-size" min="8" max="40" step="1" value="12" style="width:70px">
            <span class="muted">با زدن اینتر داخل هر خانه، متن به خط بعد می‌رود و ارتفاع خانه بزرگ‌تر می‌شود.</span>
          </div>
          <div class="lb-preview" id="lb-weekly2-preview"></div>
          <div class="row" style="margin-top:12px">
            <button class="btn primary" id="btn-lbw2-save">💾 ذخیره</button>
            <button class="btn primary" id="btn-lb-weekly2-word">📄 دانلود Word</button>
            <button class="btn sec" id="btn-lb-weekly2-excel">📊 دانلود Excel</button>
            <button class="btn gray" id="btn-lb-weekly2-pdf">🖨️ چاپ / دانلود PDF</button>
            <button type="button" class="btn sm sec" id="btn-lbw2-print-opts-toggle" title="تنظیمات چاپ" style="flex:0 0 auto">🔧</button>
            <button class="btn danger" type="button" onclick="lbClearContainer('lb-weekly2-preview')">🗑️ پاک کردن جدول</button>
          </div>
          <div id="lbw2-print-opts-drawer" class="cls-options-drawer hidden">
            <div class="row" style="align-items:center;flex-wrap:wrap;gap:8px">
              <label style="flex:0 0 auto">جهت صفحه:</label>
              <select id="lbw2-print-orientation" style="flex:0 0 auto;min-width:130px">
                <option value="portrait" selected>عمودی (Portrait)</option>
                <option value="landscape">افقی (Landscape)</option>
              </select>
              <button class="btn sm primary" id="btn-lbw2-print-custom" style="flex:0 0 auto">🖨️ چاپ با این تنظیمات</button>
              <button class="btn sm sec" id="btn-lbw2-word-custom" style="flex:0 0 auto">📄 دانلود Word با این تنظیمات</button>
            </div>
          </div>
        </div>

        <!-- ===== ۹. اطلاعات پرسنلی همکاران مدرسه ===== -->
        <div class="lb-panel hidden" id="lb-panel-staff">
          <button class="btn sm gray lb-back-btn">← بازگشت به دفتر</button>
          <h3>🪪 اطلاعات پرسنلی همکاران مدرسه</h3>
          <div class="lb-meta-form">
            <div><label>سال تحصیلی</label><input id="lbs-year" placeholder="......................."></div>
          </div>
          <div class="row">
            <label>تعداد ردیف: </label><input type="number" id="lbs-rows" value="15" min="1" max="60" style="width:80px">
            <button class="btn sm sec" id="btn-lbs-build">🔄 ساخت جدول</button>
            <button class="btn sm gray" id="btn-lbs-addrow">➕ افزودن ردیف</button>
          </div>
          <div class="lb-font-toolbar">
            <label>فونت جدول:</label>
            <select id="lbs-font">
              <option value="bnazanin">B Nazanin Bold</option>
              <option value="bmitra">B Mitra</option>
            </select>
            <label>اندازه فونت:</label>
            <input type="number" id="lbs-font-size" min="8" max="40" step="1" value="12" style="width:70px">
            <span class="muted">برای بزرگ/کوچک کردن کل جدول، گوشه‌ی پایین‌چپ آن را با ماوس بکشید.</span>
          </div>
          <div class="lb-preview">
            <div class="lb-resize-wrap" id="lbs-resize-wrap">
              <table class="lb-table lb-table-zebra" id="lbs-table"></table>
              <div class="lb-resize-handle" id="lbs-resize-handle" title="بکشید تا جدول بزرگ/کوچک شود">⤡</div>
            </div>
          </div>
          <div class="row" style="margin-top:12px">
            <button class="btn primary" id="btn-lbs-save">💾 ذخیره</button>
            <button class="btn primary" id="btn-lb-staff-word">📄 دانلود Word</button>
            <button class="btn sec" id="btn-lb-staff-excel">📊 دانلود Excel</button>
            <button class="btn gray" id="btn-lb-staff-pdf">🖨️ چاپ / دانلود PDF</button>
            <button class="btn danger" type="button" onclick="lbClearContainer('lbs-table')">🗑️ پاک کردن جدول</button>
          </div>
        </div>

        <!-- ===== ۱۰. صورتجلسه (فرم عمومی) ===== -->
        <div class="lb-panel hidden" id="lb-panel-minutes">
          <button class="btn sm gray lb-back-btn">← بازگشت به دفتر</button>
          <div class="row" style="align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px">
            <h3 style="margin:0">🧾 صورتجلسه</h3>
            <input id="lbmin-title" placeholder="عنوان صورتجلسه (اختیاری، مثلاً: صورتجلسه شورای معلمان)" style="flex:1;min-width:220px">
          </div>
          <div class="row" style="align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px">
            <label style="flex:0 0 auto;font-weight:700">فونت سند خروجی:</label>
            <select id="lbmin-font" style="flex:0 0 auto;min-width:170px">
              <option value="nazanin">بی‌نازنین Bold</option>
              <option value="titr">بی‌تیتر</option>
            </select>
            <label style="flex:0 0 auto;font-weight:700">اندازه فونت:</label>
            <input type="number" id="lbmin-font-size" min="8" max="36" step="1" value="14" style="width:70px;padding:6px;border:1px solid #ddd;border-radius:6px">
          </div>
          <p class="muted" style="text-align:center;font-weight:700;margin:0 0 10px">بسمه‌تعالی</p>
          <div class="lb-meta-form">
            <div><label>شماره جلسه</label><input id="lbmin-num" placeholder="......................."></div>
            <div><label>روز</label><input id="lbmin-day" placeholder="......................."></div>
            <div><label>تاریخ</label><input id="lbmin-date" placeholder="......................."></div>
            <div><label>ساعت شروع</label><input id="lbmin-start" placeholder="......................."></div>
            <div><label>مکان برگزاری</label><input id="lbmin-place" placeholder="......................."></div>
            <div><label>ساعت پایان</label><input id="lbmin-end" placeholder="......................."></div>
          </div>
          <label>دستور کار جلسه</label>
          <textarea id="lbmin-agenda" rows="3" class="lb-textarea" placeholder="دستور کار و موضوعات جلسه..."></textarea>
          <label>خلاصه مذاکرات جلسه</label>
          <textarea id="lbmin-summary" rows="6" class="lb-textarea" placeholder="شرح مذاکرات و مباحث مطرح‌شده در جلسه..."></textarea>

          <div class="row" style="margin-top:14px;align-items:center;flex-wrap:wrap">
            <label style="flex:0 0 auto;font-weight:700">اهم مصوبات جلسه:</label>
            <button class="btn sm sec" id="btn-lbmin-decision-add">➕ افزودن ردیف</button>
            <button class="btn sm gray" id="btn-lbmin-decision-remove">➖ حذف آخرین ردیف</button>
            <button class="btn sm danger" id="btn-lbmin-decision-clearall">🗑️ حذف همه ردیف‌ها</button>
          </div>
          <div class="lb-preview" id="lbmin-decisions-wrap"></div>

          <div class="row" style="margin-top:16px;align-items:center;flex-wrap:wrap">
            <label style="flex:0 0 auto;font-weight:700">اسامی حاضرین در جلسه:</label>
            <button class="btn sm sec" id="btn-lbmin-att-add">➕ افزودن ردیف</button>
            <button class="btn sm gray" id="btn-lbmin-att-remove">➖ حذف آخرین ردیف</button>
            <button class="btn sm danger" id="btn-lbmin-att-clearall">🗑️ حذف همه ردیف‌ها</button>
          </div>
          <div class="lb-preview" id="lbmin-attendees-wrap"></div>

          <p class="muted" style="text-align:center;margin-top:16px">مهر و امضای مدیر مدرسه</p>

          <div class="row" style="margin-top:12px">
            <button class="btn primary" id="btn-lbmin-save">💾 ذخیره</button>
            <button class="btn primary" id="btn-lb-minutes-word">📄 دانلود Word</button>
            <button class="btn gray" id="btn-lb-minutes-pdf">🖨️ چاپ / دانلود PDF</button>
            <button class="btn danger" type="button" id="btn-lbmin-clear">🗑️ پاک کردن فرم</button>
          </div>
        </div>

        <!-- ===== تقدیرنامه‌ساز ===== -->
        <div class="lb-panel hidden" id="lb-panel-certificate">
          <button class="btn sm gray lb-back-btn">← بازگشت به دفتر</button>
          <h3>🏆 تقدیرنامه‌ساز</h3>
          <div class="lb-cert-wrap">
            <div class="lb-cert-form">
              <label>عنوان سند</label>
              <select id="cert-kind">
                <option value="تقدیرنامه">تقدیرنامه</option>
                <option value="لوح تقدیر">لوح تقدیر</option>
                <option value="لوح قهرمانی">لوح قهرمانی</option>
                <option value="گواهی افتخار">گواهی افتخار</option>
                <option value="کارت تشویقی">کارت تشویقی</option>
              </select>
              <label>قالب‌های متنی آماده (اختیاری)</label>
              <div class="lb-cert-templates">
                <button type="button" class="btn sm gray lb-cert-preset-btn" data-preset="colleague">🏅 همکار نمونه</button>
                <button type="button" class="btn sm gray lb-cert-preset-btn" data-preset="student">🎓 دانش‌آموز ممتاز</button>
                <button type="button" class="btn sm gray lb-cert-preset-btn" data-preset="teacher">📚 مدرس برتر</button>
              </div>
              <div class="lb-meta-form">
                <div><label>شماره</label><input id="cert-num" placeholder="......."></div>
                <div><label>تاریخ</label><input id="cert-date" placeholder="......."></div>
              </div>
              <label>دانش‌آموز</label>
              <div class="row" style="gap:8px">
                <select id="cert-student-select" style="flex:1"><option value="">— انتخاب از لیست دانش‌آموزان —</option></select>
              </div>
              <div class="row" style="gap:8px;margin-top:6px">
                <select id="cert-salute" style="flex:0 0 auto;min-width:130px">
                  <option value="جناب آقای">جناب آقای</option>
                  <option value="سرکار خانم">سرکار خانم</option>
                  <option value="دانش‌آموز عزیز">دانش‌آموز عزیز</option>
                </select>
                <input id="cert-name" placeholder="یا نام را اینجا مستقیم تایپ کنید" style="flex:1">
              </div>
              <label>متن مقدمه</label>
              <input id="cert-intro" placeholder="این تقدیرنامه به پاس ...">
              <label>دلیل تشویق</label>
              <textarea id="cert-reason" rows="3" class="lb-textarea" placeholder="مثلاً: کسب رتبه‌ی اول در مسابقات علمی کلاس، تلاش و پشتکار در طول سال تحصیلی و ..."></textarea>
              <label>اعطاکننده (معلم/مدیر/اداره)</label>
              <input id="cert-issuer" placeholder=".......................">
              <label>امضای مدیر / اعطاکننده (عکس، اختیاری)</label>
              <div class="row" style="gap:8px;align-items:center">
                <input type="file" id="cert-sign-file" accept="image/*" style="flex:1">
                <button type="button" class="btn sm gray" id="btn-cert-sign-remove">حذف</button>
              </div>
              <label>نشان سازمان یا عکس فرد (جایگزین نماد بالای لوح، اختیاری)</label>
              <div class="row" style="gap:8px;align-items:center">
                <input type="file" id="cert-logo-file" accept="image/*" style="flex:1">
                <button type="button" class="btn sm gray" id="btn-cert-logo-remove">حذف</button>
              </div>
              <label>فونت متن</label>
              <select id="cert-font">
                <option value="shik" selected>🎩 شیک (ترکیبی حرفه‌ای)</option>
                <option value="titr">بی‌تیتر</option>
                <option value="nazanin">بی‌نازنین</option>
                <option value="nastaliq">ایران نستعلیق</option>
                <option value="vazirmatn">وزیرمتن (مدرن)</option>
                <option value="koodak">بی‌کودک (گرد و صمیمی)</option>
                <option value="mitra">بی‌میترا</option>
              </select>
              <label>اندازه فونت متن تقدیرنامه (دلیل تشویق)</label>
              <div class="row" style="align-items:center;gap:8px">
                <input type="range" id="cert-font-size" min="10" max="26" step="1" value="13" style="flex:1">
                <span id="cert-font-size-val" style="min-width:34px;font-weight:700">۱۳</span>
              </div>
              <label>تصویر پس‌زمینه دلخواه (اختیاری)</label>
              <div class="row" style="gap:8px;align-items:center">
                <input type="file" id="cert-bg-file" accept="image/*" style="flex:1">
                <button type="button" class="btn sm gray" id="btn-cert-bg-remove">حذف</button>
              </div>
              <div id="cert-bg-controls" class="hidden" style="display:flex;flex-direction:column;gap:6px;background:#f8fafc;border:1px solid var(--line);border-radius:8px;padding:10px;margin-top:4px">
                <div class="row" style="align-items:center;gap:8px">
                  <label style="margin:0;min-width:70px">بزرگ/کوچک</label>
                  <input type="range" id="cert-bg-zoom" min="50" max="250" step="1" value="100" style="flex:1">
                  <span id="cert-bg-zoom-val" style="min-width:44px;font-weight:700">۱۰۰٪</span>
                </div>
                <div class="row" style="align-items:center;gap:8px">
                  <label style="margin:0;min-width:70px">شفافیت</label>
                  <input type="range" id="cert-bg-opacity" min="15" max="100" step="1" value="100" style="flex:1">
                  <span id="cert-bg-opacity-val" style="min-width:44px;font-weight:700">۱۰۰٪</span>
                </div>
                <p class="muted" style="margin:2px 0 0;font-size:11.5px">💡 برای جابه‌جا کردن تصویر، آن را در پیش‌نمایش با موس یا انگشت بکشید (درگ کنید).</p>
                <button type="button" class="btn sm gray" id="btn-cert-bg-center">وسط‌چین کردن مجدد</button>
              </div>
              <label>فاصله قاب تزئینی از لبه کاغذ</label>
              <div class="row" style="align-items:center;gap:8px">
                <input type="range" id="cert-frame-pad" min="4" max="40" step="1" value="10" style="flex:1">
                <span id="cert-frame-pad-val" style="min-width:34px;font-weight:700">۱۰</span>
              </div>
              <label>قالب</label>
              <div class="lb-cert-templates">
                <button type="button" class="lb-cert-tpl-btn active" data-tpl="gold">🟡 طلایی</button>
                <button type="button" class="lb-cert-tpl-btn" data-tpl="blue">🔵 آبی</button>
                <button type="button" class="lb-cert-tpl-btn" data-tpl="green">🟢 سبز</button>
                <button type="button" class="lb-cert-tpl-btn" data-tpl="purple">🟣 بنفش</button>
                <button type="button" class="lb-cert-tpl-btn" data-tpl="champion">🕌 قهرمانی (تشریفاتی)</button>
                <button type="button" class="lb-cert-tpl-btn" data-tpl="white">⚪ ساده سفید</button>
                <button type="button" class="lb-cert-tpl-btn" data-tpl="royal">👑 سلطنتی</button>
                <button type="button" class="lb-cert-tpl-btn" data-tpl="lapis">🔷 لاجوردی</button>
                <button type="button" class="lb-cert-tpl-btn" data-tpl="emerald">💎 زمردی</button>
              </div>
            </div>
            <div class="lb-cert-preview-wrap">
              <div id="cert-preview" class="lb-cert-sheet lb-cert-gold"></div>
            </div>
          </div>
          <div class="row" style="align-items:center;gap:8px;margin-top:10px">
            <label style="flex:0 0 auto">جهت چاپ:</label>
            <select id="cert-print-orientation" style="flex:0 0 auto;min-width:130px">
              <option value="portrait" selected>عمودی (Portrait)</option>
              <option value="landscape">افقی (Landscape)</option>
            </select>
          </div>
          <div class="row" style="margin-top:14px">
            <button class="btn primary" id="btn-cert-save">💾 ذخیره</button>
            <button class="btn primary" id="btn-cert-word">📄 دانلود Word</button>
            <button class="btn gray" id="btn-cert-pdf">🖨️ چاپ / دانلود PDF</button>
            <button class="btn danger" type="button" id="btn-cert-clear">🗑️ پاک کردن فرم</button>
          </div>
        </div>

      </div>


      <div class="card tab-content hidden" id="tab-infoexchange">
        <h3>📨 دریافت و ارسال اطلاعات</h3>
        <p class="muted">برای هر یک از نقش‌های معلم، راهبر آموزشی یا مدیر مدرسه یک لینک اختصاصی بسازید. دیگران با باز کردن آن لینک می‌توانند عکس، PDF، Word یا Excel برایتان بفرستند؛ شما هم می‌توانید از همین‌جا برایشان پاسخ (فایل یا پیام) بفرستید.</p>

        <h4>➕ ساخت لینک اختصاصی جدید</h4>
        <div class="lb-meta-form">
          <div><label>نام شما</label><input id="infoexchange-new-name" placeholder="نام و نام خانوادگی"></div>
          <div>
            <label>عنوان/نقش</label>
            <select id="infoexchange-new-role">
              <option value="معلم">👩‍🏫 معلم</option>
              <option value="راهبر آموزشی">🧭 راهبر آموزشی</option>
              <option value="مدیر مدرسه">🏫 مدیر مدرسه</option>
            </select>
          </div>
        </div>
        <button class="btn sm primary" id="btn-infoexchange-create">➕ ساخت لینک</button>

        <h4 style="margin-top:20px">🔗 لینک‌های اختصاصی</h4>
        <div id="infoexchange-links-list"></div>

        <h4 style="margin-top:20px">✉️ ارسال به یک لینک اختصاصی (بدون نیاز به باز کردن لینک، همین‌جا در پنل)</h4>
        <p class="muted" style="font-size:12.5px">مثل ارسال پیامک: لینک یا کدی که یک راهبر، مدیر یا معلمِ دیگر برایتان فرستاده را همین‌جا وارد/پیست کنید و پیام بفرستید — چه آن لینک از همین پنل شما باشد، چه از یک پنل کاملاً جدا که روی کلودفلر جداگانه ساخته شده. او در صندوق دریافتی خودش می‌بیند.</p>
        <label>لینک یا کد گیرنده</label>
        <div class="row" style="gap:8px">
          <input id="infoexchange-send-target-input" placeholder="اگر لینک از پنل دیگری است، آدرس کامل را بچسبانید — مثلاً: https://xxxx.workers.dev/info/xxxx" style="flex:1">
          <select id="infoexchange-send-target-pick" style="flex:0 0 auto;min-width:170px"><option value="">— یا از لیست انتخاب کنید —</option></select>
        </div>
        <div class="lb-meta-form">
          <div><label>نام شما (فرستنده)</label><input id="infoexchange-send-sender" placeholder="نام و نام خانوادگی"></div>
        </div>
        <label>پیام</label>
        <textarea id="infoexchange-send-message" rows="2" class="lb-textarea" placeholder="پیام خود را بنویسید..."></textarea>
        <label>فایل‌ها (عکس، PDF، Word یا Excel — اختیاری)</label>
        <input type="file" id="infoexchange-send-files-input" accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx" multiple>
        <div id="infoexchange-send-files-list"></div>
        <button class="btn sm primary" id="btn-infoexchange-send" style="margin-top:8px">📤 ارسال</button>

        <div id="infoexchange-sent-wrap" style="margin-top:20px">
          <h4>📤 پیام‌های ارسالی من</h4>
          <div id="infoexchange-sent-list"></div>
        </div>

        <div id="infoexchange-inbox-wrap" class="hidden" style="margin-top:20px">
          <h4>📥 صندوق دریافتی <span id="infoexchange-inbox-owner" class="muted"></span></h4>
          <div id="infoexchange-inbox-list"></div>
        </div>
      </div>

      <div class="card tab-content hidden" id="tab-settings">
        <h3>🌙 تم</h3>
        <div style="display:flex;gap:12px;margin-bottom:20px">
          <button class="theme-btn" data-theme="light" onclick="setTheme('light')">☀️ روشن</button>
          <button class="theme-btn" data-theme="dark" onclick="setTheme('dark')">🌙 تاریک</button>
        </div>
        <h3>🎨 رنگ تم</h3>
        <div style="display:flex;gap:14px;margin-bottom:20px;flex-wrap:wrap;align-items:center" id="color-theme-row">
          <button class="color-swatch active" data-color="academy" style="background:linear-gradient(135deg,#123A5C,#B8922E)" title="حرفه‌ای (سرمه‌ای و طلایی)"></button>
          <button class="color-swatch" data-color="tea" style="background:linear-gradient(135deg,#AE4E28,#C08A2E)" title="چایخانه (آجری و زعفرانی)"></button>
          <button class="color-swatch" data-color="ocean" style="background:linear-gradient(135deg,#1d4ed8,#0d9488)" title="اقیانوسی (آبی)"></button>
          <button class="color-swatch" data-color="emerald" style="background:linear-gradient(135deg,#059669,#10b981)" title="زمردی (سبز)"></button>
          <button class="color-swatch" data-color="rose" style="background:linear-gradient(135deg,#e11d48,#fb7185)" title="رزی (صورتی)"></button>
          <button class="color-swatch" data-color="skyblue" style="background:linear-gradient(135deg,#0EA5E9,#38BDF8)" title="آبی کم‌رنگ (آسمانی)"></button>
          <button class="color-swatch" data-color="goldnight" style="background:linear-gradient(135deg,#1a1030,#F5A623)" title="شب طلایی (تیره و پرمیوم)"></button>
          <button class="color-swatch" data-color="turquoise" style="background:linear-gradient(135deg,#0F9B8E,#14B8A6)" title="فیروزه‌ای"></button>
          <button class="color-swatch" data-color="crystal" style="background:linear-gradient(135deg,#5B8DB8,#A5E6FF)" title="کریستالی (شیشه‌ای و مدرن)"></button>
        </div>
        <h3>🤖 موتور هوش مصنوعی</h3>
        <p class="muted" style="margin-bottom:20px">تمام قابلیت‌های هوش مصنوعی (ترجمه، استخراج متن از عکس/PDF، چت دستیار و ...) با موتور ✨ Gemini انجام می‌شود.</p>
        <h3>🔐 تغییر رمز عبور</h3>
        <label>رمز عبور جدید</label><input id="new-pass" type="password" autocomplete="new-password">
        <p class="muted" id="pass-msg"></p>
        <button class="btn" id="btn-change-pass">ذخیره رمز جدید</button>
      </div>
      </div>
    </div>
  </div>
  <div class="toast" id="toast"></div>
  <script>${teacherScript()}</script>
  </body></html>`;
}

/* ------------------------- اسکریپت معلم (کامل) ------------------------- */

function teacherScript() {
  return `
  const TYPES={descriptive:'تشریحی',multiple:'چهارگزینه‌ای',truefalse:'صحیح/غلط',short:'کوتاه‌پاسخ'};
  const MATH=['+','\u2212','\u00d7','\u00f7','=','\u2260','\u00b1','\u2213','<','>','\u2264','\u2265','\u221a','\u221b','\u221c','%','\u2030','\u03c0','\u00b0',
    '\u00bd','\u2153','\u2154','\u00bc','\u00be','\u2155','\u2156','\u2157','\u2158','\u2159','\u215a','\u215b','\u215c','\u215d','\u215e',
    '\u00b2','\u00b3','\u2070','\u00b9','\u2074','\u2075',
    '( )','[ ]','{ }','\u2211','\u220f','\u221e','\u2220','\u22a5','\u2225','\u2234','\u2235','\u2248','\u2261','\u2245','\u221d','\u222b',
    '\u2192','\u2190','\u2194','\u2191','\u2193',
    '\u2208','\u2209','\u2282','\u2286','\u2284','\u222a','\u2229','\u2205',
    '\u2200','\u2203','\u00ac','\u2227','\u2228','\u2295','\u0394','\u2202','\u2207'];
  const SHAPES=['\u25b3','\u25bd','\u25c1','\u25b7','\u25c0','\u25b6','\u25b2','\u25bc','\u25a1','\u25ad','\u25ac','\u25b1','\u25b0','\u25c7','\u25c6','\u2b20','\u2b1f','\u2b21','\u2b22','\u25cb','\u25ef','\u25cf','\u2b24','\u2b2d','\u2605','\u2606','\u23e2','\u22bf','\u25e2','\u25e3','\u25e4','\u25e5','\u2194','\u2191','\u2193','\u2220','\u22a5','\u2225','\u2312','\u2299','\u2014'];
  const SVG_SHAPES=[
    {name:'مکعب', svg:'<svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="3"><rect x="20" y="35" width="45" height="45"/><path d="M20 35 L40 15 L85 15 L65 35"/><path d="M65 35 L65 80 L85 60 L85 15"/></svg>'},
    {name:'استوانه', svg:'<svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="3"><ellipse cx="50" cy="22" rx="30" ry="12"/><path d="M20 22 L20 78"/><path d="M80 22 L80 78"/><path d="M20 78 A30 12 0 0 0 80 78"/></svg>'},
    {name:'مخروط', svg:'<svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="3"><path d="M50 12 L20 78"/><path d="M50 12 L80 78"/><ellipse cx="50" cy="78" rx="30" ry="11"/></svg>'},
    {name:'کره', svg:'<svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="3"><circle cx="50" cy="50" r="36"/><ellipse cx="50" cy="50" rx="36" ry="13"/></svg>'},
    {name:'هرم', svg:'<svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="3"><path d="M50 12 L18 75 L70 86 Z"/><path d="M50 12 L70 86 L86 64 Z"/><path d="M18 75 L70 86"/></svg>'},
    {name:'مستطیل‌مکعب', svg:'<svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="3"><rect x="14" y="40" width="60" height="38"/><path d="M14 40 L30 22 L90 22 L74 40"/><path d="M74 40 L74 78 L90 60 L90 22"/></svg>'},
    {name:'زاویه', svg:'<svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 80 L85 80"/><path d="M20 80 L78 30"/><path d="M44 80 A24 24 0 0 0 38 64"/></svg>'},
    {name:'پاره‌خط', svg:'<svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="3"><path d="M14 50 L86 50"/><circle cx="14" cy="50" r="4" fill="currentColor"/><circle cx="86" cy="50" r="4" fill="currentColor"/></svg>'}
  ];
  let QUESTIONS=[], META={}, SUBS=[], TABLES=[], RESIZE_IMAGES=[], scheduleData={cells:{}};
  
  function esc(s){const d=document.createElement('div');d.textContent=s==null?'':s;return d.innerHTML;}
  function toast(m){const t=document.getElementById('toast');t.textContent=m;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2500);}
  window.addEventListener('error',function(e){
    console.error('خطای پیش‌بینی‌نشده:',e.error||e.message);
    try{toast('⚠️ خطایی رخ داد؛ لطفاً دوباره تلاش کنید');}catch(_){}
  });
  window.addEventListener('unhandledrejection',function(e){
    console.error('خطای پیش‌بینی‌نشده (async):',e.reason);
    try{toast('⚠️ خطایی رخ داد؛ لطفاً دوباره تلاش کنید');}catch(_){}
  });
  function uid(){return 'q-'+Math.random().toString(36).slice(2,10);}
  async function api(path,opts){const r=await fetch(path,opts);return r.json();}
  async function lbSave(key,value,silent){
    try{
      const d=await api('/api/teacher/lb-save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key,value})});
      if(!silent){if(d.ok)toast('ذخیره شد');else toast(d.error||'خطا در ذخیره');}
      return d.ok;
    }catch(e){if(!silent)toast('خطا در ذخیره');return false;}
  }
  async function lbLoad(key){
    try{
      const d=await api('/api/teacher/lb-load?key='+encodeURIComponent(key));
      return d.ok?d.value:null;
    }catch(e){return null;}
  }

  // ===== ابزار مشترک رنگ‌آمیزی دلخواه ردیف‌ها (برای همه‌ی جدول‌ها) =====
  var ROW_COLOR_HEX={pink:'#fbcfe8',blue:'#bfdbfe',red:'#fecaca',yellow:'#fef08a',orange:'#fed7aa',green:'#bbf7d0'};
  var ROW_COLOR_LABELS={none:'بدون رنگ',pink:'صورتی',blue:'آبی',red:'قرمز',yellow:'زرد',orange:'نارنجی',green:'سبز'};
  var ROW_COLOR_ORDER=['none','pink','blue','red','yellow','orange','green'];
  function rowColorDotsHtml(key){
    var h='<span class="row-color-picker" data-key="'+key+'">';
    ROW_COLOR_ORDER.forEach(function(ck){h+='<button type="button" class="row-color-dot" data-color="'+ck+'" data-key="'+key+'" title="'+ROW_COLOR_LABELS[ck]+'"></button>';});
    h+='</span>';
    return h;
  }
  function applyRowColorToTr(tr,colorKey){
    if(!tr)return;
    var hex=ROW_COLOR_HEX[colorKey]||'';
    tr.querySelectorAll('td,th').forEach(function(cell){cell.style.background=hex;});
  }
  function refreshRowColorPickers(root,store){
    if(!root)return;
    root.querySelectorAll('.row-color-picker').forEach(function(picker){
      var key=picker.dataset.key;
      var current=(store&&store[key])||'none';
      picker.querySelectorAll('.row-color-dot').forEach(function(dot){
        dot.classList.toggle('active',dot.dataset.color===current);
      });
      applyRowColorToTr(picker.closest('tr'),current==='none'?'':current);
    });
  }

  const COLOR_THEMES={
    academy:{light:{bg:'#F3F6F9',card:'#FFFFFF',primary:'#123A5C','primary-2':'#1F6E8C',accent:'#B8922E',muted:'#5B6B7C',line:'#DEE5EC',text:'#16212E',danger:'#B3261E',soft:'#EBF0F5','soft-2':'#DCE4EC'},
             dark:{bg:'#0B141E',card:'#101C29',primary:'#1E5A78',   'primary-2':'#2A7495',accent:'#D4AF37',muted:'#93A6B8',line:'#1E2E3F',text:'#E8EEF3',danger:'#DC2626',soft:'#152232','soft-2':'#1C2C3F'}},
    tea:{light:{bg:'#F4EDDD',card:'#FAF3E4',primary:'#AE4E28','primary-2':'#C08A2E',accent:'#3E7C4F',muted:'#6b6455',line:'#E4D8B8',text:'#1C3327',danger:'#C0392B',soft:'#F3E4C8','soft-2':'#E4D8B8'},
         dark:{bg:'#15271E',card:'#1C3327',primary:'#AE4E28',   'primary-2':'#C08A2E',accent:'#4F9464',muted:'#A9B7A9',line:'#33473A',text:'#F4EDDD',danger:'#DC2626',soft:'#26392c','soft-2':'#33473A'}},
    ocean:{light:{bg:'#f1f5f9',card:'#e9f0fb',primary:'#1d4ed8','primary-2':'#2563eb',accent:'#0d9488',muted:'#64748b',line:'#e2e8f0',text:'#0f172a',danger:'#dc2626',soft:'#e0e7ff','soft-2':'#c7d2fe'},
          dark:{bg:'#0f172a',card:'#1e293b',primary:'#1d4ed8',   'primary-2':'#2563eb',accent:'#14b8a6',muted:'#94a3b8',line:'#334155',text:'#f1f5f9',danger:'#dc2626',soft:'#334155','soft-2':'#475569'}},
    emerald:{light:{bg:'#f0fdf6',card:'#e6fbef',primary:'#059669','primary-2':'#10b981',accent:'#0891b2',muted:'#64748b',line:'#d1fae5',text:'#0f2e22',danger:'#dc2626',soft:'#d1fae5','soft-2':'#a7f3d0'},
            dark:{bg:'#052e22',card:'#0e3d2e',primary:'#059669',   'primary-2':'#10b981',accent:'#22d3ee',muted:'#9fc9b8',line:'#155e46',text:'#ecfdf5',danger:'#dc2626',soft:'#155e46','soft-2':'#1c6e53'}},
    rose:{light:{bg:'#fff1f4',card:'#ffedf1',primary:'#e11d48','primary-2':'#fb7185',accent:'#7c3aed',muted:'#64748b',line:'#fecdd3',text:'#3f0d17',danger:'#b91c1c',soft:'#fecdd3','soft-2':'#fda4af'},
         dark:{bg:'#2b0a13',card:'#3b0f1c',primary:'#c81e45',   'primary-2':'#e11d48',accent:'#a78bfa',muted:'#c99aa4',line:'#5c1a2a',text:'#fff1f4',danger:'#dc2626',soft:'#5c1a2a','soft-2':'#6e2130'}},
    skyblue:{light:{bg:'#EAF6FF',card:'#DFF2FF',primary:'#0EA5E9','primary-2':'#38BDF8',accent:'#6366F1',muted:'#5b7d8f',line:'#CDEBFC',text:'#0B2A3B',danger:'#DC2626',soft:'#D6EEFF','soft-2':'#BFE4FB'},
            dark:{bg:'#07202E',card:'#0F3049',primary:'#0284C7',   'primary-2':'#0EA5E9',accent:'#818CF8',muted:'#93B4C7',line:'#164860',text:'#EAF6FF',danger:'#DC2626',soft:'#164860','soft-2':'#1D5975'}},
    goldnight:{light:{bg:'#FBF6EC',card:'#FFF7E6',primary:'#B45309','primary-2':'#D97706',accent:'#DB2777',muted:'#7A6E5C',line:'#F0DFB8',text:'#241A0F',danger:'#DC2626',soft:'#FCEBC5','soft-2':'#F8DC9A'},
              dark:{bg:'#0E0D17',card:'#1E1E2C',primary:'#B45309',   'primary-2':'#D97706',accent:'#F472B6',muted:'#9691A8',line:'#2E2A45',text:'#F5F3FF',danger:'#DC2626',soft:'#241F35','soft-2':'#322B4A'}},
    turquoise:{light:{bg:'#EAFBF9',card:'#E0F7F4',primary:'#0F9B8E','primary-2':'#14B8A6',accent:'#F59E0B',muted:'#5b8f89',line:'#CFEEEA',text:'#0B2C29',danger:'#DC2626',soft:'#D3F5EF','soft-2':'#BEEBE3'},
               dark:{bg:'#052220',card:'#0C332E',primary:'#0F9B8E',   'primary-2':'#14B8A6',accent:'#FBBF24',muted:'#8FC2BA',line:'#164F45',text:'#EAFBF9',danger:'#DC2626',soft:'#164F45','soft-2':'#1D6156'}},
    crystal:{light:{bg:'#F4F8FB',card:'#FFFFFF',primary:'#4A7FA8','primary-2':'#8FC4E8',accent:'#38BDF8',muted:'#64748b',line:'#DCE8F0',text:'#1E293B',danger:'#DC2626',soft:'#EAF3FA','soft-2':'#D7E8F3'},
             dark:{bg:'#0B1420',card:'#141F2E',primary:'#2F5F85',   'primary-2':'#4A7FA8',accent:'#93C5FD',muted:'#94A3B8',line:'#22344A',text:'#EAF3FA',soft:'#182740','soft-2':'#20344C',danger:'#DC2626'}},
  };
  function applyColorTheme(name){
    const mode=document.documentElement.getAttribute('data-theme')||'light';
    const th=COLOR_THEMES[name]||COLOR_THEMES.academy;
    const vars=th[mode]||th.light;
    Object.keys(vars).forEach(k=>document.documentElement.style.setProperty('--'+k,vars[k]));
    localStorage.setItem('panelColorTheme',name);
    document.querySelectorAll('.color-swatch').forEach(b=>b.classList.toggle('active',b.dataset.color===name));
  }
  window.applyColorTheme=applyColorTheme;

  const savedTheme=localStorage.getItem('panelTheme')||'light';
  document.documentElement.setAttribute('data-theme',savedTheme);
  const savedColorTheme=localStorage.getItem('panelColorTheme')||'academy';
  applyColorTheme(savedColorTheme);
  setTimeout(()=>{document.querySelectorAll('.theme-btn').forEach(b=>b.classList.toggle('active',b.dataset.theme===savedTheme));},100);
  window.setTheme=function(t){document.documentElement.setAttribute('data-theme',t);localStorage.setItem('panelTheme',t);document.querySelectorAll('.theme-btn').forEach(b=>b.classList.toggle('active',b.dataset.theme===t));applyColorTheme(localStorage.getItem('panelColorTheme')||'academy');};
  document.querySelectorAll('.color-swatch').forEach(function(b){b.addEventListener('click',function(){
    if(b.dataset.color==='goldnight')window.setTheme('dark');
    applyColorTheme(b.dataset.color);
  });});

  // ===== موتور هوش مصنوعی: فقط Gemini =====
  window.getAiProvider=function(){return 'gemini';};

  // ===== ورود =====
  async function checkAuth(){
    const d=await api('/api/teacher/state');
    if(d.auth){showDash();return;}
    if(!d.configured){
      document.getElementById('login-head').textContent='تعریف رمز عبور (اولین ورود)';
      document.getElementById('login-hint').textContent='این اولین ورود است؛ یک رمز دلخواه (حداقل ۴ کاراکتر) وارد کنید تا به‌عنوان رمز معلم ثبت شود.';
      document.getElementById('btn-login').textContent='ثبت رمز و ورود';
    }
  }
  document.getElementById('btn-login').onclick=async()=>{
    const p=document.getElementById('pass').value;
    const d=await api('/api/teacher/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:p})});
    if(d.ok){
      localStorage.setItem('panel-role',document.getElementById('login-role').value);
      if(d.created)toast('رمز عبور شما ثبت شد');
      showDash();
    }else document.getElementById('login-err').textContent=d.error||'خطا';
  };
  document.getElementById('pass').addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('btn-login').click();});
  document.getElementById('btn-logout').onclick=async()=>{await api('/api/teacher/logout',{method:'POST'});location.reload();};
  
  function showDash(){
    document.getElementById('login').classList.add('hidden');
    document.getElementById('dash').classList.remove('hidden');
    loadStudents();loadQuestions();loadSchedule();
    try{
      var qs=new URLSearchParams(location.search);
      var wantTab=qs.get('tab');
      if(wantTab)activateSection(wantTab);
      var wantSubtab=qs.get('subtab');
      if(wantSubtab){
        var stEl=document.querySelector('.subtab[data-subtab="'+wantSubtab+'"]');
        if(stEl)stEl.click();
      }
      var wantLb=qs.get('lb');
      if(wantLb){
        var lbEl=document.querySelector('.lb-menu-btn[data-lb="'+wantLb+'"]');
        if(lbEl)lbEl.click();
      }
    }catch(e){}
  }

  (function(){
    var clockEl=document.getElementById('th-clock');
    if(clockEl){
      function thTickClock(){
        var now=new Date();
        var hh=String(now.getHours()).padStart(2,'0');
        var mm=String(now.getMinutes()).padStart(2,'0');
        var ss=String(now.getSeconds()).padStart(2,'0');
        clockEl.textContent=hh+':'+mm+':'+ss;
      }
      thTickClock();
      setInterval(thTickClock,1000);
    }
  })();

  var tabsPanel=document.getElementById('tabs-panel');
  var tabsOverlay=document.getElementById('tabs-overlay');
  var mobileMenuBtn=document.getElementById('mobile-menu-btn');

  /* Force correct mobile-drawer layout at runtime via an injected !important
     stylesheet, independent of the @media(max-width) CSS rule above. This
     guarantees the right-side drawer renders correctly even when the browser
     reports a wide viewport (e.g. Chrome "Request Desktop Site" on a phone),
     since detection here is based on actual touch capability, not viewport width. */
  function isTouchDevice(){
    return (window.matchMedia && window.matchMedia('(pointer:coarse)').matches) ||
           (navigator.maxTouchPoints && navigator.maxTouchPoints>0) ||
           ('ontouchstart' in window);
  }
  var mobileNavStyleTag=document.createElement('style');
  document.head.appendChild(mobileNavStyleTag);
  function syncMobileNavStyles(open){
    if(!isTouchDevice()){ mobileNavStyleTag.textContent=''; return; }
    mobileNavStyleTag.textContent =
      '#mobile-menu-btn{display:inline-flex!important;align-items:center!important;gap:6px!important;background:var(--primary)!important;color:#fff!important;border:none!important;padding:10px 16px!important;border-radius:12px!important;font-weight:700!important;font-size:14px!important;cursor:pointer!important;margin:16px 0 0!important;box-shadow:0 3px 10px rgba(18,32,48,.16)!important}'+
      '.dash-flex{flex-direction:column!important}'+
      '#tabs-panel{position:fixed!important;top:0!important;right:0!important;left:auto!important;bottom:auto!important;height:100vh!important;max-height:100dvh!important;width:78vw!important;max-width:280px!important;flex:none!important;margin:0!important;background:var(--card)!important;border-left:2px solid var(--text)!important;box-shadow:-6px 0 24px rgba(0,0,0,.25)!important;z-index:301!important;padding:64px 14px 14px!important;overflow-y:auto!important;transition:transform .25s ease!important;transform:translateX('+(open?'0':'100%')+')!important}'+
      '#tabs-overlay{display:'+(open?'block':'none')+'!important;position:fixed!important;top:0!important;right:0!important;bottom:0!important;left:0!important;width:100vw!important;height:100vh!important;background:rgba(15,23,42,.55)!important;z-index:300!important}';
  }
  syncMobileNavStyles(false);
  window.addEventListener('resize', function(){ syncMobileNavStyles(tabsPanel.classList.contains('open')); });

  function closeMobileMenu(){tabsPanel.classList.remove('open');tabsOverlay.classList.remove('open');document.documentElement.style.overflow='';document.body.style.overflow='';syncMobileNavStyles(false);}
  mobileMenuBtn.onclick=function(){tabsPanel.classList.add('open');tabsOverlay.classList.add('open');document.documentElement.style.overflow='hidden';document.body.style.overflow='hidden';syncMobileNavStyles(true);};
  tabsOverlay.onclick=closeMobileMenu;

  document.querySelectorAll('.tab[data-tab]').forEach(function(t){
    t.addEventListener('click', function(){ closeMobileMenu(); });
  });

  document.querySelectorAll('.tab-child').forEach(function(t){
    t.addEventListener('click', function(){ closeMobileMenu(); });
  });

  document.querySelectorAll('.tab-parent[data-tab]').forEach(function(p){
    p.addEventListener('click', function(){
      var kids=document.getElementById('tab-children-'+p.dataset.tab);
      var wasOpen=p.classList.contains('open');
      document.querySelectorAll('.tab-parent').forEach(function(x){x.classList.remove('open');});
      document.querySelectorAll('.tab-children').forEach(function(x){x.classList.remove('open');});
      if(!wasOpen){
        p.classList.add('open');
        if(kids)kids.classList.add('open');
      }
    });
  });

  document.querySelectorAll('.tab-subgroup-head[data-sub]').forEach(function(sh){
    sh.addEventListener('click', function(e){
      e.stopPropagation();
      var kids=document.getElementById('tab-subchildren-'+sh.dataset.sub);
      var wasOpen=sh.classList.contains('open');
      var parentGroup=sh.closest('.tab-children');
      if(parentGroup){
        parentGroup.querySelectorAll('.tab-subgroup-head').forEach(function(x){x.classList.remove('open');});
        parentGroup.querySelectorAll('.tab-subchildren').forEach(function(x){x.classList.remove('open');});
      }
      if(!wasOpen){
        sh.classList.add('open');
        if(kids)kids.classList.add('open');
      }
    });
  });

  function activateSection(tabName){
    document.querySelectorAll('.tab[data-tab]').forEach(x=>x.classList.remove('active'));
    var tEl=document.querySelector('.tab[data-tab="'+tabName+'"]');
    if(tEl)tEl.classList.add('active');
    document.querySelectorAll('.tab-parent').forEach(x=>x.classList.remove('active'));
    document.querySelectorAll('.tab-children').forEach(x=>x.classList.remove('open'));
    var pEl=document.querySelector('.tab-parent[data-tab="'+tabName+'"]');
    if(pEl){
      pEl.classList.add('active');
      pEl.classList.add('open');
      var kidsEl=document.getElementById('tab-children-'+tabName);
      if(kidsEl)kidsEl.classList.add('open');
    }
    document.querySelectorAll('.tab-content').forEach(c=>c.classList.add('hidden'));
    var cEl=document.getElementById('tab-'+tabName);
    if(cEl)cEl.classList.remove('hidden');
    if(tabName==='tablesorg'){if(typeof loadTableIfNeeded==='function')loadTableIfNeeded();if(typeof loadOrgFormIfNeeded==='function')loadOrgFormIfNeeded();}
    if(tabName==='schedule'){document.getElementById('btn-gen-schedule').click();if(typeof loadScheduleThemeIfNeeded==='function')loadScheduleThemeIfNeeded();if(typeof loadScheduleFontIfNeeded==='function')loadScheduleFontIfNeeded();if(typeof loadScheduleRowColorsIfNeeded==='function')loadScheduleRowColorsIfNeeded();}
    if(tabName==='classroom'){renderClassLinks();setTimeout(function(){if(typeof clsResizeBoard==='function')clsResizeBoard();},50);}
    if(tabName==='examsheet'){if(typeof loadExamSheetIfNeeded==='function')loadExamSheetIfNeeded();}
    if(tabName==='infoexchange'){if(typeof loadInfoExchangeIfNeeded==='function')loadInfoExchangeIfNeeded();}
  }

  document.querySelectorAll('.subtab[data-subtab]').forEach(t=>t.onclick=()=>{
    document.querySelectorAll('.subtab[data-subtab]').forEach(x=>x.classList.remove('active'));
    t.classList.add('active');
    document.querySelectorAll('.subtab-content').forEach(c=>c.classList.add('hidden'));
    document.getElementById('tab-'+t.dataset.subtab).classList.remove('hidden');
    if(t.dataset.subtab==='answers')loadAnswers();
    if(t.dataset.subtab==='worksheet')loadWorksheetList();
    if(t.dataset.subtab==='questions'){updateDurationDisplay();}
  });

  // ===== دانش‌آموزان =====
  let TEACHER_STUDENTS=[];
  const GRADE_LABELS=['پایه اول','پایه دوم','پایه سوم','پایه چهارم','پایه پنجم','پایه ششم'];
  function renderStudentsFiltered(){
    const filterVal=document.getElementById('students-filter-grade').value;
    const list=filterVal==='all'?TEACHER_STUDENTS:TEACHER_STUDENTS.filter(s=>(Number.isInteger(s.grade)?s.grade:0)===parseInt(filterVal,10));
    renderStudentsTable(list);
  }
  document.getElementById('students-filter-grade').addEventListener('change',renderStudentsFiltered);
  function renderStudentsTable(students){
    const box=document.getElementById('students-list');
    if(!students.length){box.innerHTML='<p class="muted">دانش‌آموزی در این پایه ثبت نشده است.</p>';return;}
    box.innerHTML='<table><tr><th>عکس</th><th>#</th><th>نام</th><th>پایه</th><th>لینک اختصاصی</th><th>وضعیت</th><th></th></tr>'+
      students.map((s,i)=>{
        const link=location.origin+'/s/'+s.uuid;
        let st='<span class="pill no">در انتظار</span>';
        if(s.status==='submitted')st='<span class="pill gr">ثبت‌شده (تصحیح‌نشده)</span>';
        if(s.status==='graded')st='<span class="pill ok">تصحیح‌شده</span>';
        const avatar=s.photo?'<img src="'+s.photo+'" style="width:36px;height:36px;border-radius:50%;object-fit:cover;display:block">':'<div style="width:36px;height:36px;border-radius:50%;background:#e2e8f0;display:flex;align-items:center;justify-content:center;font-size:16px">🧑‍🎓</div>';
        const gradeIdx=Number.isInteger(s.grade)?s.grade:0;
        const gradeSel='<select style="min-width:110px" data-prev="'+gradeIdx+'" onchange="changeStudentGrade(\\''+s.uuid+'\\',this)">'+
          GRADE_LABELS.map((lbl,gi)=>'<option value="'+gi+'"'+(gi===gradeIdx?' selected':'')+'>'+lbl+'</option>').join('')+
          '</select>';
        return '<tr><td>'+avatar+'</td><td>'+(i+1)+'</td><td>'+esc(s.label||'-')+'</td>'+
          '<td>'+gradeSel+'</td>'+
          '<td><div class="link-box">'+link+'</div></td>'+
          '<td>'+st+'</td>'+
          '<td><button class="btn sm" onclick="copyLink(\\''+link+'\\')">کپی</button> '+
          '<label class="btn sm sec" style="cursor:pointer">📷 عکس<input type="file" accept="image/*" style="display:none" onchange="changeStudentPhoto(\\''+s.uuid+'\\',this)"></label> '+
          '<button class="btn sm danger" onclick="delStudent(\\''+s.uuid+'\\')">حذف</button></td></tr>';
      }).join('')+'</table>';
  }
  async function loadStudents(){
    const d=await api('/api/teacher/students');
    TEACHER_STUDENTS=d.students||[];
    renderStudentsFiltered();
  }
  window.copyLink=(l)=>{navigator.clipboard.writeText(l).then(()=>toast('لینک کپی شد'));};
  window.delStudent=async(id)=>{
    if(!confirm('حذف این دانش‌آموز و پاسخنامه‌اش؟'))return;
    // حذف فوری از فهرست نمایشی؛ درخواست حذف واقعی در پس‌زمینه انجام می‌شود تا کاربر منتظر پاسخ سرور نماند
    TEACHER_STUDENTS=TEACHER_STUDENTS.filter(s=>s.uuid!==id);
    renderStudentsFiltered();
    await api('/api/teacher/students/'+id,{method:'DELETE'});
  };

  // کوچک‌کردن و برش مرکزی عکس پروفایل به یک مربع کامل (مثل آپلود عکس پروفایل واقعی) تا داخل دایره هیچ‌وقت کشیده/بیضی به‌نظر نرسد
  function resizeProfilePhoto(file){
    return new Promise((resolve,reject)=>{
      if(file.size>2*1024*1024){reject(new Error('حجم عکس باید کمتر از ۲ مگابایت باشد'));return;}
      const rd=new FileReader();
      rd.onload=ev=>{
        const img=new Image();
        img.onload=()=>{
          const size=320;
          // برش مرکزی: بزرگ‌ترین مربع ممکن از وسط عکس اصلی انتخاب می‌شود تا نسبت تصویر به‌هم نخورد
          const side=Math.min(img.width,img.height);
          const sx=(img.width-side)/2, sy=(img.height-side)/2;
          const c=document.createElement('canvas');c.width=size;c.height=size;
          c.getContext('2d').drawImage(img,sx,sy,side,side,0,0,size,size);
          resolve(c.toDataURL('image/jpeg',0.85));
        };
        img.onerror=()=>reject(new Error('فایل عکس معتبر نیست'));
        img.src=ev.target.result;
      };
      rd.onerror=()=>reject(new Error('خطا در خواندن فایل'));
      rd.readAsDataURL(file);
    });
  }

  // فشرده‌سازی عکس کاربرگ تا زیر ۲ مگابایت (با حفظ خوانایی متن، برخلاف عکس پروفایل که کوچک می‌شود)
  function compressWorksheetImage(file){
    return new Promise((resolve,reject)=>{
      const rd=new FileReader();
      rd.onload=ev=>{
        const img=new Image();
        img.onload=()=>{
          let w=img.width,h=img.height;
          const maxDim=2000;
          if(Math.max(w,h)>maxDim){
            const scale=maxDim/Math.max(w,h);
            w=Math.round(w*scale);h=Math.round(h*scale);
          }
          const c=document.createElement('canvas');c.width=w;c.height=h;
          const ctx=c.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,w,h);ctx.drawImage(img,0,0,w,h);
          let quality=0.9;
          function tryCompress(){
            c.toBlob(function(blob){
              if(!blob){reject(new Error('خطا در فشرده‌سازی'));return;}
              if(blob.size<=2*1024*1024||quality<=0.3){
                const fr=new FileReader();
                fr.onload=()=>resolve(fr.result);
                fr.readAsDataURL(blob);
              }else{
                quality-=0.1;
                tryCompress();
              }
            },'image/jpeg',quality);
          }
          tryCompress();
        };
        img.onerror=()=>reject(new Error('فایل عکس معتبر نیست'));
        img.src=ev.target.result;
      };
      rd.onerror=()=>reject(new Error('خطا در خواندن فایل'));
      rd.readAsDataURL(file);
    });
  }

  let newStudentPhoto='';
  document.getElementById('new-student-photo').addEventListener('change',async function(){
    const f=this.files&&this.files[0];this.value='';
    if(!f)return;
    try{
      newStudentPhoto=await resizeProfilePhoto(f);
      const prev=document.getElementById('new-student-photo-preview');
      prev.src=newStudentPhoto;prev.classList.remove('hidden');
    }catch(e){toast(e.message);}
  });

  window.changeStudentGrade=async(id,sel)=>{
    const grade=parseInt(sel.value,10)||0;
    const prevGrade=sel.dataset.prev!==undefined?parseInt(sel.dataset.prev,10):null;
    sel.disabled=true;
    try{
      const r=await api('/api/teacher/students/'+id,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({grade})});
      if(r.ok){
        toast('پایه بروزرسانی شد ✅');
        const idx=TEACHER_STUDENTS.findIndex(s=>s.uuid===id);
        if(idx>-1)TEACHER_STUDENTS[idx]={...TEACHER_STUDENTS[idx],grade};
        renderStudentsFiltered();
      }else{
        toast('خطا: '+(r.error||'ثبت نشد'));
        if(prevGrade!==null)sel.value=String(prevGrade);
      }
    }catch(e){toast(e.message);if(prevGrade!==null)sel.value=String(prevGrade);}
    finally{sel.disabled=false;sel.dataset.prev=sel.value;}
  };
  window.changeStudentPhoto=async(id,input)=>{
    const f=input.files&&input.files[0];input.value='';
    if(!f)return;
    try{
      const photo=await resizeProfilePhoto(f);
      const r=await api('/api/teacher/students/'+id,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({photo})});
      if(r.ok){
        toast('عکس پروفایل بروزرسانی شد ✅');
        const idx=TEACHER_STUDENTS.findIndex(s=>s.uuid===id);
        if(idx>-1){TEACHER_STUDENTS[idx]={...TEACHER_STUDENTS[idx],photo};renderStudentsFiltered();}
        else loadStudents();
      }
      else{toast('خطا: '+(r.error||'ثبت نشد'));}
    }catch(e){toast(e.message);}
  };

  document.getElementById('btn-add-student').onclick=async()=>{
    const label=document.getElementById('new-label').value.trim();
    const grade=parseInt(document.getElementById('new-grade').value,10)||0;
    const btn=document.getElementById('btn-add-student');btn.disabled=true;
    try{
      const r=await api('/api/teacher/students',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({label,grade,photo:newStudentPhoto})});
      if(!r.ok){toast('خطا: '+(r.error||'ساخته نشد'));return;}
      document.getElementById('new-label').value='';
      newStudentPhoto='';
      document.getElementById('new-student-photo-preview').classList.add('hidden');
      // بجای دریافت دوباره‌ی کل فهرست از سرور (که با افزایش تعداد دانش‌آموزان کند می‌شود)،
      // دانش‌آموز تازه‌ساخته‌شده مستقیم به فهرست محلی اضافه و بلافاصله نمایش داده می‌شود
      TEACHER_STUDENTS.unshift({...r.student,status:'pending'});
      // فیلتر نمایش را روی همان پایه‌ای که دانش‌آموز در آن ساخته شد قرار می‌دهیم تا بلافاصله دیده شود
      document.getElementById('students-filter-grade').value=String(grade);
      renderStudentsFiltered();
      toast('دانش‌آموز ساخته شد ✅');
    }finally{btn.disabled=false;}
  };

  // ===== سوالات =====
  async function loadQuestions(){
    const d=await api('/api/teacher/questions');
    META=d.meta||{};
    QUESTIONS=d.questions||[];
    document.getElementById('m-school').value=META.school||'';
    document.getElementById('m-teacher').value=META.teacher||'';
    document.getElementById('m-exam-name').value=META.examName||'';
    document.getElementById('m-exam-duration').value=META.examDuration||'30';
    document.getElementById('m-grade-level').value=META.gradeLevel||'elementary';
    updateDurationDisplay();
    renderQ();
  }
  
  function updateDurationDisplay(){
    const duration = document.getElementById('m-exam-duration').value || '30';
    document.getElementById('duration-display').textContent = duration;
  }
  
  document.getElementById('m-exam-duration').addEventListener('input', updateDurationDisplay);
  
  // ===== محاسبه جمع وزن‌ها =====
  function calculateTotalWeight() {
    let total = 0;
    QUESTIONS.forEach(q => {
      total += (parseFloat(q.weight) || 1);
    });
    return total;
  }
  
  function updateWeightDisplay() {
    const total = calculateTotalWeight();
    const display = document.getElementById('weight-total-display');
    if (!display) return;
    if (Math.abs(total - 20) < 0.01) {
      display.innerHTML = '✅ جمع وزن‌ها: <span class="total-value valid">' + total.toFixed(1) + '</span> از 20 (صحیح)';
    } else {
      display.innerHTML = '⚠️ جمع وزن‌ها: <span class="total-value invalid">' + total.toFixed(1) + '</span> از 20 (باید برابر 20 باشد)';
    }
  }
  
  function renderQ(){
    const box=document.getElementById('q-list');
    box.innerHTML=QUESTIONS.map((q,i)=>qBlock(q,i)).join('')||'<p class="muted">سوالی اضافه نشده است.</p>';

    // نمایش جمع وزن‌ها (فقط یک‌بار ساخته می‌شود، نه هر بار رندر)
    let totalDiv = document.getElementById('weight-total-display');
    if (!totalDiv) {
      totalDiv = document.createElement('div');
      totalDiv.id = 'weight-total-display';
      totalDiv.className = 'weight-total';
      box.parentNode.insertBefore(totalDiv, box.nextSibling);
    }
    updateWeightDisplay();

    // نمایش خلاصه‌ی تعداد هر نوع سوال
    let summaryDiv = document.getElementById('q-type-summary');
    if (!summaryDiv) {
      summaryDiv = document.createElement('div');
      summaryDiv.id = 'q-type-summary';
      summaryDiv.className = 'muted';
      summaryDiv.style.cssText = 'font-size:13px;margin-top:6px';
      totalDiv.parentNode.insertBefore(summaryDiv, totalDiv.nextSibling);
    }
    const counts = {};
    QUESTIONS.forEach(q => { counts[q.type] = (counts[q.type]||0) + 1; });
    const parts = Object.keys(counts).map(t => (TYPES[t]||t) + ': ' + counts[t]);
    summaryDiv.textContent = QUESTIONS.length ? ('📊 تعداد کل سوالات: ' + QUESTIONS.length + ' (' + parts.join(' | ') + ')') : '';
  }
  
  function escA(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}
  function qHtml(q){return q.rich?(q.text||''):esc(q.text);}
  function qBlock(q,i){
    let body='';
    const imgMode=Boolean(q.imageAsQuestion);

    // ===== سوییچ: تایپ متن یا بارگذاری عکس سوال =====
    body+='<div class="q-mode-toggle" style="margin-bottom:8px">'+
      '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-weight:600">'+
      '<input type="checkbox" '+(imgMode?'checked':'')+' onchange="toggleQImageMode('+i+',this.checked)"> '+
      '🖼️ به‌جای تایپ متن، عکس سوال بارگذاری شود</label></div>';

    if(imgMode){
      // ===== حالت عکس سوال (بدون نیاز به تایپ متن) =====
      body+='<label>🖼️ عکس سوال</label>';
      if(q.image){
        const w=q.imageWidth||320;
        body+='<div><img src="'+q.image+'" class="imgprev" style="max-width:'+w+'px;width:100%"></div>'+
          '<div class="row" style="align-items:center;margin-top:6px">'+
          '<label style="flex:0 0 auto;margin:0">اندازه‌ی نمایش:</label>'+
          '<select onchange="updImgSize('+i+',this.value)" style="flex:0 0 auto;width:auto">'+
            [['180','کوچک'],['320','متوسط'],['500','بزرگ'],['800','تمام عرض برگه']].map(o=>'<option value="'+o[0]+'" '+(String(w)===o[0]?'selected':'')+'>'+o[1]+'</option>').join('')+
          '</select>'+
          '<button class="btn sm danger" type="button" onclick="rmImg('+i+')" style="flex:0 0 auto">حذف عکس</button></div>';
      }else{
        body+='<input type="file" accept="image/*" onchange="loadImg('+i+',this)">'+
          '<p class="muted" style="font-size:12px;margin-top:4px">عکس سوال را انتخاب کنید؛ نیازی به تایپ متن نیست.</p>';
      }
    }else if(q.type==='descriptive'){
      body+='<label>متن سوال</label>'+
        '<div class="rich" data-qd="'+i+'" contenteditable="true" oninput="updHtml('+i+')">'+qHtml(q)+'</div>';
    }else{
      body+='<label>متن سوال</label><textarea data-qd="'+i+'" oninput="upd('+i+',\\'text\\',this.value)">'+esc(q.text)+'</textarea>';
    }

    if(q.type==='multiple'){
      body+='<label>گزینه صحیح</label><select onchange="upd('+i+',\\'correct\\',this.value)">'+
        [0,1,2,3].map(n=>'<option value="'+n+'" '+(String(q.correct)===String(n)?'selected':'')+'>'+['الف','ب','ج','د'][n]+'</option>').join('')+'</select>';
      body+='<label>گزینه‌ها</label>';
      for(let oi=0;oi<4;oi++){
        body+='<div class="opt-row"><span>'+['الف','ب','ج','د'][oi]+')</span><input type="text" value="'+esc((q.options&&q.options[oi])||'')+'" oninput="updOpt('+i+','+oi+',this.value)"></div>';
      }
    }else if(q.type==='truefalse'){
      body+='<label>پاسخ صحیح</label><select onchange="upd('+i+',\\'correct\\',this.value)">'+
        '<option value="true" '+(String(q.correct)==='true'?'selected':'')+'>صحیح</option>'+
        '<option value="false" '+(String(q.correct)==='false'?'selected':'')+'>غلط</option></select>';
    }else if(q.type==='short'){
      body+='<label>پاسخ نمونه (اختیاری)</label><input type="text" value="'+esc(q.correct||'')+'" oninput="upd('+i+',\\'correct\\',this.value)">';
    }

    // ===== عکس / شکل کمکی اضافی (فقط وقتی حالت «عکس سوال» فعال نیست) =====
    if(!imgMode){
      body+='<label>🖼️ عکس / شکل (اختیاری)</label>';
      if(q.image){
        const w=q.imageWidth||320;
        body+='<div><img src="'+q.image+'" class="imgprev" style="max-width:'+w+'px;width:100%"></div>'+
          '<div class="row" style="align-items:center;margin-top:6px">'+
          '<label style="flex:0 0 auto;margin:0">اندازه‌ی نمایش:</label>'+
          '<select onchange="updImgSize('+i+',this.value)" style="flex:0 0 auto;width:auto">'+
            [['180','کوچک'],['320','متوسط'],['500','بزرگ'],['800','تمام عرض برگه']].map(o=>'<option value="'+o[0]+'" '+(String(w)===o[0]?'selected':'')+'>'+o[1]+'</option>').join('')+
          '</select>'+
          '<button class="btn sm danger" type="button" onclick="rmImg('+i+')" style="flex:0 0 auto">حذف عکس</button></div>';
      }else{
        body+='<input type="file" accept="image/*" onchange="loadImg('+i+',this)">';
      }
    }
    
    // ===== بخش وزن (ضریب) هر سوال =====
    body += \`
      <div class="weight-input-box">
        <label>⚖️ وزن (ضریب) این سوال:</label>
        <input type="number" id="weight_\${i}" value="\${q.weight || 1}" min="0.5" max="20" step="0.5" 
               onchange="updWeight(\${i}, this.value)">
        <span class="weight-hint">جمع وزن‌ها باید برابر 20 شود</span>
      </div>
    \`;
    
    return '<div class="q-block"><div class="qhead"><b>سوال '+(i+1)+'</b>'+
      '<span><span class="badge">'+TYPES[q.type]+'</span> '+
      '<button class="btn sm gray" onclick="moveQ('+i+',-1)">▲</button> '+
      '<button class="btn sm gray" onclick="moveQ('+i+',1)">▼</button> '+
      '<button class="btn sm gray" onclick="dupQ('+i+')">📋 کپی</button> '+
      '<button class="btn sm danger" onclick="delQ('+i+')">حذف</button></span></div>'+body+'</div>';
  }
  
  // ===== تابع جدید برای ذخیره وزن =====
  window.updWeight = (i, val) => {
    const weight = parseFloat(val);
    if (!isNaN(weight) && weight > 0) {
      QUESTIONS[i].weight = Math.min(20, Math.max(0.5, weight));
    } else {
      QUESTIONS[i].weight = 1;
      const el = document.getElementById('weight_'+i);
      if(el) el.value = 1;
    }
    updateWeightDisplay();
  };
  
  window.upd=(i,k,v)=>{QUESTIONS[i][k]=v;};
  window.updOpt=(i,oi,v)=>{QUESTIONS[i].options=QUESTIONS[i].options||['','','',''];QUESTIONS[i].options[oi]=v;};
  window.delQ=(i)=>{
    if(!confirm('این سوال حذف شود؟ این کار قابل بازگشت نیست.'))return;
    QUESTIONS.splice(i,1);renderQ();
  };
  window.dupQ=(i)=>{
    const copy=JSON.parse(JSON.stringify(QUESTIONS[i]));
    copy.id=uid();
    QUESTIONS.splice(i+1,0,copy);
    renderQ();
    toast('سوال کپی شد ✅');
  };
  window.moveQ=(i,dir)=>{const j=i+dir;if(j<0||j>=QUESTIONS.length)return;const t=QUESTIONS[i];QUESTIONS[i]=QUESTIONS[j];QUESTIONS[j]=t;renderQ();};
  window.distributeWeights=()=>{
    if(!QUESTIONS.length){toast('ابتدا سوالی اضافه کنید');return;}
    const each=Math.round((20/QUESTIONS.length)*2)/2; // رند به نزدیک‌ترین 0.5
    QUESTIONS.forEach(q=>q.weight=each);
    // اگر به‌خاطر رند کردن مجموع دقیقاً 20 نشد، اختلاف را به سوال آخر اضافه/کم می‌کنیم
    const diff=20-QUESTIONS.reduce((s,q)=>s+q.weight,0);
    if(Math.abs(diff)>0.001) QUESTIONS[QUESTIONS.length-1].weight=Math.max(0.5,QUESTIONS[QUESTIONS.length-1].weight+diff);
    renderQ();
    toast('وزن‌ها به‌طور مساوی تقسیم شدند ✅');
  };
  
  function richEl(i){return document.querySelector('.rich[data-qd="'+i+'"]');}
  function ssize(i){const r=document.getElementById('ssz-'+i);return r?parseInt(r.value,10):40;}
  function insHtmlAt(i,h){
    const el=richEl(i);if(!el)return;
    el.focus();
    const sel=document.getSelection();
    if(!sel.rangeCount||!el.contains(sel.anchorNode)){const r=document.createRange();r.selectNodeContents(el);r.collapse(false);sel.removeAllRanges();sel.addRange(r);}
    document.execCommand('insertHTML',false,h);
    updHtml(i);
  }
  window.insSym=(i,s)=>insHtmlAt(i,escA(s));
  window.insShape=(i,s)=>insHtmlAt(i,'<span class="shape" contenteditable="false" style="font-size:'+ssize(i)+'px">'+escA(s)+'</span>&#8203;');
  window.insSvg=(i,si)=>{const s=SVG_SHAPES[si];if(!s)return;const z=ssize(i);const svg=s.svg.replace('<svg','<svg width="'+z+'" height="'+z+'"');insHtmlAt(i,'<span class="shape" contenteditable="false">'+svg+'</span>&#8203;');};
  // تبدیل خودکار اعداد انگلیسی به فارسی، فقط در گره‌های متنی (بدون دست‌زدن به attribute ها مثل style/data تا ساختار خراب نشود)
  const FA_DIGITS=['۰','۱','۲','۳','۴','۵','۶','۷','۸','۹'];
  function toFaDigits(s){return String(s==null?'':s).replace(/[0-9]/g,d=>FA_DIGITS[+d]);}
  function toEnDigits(s){return String(s==null?'':s).replace(/[۰-۹]/g,d=>FA_DIGITS.indexOf(d));}
  function convertDigitsInElement(el){
    if(!el)return;
    const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT,null);
    const nodes=[];let n;
    while(n=walker.nextNode())nodes.push(n);
    nodes.forEach(node=>{if(/[0-9]/.test(node.textContent))node.textContent=toFaDigits(node.textContent);});
  }

  window.updHtml=(i)=>{const el=richEl(i);if(!el)return;convertDigitsInElement(el);const c=el.cloneNode(true);c.querySelectorAll('.shape').forEach(s=>{s.style.outline='';});QUESTIONS[i].text=c.innerHTML;QUESTIONS[i].rich=true;};

  // ===== فرمول‌ساز ریاضی (شبیه MathType) =====
  let mtTargetIndex=null;
  window.openMathBuilder=(i)=>{
    mtTargetIndex=i;
    document.getElementById('mt-canvas').innerHTML='';
    document.getElementById('mt-modal-overlay').classList.remove('hidden');
    setTimeout(()=>document.getElementById('mt-canvas').focus(),50);
  };
  window.closeMathBuilder=()=>{
    document.getElementById('mt-modal-overlay').classList.add('hidden');
  };
  window.mtInsertIntoQuestion=()=>{
    if(mtTargetIndex===null)return;
    const canvas=document.getElementById('mt-canvas');
    convertDigitsInElement(canvas);
    const h=canvas.innerHTML.trim();
    if(!h){toast('ابتدا یک فرمول بسازید');return;}
    insHtmlAt(mtTargetIndex,h+'\u200b');
    closeMathBuilder();
    toast('فرمول درج شد ✅');
  };
  function mtInsHtml(h){
    const el=document.getElementById('mt-canvas');
    el.focus();
    const sel=document.getSelection();
    if(!sel.rangeCount||!el.contains(sel.anchorNode)){const r=document.createRange();r.selectNodeContents(el);r.collapse(false);sel.removeAllRanges();sel.addRange(r);}
    document.execCommand('insertHTML',false,h);
  }
  window.mtInsSym=(btn)=>{mtInsHtml(btn.dataset.sym);};
  window.mtInsertFrac=()=>{mtInsHtml('<span class="mt-frac" contenteditable="false"><span class="mt-ph mt-num" contenteditable="true" data-ph="بالا"></span><span class="mt-ph mt-den" contenteditable="true" data-ph="پایین"></span></span>\u200b');};
  window.mtInsertPow=()=>{mtInsHtml('<span class="mt-pow" contenteditable="false"><span class="mt-ph" contenteditable="true" data-ph="پایه"></span><sup class="mt-ph" contenteditable="true" data-ph="n"></sup></span>\u200b');};
  window.mtInsertSub=()=>{mtInsHtml('<span class="mt-sub" contenteditable="false"><span class="mt-ph" contenteditable="true" data-ph="پایه"></span><sub class="mt-ph" contenteditable="true" data-ph="n"></sub></span>\u200b');};
  window.mtInsertRoot=()=>{mtInsHtml('<span class="mt-root" contenteditable="false"><sup class="mt-ph mt-idx" contenteditable="true" data-ph=""></sup><span class="mt-radsign">\u221a</span><span class="mt-ph mt-rad" contenteditable="true" data-ph="مقدار"></span></span>\u200b');};
  window.mtInsertBigOp=(sign)=>{mtInsHtml('<span class="mt-op" contenteditable="false"><span class="mt-op-stack"><span class="mt-ph mt-op-over" contenteditable="true" data-ph=""></span><span class="mt-op-sign">'+sign+'</span><span class="mt-ph mt-op-under" contenteditable="true" data-ph=""></span></span><span class="mt-ph mt-op-arg" contenteditable="true" data-ph="عبارت"></span></span>\u200b');};
  window.mtInsertLim=()=>{mtInsHtml('<span class="mt-lim" contenteditable="false"><span class="mt-lim-stack"><span class="mt-lim-word">lim</span><span class="mt-ph mt-lim-under" contenteditable="true" data-ph="x\u2192a"></span></span><span class="mt-ph" contenteditable="true" data-ph="عبارت"></span></span>\u200b');};
  window.mtInsertMatrix=(n)=>{
    let rows='';
    for(let r=0;r<n;r++){
      let cells='';
      for(let c=0;c<n;c++)cells+='<td class="mt-ph" contenteditable="true" data-ph="."></td>';
      rows+='<tr>'+cells+'</tr>';
    }
    mtInsHtml('<table class="mt-matrix" contenteditable="false"><tbody>'+rows+'</tbody></table>\u200b');
  };
  window.mtInsertParen=(l,r)=>{mtInsHtml('<span class="mt-paren" contenteditable="false"><span class="mt-paren-sign">'+l+'</span><span class="mt-ph" contenteditable="true" data-ph="عبارت"></span><span class="mt-paren-sign">'+r+'</span></span>\u200b');};
  window.mtInsertDiv=()=>{mtInsHtml('<table class="ldiv" contenteditable="false" dir="ltr"><tr><td class="ld-bar">&nbsp;</td><td class="ld-top mt-ph" contenteditable="true" data-ph=""></td></tr><tr><td class="ld-bar ld-divisor mt-ph" contenteditable="true" data-ph="مقسوم‌علیه"></td><td><div class="ld-dividend mt-ph" contenteditable="true" data-ph="مقسوم"></div><div class="ld-work">&nbsp;</div></td></tr></table>\u200b');};

  (function initMathBuilder(){
    const row=document.getElementById('mt-sym-row');
    if(!row)return;
    row.innerHTML=MATH.map(function(s){return '<button type="button" onmousedown="event.preventDefault()" onclick="mtInsSym(this)" data-sym="'+escA(s)+'">'+escA(s)+'</button>';}).join('');
    const canvas=document.getElementById('mt-canvas');
    if(canvas)canvas.addEventListener('input',function(){convertDigitsInElement(canvas);});
    const overlay=document.getElementById('mt-modal-overlay');
    if(overlay)overlay.addEventListener('mousedown',function(e){if(e.target===overlay)closeMathBuilder();});
  })();

  let SELSHAPE=null;
  document.addEventListener('click',function(e){
    const sh=e.target&&e.target.closest?e.target.closest('.shape'):null;
    if(sh&&sh.closest('.rich')){
      if(SELSHAPE)SELSHAPE.style.outline='';
      SELSHAPE=sh;sh.style.outline='2px solid #2563eb';
      const i=sh.closest('.rich').getAttribute('data-qd');const r=document.getElementById('ssz-'+i);
      if(r){const svg=sh.querySelector('svg');const cur=svg?parseInt(svg.getAttribute('width'),10):parseInt((sh.style.fontSize||'40'),10);if(cur)r.value=cur;}
    }else if(SELSHAPE){SELSHAPE.style.outline='';SELSHAPE=null;}
  });
  window.resizeSel=(i)=>{
    const r=document.getElementById('ssz-'+i);if(!r)return;
    if(SELSHAPE&&SELSHAPE.closest('.rich')&&SELSHAPE.closest('.rich').getAttribute('data-qd')==String(i)){
      const z=parseInt(r.value,10);const svg=SELSHAPE.querySelector('svg');
      if(svg){svg.setAttribute('width',z);svg.setAttribute('height',z);}else{SELSHAPE.style.fontSize=z+'px';}
      updHtml(i);
    }
  };
  window.loadImg=(i,input)=>{
    const f=input.files[0];if(!f)return;
    const rd=new FileReader();
    rd.onload=ev=>{
      const img=new Image();
      img.onload=()=>{
        const c=document.createElement('canvas');const mw=1600;let w=img.width,h=img.height;
        if(w>mw){h=Math.round(h*mw/w);w=mw;}
        c.width=w;c.height=h;c.getContext('2d').drawImage(img,0,0,w,h);
        QUESTIONS[i].image=c.toDataURL('image/jpeg',0.92);
        if(QUESTIONS[i].imageAsQuestion && !QUESTIONS[i].imageWidth){QUESTIONS[i].imageWidth=500;}
        renderQ();
      };img.src=ev.target.result;
    };rd.readAsDataURL(f);
  };
  window.rmImg=(i)=>{QUESTIONS[i].image='';QUESTIONS[i].imageWidth=0;renderQ();};
  window.updImgSize=(i,val)=>{QUESTIONS[i].imageWidth=parseInt(val,10)||320;renderQ();};
  window.toggleQImageMode=(i,checked)=>{
    QUESTIONS[i].imageAsQuestion=checked;
    renderQ();
  };
  
  document.querySelectorAll('[data-add]').forEach(b=>b.onclick=()=>{
    const t=b.dataset.add;
    QUESTIONS.push({
      id: uid(),
      type: t,
      rich: t==='descriptive',
      text: '',
      options: t==='multiple' ? ['','','',''] : [],
      correct: t==='multiple' ? '0' : (t==='truefalse' ? 'true' : ''),
      image: '',
      weight: 1
    });
    renderQ();
  });

  /* ===== پیشنهاد سوال با هوش مصنوعی ===== */
  let AIQ_SUGGESTIONS=[];
  const AIQ_TYPE_LABEL={descriptive:'تشریحی',multiple:'چهارگزینه‌ای',truefalse:'صحیح/غلط',short:'کوتاه‌پاسخ'};

  window.openAiQSuggest=function(){
    document.getElementById('aiq-modal-overlay').classList.remove('hidden');
  };
  window.closeAiQSuggest=function(){
    document.getElementById('aiq-modal-overlay').classList.add('hidden');
  };
  document.getElementById('btn-ai-suggest-q').onclick=openAiQSuggest;

  function aiqNormalize(item,forcedType){
    const type=forcedType || (['descriptive','multiple','truefalse','short'].includes(item.type)?item.type:'descriptive');
    const out={type:type,text:String(item.text||'').trim(),options:[],correct:''};
    if(type==='multiple'){
      const opts=Array.isArray(item.options)?item.options.slice(0,4):[];
      while(opts.length<4)opts.push('');
      out.options=opts.map(o=>String(o||''));
      let ci=parseInt(item.correct,10);
      if(isNaN(ci)||ci<0||ci>3)ci=0;
      out.correct=String(ci);
    }else if(type==='truefalse'){
      out.correct=(String(item.correct).toLowerCase()==='false')?'false':'true';
    }else if(type==='short'){
      out.correct=String(item.correct||'');
    }
    return out;
  }

  async function aiqGenerate(){
    const topic=document.getElementById('aiq-topic').value.trim();
    if(!topic){toast('لطفاً موضوع یا محتوای سوالات را بنویسید');return;}
    let count=parseInt(document.getElementById('aiq-count').value,10);
    if(isNaN(count)||count<1)count=1;
    if(count>10)count=10;
    document.getElementById('aiq-count').value=count;
    const typeSel=document.getElementById('aiq-type').value;

    const btn=document.getElementById('btn-aiq-generate');
    const regenBtn=document.getElementById('btn-aiq-regenerate');
    const statusEl=document.getElementById('aiq-status');
    [btn,regenBtn].forEach(b=>{if(b){b.disabled=true;}});
    statusEl.textContent='⏳ در حال دریافت پیشنهاد از هوش مصنوعی...';

    const typeInstruction = typeSel==='auto'
      ? 'نوع هر سوال را خودت به‌صورت متنوع از میان این چهار نوع انتخاب کن: descriptive (تشریحی)، multiple (چهارگزینه‌ای)، truefalse (صحیح/غلط)، short (کوتاه‌پاسخ).'
      : 'همه‌ی سوالات باید دقیقاً از نوع "'+typeSel+'" باشند.';

    const sys='تو یک دستیار طراحی سوال آزمون برای معلم‌های ایرانی هستی. بر اساس موضوع داده‌شده توسط معلم، دقیقاً '+count+' سوال آزمون طراحی کن. '+typeInstruction+
      ' خروجی را فقط و فقط به‌صورت یک آرایه‌ی JSON معتبر برگردان، بدون هیچ توضیح اضافه، بدون Markdown و بدون علامت‌های کد (بک‌تیک). '+
      'هر عضو آرایه باید این شکل را داشته باشد: {"type":"descriptive|multiple|truefalse|short","text":"متن سوال به فارسی","options":["گزینه۱","گزینه۲","گزینه۳","گزینه۴"],"correct":"..."}. '+
      'فیلد options فقط برای نوع multiple لازم است (دقیقاً ۴ گزینه) و برای بقیه‌ی انواع می‌تواند آرایه‌ی خالی باشد. '+
      'فیلد correct برای multiple باید عدد اندیس گزینه‌ی صحیح باشد (۰ تا ۳ به‌صورت رشته)، برای truefalse مقدار "true" یا "false"، برای short یک پاسخ نمونه‌ی کوتاه، و برای descriptive می‌تواند رشته‌ی خالی باشد.';

    try{
      const res=await fetch('/api/teacher/ai/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
        messages:[{role:'system',content:sys},{role:'user',content:'موضوع/محتوای سوالات: '+topic}],
        max_tokens: Math.min(8192, 1200 + count*650),
        provider:getAiProvider()
      })});
      const data=await res.json();
      if(!res.ok||data.error)throw new Error(data.error||'خطا در ارتباط با هوش مصنوعی');
      let raw=String(data.content||'').trim();
      const AIQ_BT=String.fromCharCode(96,96,96);
      if(raw.slice(0,3+4).toLowerCase()===AIQ_BT+'json')raw=raw.slice(7);else if(raw.slice(0,3)===AIQ_BT)raw=raw.slice(3);
      if(raw.slice(-3)===AIQ_BT)raw=raw.slice(0,-3);
      raw=raw.trim();
      const arrText=aiqExtractJsonArray(raw);
      if(!arrText){
        console.error('پاسخ خام هوش مصنوعی (بدون آرایه‌ی معتبر):',raw);
        throw new Error('پاسخ هوش مصنوعی قابل پردازش نبود، دوباره تلاش کنید');
      }
      let parsed;
      try{parsed=JSON.parse(arrText);}catch(e){
        console.error('پاسخ خام هوش مصنوعی (JSON نامعتبر):',raw);
        throw new Error('پاسخ هوش مصنوعی قابل پردازش نبود، دوباره تلاش کنید');
      }
      if(!Array.isArray(parsed)||!parsed.length)throw new Error('هوش مصنوعی سوالی برنگرداند، دوباره تلاش کنید');
      const forced=typeSel==='auto'?null:typeSel;
      AIQ_SUGGESTIONS=parsed.slice(0,count).map(it=>Object.assign({selected:true},aiqNormalize(it,forced)));
      aiqRenderPreview();
      document.getElementById('aiq-preview-wrap').classList.remove('hidden');
      statusEl.textContent='✅ '+AIQ_SUGGESTIONS.length+' سوال پیشنهاد شد. پیش از افزودن بررسی کنید.';
    }catch(e){
      statusEl.textContent='❌ '+e.message;
      toast('خطا: '+e.message);
    }
    [btn,regenBtn].forEach(b=>{if(b){b.disabled=false;}});
  }
  document.getElementById('btn-aiq-generate').onclick=aiqGenerate;
  document.getElementById('btn-aiq-regenerate').onclick=aiqGenerate;

  // اولین آرایه‌ی JSON متعادل (براکت‌های باز/بسته هم‌تراز) را در متن پیدا می‌کند؛
  // اگر پاسخ به‌صورت {"questions":[...]} یا مشابه بسته‌بندی شده باشد هم آن را پیدا می‌کند
  function aiqExtractJsonArray(text){
    const start=text.indexOf('[');
    if(start===-1)return null;
    let depth=0,inStr=false,esc=false;
    for(let i=start;i<text.length;i++){
      const ch=text[i];
      if(inStr){
        if(esc)esc=false;
        else if(ch==='\\\\')esc=true;
        else if(ch==='"')inStr=false;
        continue;
      }
      if(ch==='"'){inStr=true;continue;}
      if(ch==='[')depth++;
      else if(ch===']'){
        depth--;
        if(depth===0)return text.slice(start,i+1);
      }
    }
    return null;
  }

  function aiqQOptHtml(j,item){
    let h='';
    if(item.type==='multiple'){
      h+='<label>گزینه صحیح</label><select onchange="aiqUpdField('+j+',\\'correct\\',this.value)">'+
        [0,1,2,3].map(n=>'<option value="'+n+'" '+(String(item.correct)===String(n)?'selected':'')+'>'+['الف','ب','ج','د'][n]+'</option>').join('')+'</select>';
      h+='<label>گزینه‌ها</label>';
      for(let oi=0;oi<4;oi++){
        h+='<div class="opt-row"><span>'+['الف','ب','ج','د'][oi]+')</span><input type="text" value="'+esc((item.options&&item.options[oi])||'')+'" oninput="aiqUpdOpt('+j+','+oi+',this.value)"></div>';
      }
    }else if(item.type==='truefalse'){
      h+='<label>پاسخ صحیح</label><select onchange="aiqUpdField('+j+',\\'correct\\',this.value)">'+
        '<option value="true" '+(String(item.correct)==='true'?'selected':'')+'>صحیح</option>'+
        '<option value="false" '+(String(item.correct)==='false'?'selected':'')+'>غلط</option></select>';
    }else if(item.type==='short'){
      h+='<label>پاسخ نمونه (اختیاری)</label><input type="text" value="'+esc(item.correct||'')+'" oninput="aiqUpdField('+j+',\\'correct\\',this.value)">';
    }
    return h;
  }

  function aiqRenderPreview(){
    const box=document.getElementById('aiq-preview-list');
    box.innerHTML=AIQ_SUGGESTIONS.map((item,j)=>{
      return '<div class="q-block">'+
        '<div class="qhead">'+
          '<label style="display:flex;align-items:center;gap:6px;font-weight:700;cursor:pointer">'+
            '<input type="checkbox" '+(item.selected?'checked':'')+' onchange="aiqToggleSel('+j+',this.checked)"> سوال '+(j+1)+
          '</label>'+
          '<span><select onchange="aiqChangeType('+j+',this.value)">'+
            Object.keys(AIQ_TYPE_LABEL).map(t=>'<option value="'+t+'" '+(item.type===t?'selected':'')+'>'+AIQ_TYPE_LABEL[t]+'</option>').join('')+
          '</select></span>'+
        '</div>'+
        '<label>متن سوال</label><textarea oninput="aiqUpdField('+j+',\\'text\\',this.value)">'+esc(item.text)+'</textarea>'+
        aiqQOptHtml(j,item)+
      '</div>';
    }).join('');
  }

  window.aiqToggleSel=function(j,checked){ if(AIQ_SUGGESTIONS[j])AIQ_SUGGESTIONS[j].selected=checked; };
  window.aiqUpdField=function(j,k,v){ if(AIQ_SUGGESTIONS[j])AIQ_SUGGESTIONS[j][k]=v; };
  window.aiqUpdOpt=function(j,oi,v){
    if(!AIQ_SUGGESTIONS[j])return;
    AIQ_SUGGESTIONS[j].options=AIQ_SUGGESTIONS[j].options||['','','',''];
    AIQ_SUGGESTIONS[j].options[oi]=v;
  };
  window.aiqChangeType=function(j,newType){
    if(!AIQ_SUGGESTIONS[j])return;
    AIQ_SUGGESTIONS[j]=Object.assign({selected:AIQ_SUGGESTIONS[j].selected},aiqNormalize(AIQ_SUGGESTIONS[j],newType));
    aiqRenderPreview();
  };

  document.getElementById('btn-aiq-add-selected').onclick=function(){
    const chosen=AIQ_SUGGESTIONS.filter(it=>it.selected&&it.text.trim());
    if(!chosen.length){toast('هیچ سوالی برای افزودن انتخاب نشده است');return;}
    chosen.forEach(it=>{
      QUESTIONS.push({
        id: uid(),
        type: it.type,
        rich: it.type==='descriptive',
        text: it.text,
        options: it.type==='multiple' ? it.options.slice(0,4) : [],
        correct: it.correct||'',
        image: '',
        weight: 1
      });
    });
    renderQ();
    toast(chosen.length+' سوال به آزمون افزوده شد ✅');
    AIQ_SUGGESTIONS=[];
    document.getElementById('aiq-preview-wrap').classList.add('hidden');
    document.getElementById('aiq-preview-list').innerHTML='';
    document.getElementById('aiq-status').textContent='';
    closeAiQSuggest();
  };

  document.getElementById('btn-save-q').onclick=async()=>{
    const duration = parseInt(document.getElementById('m-exam-duration').value);
    if(isNaN(duration) || duration < 1){
      toast('❌ مدت زمان باید حداقل ۱ دقیقه باشد');
      return;
    }
    
    // بررسی جمع وزن‌ها
    const totalWeight = calculateTotalWeight();
    if (Math.abs(totalWeight - 20) > 0.01) {
      if (!confirm('⚠️ جمع وزن‌های سوالات ' + totalWeight.toFixed(1) + ' است (باید 20 باشد). آیا مطمئن هستید؟')) {
        return;
      }
    }
    
    META={
      school: document.getElementById('m-school').value,
      teacher: document.getElementById('m-teacher').value,
      examName: document.getElementById('m-exam-name').value,
      examDuration: String(duration),
      gradeLevel: document.getElementById('m-grade-level').value
    };
    const d=await api('/api/teacher/questions',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({questions:QUESTIONS,meta:META})});
    if(d.ok){toast('سربرگ و سوالات ذخیره شد ✅');}else toast(d.error||'خطا');
  };

  // ===== پاسخنامه‌ها =====
  function ansText(q,ans){
    if(q.type==='multiple'){const idx=parseInt(ans,10);return isNaN(idx)?'':(['الف','ب','ج','د'][idx]+') '+esc((q.options&&q.options[idx])||''));}
    if(q.type==='truefalse'){return ans==='true'?'صحیح':(ans==='false'?'غلط':'');}
    return esc(ans);
  }
  
  let GRADING_TYPE = 'descriptive';
  
  document.querySelectorAll('input[name="grading-type"]').forEach(radio => {
    radio.onchange = function() {
      GRADING_TYPE = this.value;
      const sel=document.getElementById('ans-student-select');
      if(sel.value)renderAnswerDetail(sel.value);
    };
  });
  
  window.openAnsPhoto=function(src){
    document.getElementById('ans-photo-modal-img').src=src;
    document.getElementById('ans-photo-modal-dl').href=src;
    document.getElementById('ans-photo-modal').classList.remove('hidden');
  };
  window.closeAnsPhoto=function(){
    document.getElementById('ans-photo-modal').classList.add('hidden');
  };

  async function loadAnswers(){
    const d=await api('/api/teacher/submissions');
    SUBS=d.submissions||[];
    const sel=document.getElementById('ans-student-select');
    const box=document.getElementById('answers-list');
    if(!SUBS.length){
      sel.innerHTML='<option value="">— پاسخنامه‌ای ثبت نشده —</option>';
      box.innerHTML='<p class="muted">هنوز پاسخنامه‌ای ثبت نشده است.</p>';
      return;
    }
    const prevVal=sel.value;
    sel.innerHTML='<option value="">— یک دانش‌آموز را انتخاب کنید —</option>'+SUBS.map(function(s){
      const g=s.grading||{graded:false};
      const status=g.graded?' ✅ تصحیح‌شده':' ⏳ در انتظار تصحیح';
      return '<option value="'+s.uuid+'">'+esc(s.student.name)+status+'</option>';
    }).join('');
    if(prevVal && SUBS.some(function(s){return s.uuid===prevVal;})){
      sel.value=prevVal;
      renderAnswerDetail(prevVal);
    }else{
      box.innerHTML='<p class="muted">یک دانش‌آموز را از فهرست بالا انتخاب کنید تا پاسخنامه‌ی او نمایش داده شود.</p>';
    }
  }

  function renderAnswerDetail(uuid){
    const box=document.getElementById('answers-list');
    const s=SUBS.find(function(x){return x.uuid===uuid;});
    if(!s){box.innerHTML='';return;}
    const g=s.grading||{graded:false,feedback:{},marks:{},overall:''};
    const isNumeric = GRADING_TYPE === 'numeric';
    const rows=(s.questionsSnapshot||[]).map((q,i)=>{
      const ans=s.answers?s.answers[q.id]:'';
      const photoAns=s.photoAnswers?s.photoAnswers[q.id]:'';
      const fb=(g.feedback&&g.feedback[q.id])||'';
      const mk=(g.marks&&g.marks[q.id])||'';
      const weight = q.weight || 1;
      
      let gradeCell;
      if(isNumeric){
        // محاسبه حداکثر نمره برای این سوال (بر اساس وزن)
        const totalWeight = s.questionsSnapshot.reduce((sum, qq) => sum + (qq.weight || 1), 0) || 20;
        const maxScore = (weight / totalWeight) * 20;
        gradeCell='<input type="number" id="mk_'+s.uuid+'_'+q.id+'" value="'+esc(mk)+'" placeholder="نمره" min="0" max="'+maxScore.toFixed(1)+'" step="0.5" style="width:80px;padding:6px;border:1px solid #ddd;border-radius:4px">'+
          '<span style="font-size:11px;color:#64748b;margin-right:4px">از '+maxScore.toFixed(1)+'</span>';
      } else {
        const opt=(v,t)=>'<option value="'+v+'" '+(mk===v?'selected':'')+'>'+t+'</option>';
        gradeCell='<select id="mk_'+s.uuid+'_'+q.id+'"><option value="">—</option>'+opt('excellent','🌟 خیلی خوب')+opt('good','✅ خوب')+opt('acceptable','📌 قابل‌قبول')+opt('needs-improve','📖 نیاز به تلاش')+'</select>';
      }
      
      return '<tr><td>'+(i+1)+'</td><td>'+qHtml(q)+(q.image?'<br><img src="'+q.image+'" class="imgprev" style="max-width:'+(q.imageWidth||320)+'px;width:100%;cursor:zoom-in" onclick="openAnsPhoto(this.src)" title="برای بزرگ‌نمایی کلیک کنید">':'')+'</td>'+
        '<td>'+(ansText(q,ans)||(photoAns?'':'<i>بدون پاسخ</i>'))+(photoAns?'<br><img src="'+photoAns+'" class="ans-photo-thumb" onclick="openAnsPhoto(this.src)" style="max-width:200px;width:100%;border:1px solid #ddd;border-radius:6px;margin-top:6px;cursor:zoom-in" title="برای بزرگ‌نمایی کلیک کنید"><br><a href="'+photoAns+'" download="پاسخ.jpg" class="btn sm secondary" style="margin-top:4px;display:inline-block">⬇️ دانلود عکس</a>':'')+'</td>'+
        '<td>'+gradeCell+'</td>'+
        '<td><input type="text" id="fb_'+s.uuid+'_'+q.id+'" value="'+esc(fb)+'" placeholder="بازخورد"></td></tr>';
    }).join('');
    const badge=g.graded?'<span class="pill ok">✅ تصحیح‌شده</span>':'<span class="pill gr">⏳ در انتظار تصحیح</span>';
    
    const statusHeader = isNumeric ? 'نمره' : 'وضعیت';
    const feedbackLabel = isNumeric ? 'توضیحات (اختیاری)' : 'بازخورد';
    const avatar=s.studentPhoto?'<img src="'+s.studentPhoto+'" style="width:44px;height:44px;border-radius:50%;object-fit:cover">':'<div style="width:44px;height:44px;border-radius:50%;background:#e2e8f0;display:flex;align-items:center;justify-content:center;font-size:20px">🧑‍🎓</div>';
    
    box.innerHTML='<div class="q-block"><div class="qhead"><span style="display:flex;align-items:center;gap:8px">'+avatar+'<b>'+esc(s.student.name)+'</b> '+badge+'</span>'+
      ' <a class="btn sm sec" href="/api/teacher/word?type=answers&uuid='+s.uuid+'">📄 دانلود Word</a></div>'+
      '<p class="muted">نام پدر: '+esc(s.student.fatherName)+' | کد ملی: '+esc(s.student.nationalId)+' | نام درس: '+esc(s.student.courseName||'')+' | تاریخ آزمون: '+esc(s.student.examDate||'')+' | ثبت: '+new Date(s.submittedAt).toLocaleString('fa-IR')+'</p>'+
      '<div class="ans-table-scroll"><table class="ans-grade-table"><tr><th>#</th><th>سوال</th><th>پاسخ دانش‌آموز</th><th>'+statusHeader+'</th><th>'+feedbackLabel+'</th></tr>'+rows+'</table></div>'+
      '<label>'+feedbackLabel+' کلی</label><textarea id="ov_'+s.uuid+'">'+esc(g.overall||'')+'</textarea>'+
      '<button class="btn" style="margin-top:8px" onclick="saveGrade(\\''+s.uuid+'\\')">ثبت تصحیح</button></div>';
  }

  document.getElementById('ans-student-select').addEventListener('change', function(){
    if(this.value)renderAnswerDetail(this.value);
    else document.getElementById('answers-list').innerHTML='<p class="muted">یک دانش‌آموز را از فهرست بالا انتخاب کنید تا پاسخنامه‌ی او نمایش داده شود.</p>';
  });

  window.saveGrade=async(uuid)=>{
    const sub=SUBS.find(x=>x.uuid===uuid);if(!sub)return;
    const feedback={},marks={};
    (sub.questionsSnapshot||[]).forEach(q=>{
      const fb=document.getElementById('fb_'+uuid+'_'+q.id);const mk=document.getElementById('mk_'+uuid+'_'+q.id);
      if(fb)feedback[q.id]=fb.value;
      if(mk&&mk.value)marks[q.id]=mk.value;
    });
    const overall=document.getElementById('ov_'+uuid).value;
    const d=await api('/api/teacher/grade',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({uuid,feedback,marks,overall})});
    if(d.ok){toast('تصحیح ثبت شد ✅');loadAnswers();}else toast(d.error||'خطا');
  };
  document.getElementById('btn-refresh-ans').onclick=loadAnswers;

  // ===== کاربرگ =====
  let WORKSHEET_STUDENTS=[];
  async function loadWorksheetList(){
    const sel=document.getElementById('ws-student-select');
    const box=document.getElementById('worksheet-list');
    const d=await api('/api/teacher/students');
    if(!d.ok||!d.students||!d.students.length){
      sel.innerHTML='<option value="">— ابتدا دانش‌آموز بسازید —</option>';
      box.innerHTML='<p class="muted">ابتدا از تب «دانش‌آموزان» یک دانش‌آموز بسازید.</p>';
      return;
    }
    WORKSHEET_STUDENTS=d.students;
    const prevVal=sel.value;
    sel.innerHTML='<option value="">— یک دانش‌آموز را انتخاب کنید —</option>'+d.students.map(function(s){
      return '<option value="'+s.uuid+'">'+esc(s.label||'(بدون نام)')+'</option>';
    }).join('');
    if(prevVal && d.students.some(function(s){return s.uuid===prevVal;})){
      sel.value=prevVal;
      renderWorksheetDetail(prevVal);
    }else{
      box.innerHTML='<p class="muted">یک دانش‌آموز را از فهرست بالا انتخاب کنید.</p>';
    }
  }
  document.getElementById('btn-refresh-ws').onclick=loadWorksheetList;

  async function renderWorksheetDetail(uuid){
    const box=document.getElementById('worksheet-list');
    const s=WORKSHEET_STUDENTS.find(function(x){return x.uuid===uuid;});
    const avatar=(s&&s.photo)?'<img src="'+s.photo+'" style="width:40px;height:40px;border-radius:50%;object-fit:cover">':'<div style="width:40px;height:40px;border-radius:50%;background:#e2e8f0;display:flex;align-items:center;justify-content:center;font-size:18px">🧑‍🎓</div>';
    box.innerHTML='<div class="q-block" id="ws-row-'+uuid+'">'+
      '<div class="row" style="align-items:center;flex-wrap:wrap">'+
        '<span style="display:flex;align-items:center;gap:8px;flex:1">'+avatar+'<b>'+esc(s?s.label:'')+'</b></span>'+
        '<label class="btn sm sec" style="cursor:pointer;flex:0 0 auto">📄 بارگذاری/جایگزینی کاربرگ<input type="file" accept="image/*,application/pdf" class="hidden" data-ws-upload="'+uuid+'"></label>'+
      '</div>'+
      '<div id="ws-detail-'+uuid+'" style="margin-top:12px;padding-top:12px;border-top:1px solid var(--line)"><p class="muted">در حال بارگذاری...</p></div>'+
    '</div>';
    const detail=document.getElementById('ws-detail-'+uuid);
    const d=await api('/api/teacher/worksheet/'+uuid);
    if(!d.ok){detail.innerHTML='<p class="muted">خطا در بارگذاری</p>';return;}
    const w=d.worksheet||{};
    let html='';
    if(w.teacherFile){
      html+='<div style="margin-bottom:12px"><b style="font-size:13px">📄 کاربرگ ارسال‌شده:</b><br>';
      if(w.teacherFileType==='pdf'){
        html+='<a class="btn sm sec" href="'+w.teacherFile+'" download="'+(w.teacherFileName||'کاربرگ.pdf')+'" style="margin-top:6px;display:inline-block">⬇️ دانلود PDF ('+esc(w.teacherFileName||'')+')</a>';
      }else{
        html+='<img src="'+w.teacherFile+'" style="max-width:260px;border-radius:8px;border:1px solid #ddd;margin-top:6px;display:block;cursor:zoom-in" onclick="openAnsPhoto(this.src)" title="برای بزرگ‌نمایی کلیک کنید">';
      }
      html+='<button class="btn sm danger" type="button" style="margin-top:6px" data-ws-remove="'+uuid+'">🗑 حذف کاربرگ</button>';
      html+='</div>';
    }else{
      html+='<p class="muted">هنوز کاربرگی برای این دانش‌آموز بارگذاری نکرده‌اید.</p>';
    }
    if(w.studentFiles&&w.studentFiles.length){
      html+='<div style="margin-bottom:12px"><b style="font-size:13px">📷 عکس‌های ارسالی دانش‌آموز:</b><div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px">'+
        w.studentFiles.map(function(p){return '<img src="'+p+'" style="width:100px;height:100px;object-fit:cover;border-radius:8px;border:1px solid #ddd;cursor:pointer" onclick="openAnsPhoto(this.src)">';}).join('')+
      '</div></div>';
    }else{
      html+='<p class="muted">دانش‌آموز هنوز کاربرگ انجام‌شده را ارسال نکرده است.</p>';
    }
    html+='<div><label style="font-weight:600;font-size:13px">💬 بازخورد شما:</label>'+
      '<textarea id="ws-fb-'+uuid+'" placeholder="بازخورد خود را برای دانش‌آموز بنویسید...">'+esc(w.feedback||'')+'</textarea>'+
      '<button class="btn sm primary" style="margin-top:8px" data-ws-savefb="'+uuid+'">💾 ذخیره بازخورد</button></div>';
    detail.innerHTML=html;
  }

  document.getElementById('ws-student-select').addEventListener('change', function(){
    if(this.value)renderWorksheetDetail(this.value);
    else document.getElementById('worksheet-list').innerHTML='<p class="muted">یک دانش‌آموز را از فهرست بالا انتخاب کنید.</p>';
  });

  document.getElementById('worksheet-list').addEventListener('change',async function(e){
    const inp=e.target.closest('[data-ws-upload]');
    if(!inp)return;
    const uuid=inp.dataset.wsUpload;
    const file=inp.files&&inp.files[0];
    inp.value='';
    if(!file)return;
    try{
      let fileDataUrl,fileName;
      if(file.type==='application/pdf'){
        if(file.size>4*1024*1024){toast('حجم فایل PDF باید کمتر از ۴ مگابایت باشد');return;}
        fileDataUrl=await new Promise(function(resolve,reject){
          const rd=new FileReader();
          rd.onload=function(){resolve(rd.result);};
          rd.onerror=function(){reject(new Error('خطا در خواندن فایل'));};
          rd.readAsDataURL(file);
        });
        fileName=file.name;
      }else if(file.type.startsWith('image/')){
        fileDataUrl=await compressWorksheetImage(file);
        fileName=file.name;
      }else{
        toast('فقط فایل عکس یا PDF مجاز است');return;
      }
      toast('در حال بارگذاری کاربرگ...');
      const d=await api('/api/teacher/worksheet/'+uuid,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({fileDataUrl,fileName})});
      if(d.ok){toast('کاربرگ بارگذاری شد ✅');renderWorksheetDetail(uuid);}else toast(d.error||'خطا در بارگذاری');
    }catch(err){toast(err.message||'خطا در پردازش فایل');}
  });

  document.getElementById('worksheet-list').addEventListener('click',async function(e){
    const btn=e.target.closest('[data-ws-savefb]');
    if(!btn)return;
    const uuid=btn.dataset.wsSavefb;
    const ta=document.getElementById('ws-fb-'+uuid);
    const feedback=ta?ta.value:'';
    const d=await api('/api/teacher/worksheet/'+uuid+'/feedback',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({feedback})});
    if(d.ok)toast('بازخورد ذخیره شد ✅');else toast(d.error||'خطا در ذخیره بازخورد');
  });

  document.getElementById('worksheet-list').addEventListener('click',async function(e){
    const btn=e.target.closest('[data-ws-remove]');
    if(!btn)return;
    const uuid=btn.dataset.wsRemove;
    if(!confirm('آیا از حذف کاربرگ مطمئن هستید؟'))return;
    const d=await api('/api/teacher/worksheet/'+uuid,{method:'DELETE'});
    if(d.ok){toast('کاربرگ حذف شد ✅');renderWorksheetDetail(uuid);}else toast(d.error||'خطا در حذف');
  });

  // ===== برنامه هفتگی =====
  async function loadSchedule(){
    const r=await api('/api/teacher/schedule');
    if(r.ok && r.data){
      scheduleData=r.data;
      document.getElementById('sch-school').value=scheduleData.school||'';
      document.getElementById('sch-year').value=scheduleData.year||'';
      document.getElementById('sch-topic').value=scheduleData.topic||'';
      document.getElementById('sch-principal').value=scheduleData.principal||'';
      document.getElementById('sch-class').value=scheduleData.cls||'';
      document.getElementById('sch-teacher').value=scheduleData.teacher||'';
      if(scheduleData.cells){
        for(let d=0;d<5;d++){for(let i=1;i<=5;i++){const el=document.getElementById('c'+d+i);if(el)el.value=scheduleData.cells['c'+d+i]||'';}}
      }
    }
  }

  // ===== سوییچ تم رنگی برنامهٔ هفتگی (پسرانه/دخترانه/پیش‌فرض) =====
  document.querySelectorAll('.sch-theme-btn').forEach(btn=>{
    btn.onclick=()=>{
      document.querySelectorAll('.sch-theme-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      const wrap=document.getElementById('schedule-table-wrap');
      wrap.classList.remove('theme-boy','theme-girl','theme-colorful');
      if(btn.dataset.theme==='boy')wrap.classList.add('theme-boy');
      if(btn.dataset.theme==='girl')wrap.classList.add('theme-girl');
      if(btn.dataset.theme==='colorful')wrap.classList.add('theme-colorful');
      const isColorful=btn.dataset.theme==='colorful';
      document.querySelectorAll('.sch-decor-corner').forEach(function(d){d.classList.toggle('hidden',!isColorful);});
      const titleEl=document.getElementById('schedule-title');
      if(titleEl)titleEl.textContent=isColorful?'⏰ برنامه هفتگی کلاس 📓':'📅 برنامه هفتگی';
      lbSave('sch-theme',btn.dataset.theme,true);
    };
  });
  let SCH_THEME_LOADED=false;
  async function loadScheduleThemeIfNeeded(){
    if(SCH_THEME_LOADED)return;
    SCH_THEME_LOADED=true;
    const saved=await lbLoad('sch-theme');
    if(saved && saved!=='default'){
      const btn=document.querySelector('.sch-theme-btn[data-theme="'+saved+'"]');
      if(btn)btn.click();
    }
  }

  // ===== فونت و اندازهٔ فونت جدول برنامهٔ هفتگی (پیش‌فرض/نازنین/تیتر) =====
  var SCH_FONTS={default:'',nazanin:"'B Nazanin','BNazanin',Tahoma,Arial",titr:"'B Titr','BTitr',Tahoma,Arial"};
  // مثل ورد: با زدن اینتر داخل خانه، متن به خط بعد می‌رود و ارتفاع همان خانه به‌صورت خودکار بزرگ‌تر می‌شود
  function schAutoResizeTa(ta){
    ta.style.height='auto';
    ta.style.height=ta.scrollHeight+'px';
  }
  function schWireTextareas(){
    document.querySelectorAll('#schedule-body textarea').forEach(function(ta){
      schAutoResizeTa(ta);
      if(ta.dataset.schWired)return;
      ta.dataset.schWired='1';
      ta.addEventListener('input',function(){schAutoResizeTa(ta);});
    });
  }
  function schApplyTableFont(){
    var key=document.getElementById('sch-font').value;
    var size=parseInt(document.getElementById('sch-font-size').value,10)||14;
    var family=SCH_FONTS[key]||'';
    var tableEl=document.getElementById('schedule-table');
    tableEl.style.fontFamily=family;
    tableEl.querySelectorAll('th,td').forEach(function(cell){cell.style.fontFamily=family;});
    document.querySelectorAll('#schedule-body textarea').forEach(function(ta){
      ta.style.fontFamily=family;
      ta.style.fontSize=size+'px';
    });
    schWireTextareas();
  }
  document.getElementById('sch-font').addEventListener('change',function(){
    schApplyTableFont();
    lbSave('sch-font',document.getElementById('sch-font').value,true);
  });
  document.getElementById('sch-font-size').addEventListener('input',schApplyTableFont);
  document.getElementById('sch-font-size').addEventListener('change',function(){
    schApplyTableFont();
    lbSave('sch-font-size',document.getElementById('sch-font-size').value,true);
  });
  document.getElementById('sch-font-size').addEventListener('keydown',function(e){if(e.key==='Enter')schApplyTableFont();});
  let SCH_FONT_LOADED=false;
  async function loadScheduleFontIfNeeded(){
    if(SCH_FONT_LOADED)return;
    SCH_FONT_LOADED=true;
    const saved=await lbLoad('sch-font');
    const savedSize=await lbLoad('sch-font-size');
    if(saved)document.getElementById('sch-font').value=saved;
    if(savedSize)document.getElementById('sch-font-size').value=savedSize;
    if(saved||savedSize)schApplyTableFont();
  }

  document.getElementById('btn-gen-schedule').onclick=function(){
    const body=document.getElementById('schedule-body');
    let html='';
    const days=['شنبه','یکشنبه','دوشنبه','سه‌شنبه','چهارشنبه'];
    const dayKeys=['shanbe','yekshanbe','doshshanbe','seshshanbe','chaharshanbe'];
    // نگاشت روز هفته‌ی جاری (جاوااسکریپت) به ایندکس ردیف برنامه (شنبه=0 ... چهارشنبه=4)
    const jsDayToRow={6:0,0:1,1:2,2:3,3:4};
    const todayRow=jsDayToRow.hasOwnProperty(new Date().getDay())?jsDayToRow[new Date().getDay()]:-1;
    const colorKeys=['none','pink','blue','red','yellow','orange','green'];
    for(let d=0;d<5;d++){
      const isToday=d===todayRow;
      let dots='<span class="row-color-picker" data-daykey="'+dayKeys[d]+'">';
      var colorLabels={none:'بدون رنگ',pink:'صورتی',blue:'آبی',red:'قرمز',yellow:'زرد',orange:'نارنجی',green:'سبز'};
      colorKeys.forEach(function(ck){dots+='<button type="button" class="row-color-dot" data-color="'+ck+'" data-daykey="'+dayKeys[d]+'" title="'+colorLabels[ck]+'"></button>';});
      dots+='</span>';
      html+='<tr'+(isToday?' class="sch-today"':'')+'><td class="sch-daylabel-'+dayKeys[d]+'"><span class="sch-day-accent"></span>'+(isToday?'<span class="sch-today-badge">امروز</span>':'')+days[d]+dots+'</td>';
      for(let i=1;i<=5;i++){
        const val=(scheduleData.cells&&scheduleData.cells['c'+d+i])||'';
        html+='<td class="cell-'+dayKeys[d]+'"><textarea id="c'+d+i+'" placeholder="زنگ '+(i)+'">'+esc(val)+'</textarea></td>';
      }
      html+='</tr>';
    }
    body.innerHTML=html;
    schApplyTableFont();
    schWireTextareas();
    schRefreshRowColorDots();
  };

  // ===== رنگ دلخواه هر ردیف (روز) برنامهٔ هفتگی =====
  var SCH_ROW_COLOR_HEX={pink:'#fbcfe8',blue:'#bfdbfe',red:'#fecaca',yellow:'#fef08a',orange:'#fed7aa',green:'#bbf7d0'};
  var schRowColors={};
  function schApplyRowColor(dayKey,colorKey){
    var hex=SCH_ROW_COLOR_HEX[colorKey]||'';
    document.querySelectorAll('.sch-daylabel-'+dayKey+',.cell-'+dayKey).forEach(function(td){td.style.background=hex;});
  }
  function schRefreshRowColorDots(){
    document.querySelectorAll('.row-color-picker').forEach(function(picker){
      var dayKey=picker.dataset.daykey;
      var current=schRowColors[dayKey]||'none';
      picker.querySelectorAll('.row-color-dot').forEach(function(dot){
        dot.classList.toggle('active',dot.dataset.color===current);
      });
      schApplyRowColor(dayKey,current==='none'?'':current);
    });
  }
  document.getElementById('schedule-table').addEventListener('click',function(e){
    var dot=e.target.closest('.row-color-dot');
    if(!dot)return;
    var dayKey=dot.dataset.daykey;
    var colorKey=dot.dataset.color;
    schRowColors[dayKey]=colorKey;
    schRefreshRowColorDots();
    lbSave('sch-row-colors',schRowColors,true);
  });
  var SCH_ROW_COLORS_LOADED=false;
  async function loadScheduleRowColorsIfNeeded(){
    if(SCH_ROW_COLORS_LOADED)return;
    SCH_ROW_COLORS_LOADED=true;
    const saved=await lbLoad('sch-row-colors');
    if(saved&&typeof saved==='object')schRowColors=saved;
    schRefreshRowColorDots();
  }

  function getScheduleHtmlForExport(){
    const school=document.getElementById('sch-school').value||'مدرسه';
    const year=document.getElementById('sch-year').value||'';
    const cls=document.getElementById('sch-class').value||'';
    const teacher=document.getElementById('sch-teacher').value||'';
    const days=['شنبه','یکشنبه','دوشنبه','سه‌شنبه','چهارشنبه'];
    const zang=['زنگ اول','زنگ دوم','زنگ سوم','زنگ چهارم','زنگ پنجم'];
    const activeThemeBtn=document.querySelector('.sch-theme-btn.active');
    const themeName=activeThemeBtn?activeThemeBtn.dataset.theme:'default';
    const THEMES={
      default:{corner:['#ffffff','#ffffff'],cornerText:'#1e293b',periodBg:'#f8fafc',periodColor:'#334155',accent:['#ef4444','#f59e0b','#10b981','#8b5cf6','#06b6d4'],cell:['#ffffff','#ffffff','#ffffff','#ffffff','#ffffff'],text:'#1e293b',dayText:'#1e293b'},
      boy:{corner:['#1e3a8a','#2563eb'],cornerText:'#fff',periodBg:'#eff6ff',periodColor:'#1e3a8a',accent:['#2563eb','#2563eb','#2563eb','#2563eb','#2563eb'],cell:['#dbeafe','#e0f2fe','#cffafe','#e0e7ff','#dbeafe'],text:'#1e293b',dayText:'#1e293b'},
      girl:{corner:['#9d174d','#db2777'],cornerText:'#fff',periodBg:'#fdf2f8',periodColor:'#9d174d',accent:['#db2777','#db2777','#db2777','#db2777','#db2777'],cell:['#fce7f3','#fdf2f8','#fae8ff','#f3e8ff','#ffe4e6'],text:'#1e293b',dayText:'#1e293b'},
      colorful:{corner:['#fecdd3','#fecdd3'],cornerText:'#9f1239',periodBg:'#fbcfe8',periodColor:'#9d174d',periodBgs:['#fbcfe8','#fed7aa','#bfdbfe','#bbf7d0','#ddd6fe'],periodColors:['#9d174d','#9a3412','#1e3a8a','#14532d','#5b21b6'],accent:['#f472b6','#fb923c','#60a5fa','#4ade80','#a78bfa'],cell:['#fef7fa','#fffaf3','#f5faff','#f5fdf8','#f9f7ff'],text:'#1e293b',dayText:'#1e293b',kids:true}
    };
    const T=THEMES[themeName]||THEMES.default;
    const accentColors=T.accent;
    const cellColors=T.cell;
    const fontKeyEl=document.getElementById('sch-font');
    const fontKey=fontKeyEl?fontKeyEl.value:'default';
    const exportFontFamily=fontKey==='nazanin'?'"B Nazanin","BNazanin",tahoma,Arial':(fontKey==='titr'?'"B Titr","BTitr",tahoma,Arial':'tahoma,Arial');
    let style='<style>@font-face{font-family:"BNazanin";src:url(https://cdn.jsdelivr.net/gh/intuxicated/css-persian@master/fonts/BNazanin.ttf)}';
    style+='@font-face{font-family:"BTitr";src:url(https://cdn.jsdelivr.net/gh/intuxicated/css-persian@master/fonts/BTitrBold.ttf)}';
    style+='body{direction:rtl;font-family:'+exportFontFamily+';padding:30px;background:#f8fafc}';
    style+='.header{text-align:center;padding:20px;background:#fff;color:#1e293b;border-radius:20px;margin-bottom:20px;border:1.5px solid #e2e8f0}';
    style+='.header h1{font-size:24px;margin:0 0 10px;font-weight:800;letter-spacing:.3px}.header p{margin:5px 0;font-size:14px}';
    style+='table{width:100%;border-collapse:collapse;box-shadow:0 8px 24px rgba(15,23,42,.10);border:1.5px solid #1e293b}';
    style+='th{padding:14px 8px;font-size:14px;font-weight:800;text-align:center;border:1px solid #1e293b}';
    style+='td{padding:14px 10px;text-align:center;font-size:13px;min-height:50px;font-weight:600;color:'+T.text+';border:1px solid #1e293b}';
    style+='.daylabel{border-right:5px solid;font-weight:800}';
    style+='.footer{text-align:center;margin-top:30px;padding:20px;border-top:2px dashed #ddd}</style>';
    let header='<div class="header"><h1>'+(T.kids?'⏰ برنامه هفتگی کلاس 📓':'⭐ برنامه هفتگی کلاس ⭐')+'</h1><p>🏫 '+esc(school)+' | سال تحصیلی: '+esc(year)+'</p><p>کلاس: '+esc(cls)+' | آموزگار: '+esc(teacher)+'</p></div>';
    let table='<table><tr><th style="background:linear-gradient(135deg,'+T.corner[0]+','+T.corner[1]+');color:'+(T.cornerText||'#fff')+';border-bottom:none">روز / زنگ</th>';
    for(let z=0;z<5;z++){
      const pBg=(T.periodBgs&&T.periodBgs[z])||T.periodBg;
      const pColor=(T.periodColors&&T.periodColors[z])||T.periodColor;
      table+='<th style="background:'+pBg+';color:'+pColor+'">🔔 '+zang[z]+'</th>';
    }
    table+='</tr>';
    const dayKeysExp=['shanbe','yekshanbe','doshshanbe','seshshanbe','chaharshanbe'];
    for(let d=0;d<5;d++){
      const customColorKey=(typeof schRowColors!=='undefined'&&schRowColors[dayKeysExp[d]])||'';
      const customHex=(typeof SCH_ROW_COLOR_HEX!=='undefined'&&SCH_ROW_COLOR_HEX[customColorKey])||'';
      const dayBg=customHex||T.dayBg||cellColors[d];
      const rowCellBg=customHex||cellColors[d];
      table+='<tr><td class="daylabel" style="background:'+dayBg+';border-right-color:'+accentColors[d]+';color:'+T.dayText+'">'+days[d]+'</td>';
      for(let i=1;i<=5;i++){const el=document.getElementById('c'+d+i);const val=(el?el.value:'')||'&nbsp;';table+='<td style="background:'+rowCellBg+';color:'+T.text+'"><div style="min-height:40px">'+val+'</div></td>';}
      table+='</tr>';
    }
    table+='</table>';
    const footer=T.kids?'<div style="display:flex;justify-content:space-between;align-items:flex-end;margin-top:14px;font-size:30px"><span>🪴📚</span><span>✏️🖍️</span></div>':'';
    return '<html><head><meta charset="utf-8">'+style+'</head><body>'+header+table+footer+'</body></html>';
  }

  document.getElementById('btn-print-schedule').onclick=function(){const w=window.open('','_blank');w.document.write(getScheduleHtmlForExport());w.document.close();setTimeout(function(){w.print();},500);};
  document.getElementById('btn-word-schedule').onclick=function(){const blob=new Blob([getScheduleHtmlForExport()],{type:'application/msword'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='برنامه-هفتگی.doc';document.body.appendChild(a);a.click();a.remove();};
  document.getElementById('btn-pdf-schedule').onclick=function(){const w=window.open('','_blank');w.document.write(getScheduleHtmlForExport());w.document.close();setTimeout(function(){w.print();},500);};
  
  document.getElementById('btn-save-schedule').onclick=async function(){
    const data={school:document.getElementById('sch-school').value,year:document.getElementById('sch-year').value,topic:document.getElementById('sch-topic').value,principal:document.getElementById('sch-principal').value,cls:document.getElementById('sch-class').value,teacher:document.getElementById('sch-teacher').value,cells:{}};
    for(let d=0;d<5;d++){for(let i=1;i<=5;i++){const el=document.getElementById('c'+d+i);if(el)data.cells['c'+d+i]=el.value;}}
    const r=await api('/api/teacher/schedule',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({data})});
    if(r.ok)toast('برنامه هفتگی ذخیره شد ✅');else toast('خطا در ذخیره');
  };

  // ===== جدول‌ساز حرفه‌ای (شبیه اکسل واقعی) =====
  function colLetter(n){ // 1 -> A, 2 -> B ... 27 -> AA
    let s='';
    while(n>0){ const m=(n-1)%26; s=String.fromCharCode(65+m)+s; n=Math.floor((n-1)/26); }
    return s;
  }
  function xlsCellId(r,c){return 't'+r+'_'+c;}
  function xlsTitleId(c){return 'ht_'+c;}

  // فونت جدول (اعمال روی خودِ <table>؛ چون سلول‌های داخلی font-family را ارث می‌برند، با ساخت/افزودن ردیف جدید هم دوباره اعمال نیاز نیست)
  var XLS_FONTS={default:'',titr:"'B Titr','BTitr',Tahoma,Arial"};
  function xlsApplyTableFont(){
    var key=document.getElementById('tbl-font').value;
    document.getElementById('custom-table').style.fontFamily=XLS_FONTS[key]||'';
  }
  document.getElementById('tbl-font').addEventListener('change',xlsApplyTableFont);

  document.getElementById('btn-gen-table').onclick=function(){
    const rows=parseInt(document.getElementById('tbl-rows').value)||5;
    const cols=parseInt(document.getElementById('tbl-cols').value)||4;
    xlsBuildStructure(rows,cols);
    if(document.getElementById('tbl-avg-check').checked)calcAndShowAvg();
    xlsApplyTableFont();
  };

  // ساخت کامل ساختار جدول (هدر + بدنه‌ی خالی) با تعداد سطر/ستون داده‌شده — این تابع همه‌چیز را از نو می‌سازد
  function xlsBuildStructure(rows,cols){
    const thead=document.getElementById('custom-table-head');
    const tbody=document.getElementById('custom-table-body');
    const tfoot=document.getElementById('custom-table-foot');

    let ch='<tr><th class="xls-corner"></th>';
    for(let c=1;c<=cols;c++){ch+='<th class="xls-colhead">'+colLetter(c)+'</th>';}
    ch+='<th class="xls-corner" rowspan="2">حذف</th>';
    ch+='</tr>';
    ch+='<tr class="xls-titlerow"><th class="xls-rowhead">#</th>';
    for(let c=1;c<=cols;c++){
      ch+='<th><div style="display:flex;align-items:center;gap:4px">'+
        '<input type="text" id="'+xlsTitleId(c)+'" placeholder="عنوان ستون '+c+'" value="ستون '+c+'" style="flex:1;min-width:0">'+
        '<button type="button" class="btn sm danger xls-col-del" data-col="'+c+'" title="حذف این ستون" style="padding:2px 6px;flex:0 0 auto">✖</button>'+
        '</div></th>';
    }
    ch+='</tr>';
    thead.innerHTML=ch;

    let b='';
    for(let r=1;r<=rows;r++){
      b+='<tr><td class="xls-rowhead">'+r+rowColorDotsHtml('r'+r)+'</td>';
      for(let c=1;c<=cols;c++){b+='<td><input type="text" id="'+xlsCellId(r,c)+'" data-r="'+r+'" data-c="'+c+'"></td>';}
      b+='<td class="org-row-del-cell"><button type="button" class="btn sm danger xls-row-del">✖</button></td>';
      b+='</tr>';
    }
    tbody.innerHTML=b;
    tfoot.innerHTML='';
    refreshRowColorPickers(tbody,xlsRowColors);
  }

  // افزودن یک سطر تازه به انتهای جدول موجود، بدون پاک‌کردن مقادیر سطرهای قبلی
  function xlsAddRow(){
    const tbody=document.getElementById('custom-table-body');
    const cols=parseInt(document.getElementById('tbl-cols').value)||4;
    if(!tbody.children.length){toast('ابتدا با دکمه‌ی «ساخت جدول» یک جدول بسازید');return;}
    const r=tbody.children.length+1;
    const tr=document.createElement('tr');
    let rowHtml='<td class="xls-rowhead">'+r+rowColorDotsHtml('r'+r)+'</td>';
    for(let c=1;c<=cols;c++){rowHtml+='<td><input type="text" id="'+xlsCellId(r,c)+'" data-r="'+r+'" data-c="'+c+'"></td>';}
    rowHtml+='<td class="org-row-del-cell"><button type="button" class="btn sm danger xls-row-del">✖</button></td>';
    tr.innerHTML=rowHtml;
    tbody.appendChild(tr);
    document.getElementById('tbl-rows').value=r;
    if(document.getElementById('tbl-avg-check').checked)calcAndShowAvg();
    refreshRowColorPickers(tbody,xlsRowColors);
  }
  document.getElementById('btn-tbl-add-row').onclick=xlsAddRow;
  var xlsRowColors={};

  // حذف یک ستون (بدون از دست رفتن مقادیر بقیه‌ی ستون‌ها و سطرها)
  function xlsDeleteColumn(colIdx){
    const cols=parseInt(document.getElementById('tbl-cols').value)||4;
    if(cols<=1){toast('حداقل باید یک ستون باقی بماند');return;}
    const rows=parseInt(document.getElementById('tbl-rows').value)||5;
    const titles=[];
    for(let c=1;c<=cols;c++){
      if(c===colIdx)continue;
      const el=document.getElementById(xlsTitleId(c));
      titles.push(el?el.value:'ستون '+c);
    }
    const data=[];
    for(let r=1;r<=rows;r++){
      const rowVals=[];
      for(let c=1;c<=cols;c++){
        if(c===colIdx)continue;
        const el=document.getElementById(xlsCellId(r,c));
        rowVals.push(el?el.value:'');
      }
      data.push(rowVals);
    }
    const newCols=cols-1;
    document.getElementById('tbl-cols').value=newCols;
    xlsBuildStructure(rows,newCols);
    for(let c=1;c<=newCols;c++){
      const el=document.getElementById(xlsTitleId(c));
      if(el)el.value=titles[c-1]!==undefined?titles[c-1]:('ستون '+c);
    }
    for(let r=1;r<=rows;r++){
      for(let c=1;c<=newCols;c++){
        const el=document.getElementById(xlsCellId(r,c));
        if(el)el.value=data[r-1][c-1]||'';
      }
    }
    if(document.getElementById('tbl-avg-check').checked)calcAndShowAvg();
    toast('ستون حذف شد ✅');
  }
  document.getElementById('custom-table-head').addEventListener('click',function(e){
    const btn=e.target.closest('.xls-col-del');
    if(!btn)return;
    xlsDeleteColumn(parseInt(btn.dataset.col,10));
  });

  function xlsDeleteRow(tr){
    const tbody=document.getElementById('custom-table-body');
    if(tbody.children.length<=1){toast('حداقل باید یک سطر باقی بماند');return;}
    const cols=parseInt(document.getElementById('tbl-cols').value)||4;
    tr.remove();
    const trs=Array.from(tbody.children);
    trs.forEach((row,idx)=>{
      const r=idx+1;
      row.children[0].textContent=r;
      for(let c=1;c<=cols;c++){
        const cell=row.children[c];
        const input=cell?cell.querySelector('input'):null;
        if(input){input.id=xlsCellId(r,c);input.dataset.r=r;input.dataset.c=c;}
      }
    });
    document.getElementById('tbl-rows').value=trs.length;
    if(document.getElementById('tbl-avg-check').checked)calcAndShowAvg();
  }
  document.getElementById('custom-table-body').addEventListener('click',function(e){
    const dot=e.target.closest('.row-color-dot');
    if(dot){
      xlsRowColors[dot.dataset.key]=dot.dataset.color;
      refreshRowColorPickers(document.getElementById('custom-table-body'),xlsRowColors);
      lbSave('customtable-row-colors',xlsRowColors,true);
      return;
    }
    const btn=e.target.closest('.xls-row-del');
    if(!btn)return;
    xlsDeleteRow(btn.closest('tr'));
  });

  function calcAndShowAvg(){
    const rows=parseInt(document.getElementById('tbl-rows').value)||5;
    const cols=parseInt(document.getElementById('tbl-cols').value)||4;
    const tfoot=document.getElementById('custom-table-foot');
    if(!document.getElementById(xlsCellId(1,1))){ tfoot.innerHTML=''; return; } // جدولی هنوز ساخته نشده
    const avgCells=[];
    for(let c=1;c<=cols;c++){
      const vals=[];for(let r=1;r<=rows;r++){const el=document.getElementById(xlsCellId(r,c));const v=parseFloat(el?el.value.trim():'');if(!isNaN(v))vals.push(v);}
      avgCells.push(vals.length>0?(vals.reduce((a,b)=>a+b,0)/vals.length).toFixed(2):'—');
    }
    let f='<tr class="xls-avgrow"><td>📈</td>';
    for(let c=1;c<=cols;c++){f+='<td>'+avgCells[c-1]+'</td>';}
    f+='</tr>';tfoot.innerHTML=f;
  }

  // ===== ذخیره/بارگذاری جدول‌ساز =====
  document.getElementById('btn-save-table').onclick=async function(){
    const rows=parseInt(document.getElementById('tbl-rows').value)||5;
    const cols=parseInt(document.getElementById('tbl-cols').value)||4;
    if(!document.getElementById(xlsCellId(1,1))){toast('ابتدا جدول را بسازید');return;}
    const titles=[];
    for(let c=1;c<=cols;c++){const el=document.getElementById(xlsTitleId(c));titles.push(el?el.value:'');}
    const cells=[];
    for(let r=1;r<=rows;r++){
      const rowVals=[];
      for(let c=1;c<=cols;c++){const el=document.getElementById(xlsCellId(r,c));rowVals.push(el?el.value:'');}
      cells.push(rowVals);
    }
    await lbSave('customtable',{rows,cols,title:document.getElementById('tbl-title').value,avgCheck:document.getElementById('tbl-avg-check').checked,titles,cells});
  };

  let TABLE_LOADED=false;
  async function loadTableIfNeeded(){
    if(TABLE_LOADED)return;
    TABLE_LOADED=true;
    const saved=await lbLoad('customtable');
    const savedColors=await lbLoad('customtable-row-colors');
    if(savedColors&&typeof savedColors==='object')xlsRowColors=savedColors;
    if(!saved){refreshRowColorPickers(document.getElementById('custom-table-body'),xlsRowColors);return;}
    document.getElementById('tbl-rows').value=saved.rows||5;
    document.getElementById('tbl-cols').value=saved.cols||4;
    document.getElementById('tbl-title').value=saved.title||'';
    document.getElementById('tbl-avg-check').checked=saved.avgCheck!==false;
    document.getElementById('btn-gen-table').click();
    (saved.titles||[]).forEach((t,idx)=>{const el=document.getElementById(xlsTitleId(idx+1));if(el)el.value=t;});
    (saved.cells||[]).forEach((rowVals,ri)=>{
      rowVals.forEach((v,ci)=>{const el=document.getElementById(xlsCellId(ri+1,ci+1));if(el)el.value=v;});
    });
    if(document.getElementById('tbl-avg-check').checked)calcAndShowAvg();
    refreshRowColorPickers(document.getElementById('custom-table-body'),xlsRowColors);
  }

  // ===== وارد کردن جدول از فایل PDF (با تشخیص خطوط واقعی جدول، مثل بخش PDF به Word) =====
  document.getElementById('btn-tbl-import-pdf').onclick=()=>{document.getElementById('tbl-pdf-file').click();};
  document.getElementById('tbl-pdf-file').addEventListener('change',async function(e){
    const file=e.target.files[0];
    if(!file)return;
    const statusEl=document.getElementById('tbl-pdf-status');
    statusEl.textContent='در حال خواندن فایل PDF...';
    ocrFixCount=0;ocrFailCount=0;
    try{
      const buf=await file.arrayBuffer();
      const doc=await pdfjsLib.getDocument({data:buf}).promise;
      let allRows=[];
      for(let p=1;p<=doc.numPages;p++){
        statusEl.textContent='در حال استخراج جدول از صفحه '+p+' از '+doc.numPages+'... (اگر فونت PDF غیراستاندارد باشد، تشخیص متن با OCR کمی بیشتر طول می‌کشد)';
        const blocks=await extractPdfPageBlocks(p,doc);
        blocks.forEach(block=>{
          if(block.type==='table'){
            block.rows.forEach(cells=>{
              allRows.push(cells.map(cellLines=>cellLines.join(' ')));
            });
          }
        });
      }
      if(allRows.length===0){
        statusEl.textContent='';
        toast('هیچ جدول واقعی (با خط‌کشی) در این PDF پیدا نشد');
        e.target.value='';
        return;
      }
      const maxCols=Math.max(...allRows.map(r=>r.length));
      document.getElementById('tbl-rows').value=allRows.length;
      document.getElementById('tbl-cols').value=maxCols;
      document.getElementById('btn-gen-table').click();
      allRows.forEach((rowArr,ri)=>{
        rowArr.forEach((val,ci)=>{
          const cell=document.getElementById(xlsCellId(ri+1,ci+1));
          if(cell)cell.value=val;
        });
      });
      if(document.getElementById('tbl-avg-check').checked)calcAndShowAvg();
      statusEl.textContent='';
      let msg='جدول با '+allRows.length+' ردیف از PDF وارد شد ✅';
      if(ocrFixCount>0)msg+=' ('+ocrFixCount+' سلول با فونت خراب توسط OCR ترمیم شد';
      if(ocrFailCount>0)msg+=(ocrFixCount>0?'، ':' (')+ocrFailCount+' سلول هنوز نیاز به اصلاح دستی دارد';
      if(ocrFixCount>0||ocrFailCount>0)msg+=')';
      toast(msg);
    }catch(err){
      statusEl.textContent='';
      toast('خطا در خواندن یا تحلیل فایل PDF');
    }
    e.target.value='';
  });
  document.getElementById('tbl-avg-check').onchange=function(){this.checked?calcAndShowAvg():document.getElementById('custom-table-foot').innerHTML='';};
  // محاسبه‌ی زنده‌ی میانگین با هر بار تایپ در سلول‌های عددی
  document.getElementById('custom-table-body').addEventListener('input',function(e){
    if(e.target && e.target.tagName==='INPUT' && document.getElementById('tbl-avg-check').checked) calcAndShowAvg();
  });

  // در صورت نیاز، بدون پاک‌کردن داده‌های موجود، ردیف‌های بیشتری به جدول اضافه می‌کند
  function xlsEnsureRows(newRowCount){
    const rowsInput=document.getElementById('tbl-rows');
    const currentRows=parseInt(rowsInput.value)||0;
    if(newRowCount<=currentRows)return;
    const cols=parseInt(document.getElementById('tbl-cols').value)||4;
    const tbody=document.getElementById('custom-table-body');
    for(let r=currentRows+1;r<=newRowCount;r++){
      const tr=document.createElement('tr');
      let html='<td class="xls-rowhead">'+r+rowColorDotsHtml('r'+r)+'</td>';
      for(let c=1;c<=cols;c++){html+='<td><input type="text" id="'+xlsCellId(r,c)+'" data-r="'+r+'" data-c="'+c+'"></td>';}
      html+='<td class="org-row-del-cell"><button type="button" class="btn sm danger xls-row-del">✖</button></td>';
      tr.innerHTML=html;
      tbody.appendChild(tr);
    }
    rowsInput.value=newRowCount;
    refreshRowColorPickers(tbody,xlsRowColors);
  }

  // چسباندن هوشمند (مثل اکسل): وقتی چند اسم/کد را که از یک ستون کپی کرده‌اید در یک خانه پیست می‌کنید،
  // به‌صورت خودکار هرکدام در خانه‌ی زیرین خودش قرار می‌گیرد (و در صورت نیاز، ردیف جدید هم اضافه می‌شود)
  document.getElementById('custom-table-body').addEventListener('paste',function(e){
    const target=e.target;
    if(!target || target.tagName!=='INPUT' || !target.dataset.r)return;
    const text=(e.clipboardData||window.clipboardData).getData('text');
    if(!text)return;
    const lines=text.replace(/\\r/g,'').split('\\n');
    while(lines.length>1 && lines[lines.length-1]==='')lines.pop();
    const grid=lines.map(l=>l.split('\\t'));
    const isMulti=grid.length>1||(grid[0]&&grid[0].length>1);
    if(!isMulti)return; // فقط یک مقدار تکی است؛ رفتار پیش‌فرض مرورگر کافی است
    e.preventDefault();
    const startR=parseInt(target.dataset.r),startC=parseInt(target.dataset.c);
    const cols=parseInt(document.getElementById('tbl-cols').value)||4;
    xlsEnsureRows(startR+grid.length-1);
    grid.forEach((rowArr,ri)=>{
      rowArr.forEach((val,ci)=>{
        const rr=startR+ri,cc=startC+ci;
        if(cc>cols)return;
        const cell=document.getElementById(xlsCellId(rr,cc));
        if(cell)cell.value=val.trim();
      });
    });
    if(document.getElementById('tbl-avg-check').checked)calcAndShowAvg();
    toast('چسبانده شد: '+grid.length+' ردیف ✅');
  });

  function xlsGetData(){
    const rows=parseInt(document.getElementById('tbl-rows').value)||5;
    const cols=parseInt(document.getElementById('tbl-cols').value)||4;
    const titles=[];for(let c=1;c<=cols;c++){const el=document.getElementById(xlsTitleId(c));titles.push(el?el.value||('ستون '+c):('ستون '+c));}
    const data=[];
    for(let r=1;r<=rows;r++){
      const row=[];
      for(let c=1;c<=cols;c++){const el=document.getElementById(xlsCellId(r,c));row.push(el?el.value:'');}
      data.push(row);
    }
    return {rows, cols, titles, data};
  }

  document.getElementById('btn-word-table').onclick=function(){
    const title=document.getElementById('tbl-title').value||'جدول';
    const html=xlsBuildTableExportHtml(title);
    const blob=new Blob(['<html><head><meta charset="utf-8">'+html.style+'</head><body>'+html.body+'</body></html>'],{type:'application/msword'});
    const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=title+'.doc';document.body.appendChild(a);a.click();a.remove();
  };

  // ساخت خروجی HTML جدول (استایل + بدنه)، مشترک بین دانلود Word و دانلود PDF
  function xlsBuildTableExportHtml(title){
    const showAvg=document.getElementById('tbl-avg-check').checked;
    const {rows, cols, titles, data}=xlsGetData();
    const fontKey=document.getElementById('tbl-font').value;
    const fontFamily=fontKey==='titr'?"'B Titr','BTitr',Tahoma,Arial":'tahoma,Arial';
    let style='<style>';
    if(fontKey==='titr')style+='@font-face{font-family:"BTitr";src:url(https://cdn.jsdelivr.net/gh/intuxicated/css-persian@master/fonts/BTitrBold.ttf)}';
    style+='body{direction:rtl;font-family:'+fontFamily+';padding:20px}table{width:100%;border-collapse:collapse;margin-top:15px}th,td{border:1px solid #333;padding:8px;text-align:center;font-family:'+fontFamily+'}th{background:#667eea;color:#fff}td:first-child{background:#eee;font-weight:bold}</style>';
    let h='<h2 style="text-align:center">'+esc(title)+'</h2><table><tr><th>#</th>';
    for(let c=0;c<cols;c++){h+='<th>'+esc(titles[c])+'</th>';}h+='</tr>';
    for(let r=0;r<rows;r++){
      h+='<tr><td>'+(r+1)+'</td>';
      for(let c=0;c<cols;c++){h+='<td>'+esc(data[r][c])+'</td>';}
      h+='</tr>';
    }
    if(showAvg){
      const avgCells=[];for(let c=0;c<cols;c++){const vals=[];for(let r=0;r<rows;r++){const v=parseFloat(data[r][c]);if(!isNaN(v))vals.push(v);}avgCells.push(vals.length>0?(vals.reduce((a,b)=>a+b,0)/vals.length).toFixed(2):'—');}
      h+='<tr style="background:#e2efda;font-weight:bold"><td>📈 میانگین</td>';
      for(let c=0;c<cols;c++){h+='<td>'+avgCells[c]+'</td>';}h+='</tr>';
    }
    h+='</table>';
    return {style,body:h};
  }

  // دانلود PDF: مثل «دانلود PDF» برنامه‌ی هفتگی، جدول را در یک پنجره‌ی جدید باز و از دیالوگ چاپ مرورگر به PDF تبدیل می‌کند
  document.getElementById('btn-pdf-table').onclick=function(){
    const title=document.getElementById('tbl-title').value||'جدول';
    const html=xlsBuildTableExportHtml(title);
    const w=window.open('','_blank');
    if(!w){toast('اجازه‌ی باز کردن پنجره‌ی جدید داده نشد؛ لطفاً مسدودکننده‌ی پاپ‌آپ را غیرفعال کنید');return;}
    w.document.write('<html><head><meta charset="utf-8"><title>'+esc(title)+'</title>'+html.style+'</head><body>'+html.body+'</body></html>');
    w.document.close();
    setTimeout(function(){w.print();},500);
  };


  let exceljsLoading=null;
  function loadExcelJS(){
    if(window.ExcelJS) return Promise.resolve();
    if(exceljsLoading) return exceljsLoading;
    exceljsLoading=new Promise(function(resolve,reject){
      const s=document.createElement('script');
      s.src='https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.3.0/exceljs.min.js';
      s.onload=resolve; s.onerror=function(){reject(new Error('load-failed'));};
      document.head.appendChild(s);
    });
    return exceljsLoading;
  }

  document.getElementById('btn-excel-table').onclick=async function(){
    const btn=this;
    const title=document.getElementById('tbl-title').value||'جدول';
    const showAvg=document.getElementById('tbl-avg-check').checked;
    const {rows, cols, titles, data}=xlsGetData();
    btn.disabled=true; const origText=btn.textContent; btn.textContent='⏳ در حال ساخت فایل...';
    try{
      await loadExcelJS();
      const wb=new ExcelJS.Workbook();
      wb.creator=${JSON.stringify(APP_TITLE)};
      const ws=wb.addWorksheet('جدول', { views:[{ rightToLeft:true, state:'frozen', ySplit:2 }] });

      // عنوان بزرگ ادغام‌شده در بالای جدول
      ws.mergeCells(1,1,1,cols+1);
      const titleCell=ws.getCell(1,1);
      titleCell.value=title;
      titleCell.font={ name:'Calibri', size:16, bold:true, color:{argb:'FF1E293B'} };
      titleCell.alignment={ horizontal:'center', vertical:'middle' };
      ws.getRow(1).height=28;

      // سرستون‌ها
      const headerRow=ws.getRow(2);
      headerRow.getCell(1).value='#';
      for(let c=0;c<cols;c++) headerRow.getCell(c+2).value=titles[c];
      headerRow.eachCell(function(cell){
        cell.font={ name:'Calibri', bold:true, color:{argb:'FFFFFFFF'} };
        cell.fill={ type:'pattern', pattern:'solid', fgColor:{argb:'FF4472C4'} };
        cell.alignment={ horizontal:'center', vertical:'middle' };
        cell.border={ top:{style:'thin',color:{argb:'FFB7B7B7'}}, left:{style:'thin',color:{argb:'FFB7B7B7'}}, right:{style:'thin',color:{argb:'FFB7B7B7'}}, bottom:{style:'thin',color:{argb:'FFB7B7B7'}} };
      });
      headerRow.height=22;

      // داده‌ها
      for(let r=0;r<rows;r++){
        const row=ws.getRow(r+3);
        row.getCell(1).value=r+1;
        for(let c=0;c<cols;c++){
          const raw=data[r][c];
          const num=parseFloat(raw);
          row.getCell(c+2).value=(raw!==''&&!isNaN(num)&&String(num)===raw.trim())?num:(raw||'');
        }
        row.eachCell({includeEmpty:true},function(cell,colNum){
          if(colNum>cols+1) return;
          cell.alignment={ horizontal:'center', vertical:'middle' };
          cell.border={ top:{style:'thin',color:{argb:'FFD4D4D4'}}, left:{style:'thin',color:{argb:'FFD4D4D4'}}, right:{style:'thin',color:{argb:'FFD4D4D4'}}, bottom:{style:'thin',color:{argb:'FFD4D4D4'}} };
          if((r+3)%2===0) cell.fill={ type:'pattern', pattern:'solid', fgColor:{argb:'FFFAFBFC'} };
        });
      }

      // ردیف میانگین با فرمول واقعی اکسل =AVERAGE(...)
      if(showAvg){
        const avgRow=ws.getRow(rows+3);
        avgRow.getCell(1).value='📈 میانگین';
        for(let c=0;c<cols;c++){
          const colL=colLetter(c+2); // ستون داده در شیت از ستون B شروع می‌شود
          const range=colL+'3:'+colL+(rows+2);
          avgRow.getCell(c+2).value={ formula:'IFERROR(AVERAGE('+range+'),"—")' };
          avgRow.getCell(c+2).numFmt='0.00';
        }
        avgRow.eachCell(function(cell){
          cell.font={ bold:true, color:{argb:'FF375623'} };
          cell.fill={ type:'pattern', pattern:'solid', fgColor:{argb:'FFE2EFDA'} };
          cell.alignment={ horizontal:'center', vertical:'middle' };
          cell.border={ top:{style:'thin',color:{argb:'FFB7B7B7'}}, left:{style:'thin',color:{argb:'FFB7B7B7'}}, right:{style:'thin',color:{argb:'FFB7B7B7'}}, bottom:{style:'thin',color:{argb:'FFB7B7B7'}} };
        });
      }

      // عرض ستون‌ها
      ws.getColumn(1).width=6;
      for(let c=0;c<cols;c++) ws.getColumn(c+2).width=Math.max(12, (titles[c]||'').length+4);

      const buf=await wb.xlsx.writeBuffer();
      const blob=new Blob([buf], {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
      const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=title+'.xlsx'; document.body.appendChild(a); a.click(); a.remove();
      toast('فایل Excel ساخته شد ✅');
    }catch(err){
      toast('خطا در ساخت فایل Excel — اتصال اینترنت را بررسی کنید');
    }finally{
      btn.disabled=false; btn.textContent=origText;
    }
  };

  // ===== فرم سازمان عملی (فایل اکسل رسمی دو-شیتی مخصوص مدارس ابتدایی) =====
  const ORG_GRADES=['اول','دوم','سوم','چهارم','پنجم','ششم'];
  const ORG_STAT_ROWS=[...ORG_GRADES,'چندپایه'];

  function orgRenderStatTable(){
    const body=document.getElementById('org-stat-body');
    let html='';
    ORG_STAT_ROWS.forEach((g,idx)=>{
      const gr=idx+1;
      html+='<tr><td style="font-weight:700">'+(g==='چندپایه'?'چندپایه':'پایه '+g)+'</td>'+
        '<td><input type="text" inputmode="numeric" class="org-cls-boy" data-grade="'+gr+'"></td>'+
        '<td><input type="text" inputmode="numeric" class="org-cls-girl" data-grade="'+gr+'"></td>'+
        '<td><input type="text" inputmode="numeric" class="org-cls-mixed" data-grade="'+gr+'"></td>'+
        '<td class="org-cls-sum" data-grade="'+gr+'">۰</td>'+
        '<td><input type="text" inputmode="numeric" class="org-stu-boy" data-grade="'+gr+'"></td>'+
        '<td><input type="text" inputmode="numeric" class="org-stu-girl" data-grade="'+gr+'"></td>'+
        '<td class="org-stu-sum" data-grade="'+gr+'">۰</td></tr>';
    });
    body.innerHTML=html;
    orgRecalcStats();
  }
  function orgRecalcStats(){
    const totals=new Array(6).fill(0);
    ORG_STAT_ROWS.forEach((g,idx)=>{
      const gr=idx+1;
      const val=cls=>parseInt(toEnDigits(document.querySelector('.'+cls+'[data-grade="'+gr+'"]').value),10)||0;
      const clsB=val('org-cls-boy'),clsG=val('org-cls-girl'),clsM=val('org-cls-mixed');
      const stuB=val('org-stu-boy'),stuG=val('org-stu-girl');
      document.querySelector('.org-cls-sum[data-grade="'+gr+'"]').textContent=toFaDigits(clsB+clsG+clsM);
      document.querySelector('.org-stu-sum[data-grade="'+gr+'"]').textContent=toFaDigits(stuB+stuG);
      const vals=[clsB,clsG,clsM,clsB+clsG+clsM,stuB,stuG,stuB+stuG];
      vals.forEach((v,i)=>totals[i]+=v);
    });
    const foot=document.getElementById('org-stat-foot');
    foot.innerHTML='<tr style="font-weight:800;background:#eef2ff"><td>جمع</td>'+
      totals.map(t=>'<td>'+toFaDigits(t)+'</td>').join('')+'</tr>';
  }
  document.getElementById('org-stat-body').addEventListener('input',function(e){
    if(e.target && e.target.tagName==='INPUT'){
      const cleaned=toEnDigits(e.target.value).replace(/[^0-9]/g,'').slice(0,4);
      e.target.value=toFaDigits(cleaned);
      orgRecalcStats();
    }
  });

  // ===== تعداد دانش‌آموزان خاص =====
  const ORG_SPECIAL_LABELS=['فرزندان شاهد','تلفیقی شدید','تلفیقی خفیف','تحت پوشش','اتباع خارجی','جذب بازمانده'];
  function orgRenderSpecialTable(){
    const body=document.getElementById('org-special-body');
    body.innerHTML=ORG_SPECIAL_LABELS.map((lab,idx)=>
      '<tr><td style="font-weight:700;text-align:right">'+lab+':</td><td><input type="text" inputmode="numeric" class="org-special-val" data-idx="'+idx+'"></td></tr>'
    ).join('');
  }
  document.getElementById('org-special-body').addEventListener('input',function(e){
    if(e.target && e.target.tagName==='INPUT'){
      const cleaned=toEnDigits(e.target.value).replace(/[^0-9]/g,'').slice(0,4);
      e.target.value=toFaDigits(cleaned);
    }
  });

  function orgRenumberRows(tbodyId){
    document.querySelectorAll('#'+tbodyId+' > tr').forEach((tr,idx)=>{
      const firstCell=tr.children[0];
      if(firstCell)firstCell.textContent=idx+1;
    });
  }
  function orgAddStaffRow(){
    const tbody=document.getElementById('org-staff-body');
    const rowNum=tbody.children.length+1;
    const tr=document.createElement('tr');
    tr.innerHTML='<td>'+rowNum+'</td>'+
      '<td><input type="text"></td><td><input type="text"></td><td><input type="text"></td><td><input type="text"></td>'+
      '<td><input type="text"></td>'+
      '<td><input type="text"></td><td><input type="text"></td><td><input type="text"></td><td><input type="text"></td><td><input type="text"></td><td><input type="text"></td>'+
      '<td class="org-row-del-cell"><button type="button" class="btn sm danger org-row-del">✖</button></td>';
    tbody.appendChild(tr);
  }
  document.getElementById('btn-org-staff-addrow').onclick=orgAddStaffRow;
  document.getElementById('org-staff-body').addEventListener('click',function(e){
    const btn=e.target.closest('.org-row-del');
    if(!btn)return;
    const tr=btn.closest('tr');
    if(tr)tr.remove();
    orgRenumberRows('org-staff-body');
  });
  document.getElementById('org-staff-table').addEventListener('paste',function(e){
    const target=e.target;
    if(!target||(target.tagName!=='INPUT'&&target.tagName!=='SELECT'))return;
    const td=target.closest('td');const tr=td.closest('tr');const tbody=tr.parentElement;
    const tds=Array.from(tr.children);
    const colIdx=tds.indexOf(td);
    let rows=Array.from(tbody.children);
    const rowIdx=rows.indexOf(tr);
    const text=(e.clipboardData||window.clipboardData).getData('text');
    if(!text)return;
    const lines=text.replace(/\\r/g,'').split('\\n');
    while(lines.length>1&&lines[lines.length-1]==='')lines.pop();
    const grid=lines.map(l=>l.split('\t'));
    const isMulti=grid.length>1||(grid[0]&&grid[0].length>1);
    if(!isMulti)return;
    e.preventDefault();
    while(rows.length<rowIdx+grid.length){orgAddStaffRow();rows=Array.from(tbody.children);}
    grid.forEach((rowArr,ri)=>{
      const targetTr=rows[rowIdx+ri];
      if(!targetTr)return;
      const targetTds=Array.from(targetTr.children);
      rowArr.forEach((val,ci)=>{
        const cc=colIdx+ci;
        if(cc>=targetTds.length||cc===0)return;
        const el=targetTds[cc].querySelector('input,select');
        if(el)el.value=val.trim();
      });
    });
    toast('چسبانده شد: '+grid.length+' ردیف ✅');
  });

  function orgAddHoursRow(){
    const tbody=document.getElementById('org-hours-body');
    const rowNum=tbody.children.length+1;
    const tr=document.createElement('tr');
    let html='<td>'+rowNum+'</td><td><input type="text" class="org-hr-code"></td><td><input type="text" class="org-hr-name"></td>';
    for(let g=1;g<=7;g++){
      html+='<td><input type="text" inputmode="numeric" class="org-hr-mo" data-g="'+g+'"></td>'+
            '<td><input type="text" inputmode="numeric" class="org-hr-gh" data-g="'+g+'"></td>'+
            '<td class="org-hr-rowsum" data-g="'+g+'">۰</td>';
    }
    html+='<td class="org-hr-total-mo">۰</td><td class="org-hr-total-gh">۰</td><td class="org-hr-total-sum">۰</td>';
    html+='<td class="org-row-del-cell"><button type="button" class="btn sm danger org-row-del">✖</button></td>';
    tr.innerHTML=html;
    tbody.appendChild(tr);
  }
  document.getElementById('btn-org-hours-addrow').onclick=orgAddHoursRow;
  document.getElementById('org-hours-body').addEventListener('click',function(e){
    const btn=e.target.closest('.org-row-del');
    if(!btn)return;
    const tr=btn.closest('tr');
    if(tr)tr.remove();
    orgRenumberRows('org-hours-body');
  });
  function orgRecalcHoursRow(tr){
    let totalMo=0,totalGh=0;
    for(let g=1;g<=7;g++){
      const mo=parseInt(toEnDigits(tr.querySelector('.org-hr-mo[data-g="'+g+'"]').value),10)||0;
      const gh=parseInt(toEnDigits(tr.querySelector('.org-hr-gh[data-g="'+g+'"]').value),10)||0;
      tr.querySelector('.org-hr-rowsum[data-g="'+g+'"]').textContent=toFaDigits(mo+gh);
      totalMo+=mo;totalGh+=gh;
    }
    tr.querySelector('.org-hr-total-mo').textContent=toFaDigits(totalMo);
    tr.querySelector('.org-hr-total-gh').textContent=toFaDigits(totalGh);
    tr.querySelector('.org-hr-total-sum').textContent=toFaDigits(totalMo+totalGh);
  }
  document.getElementById('org-hours-body').addEventListener('input',function(e){
    if(!e.target||e.target.tagName!=='INPUT')return;
    if(e.target.classList.contains('org-hr-mo')||e.target.classList.contains('org-hr-gh')){
      const cleaned=toEnDigits(e.target.value).replace(/[^0-9]/g,'').slice(0,3);
      e.target.value=toFaDigits(cleaned);
    }
    const tr=e.target.closest('tr');
    if(!tr)return;
    orgRecalcHoursRow(tr);
  });

  // چسباندن هوشمند برای جدول ساعات (کد پرسنلی / نام)
  document.getElementById('org-hours-table').addEventListener('paste',function(e){
    const target=e.target;
    if(!target||target.tagName!=='INPUT')return;
    const td=target.closest('td');const tr=td.closest('tr');const tbody=tr.parentElement;
    const tds=Array.from(tr.children);
    const colIdx=tds.indexOf(td);
    let rows=Array.from(tbody.children);
    const rowIdx=rows.indexOf(tr);
    const text=(e.clipboardData||window.clipboardData).getData('text');
    if(!text)return;
    const lines=text.replace(/\\r/g,'').split('\\n');
    while(lines.length>1&&lines[lines.length-1]==='')lines.pop();
    if(lines.length<2)return;
    e.preventDefault();
    while(rows.length<rowIdx+lines.length){orgAddHoursRow();rows=Array.from(tbody.children);}
    lines.forEach((val,ri)=>{
      const targetTr=rows[rowIdx+ri];
      if(!targetTr)return;
      const targetTds=Array.from(targetTr.children);
      if(targetTds[colIdx]){
        const inp=targetTds[colIdx].querySelector('input');
        if(inp)inp.value=val.trim();
      }
    });
    toast('چسبانده شد: '+lines.length+' ردیف ✅');
  });

  // فونت فرم سازمان عملی (روی خودِ ظرف بیرونی و هر چهار جدول اعمال می‌شود؛ چون جدول‌ها با تغییر ردیف بازسازی نمی‌شوند، نیازی به اعمال دوباره نیست)
  function orgApplyFont(){
    var key=document.getElementById('org-font').value;
    var family=key==='titr'?"'B Titr','BTitr',Tahoma,Arial":'';
    document.getElementById('tab-orgform').style.fontFamily=family;
    ['org-stat-table','org-special-table','org-staff-table','org-hours-table'].forEach(function(id){
      var t=document.getElementById(id);
      if(t)t.style.fontFamily=family;
    });
  }
  document.getElementById('org-font').addEventListener('change',orgApplyFont);

  let ORG_FORM_LOADED=false;
  async function loadOrgFormIfNeeded(){
    orgRenderStatTable();
    orgRenderSpecialTable();
    if(document.getElementById('org-staff-body').children.length===0){for(let i=0;i<3;i++)orgAddStaffRow();}
    if(document.getElementById('org-hours-body').children.length===0){for(let i=0;i<3;i++)orgAddHoursRow();}
    if(ORG_FORM_LOADED)return;
    ORG_FORM_LOADED=true;
    const saved=await lbLoad('orgform');
    if(!saved)return;
    ['year','formno','region','school','schoolcode','principal','gender','level','spacecode','adminType','buildingStatus','status','buildingType','phone','address'].forEach(k=>{
      const el=document.getElementById('org-'+k);
      if(el && saved[k]!==undefined)el.value=saved[k];
    });
    if(saved.stats){
      saved.stats.forEach((row,idx)=>{
        const gr=idx+1;
        ['stu-boy','stu-girl','cls-boy','cls-girl','cls-mixed'].forEach(k=>{
          const el=document.querySelector('.org-'+k+'[data-grade="'+gr+'"]');
          if(el && row[k]!==undefined)el.value=toFaDigits(row[k]);
        });
      });
      orgRecalcStats();
    }
    if(saved.special){
      saved.special.forEach((v,idx)=>{
        const el=document.querySelector('.org-special-val[data-idx="'+idx+'"]');
        if(el && v!==undefined)el.value=toFaDigits(v);
      });
    }
    if(saved.staff && saved.staff.length){
      document.getElementById('org-staff-body').innerHTML='';
      saved.staff.forEach(()=>orgAddStaffRow());
      const rows=document.querySelectorAll('#org-staff-body tr');
      saved.staff.forEach((rowVals,ri)=>{
        const tds=Array.from(rows[ri].children);
        rowVals.forEach((v,ci)=>{
          const cellIdx=ci+1;
          if(!tds[cellIdx])return;
          const el=tds[cellIdx].querySelector('input,select');
          if(el)el.value=v;
        });
      });
    }
    if(saved.hours && saved.hours.length){
      document.getElementById('org-hours-body').innerHTML='';
      saved.hours.forEach(()=>orgAddHoursRow());
      const rows=document.querySelectorAll('#org-hours-body tr');
      saved.hours.forEach((rowVals,ri)=>{
        const tr=rows[ri];
        tr.querySelector('.org-hr-code').value=rowVals.code||'';
        tr.querySelector('.org-hr-name').value=rowVals.name||'';
        (rowVals.g||[]).forEach((pair,gi)=>{
          const g=gi+1;
          const moEl=tr.querySelector('.org-hr-mo[data-g="'+g+'"]');
          const ghEl=tr.querySelector('.org-hr-gh[data-g="'+g+'"]');
          if(moEl)moEl.value=toFaDigits(pair.mo||'');
          if(ghEl)ghEl.value=toFaDigits(pair.gh||'');
        });
        orgRecalcHoursRow(tr);
      });
    }
  }

  function orgGatherData(){
    const meta={};
    ['year','formno','region','school','schoolcode','principal','gender','level','spacecode','adminType','buildingStatus','status','buildingType','phone','address'].forEach(k=>{
      meta[k]=(document.getElementById('org-'+k)||{}).value||'';
    });
    const stats=ORG_STAT_ROWS.map((g,idx)=>{
      const gr=idx+1;
      const v=cls=>toEnDigits(document.querySelector('.org-'+cls+'[data-grade="'+gr+'"]').value||'');
      return{'stu-boy':v('stu-boy'),'stu-girl':v('stu-girl'),'cls-boy':v('cls-boy'),'cls-girl':v('cls-girl'),'cls-mixed':v('cls-mixed')};
    });
    const special=[];
    document.querySelectorAll('.org-special-val').forEach(el=>{special.push(toEnDigits(el.value||''));});
    const staff=[];
    document.querySelectorAll('#org-staff-body tr').forEach(tr=>{
      const cells=Array.from(tr.children).slice(1).filter(td=>!td.classList.contains('org-row-del-cell')).map(td=>{
        const el=td.querySelector('input,select');
        return el?el.value:'';
      });
      staff.push(cells);
    });
    const hours=[];
    document.querySelectorAll('#org-hours-body tr').forEach(tr=>{
      const code=tr.querySelector('.org-hr-code').value;
      const name=tr.querySelector('.org-hr-name').value;
      const g=[];
      for(let gi=1;gi<=7;gi++){
        g.push({mo:toEnDigits(tr.querySelector('.org-hr-mo[data-g="'+gi+'"]').value||''),gh:toEnDigits(tr.querySelector('.org-hr-gh[data-g="'+gi+'"]').value||'')});
      }
      hours.push({code,name,g});
    });
    return{...meta,stats,special,staff,hours};
  }

  document.getElementById('btn-org-save').onclick=async function(){
    await lbSave('orgform',orgGatherData());
  };
  document.getElementById('btn-org-print').onclick=function(){window.print();};

  // ===== ساخت آزمون (برگه چاپی) =====
  let esRows=[{q:'',mark:''}];
  let esFontSize=12;

  // ساخت یک جدول قابل‌مدیریت (با نوار ابزار: افزودن/حذف ردیف و ستون، جابه‌جایی، تغییر اندازه، حذف کامل جدول)
  function esBuildTableWrapHtml(r,c){
    let rowsHtml='';
    for(let rr=0;rr<r;rr++){
      rowsHtml+='<tr>';
      for(let cc=0;cc<c;cc++){rowsHtml+='<td>&nbsp;</td>';}
      rowsHtml+='</tr>';
    }
    return '<div class="es-tbl-wrap" contenteditable="false" style="width:70%">'+
      '<div class="es-tbl-toolbar" contenteditable="false">'+
        '<button type="button" data-tact="addrow" title="افزودن ردیف">➕ردیف</button>'+
        '<button type="button" data-tact="delrow" title="حذف آخرین ردیف">➖ردیف</button>'+
        '<button type="button" data-tact="addcol" title="افزودن ستون">➕ستون</button>'+
        '<button type="button" data-tact="delcol" title="حذف آخرین ستون">➖ستون</button>'+
        '<button type="button" data-tact="wbig" title="بزرگ‌تر کردن جدول">↔️ بزرگ‌تر</button>'+
        '<button type="button" data-tact="wsmall" title="کوچک‌تر کردن جدول">↔️ کوچک‌تر</button>'+
        '<button type="button" data-tact="up" title="جابه‌جایی به بالا">⬆️</button>'+
        '<button type="button" data-tact="down" title="جابه‌جایی به پایین">⬇️</button>'+
        '<button type="button" class="es-tbl-del" data-tact="del" title="حذف کامل این جدول">🗑️ حذف جدول</button>'+
      '</div>'+
      '<table contenteditable="true"><tbody>'+rowsHtml+'</tbody></table>'+
    '</div><div><br></div>';
  }

  const ES_SPACE_DEFAULT=90, ES_SPACE_MIN=0, ES_SPACE_MAX=500, ES_SPACE_STEP=20;

  function esRenderRows(){
    const tbody=document.getElementById('es-rows');
    tbody.innerHTML=esRows.map(function(r,i){
      const sp=(r.space!=null&&r.space!=='')?r.space:ES_SPACE_DEFAULT;
      const isFirst=i===0, isLast=i===esRows.length-1;
      return '<tr>'+
        '<td class="es-col-num">'+toFaDigits(i+1)+
          '<div style="display:flex;gap:2px;justify-content:center">'+
            '<button type="button" class="es-row-move" data-i="'+i+'" data-dir="-1" title="جابه‌جایی به بالا"'+(isFirst?' disabled':'')+'>▲</button>'+
            '<button type="button" class="es-row-move" data-i="'+i+'" data-dir="1" title="جابه‌جایی به پایین"'+(isLast?' disabled':'')+'>▼</button>'+
          '</div>'+
          (esRows.length>1?'<div><button type="button" class="es-row-del" data-i="'+i+'" title="حذف این سؤال">✕ حذف</button></div>':'')+
        '</td>'+
        '<td class="es-q-cell">'+
          '<div class="es-q" data-i="'+i+'" contenteditable="true">'+(r.q||'')+'</div>'+
          '<div class="es-answer-space" data-i="'+i+'" style="height:'+sp+'px"></div>'+
          '<div class="es-q-tools">'+
            '<button type="button" class="es-q-addtable" data-i="'+i+'">🔲 افزودن جدول</button>'+
            '<button type="button" class="es-q-addimage" data-i="'+i+'">🖼️ افزودن عکس</button>'+
            '<span class="es-space-ctrl">📏 فضای پاسخ:'+
              '<button type="button" class="es-space-btn" data-i="'+i+'" data-dir="-1" title="فضای کمتر برای پاسخ">➖</button>'+
              '<b class="es-space-val" data-i="'+i+'">'+toFaDigits(sp)+'</b>'+
              '<button type="button" class="es-space-btn" data-i="'+i+'" data-dir="1" title="فضای بیشتر برای پاسخ">➕</button>'+
            '</span>'+
          '</div>'+
        '</td>'+
        '<td class="es-col-mark"><input class="es-mark" data-i="'+i+'" value="'+esc(r.mark||'')+'"></td>'+
        '</tr>';
    }).join('');
    tbody.querySelectorAll('.es-q').forEach(function(el){convertDigitsInElement(el);el.oninput=function(){convertDigitsInElement(this);esRows[+this.dataset.i].q=this.innerHTML;};esRecalcQHeight(el);});
    tbody.querySelectorAll('.es-mark').forEach(function(el){el.oninput=function(){esRows[+this.dataset.i].mark=this.value;};});
    tbody.querySelectorAll('.es-row-del').forEach(function(el){el.onclick=function(){esRows.splice(+this.dataset.i,1);esRenderRows();};});
    tbody.querySelectorAll('.es-row-move').forEach(function(el){
      el.onclick=function(){
        const i=+this.dataset.i;
        const dir=+this.dataset.dir;
        const j=i+dir;
        if(j<0||j>=esRows.length)return;
        const tmp=esRows[i];esRows[i]=esRows[j];esRows[j]=tmp;
        esRenderRows();
      };
    });
    tbody.querySelectorAll('.es-space-btn').forEach(function(el){
      el.onclick=function(){
        const i=+this.dataset.i;
        const dir=+this.dataset.dir;
        let cur=(esRows[i].space!=null&&esRows[i].space!=='')?esRows[i].space:ES_SPACE_DEFAULT;
        cur=Math.max(ES_SPACE_MIN,Math.min(ES_SPACE_MAX,cur+dir*ES_SPACE_STEP));
        esRows[i].space=cur;
        const spEl=tbody.querySelector('.es-answer-space[data-i="'+i+'"]');
        spEl.style.height=cur+'px';
        const valEl=tbody.querySelector('.es-space-val[data-i="'+i+'"]');
        valEl.textContent=toFaDigits(cur);
      };
    });
    tbody.querySelectorAll('.es-q-addtable').forEach(function(el){
      el.onclick=function(){
        const i=+this.dataset.i;
        const qEl=tbody.querySelector('.es-q[data-i="'+i+'"]');
        let r=parseInt(toEnDigits(prompt('تعداد ردیف جدول؟','2')),10);
        let c=parseInt(toEnDigits(prompt('تعداد ستون جدول؟','2')),10);
        if(!r||r<1)r=2;if(!c||c<1)c=2;
        // جدول به‌صورت پیش‌فرض زیر متن سؤال قرار می‌گیرد، ولی بعد از این با کشیدن دستگیره
        // می‌توان آن را به هر جای دیگری از فضای همین سؤال جابه‌جا کرد.
        const pos=esFreeItemDefaultPos(qEl);
        qEl.insertAdjacentHTML('beforeend',esBuildFreeTableHtml(r,c,pos.top,pos.left));
        esRows[i].q=qEl.innerHTML;
        esRecalcQHeight(qEl);
      };
    });
    tbody.querySelectorAll('.es-q-addimage').forEach(function(el){
      el.onclick=function(){
        const i=+this.dataset.i;
        const qEl=tbody.querySelector('.es-q[data-i="'+i+'"]');
        const inp=document.createElement('input');
        inp.type='file';inp.accept='image/*';
        inp.onchange=function(){
          const file=inp.files&&inp.files[0];
          if(!file)return;
          const reader=new FileReader();
          reader.onload=function(){
            const img=new Image();
            img.onload=function(){
              // عکس را قبل از درج، کوچک و فشرده می‌کنیم تا حجم آزمون ذخیره‌شده زیاد نشود
              const maxW=520;
              const scale=Math.min(1,maxW/img.width);
              const cw=Math.round(img.width*scale), ch=Math.round(img.height*scale);
              const c=document.createElement('canvas');c.width=cw;c.height=ch;
              c.getContext('2d').drawImage(img,0,0,cw,ch);
              const dataUrl=c.toDataURL('image/jpeg',0.85);
              const pos=esFreeItemDefaultPos(qEl);
              qEl.insertAdjacentHTML('beforeend',esBuildFreeImageHtml(dataUrl,pos.top,pos.left));
              esRows[i].q=qEl.innerHTML;
              esRecalcQHeight(qEl);
            };
            img.src=reader.result;
          };
          reader.readAsDataURL(file);
        };
        inp.click();
      };
    });
  }

  // موقعیت پیش‌فرضِ درج (زیر آخرین محتوای فعلیِ سؤال)
  function esFreeItemDefaultPos(qEl){
    return {top:qEl.scrollHeight, left:0};
  }

  // ساخت یک جدول آزاد و قابل‌کشیدن (با نوار ابزار: دستگیره‌ی جابه‌جایی، افزودن/حذف ردیف و ستون، بزرگ/کوچک، حذف)
  function esBuildFreeTableHtml(r,c,top,left){
    let rowsHtml='';
    for(let rr=0;rr<r;rr++){
      rowsHtml+='<tr>';
      for(let cc=0;cc<c;cc++){rowsHtml+='<td>&nbsp;</td>';}
      rowsHtml+='</tr>';
    }
    return '<div class="es-item" data-type="table" contenteditable="false" style="top:'+top+'px;left:'+left+'px;width:260px">'+
      '<div class="es-item-toolbar" contenteditable="false">'+
        '<button type="button" class="es-item-handle" title="بکشید تا جابه‌جا شود">✥ جابه‌جایی</button>'+
        '<button type="button" data-itact="addrow" title="افزودن ردیف">➕ردیف</button>'+
        '<button type="button" data-itact="delrow" title="حذف آخرین ردیف">➖ردیف</button>'+
        '<button type="button" data-itact="addcol" title="افزودن ستون">➕ستون</button>'+
        '<button type="button" data-itact="delcol" title="حذف آخرین ستون">➖ستون</button>'+
        '<button type="button" data-itact="wbig" title="بزرگ‌تر کردن">🔍 بزرگ‌تر</button>'+
        '<button type="button" data-itact="wsmall" title="کوچک‌تر کردن">🔎 کوچک‌تر</button>'+
        '<button type="button" class="es-item-del" data-itact="del" title="حذف کامل این جدول">🗑️ حذف</button>'+
      '</div>'+
      '<table contenteditable="true"><tbody>'+rowsHtml+'</tbody></table>'+
    '</div>';
  }

  // ساخت یک کادر عکس آزاد و قابل‌کشیدن
  function esBuildFreeImageHtml(dataUrl,top,left){
    return '<div class="es-item" data-type="image" contenteditable="false" style="top:'+top+'px;left:'+left+'px;width:220px">'+
      '<div class="es-item-toolbar" contenteditable="false">'+
        '<button type="button" class="es-item-handle" title="بکشید تا جابه‌جا شود">✥ جابه‌جایی</button>'+
        '<button type="button" data-itact="wbig" title="بزرگ‌تر کردن">🔍 بزرگ‌تر</button>'+
        '<button type="button" data-itact="wsmall" title="کوچک‌تر کردن">🔎 کوچک‌تر</button>'+
        '<button type="button" class="es-item-del" data-itact="del" title="حذف عکس">🗑️ حذف</button>'+
      '</div>'+
      '<img src="'+dataUrl+'" draggable="false" alt="">'+
    '</div>';
  }

  // ارتفاع کادر سؤال را طوری تنظیم می‌کند که پایین‌ترین جدول/عکسِ جابه‌جاشده هم داخل کادر بماند
  function esRecalcQHeight(qEl){
    let maxBottom=0;
    qEl.querySelectorAll(':scope > .es-item').forEach(function(it){
      const top=parseFloat(it.style.top)||0;
      maxBottom=Math.max(maxBottom, top+it.offsetHeight);
    });
    qEl.style.minHeight = maxBottom ? (maxBottom+10)+'px' : '';
  }

  // --- کشیدن آزاد جدول‌ها و عکس‌های تازه‌درج‌شده (با ماوس یا انگشت) ---
  let esDrag=null;
  document.getElementById('es-rows').addEventListener('mousedown',function(e){
    const handle=e.target.closest('.es-item-handle');
    if(!handle)return;
    e.preventDefault();
    esDragStart(handle,e.clientX,e.clientY);
  });
  document.getElementById('es-rows').addEventListener('touchstart',function(e){
    const handle=e.target.closest('.es-item-handle');
    if(!handle)return;
    const t=e.touches[0];
    esDragStart(handle,t.clientX,t.clientY);
  },{passive:true});
  function esDragStart(handle,x,y){
    const it=handle.closest('.es-item');
    const qEl=handle.closest('.es-q-cell').querySelector('.es-q');
    esDrag={it:it,qEl:qEl,startX:x,startY:y,startTop:parseFloat(it.style.top)||0,startLeft:parseFloat(it.style.left)||0};
    it.style.zIndex=5;
  }
  function esDragMove(x,y){
    if(!esDrag)return;
    const {it,qEl,startX,startY,startTop,startLeft}=esDrag;
    let newTop=startTop+(y-startY);
    let newLeft=startLeft+(x-startX);
    const maxLeft=Math.max(0,qEl.clientWidth-it.offsetWidth);
    newLeft=Math.max(0,Math.min(newLeft,maxLeft));
    newTop=Math.max(0,newTop);
    it.style.top=newTop+'px';
    it.style.left=newLeft+'px';
    esRecalcQHeight(qEl);
  }
  function esDragEnd(){
    if(!esDrag)return;
    const {it,qEl}=esDrag;
    it.style.zIndex=2;
    esRecalcQHeight(qEl);
    const i=+qEl.dataset.i;
    esRows[i].q=qEl.innerHTML;
    esDrag=null;
  }
  window.addEventListener('mousemove',function(e){if(esDrag)esDragMove(e.clientX,e.clientY);});
  window.addEventListener('mouseup',esDragEnd);
  window.addEventListener('touchmove',function(e){if(esDrag){e.preventDefault();const t=e.touches[0];esDragMove(t.clientX,t.clientY);}},{passive:false});
  window.addEventListener('touchend',esDragEnd);

  // مدیریت کلیک روی دکمه‌های نوار ابزار جدول/عکسِ آزاد (افزودن/حذف ردیف و ستون، بزرگ/کوچک کردن، حذف)
  document.getElementById('es-rows').addEventListener('click',function(e){
    const btn=e.target.closest('[data-itact]');
    if(!btn)return;
    e.preventDefault();
    const it=btn.closest('.es-item');
    const qEl=btn.closest('.es-q-cell').querySelector('.es-q');
    const i=+qEl.dataset.i;
    const act=btn.dataset.itact;
    if(act==='del'){
      if(!confirm('آیا از حذف این مورد مطمئن هستید؟ این کار قابل بازگشت نیست.'))return;
      it.remove();
      esRecalcQHeight(qEl);
      esRows[i].q=qEl.innerHTML;
      return;
    }
    if(it.dataset.type==='table'){
      const table=it.querySelector('table');
      if(act==='addrow'){
        const cols=table.rows.length?table.rows[0].cells.length:1;
        const tr=table.insertRow(-1);
        for(let c=0;c<cols;c++){const td=tr.insertCell(-1);td.innerHTML='&nbsp;';}
      }else if(act==='delrow'){
        if(table.rows.length>1)table.deleteRow(-1);else toast('حداقل یک ردیف باید در جدول باقی بماند');
      }else if(act==='addcol'){
        Array.from(table.rows).forEach(function(row){const td=row.insertCell(-1);td.innerHTML='&nbsp;';});
      }else if(act==='delcol'){
        const ncols=table.rows.length?table.rows[0].cells.length:0;
        if(ncols>1){Array.from(table.rows).forEach(function(row){row.deleteCell(-1);});}else toast('حداقل یک ستون باید در جدول باقی بماند');
      }
      convertDigitsInElement(table);
    }
    if(act==='wbig'){
      let w=parseInt(it.style.width,10)||(it.dataset.type==='image'?220:260);
      w=Math.min(qEl.clientWidth||600,w+40);
      it.style.width=w+'px';
    }else if(act==='wsmall'){
      let w=parseInt(it.style.width,10)||(it.dataset.type==='image'?220:260);
      w=Math.max(120,w-40);
      it.style.width=w+'px';
    }
    esRecalcQHeight(qEl);
    esRows[i].q=qEl.innerHTML;
  });

  // مدیریت کلیک روی دکمه‌های نوار ابزار هر جدول (افزودن/حذف ردیف و ستون، جابه‌جایی، بزرگ/کوچک کردن، حذف جدول)
  document.getElementById('es-rows').addEventListener('click',function(e){
    const btn=e.target.closest('[data-tact]');
    if(!btn)return;
    e.preventDefault();
    const wrap=btn.closest('.es-tbl-wrap');
    const qEl=btn.closest('.es-q-cell').querySelector('.es-q');
    const i=+qEl.dataset.i;
    const table=wrap.querySelector('table');
    const act=btn.dataset.tact;
    if(act==='addrow'){
      const cols=table.rows.length?table.rows[0].cells.length:1;
      const tr=table.insertRow(-1);
      for(let c=0;c<cols;c++){const td=tr.insertCell(-1);td.innerHTML='&nbsp;';}
    }else if(act==='delrow'){
      if(table.rows.length>1)table.deleteRow(-1);else toast('حداقل یک ردیف باید در جدول باقی بماند');
    }else if(act==='addcol'){
      Array.from(table.rows).forEach(function(row){const td=row.insertCell(-1);td.innerHTML='&nbsp;';});
    }else if(act==='delcol'){
      const ncols=table.rows.length?table.rows[0].cells.length:0;
      if(ncols>1){Array.from(table.rows).forEach(function(row){row.deleteCell(-1);});}else toast('حداقل یک ستون باید در جدول باقی بماند');
    }else if(act==='wbig'){
      let w=parseInt(wrap.style.width,10)||70;w=Math.min(100,w+10);wrap.style.width=w+'%';
    }else if(act==='wsmall'){
      let w=parseInt(wrap.style.width,10)||70;w=Math.max(20,w-10);wrap.style.width=w+'%';
    }else if(act==='up'){
      let prev=wrap.previousElementSibling;
      while(prev&&prev.tagName==='BR')prev=prev.previousElementSibling;
      if(prev)wrap.parentNode.insertBefore(wrap,prev);
    }else if(act==='down'){
      let next=wrap.nextElementSibling;
      if(next){const after=next.nextElementSibling;if(after)wrap.parentNode.insertBefore(after,wrap);}
    }else if(act==='del'){
      if(confirm('آیا از حذف کامل این جدول مطمئن هستید؟ این کار قابل بازگشت نیست.'))wrap.remove();else return;
    }
    convertDigitsInElement(table);
    esRows[i].q=qEl.innerHTML;
  });

  esRenderRows();
  document.getElementById('btn-es-addrow').onclick=function(){esRows.push({q:'',mark:''});esRenderRows();};

  /* ===== پیشنهاد سوال با هوش مصنوعی (برگه چاپی) ===== */
  let ESAI_SUGGESTIONS=[];
  window.openEsAiSuggest=function(){document.getElementById('esai-modal-overlay').classList.remove('hidden');};
  window.closeEsAiSuggest=function(){document.getElementById('esai-modal-overlay').classList.add('hidden');};
  document.getElementById('btn-esai-suggest').onclick=openEsAiSuggest;

  function esaiExtractJsonArray(text){
    const start=text.indexOf('[');
    if(start===-1)return null;
    let depth=0,inStr=false,escFlag=false;
    for(let i=start;i<text.length;i++){
      const ch=text[i];
      if(inStr){
        if(escFlag)escFlag=false;
        else if(ch==='\\\\')escFlag=true;
        else if(ch==='"')inStr=false;
        continue;
      }
      if(ch==='"'){inStr=true;continue;}
      if(ch==='[')depth++;
      else if(ch===']'){
        depth--;
        if(depth===0)return text.slice(start,i+1);
      }
    }
    return null;
  }

  async function esaiGenerate(){
    const topic=document.getElementById('esai-topic').value.trim();
    if(!topic){toast('لطفاً موضوع یا محتوای سوالات را بنویسید');return;}
    let count=parseInt(document.getElementById('esai-count').value,10);
    if(isNaN(count)||count<1)count=1;
    if(count>10)count=10;
    document.getElementById('esai-count').value=count;
    const styleSel=document.getElementById('esai-style').value;
    const defMark=document.getElementById('esai-mark').value||'1';

    const btn=document.getElementById('btn-esai-generate');
    const regenBtn=document.getElementById('btn-esai-regenerate');
    const statusEl=document.getElementById('esai-status');
    [btn,regenBtn].forEach(b=>{if(b){b.disabled=true;}});
    statusEl.textContent='⏳ در حال دریافت پیشنهاد از هوش مصنوعی...';

    const styleLabel={auto:'ترکیبی متنوع از انواع سوال',descriptive:'تشریحی',multiple:'چهارگزینه‌ای (گزینه‌ها به‌صورت متن داخل خود سؤال نوشته شوند، چون این برگه چاپی است)',truefalse:'صحیح/غلط',short:'کوتاه‌پاسخ',fillblank:'جای‌خالی'}[styleSel]||'تشریحی';

    const sys='تو دستیار طراحی سوالات برگه‌ی چاپی آزمون برای معلم‌های ایرانی هستی. بر اساس موضوع داده‌شده، دقیقاً '+count+' سوال از سبک «'+styleLabel+'» طراحی کن. '+
      'این سوالات قرار است مستقیم در یک برگه‌ی آزمون چاپی چاپ شوند، پس اگر سوال چهارگزینه‌ای یا جای‌خالی بود، گزینه‌ها یا خط جای‌خالی را داخل متن خود سؤال به‌صورت کامل بنویس (نه در فیلد جدا). '+
      'خروجی را فقط و فقط به‌صورت یک آرایه‌ی JSON معتبر برگردان، بدون هیچ توضیح اضافه و بدون علامت‌های کد (بک‌تیک). '+
      'هر عضو آرایه باید دقیقاً این شکل را داشته باشد: {"text":"متن کامل سؤال به فارسی","mark":"بارم پیشنهادی به‌صورت عدد یا رشته"}. اگر نمی‌دانی بارم چقدر باشد از عدد '+defMark+' استفاده کن.';

    try{
      const res=await fetch('/api/teacher/ai/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
        messages:[{role:'system',content:sys},{role:'user',content:'موضوع/محتوای سوالات: '+topic}],
        max_tokens: Math.min(8192, 1000 + count*450),
        provider:getAiProvider()
      })});
      const data=await res.json();
      if(!res.ok||data.error)throw new Error(data.error||'خطا در ارتباط با هوش مصنوعی');
      let raw=String(data.content||'').trim();
      const ESAI_BT=String.fromCharCode(96,96,96);
      if(raw.slice(0,3+4).toLowerCase()===ESAI_BT+'json')raw=raw.slice(7);else if(raw.slice(0,3)===ESAI_BT)raw=raw.slice(3);
      if(raw.slice(-3)===ESAI_BT)raw=raw.slice(0,-3);
      raw=raw.trim();
      const arrText=esaiExtractJsonArray(raw);
      if(!arrText){
        console.error('پاسخ خام هوش مصنوعی (بدون آرایه‌ی معتبر):',raw);
        throw new Error('پاسخ هوش مصنوعی قابل پردازش نبود، دوباره تلاش کنید');
      }
      let parsed;
      try{parsed=JSON.parse(arrText);}catch(e){
        console.error('پاسخ خام هوش مصنوعی (JSON نامعتبر):',raw);
        throw new Error('پاسخ هوش مصنوعی قابل پردازش نبود، دوباره تلاش کنید');
      }
      if(!Array.isArray(parsed)||!parsed.length)throw new Error('هوش مصنوعی سوالی برنگرداند، دوباره تلاش کنید');
      ESAI_SUGGESTIONS=parsed.slice(0,count).map(it=>({
        selected:true,
        text:String(it.text||'').trim(),
        mark:String(it.mark||defMark).trim()
      }));
      esaiRenderPreview();
      document.getElementById('esai-preview-wrap').classList.remove('hidden');
      statusEl.textContent='✅ '+ESAI_SUGGESTIONS.length+' سوال پیشنهاد شد. پیش از افزودن بررسی کنید.';
    }catch(e){
      statusEl.textContent='❌ '+e.message;
      toast('خطا: '+e.message);
    }
    [btn,regenBtn].forEach(b=>{if(b){b.disabled=false;}});
  }
  document.getElementById('btn-esai-generate').onclick=esaiGenerate;
  document.getElementById('btn-esai-regenerate').onclick=esaiGenerate;

  function esaiRenderPreview(){
    const box=document.getElementById('esai-preview-list');
    box.innerHTML=ESAI_SUGGESTIONS.map(function(item,j){
      return '<div class="q-block">'+
        '<div class="qhead">'+
          '<label style="display:flex;align-items:center;gap:6px;font-weight:700;cursor:pointer">'+
            '<input type="checkbox" '+(item.selected?'checked':'')+' onchange="esaiToggleSel('+j+',this.checked)"> سوال '+(j+1)+
          '</label>'+
        '</div>'+
        '<label>متن سؤال</label><textarea rows="2" oninput="esaiUpdField('+j+',\\'text\\',this.value)">'+esc(item.text)+'</textarea>'+
        '<label>بارم</label><input type="text" style="max-width:100px" value="'+esc(item.mark)+'" oninput="esaiUpdField('+j+',\\'mark\\',this.value)">'+
      '</div>';
    }).join('');
  }

  window.esaiToggleSel=function(j,checked){ if(ESAI_SUGGESTIONS[j])ESAI_SUGGESTIONS[j].selected=checked; };
  window.esaiUpdField=function(j,k,v){ if(ESAI_SUGGESTIONS[j])ESAI_SUGGESTIONS[j][k]=v; };

  document.getElementById('btn-esai-add-selected').onclick=function(){
    const chosen=ESAI_SUGGESTIONS.filter(function(it){return it.selected&&it.text.trim();});
    if(!chosen.length){toast('هیچ سوالی برای افزودن انتخاب نشده است');return;}
    if(esRows.length===1&&!esRows[0].q&&!esRows[0].mark)esRows=[];
    chosen.forEach(function(it){
      const htmlText=esc(it.text).replace(/\\n/g,'<br>');
      esRows.push({q:htmlText,mark:it.mark||''});
    });
    esRenderRows();
    toast(chosen.length+' سوال به آزمون افزوده شد ✅');
    ESAI_SUGGESTIONS=[];
    document.getElementById('esai-preview-wrap').classList.add('hidden');
    document.getElementById('esai-preview-list').innerHTML='';
    document.getElementById('esai-status').textContent='';
    closeEsAiSuggest();
  };

  function esApplyFontSize(v){
    esFontSize=parseInt(v,10)||12;
    document.getElementById('es-print-area').style.setProperty('--es-font-size',esFontSize+'pt');
  }
  document.getElementById('es-font-size').addEventListener('input',function(){esApplyFontSize(this.value);});
  esApplyFontSize(12);

  function esGatherData(){
    return {
      org1:document.getElementById('es-org1').value,
      org2:document.getElementById('es-org2').value,
      examtitle:document.getElementById('es-examtitle').value,
      examtitleExtra:document.getElementById('es-examtitle-extra').value,
      date:document.getElementById('es-date').value,
      time:document.getElementById('es-time').value,
      course:document.getElementById('es-course').value,
      teacherLabel:document.getElementById('es-teacher-label').value,
      teacher:document.getElementById('es-teacher').value,
      markLabel:document.getElementById('es-mark-label').value,
      grade:document.getElementById('es-grade').value,
      schoolyear:document.getElementById('es-schoolyear').value,
      fontSize:esFontSize,
      rows:esRows
    };
  }
  document.getElementById('btn-es-save').onclick=function(){lbSave('examsheet',esGatherData());};
  document.getElementById('btn-es-word').onclick=async function(){
    await lbSave('examsheet',esGatherData(),true);
    window.open('/api/teacher/word?type=examsheet','_blank');
  };
  document.getElementById('btn-es-pdf').onclick=function(){
    const html=getExamSheetHtmlForExport();
    const w=window.open('','_blank');
    w.document.write(html);w.document.close();
    setTimeout(function(){w.print();},500);
  };

  function getExamSheetHtmlForExport(){
    const d=esGatherData();
    const fs=parseInt(d.fontSize,10)||12;
    let style='<style>body{direction:rtl;font-family:"B Nazanin",Tahoma,Arial;font-weight:bold;padding:10px;font-size:'+fs+'pt}';
    style+='table{width:100%;border-collapse:collapse;table-layout:fixed;margin-bottom:6px}';
    style+='td,th{border:1px solid #000;padding:6px 8px;font-size:'+fs+'pt;vertical-align:top}';
    style+='th{background:#f1f5f9;text-align:center;font-weight:bold}';
    style+='.qnum{width:44px;text-align:center;font-weight:bold}.mk{width:64px;text-align:center}';
    style+='thead{display:table-header-group}tr{page-break-inside:avoid}';
    style+='.es-tbl-toolbar{display:none!important}.es-tbl-wrap{border:none!important;padding:0!important}';
    style+='.es-item{position:static!important;display:inline-block;vertical-align:top;margin:6px 4px;border:none!important;padding:0!important;box-sizing:border-box}';
    style+='.es-item-toolbar,.es-item-handle{display:none!important}';
    style+='.es-item img{max-width:100%;width:100%;display:block;border-radius:4px}';
    style+='.es-item table{width:100%;border-collapse:collapse;margin:0}';
    style+='.es-item table td{border:1px solid #000;padding:8px;min-width:24px;font-size:inherit}</style>';
    let h='<table><tr>'+
      '<td>نام و نام‌خانوادگی: ...................................</td>'+
      '<td style="text-align:center">'+esc(d.org1)+'</td>'+
      '<td>تاریخ آزمون: '+esc(d.date)+'</td>'+
      '</tr><tr>'+
      '<td>نام پدر: ...................................</td>'+
      '<td style="text-align:center">'+esc(d.org2)+'</td>'+
      '<td>زمان آزمون: '+esc(d.time)+'</td>'+
      '</tr><tr>'+
      '<td>رشته / پایه: '+esc(d.grade)+'</td>'+
      '<td>سال تحصیلی: '+esc(d.schoolyear)+'</td>'+
      '<td>'+esc(d.examtitle)+(d.examtitleExtra?' - '+esc(d.examtitleExtra):'')+'</td>'+
      '</tr></table>'+
      '<table><tr><td>نام درس: '+esc(d.course)+'</td><td>'+esc(d.teacherLabel)+': '+esc(d.teacher)+'</td></tr></table>';
    let q='<table><thead><tr><th class="qnum">ردیف</th><th>سؤال</th><th class="mk">'+esc(d.markLabel)+'</th></tr></thead><tbody>';
    d.rows.forEach(function(r,i){
      const sp=(r.space!=null&&r.space!=='')?r.space:90;
      q+='<tr><td class="qnum">'+toFaDigits(i+1)+'</td><td>'+(r.q||'')+'<div style="height:'+sp+'px"></div></td><td style="text-align:center">'+esc(r.mark||'')+'</td></tr>';
    });
    q+='</tbody></table>';
    return '<html><head><meta charset="utf-8">'+style+'</head><body>'+h+q+'</body></html>';
  }

  let esLoaded=false;
  async function loadExamSheetIfNeeded(){
    if(esLoaded)return;esLoaded=true;
    const d=await lbLoad('examsheet');
    if(!d)return;
    if(d.org1!=null)document.getElementById('es-org1').value=d.org1;
    if(d.org2!=null)document.getElementById('es-org2').value=d.org2;
    if(d.examtitle!=null)document.getElementById('es-examtitle').value=d.examtitle;
    if(d.examtitleExtra!=null)document.getElementById('es-examtitle-extra').value=d.examtitleExtra;
    if(d.date!=null)document.getElementById('es-date').value=d.date;
    if(d.time!=null)document.getElementById('es-time').value=d.time;
    if(d.course!=null)document.getElementById('es-course').value=d.course;
    if(d.teacherLabel!=null)document.getElementById('es-teacher-label').value=d.teacherLabel;
    if(d.teacher!=null)document.getElementById('es-teacher').value=d.teacher;
    if(d.markLabel!=null)document.getElementById('es-mark-label').value=d.markLabel;
    if(d.grade!=null)document.getElementById('es-grade').value=d.grade;
    if(d.schoolyear!=null)document.getElementById('es-schoolyear').value=d.schoolyear;
    if(d.fontSize!=null){document.getElementById('es-font-size').value=d.fontSize;esApplyFontSize(d.fontSize);}
    if(Array.isArray(d.rows)&&d.rows.length)esRows=d.rows;
    esRenderRows();
  }


  document.getElementById('btn-org-form').onclick=async function(){
    const btn=this;btn.disabled=true;const origText=btn.textContent;btn.textContent='⏳ در حال ساخت فایل...';
    try{
      await loadExcelJS();
      const orgData=orgGatherData();
      const wb=new ExcelJS.Workbook();
      wb.creator='پنل مدیریت کلاسی';

      function numOrBlank(raw){
        if(raw===undefined||raw===null||raw==='')return undefined;
        const n=Number(raw);
        return isNaN(n)?undefined:n;
      }
      // ردیف مهر و امضا در پایین هر شیت: مدیر مدرسه سمت راست، مسئول آموزش سمت چپ
      function addSignatureFooter(ws,startCol,endCol,lastUsedRow){
        const gap=lastUsedRow+2;
        const total=endCol-startCol+1;
        const half=Math.floor(total/2);
        const rightEnd=startCol+half-1;
        const leftStart=rightEnd+1;
        const labelRow=gap;
        ws.mergeCells(labelRow,startCol,labelRow,rightEnd);
        ws.getCell(labelRow,startCol).value='مهر و امضا مدیر مدرسه';
        ws.getCell(labelRow,startCol).font={bold:true,size:11};
        ws.getCell(labelRow,startCol).alignment={horizontal:'center',vertical:'middle'};
        ws.mergeCells(labelRow,leftStart,labelRow,endCol);
        ws.getCell(labelRow,leftStart).value='مهر و امضا مسئول آموزش';
        ws.getCell(labelRow,leftStart).font={bold:true,size:11};
        ws.getCell(labelRow,leftStart).alignment={horizontal:'center',vertical:'middle'};
        ws.getRow(labelRow).height=18;
        const boxRow=labelRow+1;
        ws.mergeCells(boxRow,startCol,boxRow,rightEnd);
        ws.getCell(boxRow,startCol).border={top:{style:'thin',color:{argb:'FF94A3B8'}},left:{style:'thin',color:{argb:'FF94A3B8'}},right:{style:'thin',color:{argb:'FF94A3B8'}},bottom:{style:'thin',color:{argb:'FF94A3B8'}}};
        ws.mergeCells(boxRow,leftStart,boxRow,endCol);
        ws.getCell(boxRow,leftStart).border={top:{style:'thin',color:{argb:'FF94A3B8'}},left:{style:'thin',color:{argb:'FF94A3B8'}},right:{style:'thin',color:{argb:'FF94A3B8'}},bottom:{style:'thin',color:{argb:'FF94A3B8'}}};
        ws.getRow(boxRow).height=55;
        return boxRow;
      }
      const thin={style:'thin',color:{argb:'FFB7B7B7'}};
      const borderAll={top:thin,left:thin,right:thin,bottom:thin};
      const headerFill={type:'pattern',pattern:'solid',fgColor:{argb:'FFD9E2F3'}};
      const inputFill={type:'pattern',pattern:'solid',fgColor:{argb:'FFFFF6DC'}};
      const groupFill={type:'pattern',pattern:'solid',fgColor:{argb:'FF4472C4'}};

      // ---------- شیت ۱: مشخصات آموزشگاه و آمار دانش‌آموزان ----------
      const ws1=wb.addWorksheet('مشخصات و آمار',{views:[{rightToLeft:true}],pageSetup:{paperSize:9,orientation:'landscape',fitToPage:true,fitToWidth:1,fitToHeight:1,margins:{left:0.3,right:0.3,top:0.4,bottom:0.4,header:0.2,footer:0.2},horizontalCentered:true}});
      ws1.mergeCells('A1:N1');
      ws1.getCell('A1').value='فرم سازمان عملی — سازمان ملی تعلیم و تربیت کودک / دوره ابتدایی';
      ws1.getCell('A1').font={size:15,bold:true,color:{argb:'FF1E293B'}};
      ws1.getCell('A1').alignment={horizontal:'center',vertical:'middle'};
      ws1.getRow(1).height=26;

      ws1.mergeCells('A2:N2');
      ws1.getCell('A2').value='مشخصات آموزشگاه';
      ws1.getCell('A2').font={size:12,bold:true,color:{argb:'FFFFFFFF'}};
      ws1.getCell('A2').fill=groupFill;
      ws1.getCell('A2').alignment={horizontal:'center',vertical:'middle'};
      ws1.getRow(2).height=20;

      // فیلدهای مشخصات آموزشگاه: [برچسب, نوع, کلید‌داده, لیست‌دراپ‌داون]
      const infoFields=[
        ['سال تحصیلی','text','year'],['فرم شماره','text','formno'],
        ['منطقه','text','region'],['نام آموزشگاه','text','school'],
        ['کد آموزشگاه','text','schoolcode'],['نام مدیر','text','principal'],
        ['جنسیت','list','gender',['پسر','دختر','مختلط']],['مقطع','text','level'],
        ['کد فضا','text','spacecode'],['نوع اداره','list','adminType',['دولتی','غیردولتی']],
        ['وضعیت ساختمان','text','buildingStatus'],['وضعیت','text','status'],
        ['نوع ساختمان','list','buildingType',['آجری','بتنی','سایر']],['شماره تلفن','text','phone']
      ];
      let r=3;
      for(let i=0;i<infoFields.length;i+=2){
        const row=ws1.getRow(r);
        row.getCell(1).value=infoFields[i][0]+':';
        row.getCell(1).font={bold:true};
        row.getCell(1).alignment={horizontal:'right',vertical:'middle'};
        ws1.mergeCells(r,2,r,4);
        row.getCell(2).value=orgData[infoFields[i][2]]||'';
        row.getCell(2).fill=inputFill;
        row.getCell(2).border=borderAll;
        row.getCell(2).alignment={horizontal:'right',vertical:'middle'};
        if(infoFields[i][1]==='list'){row.getCell(2).dataValidation={type:'list',allowBlank:true,formulae:['"'+infoFields[i][3].join(',')+'"']};}
        if(infoFields[i+1]){
          row.getCell(8).value=infoFields[i+1][0]+':';
          row.getCell(8).font={bold:true};
          row.getCell(8).alignment={horizontal:'right',vertical:'middle'};
          ws1.mergeCells(r,9,r,11);
          row.getCell(9).value=orgData[infoFields[i+1][2]]||'';
          row.getCell(9).fill=inputFill;
          row.getCell(9).border=borderAll;
          row.getCell(9).alignment={horizontal:'right',vertical:'middle'};
          if(infoFields[i+1][1]==='list'){row.getCell(9).dataValidation={type:'list',allowBlank:true,formulae:['"'+infoFields[i+1][3].join(',')+'"']};}
        }
        row.getCell(1).border=borderAll;row.getCell(8).border=borderAll;
        row.height=20;
        r++;
      }
      // ردیف «سازمان / دوره تحصیلی» ثابت
      ws1.getCell('A'+r).value='سازمان / دوره تحصیلی:';
      ws1.getCell('A'+r).font={bold:true};
      ws1.mergeCells(r,2,r,11);
      ws1.getCell('B'+r).value='سازمان ملی تعلیم و تربیت کودک / دوره ابتدایی';
      ws1.getCell('B'+r).font={italic:true,color:{argb:'FF475569'}};
      ws1.getCell('B'+r).alignment={horizontal:'right',vertical:'middle'};
      r++;
      // نشانی
      ws1.getCell('A'+r).value='نشانی آموزشگاه:';
      ws1.getCell('A'+r).font={bold:true};
      ws1.mergeCells(r,2,r,11);
      ws1.getCell('B'+r).value=orgData.address||'';
      ws1.getCell('B'+r).fill=inputFill;
      ws1.getCell('B'+r).border=borderAll;
      ws1.getCell('B'+r).alignment={horizontal:'right',vertical:'middle'};
      ws1.getRow(r).height=22;
      r+=2;

      // ---------- جدول آمار کلاس‌ها و دانش‌آموزان ----------
      const statTop=r;
      ws1.mergeCells(statTop,1,statTop,8);
      ws1.getCell(statTop,1).value='آمار کلاس‌ها و دانش‌آموزان به تفکیک پایه';
      ws1.getCell(statTop,1).font={size:12,bold:true,color:{argb:'FFFFFFFF'}};
      ws1.getCell(statTop,1).fill=groupFill;
      ws1.getCell(statTop,1).alignment={horizontal:'center',vertical:'middle'};
      ws1.getRow(statTop).height=20;

      const h1=statTop+1,h2=statTop+2;
      ws1.mergeCells(h1,1,h2,1); ws1.getCell(h1,1).value='پایه';
      ws1.mergeCells(h1,2,h1,5); ws1.getCell(h1,2).value='کلاس';
      ws1.mergeCells(h1,6,h1,8); ws1.getCell(h1,6).value='دانش‌آموزان';
      const sub1=['پسرانه','دخترانه','مختلط','جمع'], sub2=['پسر','دختر','جمع'];
      sub1.forEach((t,i)=>{ws1.getCell(h2,2+i).value=t;});
      sub2.forEach((t,i)=>{ws1.getCell(h2,6+i).value=t;});
      for(let rr=h1;rr<=h2;rr++){
        ws1.getRow(rr).eachCell({includeEmpty:true},function(cell,colNum){
          if(colNum>8)return;
          cell.font={bold:true,color:{argb:'FF1E3A8A'}};
          cell.fill=headerFill;
          cell.alignment={horizontal:'center',vertical:'middle',wrapText:true};
          cell.border=borderAll;
        });
        ws1.getRow(rr).height=20;
      }

      const statRows=[...ORG_GRADES,'چندپایه'];
      const dataStart=h2+1;
      statRows.forEach((g,idx)=>{
        const rr=dataStart+idx;
        const st=orgData.stats[idx]||{};
        ws1.getCell(rr,1).value=g==='چندپایه'?g:'پایه '+g;
        ws1.getCell(rr,2).value=numOrBlank(st['cls-boy']);
        ws1.getCell(rr,3).value=numOrBlank(st['cls-girl']);
        ws1.getCell(rr,4).value=numOrBlank(st['cls-mixed']);
        ws1.getCell(rr,5).value={formula:'SUM(B'+rr+':D'+rr+')'};
        ws1.getCell(rr,6).value=numOrBlank(st['stu-boy']);
        ws1.getCell(rr,7).value=numOrBlank(st['stu-girl']);
        ws1.getCell(rr,8).value={formula:'SUM(F'+rr+':G'+rr+')'};
        ws1.getRow(rr).eachCell({includeEmpty:true},function(cell,colNum){
          if(colNum>8)return;
          cell.border=borderAll;
          cell.alignment={horizontal:'center',vertical:'middle'};
          if([2,3,4,6,7].includes(colNum))cell.fill=inputFill;
        });
        ws1.getRow(rr).height=19;
      });
      const totalRow=dataStart+statRows.length;
      ws1.getCell(totalRow,1).value='جمع';
      ws1.getCell(totalRow,1).font={bold:true};
      [2,3,4,5,6,7,8].forEach(function(c){
        const colL=colLetter(c);
        ws1.getCell(totalRow,c).value={formula:'SUM('+colL+dataStart+':'+colL+(totalRow-1)+')'};
      });
      ws1.getRow(totalRow).eachCell({includeEmpty:true},function(cell,colNum){
        if(colNum>8)return;
        cell.font={bold:true,color:{argb:'FF375623'}};
        cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFE2EFDA'}};
        cell.border=borderAll;
        cell.alignment={horizontal:'center',vertical:'middle'};
      });
      ws1.getRow(totalRow).height=20;

      // ---------- تعداد دانش‌آموزان خاص ----------
      let sr=totalRow+2;
      ws1.mergeCells(sr,1,sr,8);
      ws1.getCell(sr,1).value='تعداد دانش‌آموزان خاص';
      ws1.getCell(sr,1).font={size:12,bold:true,color:{argb:'FFFFFFFF'}};
      ws1.getCell(sr,1).fill=groupFill;
      ws1.getCell(sr,1).alignment={horizontal:'center',vertical:'middle'};
      ws1.getRow(sr).height=20;
      sr++;
      const specialLabels=['فرزندان شاهد','تلفیقی شدید','تلفیقی خفیف','تحت پوشش','اتباع خارجی','جذب بازمانده'];
      specialLabels.forEach((lab,idx)=>{
        const rr=sr+idx;
        ws1.getCell(rr,1).value=lab+':';
        ws1.getCell(rr,1).font={bold:true};
        ws1.getCell(rr,1).alignment={horizontal:'right',vertical:'middle'};
        ws1.getCell(rr,1).border=borderAll;
        ws1.getCell(rr,2).value=numOrBlank(orgData.special[idx]);
        ws1.getCell(rr,2).fill=inputFill;
        ws1.getCell(rr,2).border=borderAll;
        ws1.getCell(rr,2).alignment={horizontal:'center',vertical:'middle'};
        ws1.getRow(rr).height=19;
      });

      addSignatureFooter(ws1,1,8,sr+specialLabels.length-1);

      ws1.getColumn(1).width=17;
      for(let c=2;c<=8;c++)ws1.getColumn(c).width=11;

      // ---------- شیت ۲: اطلاعات پرسنل ----------
      const ws2=wb.addWorksheet('اطلاعات پرسنل',{views:[{rightToLeft:true,state:'frozen',ySplit:1}],pageSetup:{paperSize:9,orientation:'landscape',fitToPage:true,fitToWidth:1,fitToHeight:0,margins:{left:0.3,right:0.3,top:0.4,bottom:0.4,header:0.2,footer:0.2},horizontalCentered:true}});
      const headers2=['ردیف','کد پرسنلی','نام','نام خانوادگی','کد ملی','مدرک','رشته تحصیلی','سابقه','نوع استخدام / وضعیت','پست سازمانی','آدرس','تلفن'];
      const hdrRow2=ws2.getRow(1);
      headers2.forEach((t,i)=>{hdrRow2.getCell(i+1).value=t;});
      hdrRow2.eachCell(function(cell){
        cell.font={bold:true,color:{argb:'FFFFFFFF'}};
        cell.fill=groupFill;
        cell.alignment={horizontal:'center',vertical:'middle',wrapText:true};
        cell.border=borderAll;
      });
      hdrRow2.height=26;

      const staffRowCount=Math.max(orgData.staff.length,20);
      for(let rr=2;rr<=staffRowCount+1;rr++){
        const rowVals=orgData.staff[rr-2]||[];
        ws2.getCell(rr,1).value={formula:'ROW()-1'};
        for(let c=1;c<=12;c++){
          const cell=ws2.getCell(rr,c);
          cell.border=borderAll;
          cell.alignment={horizontal:'center',vertical:'middle'};
          if(c!==1){cell.fill=inputFill;cell.value=rowVals[c-2]||'';}
        }
      }
      ws2.autoFilter={from:{row:1,column:1},to:{row:1,column:12}};
      addSignatureFooter(ws2,1,12,staffRowCount+1);
      ws2.getColumn(1).width=7;
      ws2.getColumn(2).width=14;
      ws2.getColumn(3).width=12;
      ws2.getColumn(4).width=14;
      ws2.getColumn(5).width=12;
      ws2.getColumn(6).width=11;
      ws2.getColumn(7).width=13;
      ws2.getColumn(8).width=8;
      ws2.getColumn(9).width=15;
      ws2.getColumn(10).width=13;
      ws2.getColumn(11).width=18;
      ws2.getColumn(12).width=13;

      // ---------- شیت ۳: ساعات موظف / غیرموظف به تفکیک پایه ----------
      const ws3=wb.addWorksheet('ساعات موظف',{views:[{rightToLeft:true,state:'frozen',ySplit:2}],pageSetup:{paperSize:9,orientation:'landscape',fitToPage:true,fitToWidth:1,fitToHeight:0,margins:{left:0.25,right:0.25,top:0.35,bottom:0.35,header:0.15,footer:0.15},horizontalCentered:true}});
      const hg1=1,hg2=2;
      ws3.mergeCells(hg1,1,hg2,1); ws3.getCell(hg1,1).value='ردیف';
      ws3.mergeCells(hg1,2,hg2,2); ws3.getCell(hg1,2).value='کد پرسنلی';
      ws3.mergeCells(hg1,3,hg2,3); ws3.getCell(hg1,3).value='نام و نام خانوادگی';
      const hourGroups=['پایه اول','پایه دوم','پایه سوم','پایه چهارم','پایه پنجم','پایه ششم','چندپایه','جمع'];
      hourGroups.forEach((gname,gi)=>{
        const c0=4+gi*3;
        ws3.mergeCells(hg1,c0,hg1,c0+2);
        ws3.getCell(hg1,c0).value=gname;
        ws3.getCell(hg2,c0).value='موظف';
        ws3.getCell(hg2,c0+1).value='غ‌موظف';
        ws3.getCell(hg2,c0+2).value='جمع';
      });
      const lastCol=4+hourGroups.length*3-1;
      for(let rr=hg1;rr<=hg2;rr++){
        ws3.getRow(rr).eachCell({includeEmpty:true},function(cell,colNum){
          if(colNum>lastCol)return;
          cell.font={bold:true,color:{argb:'FF1E3A8A'}};
          cell.fill=headerFill;
          cell.alignment={horizontal:'center',vertical:'middle',wrapText:true};
          cell.border=borderAll;
        });
        ws3.getRow(rr).height=20;
      }
      const gradeGroupCount=7; // پایه اول..ششم + چندپایه (گروه هشتم «جمع» خودش محاسبه‌شونده است)
      const hoursRowCount=Math.max(orgData.hours.length,15);
      for(let idx=0;idx<hoursRowCount;idx++){
        const rr=hg2+1+idx;
        const hrow=orgData.hours[idx]||{code:'',name:'',g:[]};
        ws3.getCell(rr,1).value={formula:'ROW()-'+(hg2)};
        ws3.getCell(rr,2).value=hrow.code||'';
        ws3.getCell(rr,3).value=hrow.name||'';
        const moColLetters=[],ghColLetters=[];
        for(let gi=0;gi<gradeGroupCount;gi++){
          const c0=4+gi*3;
          const pair=hrow.g[gi]||{};
          ws3.getCell(rr,c0).value=numOrBlank(pair.mo);
          ws3.getCell(rr,c0+1).value=numOrBlank(pair.gh);
          ws3.getCell(rr,c0+2).value={formula:colLetter(c0)+rr+'+'+colLetter(c0+1)+rr};
          moColLetters.push(colLetter(c0));ghColLetters.push(colLetter(c0+1));
        }
        const finalC0=4+gradeGroupCount*3;
        ws3.getCell(rr,finalC0).value={formula:moColLetters.map(cl=>cl+rr).join('+')};
        ws3.getCell(rr,finalC0+1).value={formula:ghColLetters.map(cl=>cl+rr).join('+')};
        ws3.getCell(rr,finalC0+2).value={formula:colLetter(finalC0)+rr+'+'+colLetter(finalC0+1)+rr};
        ws3.getRow(rr).eachCell({includeEmpty:true},function(cell,colNum){
          if(colNum>lastCol)return;
          cell.border=borderAll;
          cell.alignment={horizontal:'center',vertical:'middle'};
          if(colNum>3)cell.fill=inputFill;
        });
        ws3.getRow(rr).height=19;
      }
      addSignatureFooter(ws3,1,lastCol,hg2+hoursRowCount);
      ws3.getColumn(1).width=7;
      ws3.getColumn(2).width=13;
      ws3.getColumn(3).width=20;
      for(let c=4;c<=lastCol;c++)ws3.getColumn(c).width=8;

      const buf=await wb.xlsx.writeBuffer();
      const blob=new Blob([buf],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
      const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='فرم-سازمان-عملی.xlsx';document.body.appendChild(a);a.click();a.remove();
      toast('فرم سازمان عملی ساخته شد ✅');
    }catch(err){
      toast('خطا در ساخت فایل — اتصال اینترنت را بررسی کنید');
    }finally{
      btn.disabled=false;btn.textContent=origText;
    }
  };


  // ===== اسکنر =====
  let SCANIMG=null, SCANORIG=null, scanRotation=0;
  let scanPdfPages=[], scanPdfIndex=0; // صفحات یک PDF که به عکس تبدیل شده‌اند (برای اسکن یکی‌یکی)
  const scanDropZone=document.getElementById('scan-drop-zone');
  const scanFileInput=document.getElementById('scan-file');
  const scanPdfNav=document.getElementById('scan-pdf-nav');
  scanDropZone.onclick=()=>scanFileInput.click();
  scanDropZone.addEventListener('dragover',e=>{e.preventDefault();scanDropZone.classList.add('dragover');});
  scanDropZone.addEventListener('dragleave',()=>scanDropZone.classList.remove('dragover'));
  scanDropZone.addEventListener('drop',e=>{e.preventDefault();scanDropZone.classList.remove('dragover');if(e.dataTransfer.files[0])handleScanFile(e.dataTransfer.files[0]);});
  scanFileInput.addEventListener('change',function(){if(this.files[0])handleScanFile(this.files[0]);this.value='';});

  function handleScanFile(file){
    if(file.type==='application/pdf'||/\.pdf$/i.test(file.name||'')){
      loadScanPdf(file);
    }else{
      scanPdfPages=[];scanPdfIndex=0;updateScanPdfNav();
      loadScanImg(file);
    }
  }

  // تبدیل خودکار همه‌ی صفحات یک PDF به عکس، و اضافه‌شدن آن‌ها به‌صورت صف برای اسکن یکی‌یکی
  async function loadScanPdf(file){
    if(typeof pdfjsLib==='undefined'){toast('کتابخانه PDF در دسترس نیست');return;}
    toast('⏳ در حال تبدیل صفحات PDF به عکس...');
    try{
      // کیفیت خروجی طبق اسلایدر «کیفیت خروجی» تنظیم می‌شود؛ قبلاً همیشه روی مقدار ثابت ۹۲٪ بود و اسلایدر هیچ اثری نداشت
      const outQ=(parseInt(document.getElementById('scan-out-quality')?.value,10)||90)/100;
      const buf=await file.arrayBuffer();
      const doc=await pdfjsLib.getDocument({data:buf}).promise;
      const pages=[];
      for(let p=1;p<=doc.numPages;p++){
        const page=await doc.getPage(p);
        const viewport=page.getViewport({scale:2});
        const c=document.createElement('canvas');
        c.width=viewport.width;c.height=viewport.height;
        await page.render({canvasContext:c.getContext('2d'),viewport}).promise;
        pages.push(c.toDataURL('image/jpeg',outQ));
      }
      if(!pages.length){toast('صفحه‌ای در این PDF پیدا نشد');return;}
      scanPdfPages=pages;
      scanPdfIndex=0;
      updateScanPdfNav();
      loadScanPdfPage(0);
      toast('✅ '+toFaDigits(pages.length)+' صفحه از PDF به عکس تبدیل شد؛ اکنون می‌توانید هرکدام را اسکن کنید');
    }catch(e){
      console.error('خطا در تبدیل PDF به عکس:',e);
      toast('⚠️ خطا در تبدیل PDF به عکس؛ لطفاً فایل دیگری را امتحان کنید');
    }
  }

  function loadScanPdfPage(idx){
    const dataUrl=scanPdfPages[idx];
    if(!dataUrl)return;
    const img=new Image();
    img.onload=()=>{
      scanDropZone.classList.add('hidden');
      scanWarpOriginalImg=img;
      openScanWarpStage(img);
    };
    img.onerror=()=>{toast('خطا در بارگذاری این صفحه از PDF');};
    img.src=dataUrl;
  }

  function updateScanPdfNav(){
    if(scanPdfPages.length>1){
      scanPdfNav.classList.remove('hidden');
      document.getElementById('scan-pdf-pageinfo').textContent='صفحه '+toFaDigits(scanPdfIndex+1)+' از '+toFaDigits(scanPdfPages.length);
      document.getElementById('btn-scan-pdf-prev').disabled=(scanPdfIndex===0);
      document.getElementById('btn-scan-pdf-next').disabled=(scanPdfIndex===scanPdfPages.length-1);
    }else{
      scanPdfNav.classList.add('hidden');
    }
  }
  document.getElementById('btn-scan-pdf-prev').onclick=()=>{if(scanPdfIndex>0){scanPdfIndex--;updateScanPdfNav();loadScanPdfPage(scanPdfIndex);}};
  document.getElementById('btn-scan-pdf-next').onclick=()=>{if(scanPdfIndex<scanPdfPages.length-1){scanPdfIndex++;updateScanPdfNav();loadScanPdfPage(scanPdfIndex);}};

  function loadScanImg(file){
    const rd=new FileReader();
    rd.onload=ev=>{const img=new Image();img.onload=()=>{
      // عکس‌های دوربین موبایل معمولاً خیلی بزرگ‌اند (۸ تا ۱۲+ مگاپیکسل)؛ پردازش‌های بعدی (اصلاح پرسپکتیو، فیلترها، برش)
      // پیکسل‌به‌پیکسل روی کل تصویر انجام می‌شوند و بدون کوچک‌سازی ممکن است مرورگر موبایل هنگ کند یا کاملاً بسته شود.
      const maxDim=2000;
      let w=img.naturalWidth,h=img.naturalHeight;
      if(Math.max(w,h)>maxDim){
        const scale=maxDim/Math.max(w,h);
        const c=document.createElement('canvas');
        c.width=Math.round(w*scale);c.height=Math.round(h*scale);
        c.getContext('2d').drawImage(img,0,0,c.width,c.height);
        const resized=new Image();
        resized.onload=()=>{
          scanDropZone.classList.add('hidden');
          scanWarpOriginalImg=resized;
          openScanWarpStage(resized);
        };
        resized.onerror=()=>{toast('خطا در پردازش عکس');};
        resized.src=c.toDataURL('image/jpeg',0.92);
        return;
      }
      scanDropZone.classList.add('hidden');
      scanWarpOriginalImg=img;
      openScanWarpStage(img);
    };img.onerror=()=>{toast('فایل عکس معتبر نیست');};img.src=ev.target.result;};
    rd.onerror=()=>{toast('خطا در خواندن فایل');};
    rd.readAsDataURL(file);
  }

  // ===== برش پرسپکتیو (صاف‌کردن سند مثل CamScanner) =====
  let scanWarpOriginalImg=null;
  let scanWarpCorners={tl:{x:0.08,y:0.08},tr:{x:0.92,y:0.08},br:{x:0.92,y:0.92},bl:{x:0.08,y:0.92}};

  function openScanWarpStage(img){
    document.getElementById('scan-warp-img').src=img.src;
    document.getElementById('scan-warp-stage').classList.remove('hidden');
    document.getElementById('scan-controls').classList.add('hidden');
    scanWarpCorners={tl:{x:0.08,y:0.08},tr:{x:0.92,y:0.08},br:{x:0.92,y:0.92},bl:{x:0.08,y:0.92}};
    scanRenderWarpHandles();
  }

  function scanRenderWarpHandles(){
    const wrapper=document.getElementById('scan-warp-wrapper');
    ['tl','tr','br','bl'].forEach(k=>{
      const h=wrapper.querySelector('.scan-warp-handle[data-corner="'+k+'"]');
      h.style.left=(scanWarpCorners[k].x*100)+'%';
      h.style.top=(scanWarpCorners[k].y*100)+'%';
    });
    const pts=['tl','tr','br','bl'].map(k=>(scanWarpCorners[k].x*100)+'%,'+(scanWarpCorners[k].y*100)+'%').join(' ');
    document.getElementById('scan-warp-poly').setAttribute('points',pts);
  }

  function scanMakeDraggable(handle,corner){
    handle.addEventListener('pointerdown',e=>{
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const wrapper=document.getElementById('scan-warp-wrapper');
      function move(ev){
        const rect=wrapper.getBoundingClientRect();
        let px=(ev.clientX-rect.left)/rect.width, py=(ev.clientY-rect.top)/rect.height;
        px=Math.min(1,Math.max(0,px));py=Math.min(1,Math.max(0,py));
        scanWarpCorners[corner]={x:px,y:py};
        scanRenderWarpHandles();
      }
      function up(){
        handle.releasePointerCapture(e.pointerId);
        handle.removeEventListener('pointermove',move);
        handle.removeEventListener('pointerup',up);
      }
      handle.addEventListener('pointermove',move);
      handle.addEventListener('pointerup',up);
    });
  }
  document.querySelectorAll('.scan-warp-handle').forEach(h=>scanMakeDraggable(h,h.dataset.corner));

  // تشخیص تقریبیِ لبه‌های سند (بر پایهٔ تغییرات شدید رنگ/روشنایی نسبت به پس‌زمینه)
  function scanAutoDetectEdges(img){
    const maxDim=400;
    const w=img.naturalWidth,h=img.naturalHeight;
    const scale=Math.min(1,maxDim/Math.max(w,h));
    const cw=Math.max(2,Math.round(w*scale)),ch=Math.max(2,Math.round(h*scale));
    const cv=document.createElement('canvas');cv.width=cw;cv.height=ch;
    const ctx=cv.getContext('2d');ctx.drawImage(img,0,0,cw,ch);
    const d=ctx.getImageData(0,0,cw,ch).data;
    const gray=new Float32Array(cw*ch);
    for(let i=0;i<cw*ch;i++){const p=i*4;gray[i]=0.299*d[p]+0.587*d[p+1]+0.114*d[p+2];}
    const rowScore=new Float32Array(ch),colScore=new Float32Array(cw);
    for(let y=1;y<ch-1;y++){
      for(let x=1;x<cw-1;x++){
        const gx=gray[y*cw+x+1]-gray[y*cw+x-1];
        const gy=gray[(y+1)*cw+x]-gray[(y-1)*cw+x];
        const mag=Math.abs(gx)+Math.abs(gy);
        rowScore[y]+=mag;colScore[x]+=mag;
      }
    }
    let rMax=0,cMax=0;
    for(let i=0;i<ch;i++)if(rowScore[i]>rMax)rMax=rowScore[i];
    for(let i=0;i<cw;i++)if(colScore[i]>cMax)cMax=colScore[i];
    const rThresh=rMax*0.15,cThresh=cMax*0.15;
    let top=0,bottom=ch-1,left=0,right=cw-1;
    for(let y=0;y<ch;y++){if(rowScore[y]>rThresh){top=y;break;}}
    for(let y=ch-1;y>=0;y--){if(rowScore[y]>rThresh){bottom=y;break;}}
    for(let x=0;x<cw;x++){if(colScore[x]>cThresh){left=x;break;}}
    for(let x=cw-1;x>=0;x--){if(colScore[x]>cThresh){right=x;break;}}
    if(right-left<cw*0.2||bottom-top<ch*0.2)return null; // تشخیص نامطمئن بود
    return{left:left/cw,top:top/ch,right:right/cw,bottom:bottom/ch};
  }

  document.getElementById('btn-scan-autodetect').onclick=()=>{
    if(!scanWarpOriginalImg)return;
    const box=scanAutoDetectEdges(scanWarpOriginalImg);
    if(!box){toast('تشخیص خودکار مطمئن نبود — لطفاً گوشه‌ها را دستی تنظیم کنید');return;}
    scanWarpCorners={tl:{x:box.left,y:box.top},tr:{x:box.right,y:box.top},br:{x:box.right,y:box.bottom},bl:{x:box.left,y:box.bottom}};
    scanRenderWarpHandles();
    toast('لبه‌های سند تشخیص داده شد — در صورت نیاز گوشه‌ها را دقیق‌تر کنید');
  };

  // محاسبهٔ ماتریس هوموگرافی (تبدیل پرسپکتیو) از ۴ نقطهٔ متناظر
  function scanComputeHomography(from,to){
    const A=[],n=8;
    for(let i=0;i<4;i++){
      const{x,y}=from[i],X=to[i].x,Y=to[i].y;
      A.push([x,y,1,0,0,0,-x*X,-y*X,X]);
      A.push([0,0,0,x,y,1,-x*Y,-y*Y,Y]);
    }
    for(let col=0;col<n;col++){
      let maxRow=col;
      for(let r=col+1;r<n;r++)if(Math.abs(A[r][col])>Math.abs(A[maxRow][col]))maxRow=r;
      const tmp=A[col];A[col]=A[maxRow];A[maxRow]=tmp;
      const pivot=A[col][col];
      if(Math.abs(pivot)<1e-12)continue;
      for(let r=0;r<n;r++){
        if(r===col)continue;
        const factor=A[r][col]/pivot;
        for(let c=col;c<=n;c++)A[r][c]-=factor*A[col][c];
      }
    }
    const hArr=new Array(n);
    for(let i=0;i<n;i++)hArr[i]=A[i][n]/A[i][i];
    return hArr;
  }

  function scanWarpPerspective(img,srcCorners,outW,outH){
    const srcCanvas=document.createElement('canvas');
    srcCanvas.width=img.naturalWidth;srcCanvas.height=img.naturalHeight;
    const sctx=srcCanvas.getContext('2d');sctx.drawImage(img,0,0);
    const sw=srcCanvas.width,sh=srcCanvas.height;
    const srcData=sctx.getImageData(0,0,sw,sh).data;
    const dst=[{x:0,y:0},{x:outW,y:0},{x:outW,y:outH},{x:0,y:outH}];
    const h=scanComputeHomography(dst,srcCorners);
    const outCanvas=document.createElement('canvas');
    outCanvas.width=outW;outCanvas.height=outH;
    const octx=outCanvas.getContext('2d');
    const outImgData=octx.createImageData(outW,outH);
    const od=outImgData.data;
    for(let Y=0;Y<outH;Y++){
      for(let X=0;X<outW;X++){
        const denom=h[6]*X+h[7]*Y+1;
        const sx=(h[0]*X+h[1]*Y+h[2])/denom;
        const sy=(h[3]*X+h[4]*Y+h[5])/denom;
        const oi=(Y*outW+X)*4;
        if(sx<0||sy<0||sx>=sw-1||sy>=sh-1){od[oi]=255;od[oi+1]=255;od[oi+2]=255;od[oi+3]=255;continue;}
        const x0=Math.floor(sx),y0=Math.floor(sy),fx=sx-x0,fy=sy-y0;
        const i00=(y0*sw+x0)*4,i10=(y0*sw+x0+1)*4,i01=((y0+1)*sw+x0)*4,i11=((y0+1)*sw+x0+1)*4;
        for(let c=0;c<3;c++){
          const top=srcData[i00+c]*(1-fx)+srcData[i10+c]*fx;
          const bot=srcData[i01+c]*(1-fx)+srcData[i11+c]*fx;
          od[oi+c]=top*(1-fy)+bot*fy;
        }
        od[oi+3]=255;
      }
    }
    octx.putImageData(outImgData,0,0);
    return outCanvas;
  }

  function scanFinishToFilterStage(img){
    SCANIMG=img;SCANORIG=img;scanRotation=0;
    document.getElementById('scan-warp-stage').classList.add('hidden');
    document.getElementById('scan-controls').classList.remove('hidden');
    applyScan();
  }

  document.getElementById('btn-scan-warp-skip').onclick=()=>{
    scanFinishToFilterStage(scanWarpOriginalImg);
  };

  document.getElementById('btn-scan-warp-apply').onclick=async()=>{
    if(!scanWarpOriginalImg)return;
    const btn=document.getElementById('btn-scan-warp-apply');const origText=btn.textContent;
    btn.disabled=true;btn.textContent='⏳ در حال صاف‌کردن...';
    await new Promise(r=>setTimeout(r,30)); // فرصت برای رندر لودینگ
    try{
      const img=scanWarpOriginalImg;
      const iw=img.naturalWidth,ih=img.naturalHeight;
      const src=['tl','tr','br','bl'].map(k=>({x:scanWarpCorners[k].x*iw,y:scanWarpCorners[k].y*ih}));
      const wTop=Math.hypot(src[1].x-src[0].x,src[1].y-src[0].y);
      const wBot=Math.hypot(src[2].x-src[3].x,src[2].y-src[3].y);
      const hLeft=Math.hypot(src[3].x-src[0].x,src[3].y-src[0].y);
      const hRight=Math.hypot(src[2].x-src[1].x,src[2].y-src[1].y);
      const outW=Math.round(Math.max(wTop,wBot));
      const outH=Math.round(Math.max(hLeft,hRight));
      const canvas=scanWarpPerspective(img,src,outW,outH);
      const flatImg=new Image();
      flatImg.onload=()=>{scanFinishToFilterStage(flatImg);btn.disabled=false;btn.textContent=origText;};
      flatImg.src=canvas.toDataURL('image/png');
    }catch(e){
      toast('خطا در صاف‌کردن سند');btn.disabled=false;btn.textContent=origText;
    }
  };

  document.getElementById('btn-rescan-warp').onclick=()=>{
    if(!scanWarpOriginalImg)return;
    openScanWarpStage(scanWarpOriginalImg);
  };

  document.getElementById('scan-out-quality').addEventListener('input',function(){document.getElementById('scan-out-quality-val').textContent=this.value+'%';});

  const FILTERS={
    original:()=>{document.getElementById('scan-bright').value=0;document.getElementById('scan-contrast').value=0;document.getElementById('scan-saturation').value=0;document.getElementById('scan-sharp').value=0;},
    color:()=>{document.getElementById('scan-bright').value=5;document.getElementById('scan-contrast').value=10;document.getElementById('scan-saturation').value=15;document.getElementById('scan-sharp').value=20;},
    gray:()=>{document.getElementById('scan-bright').value=10;document.getElementById('scan-contrast').value=20;document.getElementById('scan-saturation').value=-100;document.getElementById('scan-sharp').value=30;},
    bw:()=>{document.getElementById('scan-bright').value=30;document.getElementById('scan-contrast').value=50;document.getElementById('scan-saturation').value=-100;document.getElementById('scan-sharp').value=40;},
    document:()=>{document.getElementById('scan-bright').value=20;document.getElementById('scan-contrast').value=40;document.getElementById('scan-saturation').value=-80;document.getElementById('scan-sharp').value=50;},
    enhance:()=>{document.getElementById('scan-bright').value=10;document.getElementById('scan-contrast').value=30;document.getElementById('scan-saturation').value=10;document.getElementById('scan-sharp').value=40;},
    textoenhance:()=>{document.getElementById('scan-bright').value=15;document.getElementById('scan-contrast').value=50;document.getElementById('scan-saturation').value=-100;document.getElementById('scan-sharp').value=60;},
    removeshadow:()=>{document.getElementById('scan-bright').value=25;document.getElementById('scan-contrast').value=35;document.getElementById('scan-saturation').value=-50;document.getElementById('scan-sharp').value=30;},
    whitenbg:()=>{document.getElementById('scan-bright').value=30;document.getElementById('scan-contrast').value=45;document.getElementById('scan-saturation').value=-100;document.getElementById('scan-sharp').value=40;}
  };

  document.querySelectorAll('.filter-btn').forEach(btn=>{
    btn.onclick=()=>{document.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active'));btn.classList.add('active');if(FILTERS[btn.dataset.filter])FILTERS[btn.dataset.filter]();updateFilterValues();applyScan();};
  });

  function updateFilterValues(){
    document.getElementById('bright-val').textContent=document.getElementById('scan-bright').value;
    document.getElementById('contrast-val').textContent=document.getElementById('scan-contrast').value;
    document.getElementById('sharp-val').textContent=document.getElementById('scan-sharp').value;
    document.getElementById('saturation-val').textContent=document.getElementById('scan-saturation').value;
  }

  ['scan-bright','scan-contrast','scan-sharp','scan-saturation'].forEach(id=>{const el=document.getElementById(id);if(el)el.addEventListener('input',()=>{updateFilterValues();applyScan();});});

  function applyScan(){
    if(!SCANORIG)return;
    scanRotation=(scanRotation%4+4)%4;
    const cv=document.getElementById('scan-canvas');const ctx=cv.getContext('2d');
    const mw=1400;let w=SCANORIG.width,h=SCANORIG.height;if(w>mw){h=Math.round(h*mw/w);w=mw;}
    if(scanRotation===1||scanRotation===3){cv.width=h;cv.height=w;}else{cv.width=w;cv.height=h;}
    ctx.save();
    if(scanRotation===1)ctx.translate(cv.width,0);
    if(scanRotation===2)ctx.translate(cv.width,cv.height);
    if(scanRotation===3)ctx.translate(0,cv.height);
    ctx.rotate(scanRotation*Math.PI/2);
    ctx.drawImage(SCANORIG,0,0,w,h);
    ctx.restore();
    const cw=cv.width, ch=cv.height;
    const bright=parseInt(document.getElementById('scan-bright').value,10);
    const contrast=parseInt(document.getElementById('scan-contrast').value,10);
    const sharp=parseInt(document.getElementById('scan-sharp').value,10)/100;
    const sat=parseInt(document.getElementById('scan-saturation').value,10)/100+1;
    let im=ctx.getImageData(0,0,cw,ch);let d=im.data;
    if(sat!==1){for(let p=0;p<d.length;p+=4){const gray=0.299*d[p]+0.587*d[p+1]+0.114*d[p+2];d[p]=Math.min(255,Math.max(0,gray+sat*(d[p]-gray)));d[p+1]=Math.min(255,Math.max(0,gray+sat*(d[p+1]-gray)));d[p+2]=Math.min(255,Math.max(0,gray+sat*(d[p+2]-gray)));}ctx.putImageData(im,0,0);im=ctx.getImageData(0,0,cw,ch);d=im.data;}
    const factor=(259*(contrast+255))/(255*(259-contrast));
    for(let p=0;p<d.length;p+=4){for(let c=0;c<3;c++){let val=d[p+c];val=factor*(val-128)+128+bright;d[p+c]=Math.min(255,Math.max(0,val));}}
    ctx.putImageData(im,0,0);
    if(sharp>0){im=ctx.getImageData(0,0,cw,ch);const tmp=ctx.createImageData(cw,ch);const kernel=[0,-sharp,0,-sharp,1+4*sharp,-sharp,0,-sharp,0];for(let y=1;y<ch-1;y++){for(let x=1;x<cw-1;x++){for(let c=0;c<3;c++){let sum=0;for(let ky=-1;ky<=1;ky++){for(let kx=-1;kx<=1;kx++){const idx=((y+ky)*cw+(x+kx))*4+c;sum+=im.data[idx]*kernel[(ky+1)*3+(kx+1)];}}tmp.data[(y*cw+x)*4+c]=Math.min(255,Math.max(0,sum));}tmp.data[(y*cw+x)*4+3]=255;}}ctx.putImageData(tmp,0,0);}
  }

  document.getElementById('btn-rotate-l').onclick=()=>{if(!SCANORIG){toast('ابتدا عکس را انتخاب کنید');return;}scanRotation--;applyScan();};
  document.getElementById('btn-rotate-r').onclick=()=>{if(!SCANORIG){toast('ابتدا عکس را انتخاب کنید');return;}scanRotation++;applyScan();};

  // ===== روشن‌سازی خودکار (شبیه حالت Auto در CamScanner) =====
  // با تحلیل هیستوگرام روشنایی تصویر، بازه واقعی روشنایی را پیدا کرده و مستقیماً (بدون محدودیت اسلایدرها) آن را به بازهٔ کامل ۰ تا ۲۵۵ کش می‌دهد
  document.getElementById('btn-scan-autoenhance').onclick=()=>{
    if(!SCANORIG){toast('ابتدا عکس را انتخاب کنید');return;}
    const mw=300;
    let w=SCANORIG.width,h=SCANORIG.height;
    const scale=Math.min(1,mw/Math.max(w,h));
    const sw=Math.max(2,Math.round(w*scale)),sh=Math.max(2,Math.round(h*scale));
    const tmp=document.createElement('canvas');tmp.width=sw;tmp.height=sh;
    const tctx=tmp.getContext('2d');tctx.drawImage(SCANORIG,0,0,sw,sh);
    const data=tctx.getImageData(0,0,sw,sh).data;
    const hist=new Array(256).fill(0);
    let total=0;
    for(let i=0;i<data.length;i+=4){
      const lum=Math.round(0.299*data[i]+0.587*data[i+1]+0.114*data[i+2]);
      hist[lum]++;total++;
    }
    const lowCut=total*0.02,highCutFromTop=total*0.02;
    let cum=0,lowP=0,highP=255;
    for(let v=0;v<256;v++){cum+=hist[v];if(cum>=lowCut){lowP=v;break;}}
    cum=0;
    for(let v=255;v>=0;v--){cum+=hist[v];if(cum>=highCutFromTop){highP=v;break;}}
    if(highP-lowP<20){toast('تصویر نیازی به بهبود خودکار ندارد');return;}
    const a=255/(highP-lowP);
    const b=-a*lowP;
    // این ضرایب مستقیماً روی تصویر اصلی اعمال می‌شوند (بدون واسطهٔ اسلایدرهای روشنایی/کنتراست که ممکن است رنجشان کافی نباشد)
    const fullCanvas=document.createElement('canvas');
    fullCanvas.width=SCANORIG.width;fullCanvas.height=SCANORIG.height;
    const fctx=fullCanvas.getContext('2d');
    fctx.drawImage(SCANORIG,0,0);
    const im=fctx.getImageData(0,0,fullCanvas.width,fullCanvas.height);const d=im.data;
    for(let p=0;p<d.length;p+=4){
      d[p]=Math.min(255,Math.max(0,a*d[p]+b));
      d[p+1]=Math.min(255,Math.max(0,a*d[p+1]+b));
      d[p+2]=Math.min(255,Math.max(0,a*d[p+2]+b));
    }
    fctx.putImageData(im,0,0);
    const enhancedImg=new Image();
    enhancedImg.onload=()=>{
      SCANORIG=enhancedImg;SCANIMG=enhancedImg;
      document.getElementById('scan-bright').value=0;
      document.getElementById('scan-contrast').value=0;
      document.querySelectorAll('.filter-btn').forEach(fb=>fb.classList.remove('active'));
      updateFilterValues();
      applyScan();
      toast('روشنایی تصویر به‌صورت خودکار بهبود یافت ✅');
    };
    enhancedImg.src=fullCanvas.toDataURL('image/png');
  };

  document.getElementById('btn-reset-scan').onclick=()=>{SCANORIG=SCANIMG;scanRotation=0;document.getElementById('scan-bright').value=0;document.getElementById('scan-contrast').value=0;document.getElementById('scan-sharp').value=0;document.getElementById('scan-saturation').value=0;updateFilterValues();document.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active'));document.querySelector('.filter-btn[data-filter="original"]').classList.add('active');applyScan();};
  document.getElementById('btn-remove-scan').onclick=()=>{if(!confirm('عکس فعلی حذف شود؟'))return;SCANIMG=null;SCANORIG=null;scanWarpOriginalImg=null;scanRotation=0;scanPdfPages=[];scanPdfIndex=0;updateScanPdfNav();document.getElementById('scan-controls').classList.add('hidden');document.getElementById('scan-warp-stage').classList.add('hidden');document.getElementById('scan-drop-zone').classList.remove('hidden');document.getElementById('scan-file').value='';document.getElementById('scan-bright').value=0;document.getElementById('scan-contrast').value=0;document.getElementById('scan-sharp').value=0;document.getElementById('scan-saturation').value=0;updateFilterValues();document.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active'));document.querySelector('.filter-btn[data-filter="original"]').classList.add('active');};
  document.getElementById('btn-dl-img').onclick=()=>{if(!SCANORIG){toast('ابتدا عکس را انتخاب کنید');return;}const cv=document.getElementById('scan-canvas');const q=parseInt(document.getElementById('scan-out-quality').value,10)/100;cv.toBlob(blob=>{const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='اسکن.jpg';document.body.appendChild(a);a.click();a.remove();toast('عکس دانلود شد ✅ (حجم فایل حدود '+(blob.size/1024).toFixed(0)+' کیلوبایت)');},'image/jpeg',q);};
  document.getElementById('btn-dl-pdf').onclick=()=>{if(!SCANORIG){toast('ابتدا عکس را انتخاب کنید');return;}if(!window.jspdf){toast('کتابخانه PDF در دسترس نیست');return;}const cv=document.getElementById('scan-canvas');const outQ=(parseInt(document.getElementById('scan-out-quality')?.value,10)||90)/100;const img=cv.toDataURL('image/jpeg',outQ);const jsPDF=window.jspdf.jsPDF;const pdf=new jsPDF({orientation:cv.width>=cv.height?'l':'p',unit:'pt',format:'a4'});const pw=pdf.internal.pageSize.getWidth(),ph=pdf.internal.pageSize.getHeight();const m=24,aw=pw-2*m,ah=ph-2*m;let iw=cv.width,ih=cv.height;const ratio=Math.min(aw/iw,ah/ih);iw*=ratio;ih*=ratio;pdf.addImage(img,'JPEG',(pw-iw)/2,(ph-ih)/2,iw,ih);pdf.save('اسکن.pdf');toast('فایل PDF ساخته شد ✅');};

  // ===== کاهش حجم =====
  const resizeDropZone=document.getElementById('resize-drop-zone');
  const resizeFileInput=document.getElementById('resize-file');
  resizeDropZone.onclick=()=>resizeFileInput.click();
  resizeDropZone.addEventListener('dragover',e=>{e.preventDefault();resizeDropZone.classList.add('dragover');});
  resizeDropZone.addEventListener('dragleave',()=>resizeDropZone.classList.remove('dragover'));
  resizeDropZone.addEventListener('drop',e=>{e.preventDefault();resizeDropZone.classList.remove('dragover');handleResizeFiles(e.dataTransfer.files);});
  resizeFileInput.addEventListener('change',function(){handleResizeFiles(this.files);});

  function handleResizeFiles(files){
    Array.from(files).forEach(file=>{
      if(!file.type.startsWith('image/')){toast('فایل «'+file.name+'» عکس نیست و نادیده گرفته شد');return;}
      const rd=new FileReader();
      rd.onload=ev=>{
        const img=new Image();
        img.onload=()=>{RESIZE_IMAGES.push({file,img,original:ev.target.result});document.getElementById('resize-controls').classList.remove('hidden');renderResizePreview();};
        img.onerror=()=>{toast('فایل «'+file.name+'» قابل بازکردن نیست');};
        img.src=ev.target.result;
      };
      rd.onerror=()=>{toast('خطا در خواندن فایل «'+file.name+'»');};
      rd.readAsDataURL(file);
    });
  }

  function renderResizePreview(){
    const box=document.getElementById('resize-preview');
    if(!RESIZE_IMAGES.length){box.innerHTML='';updateTotalInfo();return;}
    box.innerHTML=RESIZE_IMAGES.map((r,i)=>{
      const origSize=(r.file.size/1024).toFixed(1);
      return '<div class="resize-item"><button class="remove-btn" onclick="removeResizeImg('+i+')">×</button><img src="'+r.original+'" alt=""><div class="size-info">'+origSize+' KB<br>'+r.img.width+'×'+r.img.height+'</div></div>';
    }).join('');
    updateTotalInfo();
  }
  window.removeResizeImg=(i)=>{RESIZE_IMAGES.splice(i,1);renderResizePreview();if(!RESIZE_IMAGES.length)document.getElementById('resize-controls').classList.add('hidden');};

  function updateTotalInfo(){
    const el=document.getElementById('total-original-size');const nel=document.getElementById('total-new-size');const rel=document.getElementById('total-reduction');
    if(!el||!nel||!rel)return;
    if(!RESIZE_IMAGES.length){el.textContent='-';nel.textContent='-';rel.textContent='-';return;}
    const totalOrig=RESIZE_IMAGES.reduce((s,r)=>s+r.file.size,0);
    el.textContent=(totalOrig/1024/1024).toFixed(2)+' MB';
    const q=parseInt(document.getElementById('resize-quality').value,10)/100;
    const fmt=document.querySelector('.format-btn.active')?.dataset.format||'jpeg';
    let estNew=totalOrig*q*0.7;
    nel.textContent=(estNew/1024/1024).toFixed(2)+' MB';
    const reduction=Math.round((1-estNew/totalOrig)*100);
    rel.textContent=reduction+'٪ کاهش';
  }

  document.getElementById('resize-quality').addEventListener('input',function(){
    const q=parseInt(this.value,10);
    document.getElementById('quality-percent').textContent=q+'%';
    const avgSize=RESIZE_IMAGES.length?RESIZE_IMAGES.reduce((s,r)=>s+r.file.size,0)/RESIZE_IMAGES.length:500000;
    const est=Math.round(avgSize*(q/100));
    document.getElementById('quality-estimate').textContent='حدود '+(est/1024).toFixed(0)+' KB';
    updateTotalInfo();
  });

  document.querySelectorAll('.format-btn').forEach(btn=>{btn.onclick=()=>{document.querySelectorAll('.format-btn').forEach(b=>b.classList.remove('active'));btn.classList.add('active');updateTotalInfo();};});
  document.querySelectorAll('input[name="resize-size"]').forEach(radio=>{radio.addEventListener('change',updateTotalInfo);});

  function computeResizedBlob(r,fmt,mime,q,sizeOpt){
    return new Promise((resolve)=>{
      let w=r.img.width,h=r.img.height;
      if(sizeOpt!=='original'){const maxSize=parseInt(sizeOpt);if(w>maxSize||h>maxSize){const ratio=Math.min(maxSize/w,maxSize/h);w=Math.round(w*ratio);h=Math.round(h*ratio);}}
      const cv=document.createElement('canvas');cv.width=w;cv.height=h;const ctx=cv.getContext('2d');ctx.drawImage(r.img,0,0,w,h);
      cv.toBlob(blob=>resolve({blob,w,h}),mime,q);
    });
  }
  function getResizeSettings(){
    const q=parseInt(document.getElementById('resize-quality').value,10)/100;
    const fmt=document.querySelector('.format-btn.active').dataset.format;
    const sizeOpt=document.querySelector('input[name="resize-size"]:checked').value;
    const mime=fmt==='png'?'image/png':fmt==='webp'?'image/webp':'image/jpeg';
    const ext=fmt==='png'?'png':fmt==='webp'?'webp':'jpg';
    return {q,fmt,sizeOpt,mime,ext};
  }

  document.getElementById('btn-resize-all').onclick=async()=>{
    if(!RESIZE_IMAGES.length){toast('ابتدا عکس انتخاب کنید');return;}
    const {q,mime,ext,sizeOpt}=getResizeSettings();
    let failCount=0;
    for(let i=0;i<RESIZE_IMAGES.length;i++){
      const {blob,w,h}=await computeResizedBlob(RESIZE_IMAGES[i],null,mime,q,sizeOpt);
      if(!blob){failCount++;continue;}
      const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='عکس_'+(i+1)+'_'+w+'x'+h+'.'+ext;document.body.appendChild(a);a.click();a.remove();
    }
    toast(failCount?('برخی عکس‌ها ('+failCount+') با خطا مواجه شدند'):'عکس‌ها با موفقیت فشرده شدند ✅');
  };

  document.getElementById('btn-resize-zip').onclick=async()=>{
    if(!RESIZE_IMAGES.length){toast('ابتدا عکس انتخاب کنید');return;}
    if(!window.JSZip){toast('کتابخانه ZIP در دسترس نیست');return;}
    const btn=document.getElementById('btn-resize-zip');btn.disabled=true;const origText=btn.textContent;btn.textContent='⏳ در حال ساخت ZIP...';
    try{
      const {q,mime,ext,sizeOpt}=getResizeSettings();
      const zip=new JSZip();
      let failCount=0;
      for(let i=0;i<RESIZE_IMAGES.length;i++){
        const {blob,w,h}=await computeResizedBlob(RESIZE_IMAGES[i],null,mime,q,sizeOpt);
        if(!blob){failCount++;continue;}
        zip.file('عکس_'+(i+1)+'_'+w+'x'+h+'.'+ext, blob);
      }
      const zipBlob=await zip.generateAsync({type:'blob'});
      const a=document.createElement('a');a.href=URL.createObjectURL(zipBlob);a.download='عکس‌های_فشرده.zip';document.body.appendChild(a);a.click();a.remove();
      toast(failCount?('ZIP ساخته شد (برخی عکس‌ها با خطا مواجه شدند)'):'فایل ZIP دانلود شد ✅');
    }catch(e){
      toast('خطا در ساخت فایل ZIP');
    }finally{
      btn.disabled=false;btn.textContent=origText;
    }
  };

  document.getElementById('btn-clear-resize').onclick=()=>{RESIZE_IMAGES=[];renderResizePreview();document.getElementById('resize-controls').classList.add('hidden');};

  // ===== Crop (اصلاح‌شده با پشتیبانی از لمس برای گوشی) =====
  let cropImg = null,
    cropFileName = '',
    cropState = {
      x: 0,
      y: 0,
      w: 0,
      h: 0,
      ratio: 'free',
      dragging: false,
      resizing: false,
      handle: '',
      startX: 0,
      startY: 0
    };

  const cropDropZone = document.getElementById('crop-drop-zone');
  const cropFileInput = document.getElementById('crop-file');
  const cropControls = document.getElementById('crop-controls');

  cropDropZone.addEventListener('click', () => cropFileInput.click());
  cropDropZone.addEventListener('dragover', e => { e.preventDefault();
    cropDropZone.style.borderColor = 'var(--primary)'; });
  cropDropZone.addEventListener('dragleave', () => { cropDropZone.style.borderColor = ''; });
  cropDropZone.addEventListener('drop', e => {
    e.preventDefault();
    cropDropZone.style.borderColor = '';
    if (e.dataTransfer.files[0]) loadCropImg(e.dataTransfer.files[0]);
  });
  cropFileInput.addEventListener('change', function() {
    if (this.files[0]) loadCropImg(this.files[0]);
  });

  function loadCropImg(file) {
    if (!file.type.startsWith('image/')) { toast('فقط عکس مجاز است'); return; }
    cropFileName = file.name;
    const rd = new FileReader();
    rd.onload = ev => {
      const img = document.getElementById('crop-img');
      img.onload = () => {
        // نمایش عکس با نسبت واقعی - محدودیت عرض و ارتفاع هر دو با هم در نظر گرفته می‌شوند
        // (قبلاً فقط عرض محدود می‌شد و CSS جداگانه ارتفاع را می‌بُرید، همین باعث کشیده‌شدن عکس می‌شد)
        const maxWidth = window.innerWidth - 80;
        const maxHeight = window.innerHeight * 0.5;
        let displayWidth = img.naturalWidth;
        let displayHeight = img.naturalHeight;
        const scale = Math.min(1, maxWidth / displayWidth, maxHeight / displayHeight);
        displayWidth = Math.round(displayWidth * scale);
        displayHeight = Math.round(displayHeight * scale);
        
        img.style.width = displayWidth + 'px';
        img.style.height = displayHeight + 'px';
        const wrapper = document.getElementById('crop-wrapper');
        wrapper.style.width = displayWidth + 'px';
        wrapper.style.height = displayHeight + 'px';
        cropImg = { el: img, natW: img.naturalWidth, natH: img.naturalHeight };
        initCropBox();
        cropControls.classList.remove('hidden');
        cropDropZone.classList.add('hidden');
      };
      img.onerror = () => { toast('فایل عکس معتبر نیست'); };
      img.src = ev.target.result;
    };
    rd.onerror = () => { toast('خطا در خواندن فایل'); };
    rd.readAsDataURL(file);
  }

  function initCropBox() {
    const img = document.getElementById('crop-img');
    const w = parseFloat(img.style.width);
    const h = parseFloat(img.style.height);
    const box = document.getElementById('crop-box');
    cropState.x = 0;
    cropState.y = 0;
    cropState.w = w;
    cropState.h = h;
    cropState.ratio = 'free';
    box.style.left = cropState.x + 'px';
    box.style.top = cropState.y + 'px';
    box.style.width = cropState.w + 'px';
    box.style.height = cropState.h + 'px';
    const ratioBtns = document.querySelectorAll('.ratio-btn');
    if (ratioBtns.length) {
      ratioBtns.forEach(b => b.classList.remove('active'));
      document.querySelector('.ratio-btn[data-ratio="free"]').classList.add('active');
    }
  }

  document.getElementById('btn-crop-delete').onclick = () => {
    cropImg = null;
    cropFileName = '';
    cropControls.classList.add('hidden');
    cropDropZone.classList.remove('hidden');
    document.getElementById('crop-img').src = '';
  };
  document.getElementById('btn-crop-reset').onclick = () => initCropBox();

  function applyRatio() {
    if (cropState.ratio === 'free') return;
    const wrapper = document.getElementById('crop-wrapper');
    const maxW = parseFloat(wrapper.style.width), maxH = parseFloat(wrapper.style.height);
    const parts = cropState.ratio.split(':').map(Number);
    const ratio = parts[0] / parts[1];
    // مرکز باکس فعلی را حفظ کن، فقط اندازه را با نسبت جدید تنظیم کن
    const cx = cropState.x + cropState.w / 2, cy = cropState.y + cropState.h / 2;
    let newW = cropState.w, newH = newW / ratio;
    if (newH > maxH) { newH = maxH; newW = newH * ratio; }
    if (newW > maxW) { newW = maxW; newH = newW / ratio; }
    cropState.w = newW; cropState.h = newH;
    cropState.x = Math.max(0, Math.min(maxW - newW, cx - newW / 2));
    cropState.y = Math.max(0, Math.min(maxH - newH, cy - newH / 2));
    updateCropBox();
  }

  document.querySelectorAll('.ratio-btn').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.ratio-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      cropState.ratio = btn.dataset.ratio;
      applyRatio();
    };
  });

  function updateCropBox() {
    const box = document.getElementById('crop-box');
    box.style.left = cropState.x + 'px';
    box.style.top = cropState.y + 'px';
    box.style.width = cropState.w + 'px';
    box.style.height = cropState.h + 'px';
  }

  document.getElementById('btn-crop-download').onclick = () => {
    if (!cropImg) { toast('عکسی انتخاب نشده'); return; }
    const img = cropImg.el;
    const sx = cropState.x * (img.naturalWidth / parseFloat(img.style.width));
    const sy = cropState.y * (img.naturalHeight / parseFloat(img.style.height));
    const sw = cropState.w * (img.naturalWidth / parseFloat(img.style.width));
    const sh = cropState.h * (img.naturalHeight / parseFloat(img.style.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(sw);
    canvas.height = Math.round(sh);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(blob => {
      if (!blob) { toast('خطا در ساخت فایل عکس'); return; }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = cropFileName.replace(/\.[^.]+$/, '_cropped.png');
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast('عکس برش‌خورده دانلود شد ✅');
    }, 'image/png', 1.0);
  };

  // ===== رویدادهای موس (برای کامپیوتر) =====
  const cropBox = document.getElementById('crop-box');

  function getCropPos(e) {
    const rect = cropBox.getBoundingClientRect();
    const wrapperRect = document.getElementById('crop-wrapper').getBoundingClientRect();
    return {
      clientX: e.clientX,
      clientY: e.clientY,
      offsetX: e.clientX - wrapperRect.left,
      offsetY: e.clientY - wrapperRect.top
    };
  }

  function startCropDrag(e) {
    e.preventDefault();
    const pos = getCropPos(e);
    
    if (e.target.classList.contains('crop-handle')) {
      cropState.resizing = true;
      cropState.handle = e.target.className.replace('crop-handle crop-', '');
    } else {
      cropState.dragging = true;
    }
    cropState.startX = pos.offsetX;
    cropState.startY = pos.offsetY;
  }

  // محاسبه‌ی تغییر اندازه با رعایت مرزهای تصویر (رفع اشکال قبلی: دسته‌های شمال/غرب می‌توانستند از تصویر بیرون بزنند)
  function resizeCropBox(rh, dx, dy, w, h) {
    if (rh.includes('e')) cropState.w = Math.max(50, Math.min(w - cropState.x, cropState.w + dx));
    if (rh.includes('w')) {
      let newX = Math.max(0, cropState.x + dx);
      let newW = cropState.w + (cropState.x - newX);
      if (newW < 50) { newW = 50; newX = cropState.x + cropState.w - 50; }
      cropState.x = newX; cropState.w = newW;
    }
    if (rh.includes('s')) cropState.h = Math.max(50, Math.min(h - cropState.y, cropState.h + dy));
    if (rh.includes('n')) {
      let newY = Math.max(0, cropState.y + dy);
      let newH = cropState.h + (cropState.y - newY);
      if (newH < 50) { newH = 50; newY = cropState.y + cropState.h - 50; }
      cropState.y = newY; cropState.h = newH;
    }
  }

  function moveCropDrag(e) {
    if (!cropState.dragging && !cropState.resizing) return;
    e.preventDefault();
    
    const pos = getCropPos(e);
    const dx = pos.offsetX - cropState.startX;
    const dy = pos.offsetY - cropState.startY;
    cropState.startX = pos.offsetX;
    cropState.startY = pos.offsetY;
    
    const wrapper = document.getElementById('crop-wrapper');
    const w = parseFloat(wrapper.style.width);
    const h = parseFloat(wrapper.style.height);
    
    if (cropState.dragging) {
      cropState.x = Math.max(0, Math.min(w - cropState.w, cropState.x + dx));
      cropState.y = Math.max(0, Math.min(h - cropState.h, cropState.y + dy));
    } else if (cropState.resizing) {
      resizeCropBox(cropState.handle, dx, dy, w, h);
    }
    updateCropBox();
  }

  function endCropDrag(e) {
    if (cropState.resizing && cropState.ratio !== 'free') applyRatio();
    cropState.dragging = false;
    cropState.resizing = false;
  }

  // رویدادهای موس (کامپیوتر)
  cropBox.addEventListener('mousedown', startCropDrag);
  document.addEventListener('mousemove', moveCropDrag);
  document.addEventListener('mouseup', endCropDrag);

  // ===== رویدادهای لمسی (گوشی) =====
  function getTouchPos(e) {
    const touch = e.touches[0];
    const rect = document.getElementById('crop-wrapper').getBoundingClientRect();
    return {
      clientX: touch.clientX,
      clientY: touch.clientY,
      offsetX: touch.clientX - rect.left,
      offsetY: touch.clientY - rect.top
    };
  }

  function startTouchDrag(e) {
    e.preventDefault();
    const pos = getTouchPos(e);
    
    // بررسی اینکه آیا روی دسته برش کلیک شده
    const touch = e.touches[0];
    const target = document.elementFromPoint(touch.clientX, touch.clientY);
    
    if (target && target.classList.contains('crop-handle')) {
      cropState.resizing = true;
      cropState.handle = target.className.replace('crop-handle crop-', '');
    } else {
      cropState.dragging = true;
    }
    cropState.startX = pos.offsetX;
    cropState.startY = pos.offsetY;
  }

  function moveTouchDrag(e) {
    if (!cropState.dragging && !cropState.resizing) return;
    e.preventDefault();
    
    const pos = getTouchPos(e);
    const dx = pos.offsetX - cropState.startX;
    const dy = pos.offsetY - cropState.startY;
    cropState.startX = pos.offsetX;
    cropState.startY = pos.offsetY;
    
    const wrapper = document.getElementById('crop-wrapper');
    const w = parseFloat(wrapper.style.width);
    const h = parseFloat(wrapper.style.height);
    
    if (cropState.dragging) {
      cropState.x = Math.max(0, Math.min(w - cropState.w, cropState.x + dx));
      cropState.y = Math.max(0, Math.min(h - cropState.h, cropState.y + dy));
    } else if (cropState.resizing) {
      resizeCropBox(cropState.handle, dx, dy, w, h);
    }
    updateCropBox();
  }

  function endTouchDrag(e) {
    if (cropState.resizing && cropState.ratio !== 'free') applyRatio();
    cropState.dragging = false;
    cropState.resizing = false;
  }

  // رویدادهای لمسی (گوشی) با passive: false برای جلوگیری از اسکرول
  cropBox.addEventListener('touchstart', startTouchDrag, { passive: false });
  document.addEventListener('touchmove', moveTouchDrag, { passive: false });
  document.addEventListener('touchend', endTouchDrag);

  // ===== PDF به عکس =====
  let pdfDoc=null,pdfFileName='',pdfRenderedPages=[];
  const pdfDropZone=document.getElementById('pdf-drop-zone');const pdfFileInput=document.getElementById('pdf-file');
  pdfDropZone.onclick=()=>pdfFileInput.click();
  pdfDropZone.addEventListener('dragover',e=>{e.preventDefault();pdfDropZone.style.borderColor='#667eea';});
  pdfDropZone.addEventListener('dragleave',()=>{pdfDropZone.style.borderColor='#ccc';});
  pdfDropZone.addEventListener('drop',e=>{e.preventDefault();pdfDropZone.style.borderColor='#ccc';if(e.dataTransfer.files[0])loadPdfFile(e.dataTransfer.files[0]);});
  pdfFileInput.addEventListener('change',e=>{if(e.target.files[0])loadPdfFile(e.target.files[0]);});

  async function loadPdfFile(file){if(file.type!=='application/pdf'){toast('فقط فایل PDF مجاز است');return;}pdfFileName=file.name;const arrayBuffer=await file.arrayBuffer();pdfDoc=await pdfjsLib.getDocument({data:arrayBuffer}).promise;document.getElementById('pdf-name').textContent=file.name;document.getElementById('pdf-pages-count').textContent=pdfDoc.numPages;document.getElementById('pdf-controls').classList.remove('hidden');document.getElementById('pdf-preview').innerHTML='';pdfRenderedPages=[];renderPdfPage(1);}

  async function renderPdfPage(pageNum){if(!pdfDoc)return;const page=await pdfDoc.getPage(pageNum);const dpi=parseInt(document.querySelector('.pdf-dpi-btn.active')?.dataset.dpi)||150;const scale=dpi/72;const viewport=page.getViewport({scale,rotation:pdfRotation});const canvas=document.createElement('canvas');canvas.width=viewport.width;canvas.height=viewport.height;const ctx=canvas.getContext('2d');await page.render({canvasContext:ctx,viewport}).promise;const format=document.querySelector('.pdf-format-btn.active')?.dataset.format||'png';const dataUrl=canvas.toDataURL('image/'+format,format==='jpeg'?parseInt(document.getElementById('jpeg-quality')?.value||85)/100:undefined);const previewDiv=document.getElementById('pdf-preview');const pageDiv=document.createElement('div');pageDiv.className='pdf-page-preview';pageDiv.style.cssText='display:inline-block;margin:8px;text-align:center;background:#fff;border:1px solid #ddd;border-radius:8px;padding:8px;box-shadow:0 2px 8px rgba(0,0,0,0.1)';pageDiv.innerHTML='<div style="font-weight:bold;margin-bottom:8px">صفحه '+pageNum+'</div><img src="'+dataUrl+'" style="max-width:200px;max-height:280px;border:1px solid #eee"><div style="margin-top:8px"><button class="btn sm primary" onclick="downloadPdfPage('+pageNum+')">📥 دانلود</button></div>';previewDiv.appendChild(pageDiv);pdfRenderedPages.push({pageNum,canvas,dataUrl});return canvas;}
  window.downloadPdfPage=function(pageNum){const rp=pdfRenderedPages.find(p=>p.pageNum===pageNum);if(!rp){toast('صفحه رندر نشده');return;}const format=document.querySelector('.pdf-format-btn.active')?.dataset.format||'png';const ext=format==='jpeg'?'jpg':format;const a=document.createElement('a');a.href=rp.dataUrl;a.download=pdfFileName.replace('.pdf','_page_'+pageNum+'.'+ext);document.body.appendChild(a);a.click();a.remove();toast('صفحه '+pageNum+' دانلود شد ✅');};
  document.getElementById('pdf-remove').onclick=()=>{pdfDoc=null;pdfFileName='';pdfRenderedPages=[];pdfRotation=0;updatePdfRotateDisplay();document.getElementById('pdf-controls').classList.add('hidden');document.getElementById('pdf-preview').innerHTML='';};
  document.querySelectorAll('.pdf-select-btn').forEach(btn=>{btn.onclick=()=>{document.querySelectorAll('.pdf-select-btn').forEach(b=>b.classList.remove('active'));btn.classList.add('active');const type=btn.dataset.pages;document.getElementById('pdf-range').classList.toggle('hidden',type!=='range');};});
  document.querySelectorAll('.pdf-dpi-btn').forEach(btn=>{btn.onclick=()=>{document.querySelectorAll('.pdf-dpi-btn').forEach(b=>b.classList.remove('active'));btn.classList.add('active');};});
  let pdfRotation=0;
  function updatePdfRotateDisplay(){const fa=['۰','۹۰','۱۸۰','۲۷۰'][(pdfRotation/90+4)%4];document.getElementById('pdf-rotate-val').textContent=fa;}
  document.getElementById('btn-pdf-rotate-l').onclick=()=>{pdfRotation=(pdfRotation-90+360)%360;updatePdfRotateDisplay();toast('برای اعمال چرخش، دوباره «رندر همه صفحات» را بزنید');};
  document.getElementById('btn-pdf-rotate-r').onclick=()=>{pdfRotation=(pdfRotation+90)%360;updatePdfRotateDisplay();toast('برای اعمال چرخش، دوباره «رندر همه صفحات» را بزنید');};
  document.querySelectorAll('.pdf-format-btn').forEach(btn=>{btn.onclick=()=>{document.querySelectorAll('.pdf-format-btn').forEach(b=>b.classList.remove('active'));btn.classList.add('active');const format=btn.dataset.format;document.getElementById('jpeg-quality-group').classList.toggle('hidden',format!=='jpeg');};});
  document.getElementById('jpeg-quality').oninput=function(){document.getElementById('jpeg-quality-val').textContent=this.value+'%';};
  
  document.getElementById('btn-pdf-render-all').onclick=async()=>{if(!pdfDoc){toast('فایل PDF انتخاب نشده');return;}document.getElementById('pdf-preview').innerHTML='';pdfRenderedPages=[];const selectType=document.querySelector('.pdf-select-btn.active')?.dataset.pages||'all';let pagesToRender=[];if(selectType==='all'){for(let i=1;i<=pdfDoc.numPages;i++)pagesToRender.push(i);}else if(selectType==='odd'){for(let i=1;i<=pdfDoc.numPages;i+=2)pagesToRender.push(i);}else if(selectType==='even'){for(let i=2;i<=pdfDoc.numPages;i+=2)pagesToRender.push(i);}else if(selectType==='range'){const rangeStr=document.getElementById('pdf-range').value;const parts=rangeStr.split(',');parts.forEach(p=>{if(p.includes('-')){const [s,e]=p.split('-').map(x=>parseInt(x.trim()));for(let i=s;i<=e;i++)if(i>=1&&i<=pdfDoc.numPages)pagesToRender.push(i);}else{const n=parseInt(p.trim());if(n>=1&&n<=pdfDoc.numPages)pagesToRender.push(n);}});}pagesToRender=[...new Set(pagesToRender)].sort((a,b)=>a-b);toast('در حال رندر '+pagesToRender.length+' صفحه...');for(const pn of pagesToRender){await renderPdfPage(pn);}toast('رندر تمام صفحات انجام شد ✅');};
  document.getElementById('btn-pdf-clear-previews').onclick=()=>{document.getElementById('pdf-preview').innerHTML='';pdfRenderedPages=[];};
  document.getElementById('btn-pdf-download-zip').onclick=async()=>{
    if(pdfRenderedPages.length===0){toast('ابتدا صفحات را رندر کنید');return;}
    if(!window.JSZip){toast('کتابخانه ZIP در دسترس نیست');return;}
    const btn=document.getElementById('btn-pdf-download-zip');btn.disabled=true;const origText=btn.textContent;btn.textContent='⏳ در حال ساخت ZIP...';
    try{
      const format=document.querySelector('.pdf-format-btn.active')?.dataset.format||'png';
      const ext=format==='jpeg'?'jpg':format;
      const mimeType='image/'+format;
      const zip=new JSZip();
      pdfRenderedPages.forEach(rp=>{
        const dataUrl=rp.canvas.toDataURL(mimeType,format==='jpeg'?parseInt(document.getElementById('jpeg-quality')?.value||85)/100:undefined);
        const base64=dataUrl.split(',')[1];
        zip.file(pdfFileName.replace(/\.pdf$/i,'')+'_page_'+rp.pageNum+'.'+ext, base64, {base64:true});
      });
      const blob=await zip.generateAsync({type:'blob'});
      const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=pdfFileName.replace(/\.pdf$/i,'')+'_pages.zip';document.body.appendChild(a);a.click();a.remove();
      toast('فایل ZIP شامل '+pdfRenderedPages.length+' صفحه دانلود شد ✅');
    }catch(e){
      toast('خطا در ساخت فایل ZIP');
    }finally{
      btn.disabled=false;btn.textContent=origText;
    }
  };

  // ===== PDF به Word (متن قابل ویرایش) =====
  let pdf2wordDoc=null,pdf2wordFileName='',pdf2wordBlob=null;
  const pdf2wordDropZone=document.getElementById('pdf2word-drop-zone');const pdf2wordFileInput=document.getElementById('pdf2word-file');
  pdf2wordDropZone.onclick=()=>pdf2wordFileInput.click();
  pdf2wordDropZone.addEventListener('dragover',e=>{e.preventDefault();pdf2wordDropZone.style.borderColor='#667eea';});
  pdf2wordDropZone.addEventListener('dragleave',()=>{pdf2wordDropZone.style.borderColor='#ccc';});
  pdf2wordDropZone.addEventListener('drop',e=>{e.preventDefault();pdf2wordDropZone.style.borderColor='#ccc';if(e.dataTransfer.files[0])loadPdf2WordFile(e.dataTransfer.files[0]);});
  pdf2wordFileInput.addEventListener('change',e=>{if(e.target.files[0])loadPdf2WordFile(e.target.files[0]);});

  async function loadPdf2WordFile(file){
    if(file.type!=='application/pdf'){toast('فقط فایل PDF مجاز است');return;}
    pdf2wordFileName=file.name;pdf2wordBlob=null;
    const arrayBuffer=await file.arrayBuffer();
    pdf2wordDoc=await pdfjsLib.getDocument({data:arrayBuffer}).promise;
    document.getElementById('pdf2word-name').textContent=file.name;
    document.getElementById('pdf2word-pages-count').textContent=pdf2wordDoc.numPages;
    document.getElementById('pdf2word-controls').classList.remove('hidden');
    document.getElementById('pdf2word-status').textContent='';
    document.getElementById('btn-pdf2word-download').classList.add('hidden');
  }

  document.getElementById('pdf2word-remove').onclick=()=>{
    pdf2wordDoc=null;pdf2wordFileName='';pdf2wordBlob=null;
    document.getElementById('pdf2word-controls').classList.add('hidden');
    document.getElementById('pdf2word-status').textContent='';
  };

  // استخراج متن هر صفحه بر اساس موقعیت واقعی روی صفحه + تشخیص خطوط واقعی جدول (رسم‌شده در PDF)
  // این روش دقیق‌تر از حدس‌زدن بر اساس فاصلهٔ متن‌هاست، چون از خود مرزهای جدول در فایل PDF استفاده می‌کند
  function pdf2wordCleanStr(s){return s.replace(/[\uE000-\uF8FF]/g,'');} // حذف کاراکترهای ناحیهٔ اختصاصی فونت (نامرئی/بی‌معنی)

  // ===== تشخیص و ترمیم PDFهایی با فونت فارسیِ خراب (نگاشت غلط ToUnicode) =====
  // برخی نرم‌افزارها (مثل سامانه‌های آموزشی قدیمی که فونت‌هایی مثل «Wyekan» را جاسازی می‌کنند) متن را طوری در PDF
  // ذخیره می‌کنند که ظاهر آن روی صفحه درست است، اما استخراج متن (کد کاراکترها) به‌هم‌ریخته و غیرقابل‌استفاده است،
  // چون این کاراکترها به بازه‌های یونیکد نامرتبط (Variation Selector, Combining Half Mark, Small Form Variant, ...)
  // نگاشت شده‌اند نه به حروف واقعی فارسی/عربی. برای این حالت، به‌جای تکیه بر متن استخراج‌شده، همان بخش از تصویر
  // صفحه با OCR (تشخیص نوری کاراکتر) خوانده می‌شود که همیشه درست است چون شکل ظاهری حروف سالم است.
  // به‌جای فهرست کردن بازه‌های «خراب» (که ممکن است ناقص باشد)، بازه‌های «سالمِ» مورد انتظار برای متن فارسی/عربی و
  // انگلیسی/اعداد را مشخص می‌کنیم؛ هر کاراکتری بیرون از این بازه‌ها تقریباً همیشه نشانهٔ نگاشت خراب فونت است
  const OK_RANGES=[[0x00,0x7F],[0x0600,0x06FF],[0x0750,0x077F],[0x08A0,0x08FF],[0xFB50,0xFDFF],[0xFE70,0xFEFF]];
  function hasBrokenGlyphs(str){
    for(let i=0;i<str.length;i++){
      const cp=str.codePointAt(i);
      if(cp>0xFFFF)i++; // کاراکترهای بیرون از BMP را رد کن (نادر و بی‌ربط به این مشکل)
      let ok=false;
      for(const[lo,hi]of OK_RANGES){if(cp>=lo&&cp<=hi){ok=true;break;}}
      if(!ok)return true;
    }
    return false;
  }
  let _ocrWorkerPromise=null;
  async function getOcrWorker(){
    if(!_ocrWorkerPromise){
      _ocrWorkerPromise=(async()=>{
        if(typeof Tesseract==='undefined')throw new Error('Tesseract not loaded');
        const worker=await Tesseract.createWorker('fas');
        // حالت پیش‌فرض Tesseract («تحلیل کامل صفحه») برای تکه‌های کوچک بریده‌شده (یک نام یا یک عدد) خوب کار نمی‌کند
        // و اغلب خروجی خالی می‌دهد؛ حالت «یک خط تکی» برای این کاربرد مناسب‌تر است
        await worker.setParameters({tessedit_pageseg_mode:'7'});
        return worker;
      })().catch(err=>{_ocrWorkerPromise=null;throw err;});
    }
    return _ocrWorkerPromise;
  }
  let ocrFixCount=0,ocrFailCount=0;
  // رندر کل صفحه با کیفیت بالا روی یک کنواس مخفی، فقط وقتی لازم باشد (یعنی متنِ خراب پیدا شده باشد)
  async function renderPageForOcr(page){
    const scale=4;
    const viewport=page.getViewport({scale});
    const canvas=document.createElement('canvas');
    canvas.width=Math.ceil(viewport.width);
    canvas.height=Math.ceil(viewport.height);
    const ctx=canvas.getContext('2d');
    await page.render({canvasContext:ctx,viewport}).promise;
    return{canvas,viewport};
  }
  // خواندن متن یک مستطیل مشخص از صفحه (در مختصات PDF) با OCR
  async function ocrRect(ocrCtx,xL,xR,yTop,yBot){
    if(!ocrCtx)return '';
    const{canvas,viewport}=ocrCtx;
    const p1=viewport.convertToViewportPoint(xL,yTop);
    const p2=viewport.convertToViewportPoint(xR,yBot);
    const pad=8;
    let x=Math.min(p1[0],p2[0])-pad,y=Math.min(p1[1],p2[1])-pad;
    let w=Math.abs(p2[0]-p1[0])+pad*2,h=Math.abs(p2[1]-p1[1])+pad*2;
    x=Math.max(0,x);y=Math.max(0,y);
    w=Math.min(canvas.width-x,w);h=Math.min(canvas.height-y,h);
    if(w<6||h<6)return '';
    const crop=document.createElement('canvas');
    crop.width=w;crop.height=h;
    crop.getContext('2d').drawImage(canvas,x,y,w,h,0,0,w,h);
    try{
      const worker=await getOcrWorker();
      let{data}=await worker.recognize(crop);
      let text=(data.text||'').replace(/\s+/g,' ').trim();
      if(!text){
        // اگر «یک خط» چیزی پیدا نکرد، شاید تکه فقط یک کلمهٔ تکی یا عدد کوتاه باشد
        await worker.setParameters({tessedit_pageseg_mode:'8'});
        ({data}=await worker.recognize(crop));
        text=(data.text||'').replace(/\s+/g,' ').trim();
        await worker.setParameters({tessedit_pageseg_mode:'7'});
      }
      if(text)ocrFixCount++;else ocrFailCount++;
      return text;
    }catch(err){ocrFailCount++;return '';}
  }
  // محدودهٔ x/y یک مجموعه آیتم متنی (برای برش تصویر جهت OCR)
  function itemsBBox(itemList){
    let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
    itemList.forEach(it=>{
      const fontSize=Math.abs(it.transform[3])||Math.abs(it.transform[0])||10;
      const x0=it.transform[4],x1=it.transform[4]+(it.width||fontSize);
      const y0=it.transform[5]-fontSize*0.3,y1=it.transform[5]+fontSize*0.85;
      if(x0<minX)minX=x0;if(x1>maxX)maxX=x1;if(y0<minY)minY=y0;if(y1>maxY)maxY=y1;
    });
    return{xL:minX,xR:maxX,yBot:minY,yTop:maxY};
  }

  function pdf2wordClusterValues(vals,tol){
    const sorted=[...vals].sort((a,b)=>a-b);
    const clusters=[];
    sorted.forEach(v=>{
      if(clusters.length && v-clusters[clusters.length-1].vals[clusters[clusters.length-1].vals.length-1]<=tol){
        clusters[clusters.length-1].vals.push(v);
      }else{clusters.push({vals:[v]});}
    });
    return clusters.map(c=>c.vals.reduce((a,b)=>a+b,0)/c.vals.length);
  }

  // خطوط افقی/عمودی واقعی رسم‌شده در صفحه (مرزهای جدول) را با خواندن دستورهای گرافیکی PDF پیدا می‌کند
  async function pdf2wordExtractGridLines(page){
    const OPS=pdfjsLib.OPS;
    const opList=await page.getOperatorList();
    let curMatrix=[1,0,0,1,0,0];
    const matStack=[];
    const applyM=(m,p)=>[m[0]*p[0]+m[2]*p[1]+m[4], m[1]*p[0]+m[3]*p[1]+m[5]];
    const hLines=[],vLines=[];
    for(let i=0;i<opList.fnArray.length;i++){
      const fn=opList.fnArray[i],args=opList.argsArray[i];
      if(fn===OPS.save){matStack.push(curMatrix);}
      else if(fn===OPS.restore){curMatrix=matStack.pop()||curMatrix;}
      else if(fn===OPS.transform){
        const[a,b,c,d,e,f]=args,m=curMatrix;
        curMatrix=[a*m[0]+b*m[2],a*m[1]+b*m[3],c*m[0]+d*m[2],c*m[1]+d*m[3],e*m[0]+f*m[2]+m[4],e*m[1]+f*m[3]+m[5]];
      }else if(fn===OPS.constructPath){
        const[subOps,subArgs]=args;let ai=0,cx=0,cy=0,sx=0,sy=0;
        for(const op of subOps){
          if(op===OPS.moveTo){cx=subArgs[ai++];cy=subArgs[ai++];sx=cx;sy=cy;}
          else if(op===OPS.lineTo){
            const nx=subArgs[ai++],ny=subArgs[ai++];
            const p1=applyM(curMatrix,[cx,cy]),p2=applyM(curMatrix,[nx,ny]);
            const dx=Math.abs(p2[0]-p1[0]),dy=Math.abs(p2[1]-p1[1]);
            // آستانهٔ طول بزرگ‌تر: خطوط کوچک (دور چک‌باکس گزینه‌ها، خط‌چین جای خالی) نباید به‌عنوان مرز جدول در کل عرض صفحه در نظر گرفته شوند
            if(dy<0.5&&dx>28)hLines.push({x1:Math.min(p1[0],p2[0]),x2:Math.max(p1[0],p2[0]),y:(p1[1]+p2[1])/2});
            else if(dx<0.5&&dy>18)vLines.push({y1:Math.min(p1[1],p2[1]),y2:Math.max(p1[1],p2[1]),x:(p1[0]+p2[0])/2});
            cx=nx;cy=ny;
          }else if(op===OPS.curveTo){ai+=6;cx=subArgs[ai-2];cy=subArgs[ai-1];}
          else if(op===OPS.closePath){cx=sx;cy=sy;}
          else if(op===OPS.rectangle){
            const rx=subArgs[ai++],ry=subArgs[ai++],rw=subArgs[ai++],rh=subArgs[ai++];
            const p1=applyM(curMatrix,[rx,ry]),p2=applyM(curMatrix,[rx+rw,ry+rh]);
            const w=Math.abs(p2[0]-p1[0]),h=Math.abs(p2[1]-p1[1]);
            if(h<2&&w>28)hLines.push({x1:Math.min(p1[0],p2[0]),x2:Math.max(p1[0],p2[0]),y:(p1[1]+p2[1])/2});
            else if(w<2&&h>18)vLines.push({y1:Math.min(p1[1],p2[1]),y2:Math.max(p1[1],p2[1]),x:(p1[0]+p2[0])/2});
          }
        }
      }
    }
    return{hLines,vLines};
  }

  // تشخیص «شکاف بزرگ» بین دو تکهٔ متن مجاور = مرز واقعی دو بلوک/ستون جدا (نه فقط فاصلهٔ معمولی بین کلمات)
  // مثال کلاسیک: در سربرگ آزمون‌ها، «نام و نام‌خانوادگی:» (باکس راست) و عنوان وسط صفحه («مرکز ارزشیابی...»)
  // ممکن است روی یک خط افقی (همان y) قرار بگیرند چون کنار هم چیده شده‌اند، اما با فاصلهٔ خالی زیاد در وسط؛
  // بدون این تشخیص، این دو متنِ کاملاً نامرتبط به‌اشتباه به‌عنوان یک خط واحد به‌هم می‌چسبند.
  // محاسبهٔ شکاف با کسر عرض واقعی آیتم (it.width) دقیق‌تر از تفاضل سادهٔ x است و از تشخیص اشتباه در جمله‌های عادی جلوگیری می‌کند.
  const PDF2WORD_COL_BREAK_RATIO=4, PDF2WORD_COL_BREAK_MIN_ABS=18;
  function pdf2wordSplitIntoLines(sortedItems){
    const lines=[];let cur=[];let prevItem=null;
    sortedItems.forEach(it=>{
      if(prevItem){
        const prevRight=prevItem.transform[4];
        const curRight=it.transform[4]+(it.width||0);
        const gap=prevRight-curRight;
        const fontSize=Math.abs(it.transform[3])||Math.abs(it.transform[0])||10;
        if(gap>Math.max(fontSize*PDF2WORD_COL_BREAK_RATIO,PDF2WORD_COL_BREAK_MIN_ABS)){lines.push(cur);cur=[];}
      }
      cur.push(it);prevItem=it;
    });
    if(cur.length)lines.push(cur);
    return lines;
  }

  // اتصال هوشمند تکه‌های متن: فقط وقتی فاصلهٔ واقعی بین دو تکه به‌اندازهٔ کافی بزرگ باشد یک space درج می‌شود
  // (وگرنه دو تکه بخشی از یک کلمهٔ واحدند و نباید فاصله بینشان بیفتد — مثل «دبستا»+«ن» که باید «دبستان» شود)
  function pdf2wordJoinItems(sortedItems){
    let text='';
    let prevItem=null;
    sortedItems.forEach(it=>{
      if(prevItem){
        const gap=prevItem.transform[4]-it.transform[4];
        const fontSize=Math.abs(it.transform[3])||Math.abs(it.transform[0])||10;
        if(gap/fontSize>0.7 && !text.endsWith(' '))text+=' ';
      }
      text+=it.str;
      prevItem=it;
    });
    return text;
  }

  // متن یک بلوک از آیتم‌ها را با فاصله‌گذاری درست و حفظ خط‌های داخلی می‌سازد
  // ocrCtx در صورت وجود، برای ترمیم خط‌هایی با کاراکترهای خراب (فونت غیراستاندارد) استفاده می‌شود
  async function pdf2wordBuildCellText(cellItems,ocrCtx){
    const microLines=[];
    cellItems.forEach(it=>{
      const y=it.transform[5];
      let ml=microLines.find(m=>Math.abs(m.y-y)<=3);
      if(!ml){ml={y,items:[]};microLines.push(ml);}
      ml.items.push(it);
    });
    microLines.sort((a,b)=>b.y-a.y);
    const out=[];
    for(const ml of microLines){
      const sorted=[...ml.items].sort((a,b)=>b.transform[4]-a.transform[4]);
      const subLines=pdf2wordSplitIntoLines(sorted); // جلوگیری از چسبیدن متن ستون‌های مجزای هم‌ارتفاع به هم
      for(const sub of subLines){
        let text=pdf2wordJoinItems(sub).replace(/\s+/g,' ').replace(/\s+([.,،؛:؟!])/g,'$1').trim();
        if(text!==''&&ocrCtx&&hasBrokenGlyphs(text)){
          const bb=itemsBBox(sub);
          const ocrText=await ocrRect(ocrCtx,bb.xL,bb.xR,bb.yTop,bb.yBot);
          if(ocrText)text=ocrText;
        }
        if(text!=='')out.push(text);
      }
    }
    return out;
  }

  // خروجی هر صفحه: آرایه‌ای از بلوک‌ها — {type:'table', rows:[[متن سلول‌ها به ترتیب راست‌به‌چپ],...]} یا {type:'para', lines:[...]}
  async function extractPdfPageBlocks(pageNum,docOverride){
    const doc=docOverride||pdf2wordDoc;
    const page=await doc.getPage(pageNum);
    const content=await page.getTextContent();
    const items=content.items.filter(it=>it.str!==undefined).map(it=>({...it,str:pdf2wordCleanStr(it.str)})).filter(it=>it.str.trim()!=='');
    if(items.length===0)return[];

    // اگر PDF از فونتی با نگاشت خراب استفاده کند، صفحه یک‌بار برای استفادهٔ بعدی در OCR رندر می‌شود
    let ocrCtx=null;
    if(items.some(it=>hasBrokenGlyphs(it.str))){
      try{ocrCtx=await renderPageForOcr(page);}catch(err){ocrCtx=null;}
    }

    const{hLines,vLines}=await pdf2wordExtractGridLines(page);

    // بدون خط جدول: همهٔ متن به‌صورت پاراگراف معمولی (بر اساس ردیف Y + راست‌به‌چپ)
    const buildPlainParas=async(itemList)=>{
      const lines=[];
      itemList.forEach(it=>{
        const y=it.transform[5];
        const fontSize=Math.abs(it.transform[3])||Math.abs(it.transform[0])||10;
        const tol=Math.max(2,fontSize*0.35);
        let line=lines.find(l=>Math.abs(l.y-y)<=tol);
        if(!line){line={y,items:[]};lines.push(line);}
        line.items.push(it);
      });
      lines.sort((a,b)=>b.y-a.y);
      const out=[];
      for(const l of lines){
        const sorted=[...l.items].sort((a,b)=>b.transform[4]-a.transform[4]);
        const subLines=pdf2wordSplitIntoLines(sorted); // جلوگیری از چسبیدن متن ستون‌های مجزای هم‌ارتفاع به هم (مثلاً باکس‌های سربرگ آزمون)
        for(const sub of subLines){
          let text=pdf2wordJoinItems(sub).replace(/\s+/g,' ').replace(/\s+([.,،؛:؟!])/g,'$1').trim();
          if(text!==''&&ocrCtx&&hasBrokenGlyphs(text)){
            const bb=itemsBBox(sub);
            const ocrText=await ocrRect(ocrCtx,bb.xL,bb.xR,bb.yTop,bb.yBot);
            if(ocrText)text=ocrText;
          }
          if(text!=='')out.push({type:'para',text});
        }
      }
      return out;
    };

    if(hLines.length<2)return await buildPlainParas(items);

    const rowBounds=pdf2wordClusterValues(hLines.map(l=>l.y),2).sort((a,b)=>b-a);
    const yTopMost=rowBounds[0],yBotMost=rowBounds[rowBounds.length-1];
    const blocks=[];

    // متن‌های بالاتر از جدول (پاراگراف)
    const aboveItems=items.filter(it=>it.transform[5]>yTopMost+1);
    blocks.push(...(await buildPlainParas(aboveItems)));

    const tableRows=[];
    for(let r=0;r<rowBounds.length-1;r++){
      const yTop=rowBounds[r],yBot=rowBounds[r+1];
      const bandVX=vLines.filter(v=>v.y1<=yTop-1&&v.y2>=yBot+1).map(v=>v.x);
      let colBounds=pdf2wordClusterValues(bandVX,2).sort((a,b)=>a-b);
      const bandItems=items.filter(it=>{const y=it.transform[5];return y<=yTop+1&&y>=yBot-1;});
      if(colBounds.length<2){
        if(bandItems.length===0)continue;
        tableRows.push([await pdf2wordBuildCellText(bandItems,ocrCtx)]);
        continue;
      }
      const cols=[];
      for(let c=colBounds.length-2;c>=0;c--){
        const xL=colBounds[c],xR=colBounds[c+1];
        const cellItems=bandItems.filter(it=>{const x=it.transform[4];return x>=xL-1&&x<=xR+1;});
        cols.push(await pdf2wordBuildCellText(cellItems,ocrCtx));
      }
      tableRows.push(cols);
    }
    if(tableRows.length>0)blocks.push({type:'table',rows:tableRows});

    // متن‌های پایین‌تر از جدول (پاراگراف)
    const belowItems=items.filter(it=>it.transform[5]<yBotMost-1);
    blocks.push(...(await buildPlainParas(belowItems)));

    return blocks;
  }

  function escapeHtml(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

  document.getElementById('btn-pdf2word-convert').onclick=async()=>{
    if(!pdf2wordDoc){toast('فایل PDF انتخاب نشده');return;}
    const btn=document.getElementById('btn-pdf2word-convert');btn.disabled=true;const origText=btn.textContent;
    const statusEl=document.getElementById('pdf2word-status');
    ocrFixCount=0;ocrFailCount=0;
    try{
      let bodyHtml='';
      for(let i=1;i<=pdf2wordDoc.numPages;i++){
        statusEl.textContent='در حال استخراج متن صفحه '+i+' از '+pdf2wordDoc.numPages+'...';
        btn.textContent='⏳ '+i+'/'+pdf2wordDoc.numPages;
        const blocks=await extractPdfPageBlocks(i);
        // نکتهٔ مهم: page-break-before:always روی <div> توسط Word به‌صورت قابل‌اعتماد تفسیر نمی‌شود (بسته به نسخهٔ
        // Word/فونت نصب‌شده می‌تواند صفحه‌ها را با هم ادغام کند یا برعکس باعث افزایش غیرمنتظرهٔ تعداد صفحه شود).
        // به‌جای آن از نشانهٔ استاندارد و قابل‌اعتماد Word برای شکست صفحه استفاده می‌شود (<br> با mso-special-character)
        // که در فایل‌های Word/HTML همیشه به‌عنوان یک شکست صفحهٔ واقعی شناسایی می‌شود.
        if(i>1)bodyHtml+='<br clear="all" style="mso-special-character:line-break;page-break-before:always">';
        bodyHtml+='<div>';
        if(blocks.length===0){
          bodyHtml+='<p style="color:#999">[این صفحه متن قابل استخراج ندارد — احتمالاً عکس یا اسکن است]</p>';
        }else{
          blocks.forEach(block=>{
            if(block.type==='table'){
              const maxCols=Math.max(...block.rows.map(r=>r.length));
              bodyHtml+='<table style="width:100%;border-collapse:collapse;table-layout:fixed" dir="rtl"><tbody>';
              block.rows.forEach(cells=>{
                bodyHtml+='<tr>';
                cells.forEach((cellLines,idx)=>{
                  // فقط سلول اول (راست‌ترین) در ردیف‌های چندستونی ممکن است ستون «شماره» باشد — بقیهٔ سلول‌های کوتاه نباید باریک/وسط‌چین شوند
                  const isNarrow=idx===0&&cells.length>1&&maxCols>2&&cellLines.length===1&&cellLines[0].length<=3;
                  const isLast=idx===cells.length-1;
                  const colspan=isLast&&cells.length<maxCols?' colspan="'+(maxCols-cells.length+1)+'"':'';
                  const cellHtml=cellLines.length>0?cellLines.map(l=>escapeHtml(l)).join('<br>'):'&nbsp;';
                  bodyHtml+='<td'+colspan+' style="border:1px solid #333;padding:5px 8px;vertical-align:top;'+(isNarrow?'width:36px;text-align:center':'')+'">'+cellHtml+'</td>';
                });
                bodyHtml+='</tr>';
              });
              bodyHtml+='</tbody></table>';
            }else{
              bodyHtml+='<p style="margin:0 0 6px 0">'+(block.text?escapeHtml(block.text):'&nbsp;')+'</p>';
            }
          });
        }
        bodyHtml+='</div>';
      }
      const htmlDoc='<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">'+
        '<head><meta charset="utf-8"><title>'+escapeHtml(pdf2wordFileName)+'</title>'+
        '<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom><w:DoNotOptimizeForBrowser/></w:WordDocument></xml><![endif]-->'+
        '<style>'+
        '@page WordSection1{size:21cm 29.7cm;margin:2cm;mso-page-orientation:portrait}'+
        'div.WordSection1{page:WordSection1}'+
        '@page{size:21cm 29.7cm;margin:2cm}'+
        'body{font-family:"B Nazanin","Vazirmatn","Tahoma",sans-serif;font-size:14pt;direction:rtl;text-align:right}'+
        'p{margin:0 0 6px 0}table{margin:0 0 6px 0}</style>'+
        '</head><body dir="rtl"><div class="WordSection1">'+bodyHtml+'</div></body></html>';
      pdf2wordBlob=new Blob(['\ufeff'+htmlDoc],{type:'application/msword'});
      let doneMsg='✅ تبدیل انجام شد — '+pdf2wordDoc.numPages+' صفحه استخراج شد.';
      if(ocrFixCount>0)doneMsg+=' ('+ocrFixCount+' بخش با فونت خراب توسط OCR ترمیم شد'+(ocrFailCount>0?'، '+ocrFailCount+' مورد نیاز به بازبینی دستی دارد':'')+')';
      statusEl.textContent=doneMsg;
      document.getElementById('btn-pdf2word-download').classList.remove('hidden');
      toast('فایل Word آماده شد ✅');
    }catch(e){
      statusEl.textContent='';
      toast('خطا در تبدیل PDF به Word');
    }finally{
      btn.disabled=false;btn.textContent=origText;
    }
  };

  document.getElementById('btn-pdf2word-download').onclick=()=>{
    if(!pdf2wordBlob){toast('ابتدا تبدیل را انجام دهید');return;}
    const a=document.createElement('a');
    a.href=URL.createObjectURL(pdf2wordBlob);
    a.download=pdf2wordFileName.replace(/\.pdf$/i,'')+'.doc';
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast('فایل Word دانلود شد ✅');
  };

  // ===== ترجمه =====
  document.getElementById('tl-from').onchange=function(){const f=this.value;const t=document.getElementById('tl-to');if(f===t.value){t.value=f==='fa'?'en':'fa';}};
  const tlLangNames={auto:'زبان ورودی (تشخیص خودکار)',fa:'فارسی',en:'انگلیسی',ar:'عربی',fr:'فرانسوی',de:'آلمانی',tr:'ترکی استانبولی',es:'اسپانیایی',it:'ایتالیایی',pt:'پرتغالی',ru:'روسی',zh:'چینی',ja:'ژاپنی',ko:'کره‌ای',ur:'اردو',hi:'هندی',ps:'پشتو',ku:'کردی سورانی',az:'آذربایجانی',hy:'ارمنی'};
  const tlLangDir={fa:'rtl',ar:'rtl',ur:'rtl',ps:'rtl',ku:'rtl',en:'ltr',fr:'ltr',de:'ltr',tr:'ltr',es:'ltr',it:'ltr',pt:'ltr',ru:'ltr',zh:'ltr',ja:'ltr',ko:'ltr',hi:'ltr',az:'ltr',hy:'ltr'};
  const tlToneNames={neutral:'',formal:'Use a formal / official tone suitable for administrative and formal correspondence.',informal:'Use a casual, everyday conversational tone.',academic:'Use a formal academic/scientific tone suitable for educational and research texts.',simple:'Use very simple, easy words suitable for children or beginners.'};
  function tlUpdateDirs(){
    const fromVal=document.getElementById('tl-from').value;
    document.getElementById('tl-input').dir=fromVal==='auto'?'auto':(tlLangDir[fromVal]||'rtl');
    document.getElementById('tl-output').dir=tlLangDir[document.getElementById('tl-to').value]||'ltr';
  }
  function tlUpdateCounts(){
    const inLen=document.getElementById('tl-input').value.length;
    const outLen=document.getElementById('tl-output').value.length;
    document.getElementById('tl-input-count').textContent=inLen.toLocaleString('fa-IR')+' کاراکتر';
    document.getElementById('tl-output-count').textContent=outLen.toLocaleString('fa-IR')+' کاراکتر';
  }
  document.getElementById('tl-from').addEventListener('change',tlUpdateDirs);
  document.getElementById('tl-to').addEventListener('change',tlUpdateDirs);
  document.getElementById('tl-input').addEventListener('input',tlUpdateCounts);
  window.tlSwap=function(){
    const f=document.getElementById('tl-from');const t=document.getElementById('tl-to');
    if(f.value==='auto'){toast('برای جابه‌جایی، ابتدا یک زبان مبدأ مشخص انتخاب کنید (نه تشخیص خودکار)');return;}
    const tmp=f.value;f.value=t.value;t.value=tmp;
    const inp=document.getElementById('tl-input');const out=document.getElementById('tl-output');
    const t2=inp.value;inp.value=out.value;out.value=t2;
    tlUpdateDirs();tlUpdateCounts();
    document.getElementById('tl-back-box').classList.add('hidden');
  };
  window.tlCopy=function(){const txt=document.getElementById('tl-output').value;if(!txt){toast('متنی وارد نشده');return;}navigator.clipboard.writeText(txt).then(()=>toast('کپی شد ✅'));};
  window.tlClear=function(){document.getElementById('tl-input').value='';document.getElementById('tl-output').value='';tlUpdateCounts();document.getElementById('tl-back-box').classList.add('hidden');};
  async function tlCallAi(text,fromName,toName,toneInstruction,autoDetect){
    const sys='You are a professional, experienced human translator. Translate the text the user sends '+
      (autoDetect?'(automatically detect the source language) ':'from '+fromName+' ')+
      'into '+toName+'. '+(toneInstruction||'')+' '+
      'Preserve the original meaning, paragraph breaks, and any numbers/names exactly. '+
      'Respond with ONLY the translation itself — natural, fluent, and idiomatic — no quotes, no explanations, no extra commentary, no original text repeated.';
    const res=await fetch('/api/teacher/ai/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:[{role:'system',content:sys},{role:'user',content:text}],max_tokens:4096,provider:getAiProvider()})});
    const data=await res.json();
    if(data.error)throw new Error(data.error);
    return (data.content||'').trim();
  }
  document.getElementById('btn-translate').onclick=async function(){
    const text=document.getElementById('tl-input').value.trim();
    if(!text){toast('متنی وارد نشده');return;}
    const from=document.getElementById('tl-from').value, to=document.getElementById('tl-to').value;
    if(from===to){toast('زبان مبدا و مقصد یکسان است');return;}
    const tone=document.getElementById('tl-tone').value;
    const btn=this;btn.disabled=true;btn.textContent='⏳ در حال ترجمه...';
    document.getElementById('tl-back-box').classList.add('hidden');
    try{
      const out=await tlCallAi(text,tlLangNames[from],tlLangNames[to],tlToneNames[tone],from==='auto');
      document.getElementById('tl-output').value=out;
      tlUpdateDirs();tlUpdateCounts();
      toast('ترجمه شد ✅');
    }catch(e){toast('خطا در ترجمه: '+e.message);}
    btn.disabled=false;btn.textContent='🌐 ترجمه کن';
  };
  document.getElementById('btn-translate-back').onclick=async function(){
    const out=document.getElementById('tl-output').value.trim();
    if(!out){toast('ابتدا متن را ترجمه کنید');return;}
    const from=document.getElementById('tl-from').value, to=document.getElementById('tl-to').value;
    const targetLangForBack=from==='auto'?'fa':from; // اگر مبدا «تشخیص خودکار» بود، بازترجمه را به فارسی نشان می‌دهیم
    const btn=this;btn.disabled=true;btn.textContent='⏳ در حال بازبینی...';
    try{
      const backText=await tlCallAi(out,tlLangNames[to],tlLangNames[targetLangForBack],'',false);
      document.getElementById('tl-back-text').textContent=backText;
      document.getElementById('tl-back-text').dir=tlLangDir[targetLangForBack]||'rtl';
      document.getElementById('tl-back-box').classList.remove('hidden');
    }catch(e){toast('خطا در بازبینی: '+e.message);}
    btn.disabled=false;btn.textContent='🔁 بازبینی (ترجمه معکوس)';
  };
  document.getElementById('tl-input').addEventListener('keydown',function(e){
    if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();document.getElementById('btn-translate').click();}
  });
  tlUpdateDirs();tlUpdateCounts();

  // ===== گرفتن متن ورودی ترجمه از عکس (OCR با هوش مصنوعی تصویری) یا از فایل PDF =====
  const tlExtractStatus=document.getElementById('tl-extract-status');
  document.getElementById('btn-tl-from-img').onclick=()=>{document.getElementById('tl-img-file').click();};
  document.getElementById('tl-img-file').addEventListener('change',async function(e){
    const file=e.target.files[0];
    if(!file)return;
    if(!file.type.startsWith('image/')){toast('لطفاً یک فایل تصویری انتخاب کنید');e.target.value='';return;}
    const btn=document.getElementById('btn-tl-from-img');btn.disabled=true;
    tlExtractStatus.textContent='⏳ در حال خواندن متن از عکس...';
    try{
      const dataUrl=await new Promise((resolve,reject)=>{
        const reader=new FileReader();
        reader.onload=()=>resolve(reader.result);
        reader.onerror=reject;
        reader.readAsDataURL(file);
      });
      const sys='You are an OCR engine. Extract ALL text visible in the image EXACTLY as written, preserving line breaks and paragraph structure. Do NOT translate it. Do NOT add any commentary, headers, or explanation — output ONLY the extracted text, nothing else.';
      const res=await fetch('/api/teacher/ai/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:[{role:'system',content:sys},{role:'user',content:[{type:'text',text:'متن این تصویر را استخراج کن.'},{type:'image_url',image_url:{url:dataUrl}}]}],max_tokens:4096,provider:getAiProvider()})});
      const data=await res.json();
      if(data.error)throw new Error(data.error);
      const extracted=(data.content||'').trim();
      if(!extracted){toast('متنی در عکس پیدا نشد');}
      else{
        document.getElementById('tl-input').value=extracted;
        tlUpdateDirs();tlUpdateCounts();
        toast('متن از عکس استخراج شد ✅ — حالا زبان و لحن را بررسی و ترجمه کنید');
      }
    }catch(err){toast('خطا در خواندن عکس: '+err.message);}
    tlExtractStatus.textContent='';
    btn.disabled=false;
    e.target.value='';
  });

  document.getElementById('btn-tl-from-pdf').onclick=()=>{document.getElementById('tl-pdf-file').click();};
  document.getElementById('tl-pdf-file').addEventListener('change',async function(e){
    const file=e.target.files[0];
    if(!file)return;
    const btn=document.getElementById('btn-tl-from-pdf');btn.disabled=true;
    tlExtractStatus.textContent='در حال خواندن فایل PDF...';
    try{
      const buf=await file.arrayBuffer();
      const doc=await pdfjsLib.getDocument({data:buf}).promise;
      const parts=[];
      for(let p=1;p<=doc.numPages;p++){
        tlExtractStatus.textContent='در حال استخراج متن صفحه '+p+' از '+doc.numPages+'...';
        const blocks=await extractPdfPageBlocks(p,doc);
        blocks.forEach(b=>{
          if(b.type==='table'){
            b.rows.forEach(cells=>{parts.push(cells.map(cellLines=>cellLines.join(' ')).join(' | '));});
          }else if(b.type==='para'&&b.text){
            parts.push(b.text);
          }
        });
      }
      const extracted=parts.join('\\n').trim();
      if(!extracted){toast('متنی در این PDF پیدا نشد (شاید فقط عکس/اسکن باشد)');}
      else{
        document.getElementById('tl-input').value=extracted;
        tlUpdateDirs();tlUpdateCounts();
        toast('متن از PDF استخراج شد ✅ ('+doc.numPages+' صفحه) — حالا زبان و لحن را بررسی و ترجمه کنید');
      }
    }catch(err){toast('خطا در خواندن فایل PDF: '+err.message);}
    tlExtractStatus.textContent='';
    btn.disabled=false;
    e.target.value='';
  });

  // ===== AI Chat =====
  let aiMessages=[{role:'system',content:'تو یک دستیار هوشمند برای معلمان هستی. به زبان فارسی پاسخ بده.'}];
  let aiPendingImage=null; // dataURL تصویر ضمیمه‌شده (در صورت وجود) پیش از ارسال پیام بعدی
  const aiInput=document.getElementById('ai-input');
  aiInput.addEventListener('input',function(){this.style.height='auto';this.style.height=Math.min(this.scrollHeight,120)+'px';});
  document.getElementById('btn-ai-img-pick').onclick=()=>{document.getElementById('ai-img-file').click();};
  document.getElementById('ai-img-file').addEventListener('change',function(e){
    const file=e.target.files[0];
    if(!file)return;
    if(!file.type.startsWith('image/')){toast('لطفاً یک فایل تصویری انتخاب کنید');e.target.value='';return;}
    const reader=new FileReader();
    reader.onload=function(){
      aiPendingImage=reader.result;
      document.getElementById('ai-img-preview-thumb').src=aiPendingImage;
      document.getElementById('ai-img-preview').classList.remove('hidden');
    };
    reader.readAsDataURL(file);
    e.target.value='';
  });
  document.getElementById('btn-ai-img-remove').onclick=()=>{
    aiPendingImage=null;
    document.getElementById('ai-img-preview').classList.add('hidden');
  };
  let aiPendingPdfText=null,aiPendingPdfName='';
  document.getElementById('btn-ai-pdf-pick').onclick=()=>{document.getElementById('ai-pdf-file').click();};
  document.getElementById('ai-pdf-file').addEventListener('change',async function(e){
    const file=e.target.files[0];
    if(!file)return;
    if(file.type!=='application/pdf'){toast('لطفاً یک فایل PDF انتخاب کنید');e.target.value='';return;}
    const btn=document.getElementById('btn-ai-pdf-pick');btn.disabled=true;
    toast('در حال استخراج متن از PDF...');
    try{
      const buf=await file.arrayBuffer();
      const doc=await pdfjsLib.getDocument({data:buf}).promise;
      const parts=[];
      for(let p=1;p<=doc.numPages;p++){
        const blocks=await extractPdfPageBlocks(p,doc);
        blocks.forEach(function(b){
          if(b.type==='table'){b.rows.forEach(function(cells){parts.push(cells.map(function(cellLines){return cellLines.join(' ');}).join(' | '));});}
          else if(b.type==='para'&&b.text){parts.push(b.text);}
        });
      }
      const extracted=parts.join('\\n').trim();
      if(!extracted){toast('متنی در این PDF پیدا نشد (شاید فقط عکس/اسکن باشد)');e.target.value='';btn.disabled=false;return;}
      aiPendingPdfText=extracted;
      aiPendingPdfName=file.name;
      document.getElementById('ai-pdf-preview-name').textContent='📄 '+file.name+' ('+doc.numPages+' صفحه)';
      document.getElementById('ai-pdf-preview').classList.remove('hidden');
      toast('متن PDF استخراج شد ✅');
    }catch(err){toast('خطا در خواندن PDF: '+err.message);}
    btn.disabled=false;
    e.target.value='';
  });
  document.getElementById('btn-ai-pdf-remove').onclick=()=>{
    aiPendingPdfText=null;aiPendingPdfName='';
    document.getElementById('ai-pdf-preview').classList.add('hidden');
  };
  function addAiMessage(role,text,imageUrl,msgId){
    const box=document.getElementById('ai-messages');
    const isUser=role==='user';
    const imgHtml=imageUrl?'<img src="'+imageUrl+'" style="max-width:180px;max-height:180px;border-radius:8px;display:block;margin-bottom:6px">':'';
    const id=msgId||('aimsg_'+Date.now()+'_'+Math.floor(Math.random()*10000));
    const html='<div class="ai-message '+(isUser?'user':'ai')+'" data-msgid="'+id+'"><div class="ai-message-avatar">'+(isUser?'👤':'🤖')+'</div><div class="ai-message-content"><div class="ai-message-text" id="'+id+'">'+imgHtml+esc(text)+'</div><button type="button" class="ai-copy-btn" onclick="copyAiMsg(\\''+id+'\\',this)">📋 کپی</button><button type="button" class="ai-del-btn" onclick="deleteAiMsg(\\''+id+'\\')">🗑️ حذف</button></div></div>';
    box.insertAdjacentHTML('beforeend',html);
    box.scrollTop=box.scrollHeight;
    return id;
  }
  window.copyAiMsg=function(msgId,btn){
    const el=document.getElementById(msgId);
    if(!el)return;
    const text=el.innerText||el.textContent||'';
    navigator.clipboard.writeText(text).then(()=>{
      const old=btn.innerHTML;
      btn.innerHTML='✅ کپی شد';
      setTimeout(()=>{btn.innerHTML=old;},1500);
    }).catch(()=>{toast('کپی ناموفق بود');});
  };
  window.deleteAiMsg=function(msgId){
    const bubble=document.querySelector('.ai-message[data-msgid="'+msgId+'"]');
    if(bubble)bubble.remove();
    aiMessages=aiMessages.filter(m=>m._id!==msgId);
    toast('پیام حذف شد');
  };
  document.getElementById('btn-ai-clear').onclick=()=>{
    if(!confirm('آیا از پاک کردن کل گفتگو مطمئن هستید؟ این کار قابل بازگشت نیست.'))return;
    document.getElementById('ai-messages').innerHTML='<div class="ai-message ai"><div class="ai-message-avatar">🤖</div><div class="ai-message-content"><div class="ai-message-text">سلام! 👋 من دستیار هوش مصنوعی شما هستم. چطور می‌توانم کمکتان کنم؟</div></div></div>';
    aiMessages=[{role:'system',content:'تو یک دستیار هوشمند برای معلمان هستی. به زبان فارسی پاسخ بده.'}];
    toast('گفتگو پاک شد');
  };
  function showTyping(){document.getElementById('ai-typing').classList.remove('hidden');document.getElementById('ai-messages').scrollTop=document.getElementById('ai-messages').scrollHeight;}
  function hideTyping(){document.getElementById('ai-typing').classList.add('hidden');}
  document.getElementById('btn-ai-send').onclick=async()=>{
    const text=aiInput.value.trim();
    const img=aiPendingImage;
    const pdfText=aiPendingPdfText;
    const pdfName=aiPendingPdfName;
    if(!text&&!img&&!pdfText)return;
    aiInput.value='';aiInput.style.height='auto';
    const displayText=(text||(pdfText?'':'(بدون متن)'))+(pdfText?'\\n\\n📄 فایل ضمیمه: '+pdfName:'');
    const userMsgId=addAiMessage('user',displayText,img);
    let apiText=text;
    if(pdfText){
      apiText=(text?text+'\\n\\n':'')+'متن استخراج‌شده از فایل PDF («'+pdfName+'»):\\n---\\n'+pdfText+'\\n---';
    }
    if(img){
      aiMessages.push({role:'user',content:[{type:'text',text:apiText||'این تصویر را توضیح بده'},{type:'image_url',image_url:{url:img}}],_id:userMsgId});
    }else{
      aiMessages.push({role:'user',content:apiText||'لطفاً این متن را بررسی کن.',_id:userMsgId});
    }
    aiPendingImage=null;
    aiPendingPdfText=null;aiPendingPdfName='';
    document.getElementById('ai-img-preview').classList.add('hidden');
    document.getElementById('ai-pdf-preview').classList.add('hidden');
    showTyping();
    try{
      const msgs=aiMessages.slice(-10).map(m=>({role:m.role,content:m.content}));
      const res=await fetch('/api/teacher/ai/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:msgs,provider:getAiProvider(),max_tokens:4096})});
      const d=await res.json();
      hideTyping();
      if(d.error){addAiMessage('ai','❌ خطا: '+d.error);return;}
      const aiMsgId=addAiMessage('ai',d.content);
      aiMessages.push({role:'assistant',content:d.content,_id:aiMsgId});
    }catch(e){
      hideTyping();
      addAiMessage('ai','❌ خطا در اتصال: '+e.message);
    }
  };
  aiInput.onkeydown=e=>{ if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();document.getElementById('btn-ai-send').click();} };

  // ===== تغییر رمز عبور =====
  document.getElementById('btn-change-pass').onclick=async()=>{
    const np=document.getElementById('new-pass').value;
    const msg=document.getElementById('pass-msg');
    const d=await api('/api/teacher/password',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({newPassword:np})});
    if(d.ok){msg.style.color='#166534';msg.textContent='رمز عبور با موفقیت تغییر کرد.';document.getElementById('new-pass').value='';}
    else{msg.style.color='var(--danger)';msg.textContent=d.error||'خطا';}
  };

  // ===== کلاس آنلاین (تخته هوشمند + چت + صدای زنده معلم) =====
  async function renderClassLinks(){
    const d=await api('/api/teacher/students');
    const box=document.getElementById('cls-links-list');
    if(!d.students.length){box.innerHTML='<p class="muted">ابتدا از تب «دانش‌آموزان» برای هر نفر یک لینک بسازید.</p>';return;}
    box.innerHTML='<table><tr><th>#</th><th>نام</th><th>لینک ورود به کلاس آنلاین</th><th></th></tr>'+
      d.students.map((s,i)=>{
        const link=location.origin+'/class/'+s.uuid;
        return '<tr><td>'+(i+1)+'</td><td>'+esc(s.label||'-')+'</td>'+
          '<td><div class="link-box">'+link+'</div></td>'+
          '<td><button class="btn sm" onclick="copyLink(\\''+link+'\\')">کپی</button></td></tr>';
      }).join('')+'</table>';
  }

  let clsWs=null, clsMicStream=null, clsRecorder=null, clsDrawing=false, clsLastPoint=null, clsCurrentStroke=null, clsAudioActive=false, clsAudioGen=0;
  let clsCamStream=null, clsCamInterval=null, clsAudioFromCam=false, clsCamFacing='user';
  const tBoard=document.getElementById('t-board');
  const tCtx=tBoard.getContext('2d');
  const CLS_BOARD_DEFAULT_W=900, CLS_BOARD_DEFAULT_H=560;

  function clsResizeBoard(){
    const ratio=tBoard.height/tBoard.width;
    const containerW=tBoard.parentElement.clientWidth;
    if(!containerW)return;
    const maxH=window.innerHeight*0.78; // بزرگ ولی همیشه در صفحه جا می‌شود (مثل نمایشگر PDF در Adobe Connect)
    let w=containerW, h=w*ratio;
    if(h>maxH){h=maxH;w=h/ratio;}
    tBoard.style.width=w+'px';
    tBoard.style.height=h+'px';
  }
  function clsResizeBoardTo(w,h){
    tBoard.width=Math.round(w);
    tBoard.height=Math.round(h);
    clsResizeBoard();
  }
  clsResizeBoard();window.addEventListener('resize',clsResizeBoard);

  function clsPointFromEvent(e){
    const rect=tBoard.getBoundingClientRect();
    const cx=(e.touches?e.touches[0].clientX:e.clientX)-rect.left;
    const cy=(e.touches?e.touches[0].clientY:e.clientY)-rect.top;
    return [cx/rect.width, cy/rect.height];
  }
  function clsDrawLocal(stroke){
    if(!stroke)return;
    if(stroke.type==='text'){
      tCtx.save();
      tCtx.fillStyle=stroke.color||'#111827';
      tCtx.font='bold '+((stroke.size||3)*7+12)+'px Vazirmatn, Tahoma, sans-serif';
      tCtx.textBaseline='top';
      tCtx.fillText(stroke.text||'', stroke.x*tBoard.width, stroke.y*tBoard.height);
      tCtx.restore();
      return;
    }
    if(!stroke.points||stroke.points.length<2)return;
    tCtx.save();
    tCtx.strokeStyle=stroke.erase?'#ffffff':(stroke.color||'#111827');
    tCtx.lineWidth=stroke.size||3;
    tCtx.lineCap='round';tCtx.lineJoin='round';
    tCtx.beginPath();
    tCtx.moveTo(stroke.points[0][0]*tBoard.width, stroke.points[0][1]*tBoard.height);
    for(let i=1;i<stroke.points.length;i++)tCtx.lineTo(stroke.points[i][0]*tBoard.width, stroke.points[i][1]*tBoard.height);
    tCtx.stroke();
    tCtx.restore();
  }
  function clsSend(obj){ if(clsWs && clsWs.readyState===1) clsWs.send(JSON.stringify(obj)); }

  // ===== لایه‌ی پس‌زمینه (صفحه‌ی PDF روی تخته) =====
  let clsBoardBgImg=null;
  function clsUpdateCamLayout(){
    const preview=document.getElementById('t-cam-preview');
    if(!preview)return;
    if(clsBoardBgImg){
      preview.classList.remove('t-cam-oncanvas');
      preview.classList.add('t-cam-corner');
    }else{
      preview.classList.remove('t-cam-corner');
      preview.classList.add('t-cam-oncanvas');
    }
  }
  function clsSetBoardBg(dataUrl,w,h){
    if(!dataUrl){
      clsBoardBgImg=null;
      clsResizeBoardTo(w||CLS_BOARD_DEFAULT_W,h||CLS_BOARD_DEFAULT_H);
      tCtx.clearRect(0,0,tBoard.width,tBoard.height);
      clsUpdateCamLayout();
      return;
    }
    const img=new Image();
    img.onload=()=>{
      clsBoardBgImg=img;
      clsResizeBoardTo(w||img.naturalWidth,h||img.naturalHeight);
      tCtx.clearRect(0,0,tBoard.width,tBoard.height);
      tCtx.drawImage(img,0,0,tBoard.width,tBoard.height);
      clsUpdateCamLayout();
    };
    img.onerror=()=>{toast('خطا در بارگذاری تصویر پس‌زمینه');};
    img.src=dataUrl;
  }
  function clsSetBoardBgAndReplay(dataUrl,strokes,w,h){
    if(!dataUrl){
      clsBoardBgImg=null;
      clsResizeBoardTo(w||CLS_BOARD_DEFAULT_W,h||CLS_BOARD_DEFAULT_H);
      tCtx.clearRect(0,0,tBoard.width,tBoard.height);
      (strokes||[]).forEach(clsDrawLocal);
      clsUpdateCamLayout();
      return;
    }
    const img=new Image();
    img.onload=()=>{
      clsBoardBgImg=img;
      clsResizeBoardTo(w||img.naturalWidth,h||img.naturalHeight);
      tCtx.clearRect(0,0,tBoard.width,tBoard.height);
      tCtx.drawImage(img,0,0,tBoard.width,tBoard.height);
      (strokes||[]).forEach(clsDrawLocal);
      clsUpdateCamLayout();
    };
    img.onerror=()=>{toast('خطا در بارگذاری تصویر پس‌زمینه');};
    img.src=dataUrl;
  }

  // ===== نمایش PDF روی تخته =====
  let clsPdfDoc=null, clsPdfFileName='', clsPdfCurrentPage=1;
  document.getElementById('cls-pdf-file').addEventListener('change',async function(){
    const f=this.files&&this.files[0];this.value='';
    if(!f)return;
    if(f.type!=='application/pdf'){toast('فقط فایل PDF مجاز است');return;}
    try{
      const buf=await f.arrayBuffer();
      clsPdfDoc=await pdfjsLib.getDocument({data:buf}).promise;
      clsPdfFileName=f.name;
      clsPdfCurrentPage=1;
      document.getElementById('cls-pdf-name').textContent=f.name;
      document.getElementById('cls-pdf-total').textContent=clsPdfDoc.numPages;
      const pn=document.getElementById('cls-pdf-pagenum');
      pn.value=1;pn.max=clsPdfDoc.numPages;
      document.getElementById('cls-pdf-nav').classList.remove('hidden');
      document.getElementById('cls-pdf-remove-file').classList.remove('hidden');
      toast('فایل PDF بارگذاری شد ✅ ('+clsPdfDoc.numPages+' صفحه)');
    }catch(e){
      toast('خطا در باز کردن فایل PDF - فایل معتبر است؟');
      clsPdfDoc=null;
    }
  });
  async function clsRenderPdfPage(pageNum){
    const page=await clsPdfDoc.getPage(pageNum);
    const baseViewport=page.getViewport({scale:1});
    async function renderAt(targetWidth,quality){
      const scale=targetWidth/baseViewport.width;
      const viewport=page.getViewport({scale});
      const canvas=document.createElement('canvas');
      canvas.width=viewport.width;canvas.height=viewport.height;
      const ctx=canvas.getContext('2d');
      ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);
      await page.render({canvasContext:ctx,viewport}).promise;
      return {dataUrl:canvas.toDataURL('image/jpeg',quality), w:canvas.width, h:canvas.height};
    }
    // ابتدا با کیفیت بالا رندر می‌کنیم؛ اگر حجم نهایی برای ارسال زنده خیلی بزرگ شد، به‌صورت خودکار کیفیت را کمی کاهش می‌دهیم
    let result=await renderAt(1900,0.9);
    if(result.dataUrl.length>3_000_000){
      result=await renderAt(1500,0.82);
    }
    if(result.dataUrl.length>3_000_000){
      result=await renderAt(1100,0.75);
    }
    return result;
  }
  document.getElementById('cls-pdf-prev').onclick=()=>{
    if(!clsPdfDoc)return;
    clsPdfCurrentPage=Math.max(1,clsPdfCurrentPage-1);
    document.getElementById('cls-pdf-pagenum').value=clsPdfCurrentPage;
  };
  document.getElementById('cls-pdf-next').onclick=()=>{
    if(!clsPdfDoc)return;
    clsPdfCurrentPage=Math.min(clsPdfDoc.numPages,clsPdfCurrentPage+1);
    document.getElementById('cls-pdf-pagenum').value=clsPdfCurrentPage;
  };
  document.getElementById('cls-pdf-pagenum').addEventListener('change',function(){
    if(!clsPdfDoc)return;
    let v=parseInt(this.value,10)||1;
    v=Math.max(1,Math.min(clsPdfDoc.numPages,v));
    clsPdfCurrentPage=v;this.value=v;
  });
  document.getElementById('cls-pdf-show').onclick=async()=>{
    if(!clsPdfDoc){toast('ابتدا یک فایل PDF انتخاب کنید');return;}
    const btn=document.getElementById('cls-pdf-show');btn.disabled=true;const orig=btn.textContent;btn.textContent='⏳ در حال رندر...';
    try{
      const {dataUrl,w,h}=await clsRenderPdfPage(clsPdfCurrentPage);
      clsResizeBoardTo(w,h);
      clsSetBoardBg(dataUrl);
      clsSend({type:'board-bg',data:dataUrl,w,h});
      toast('صفحه '+clsPdfCurrentPage+' روی تخته نمایش داده شد ✅');
    }catch(e){
      toast('خطا در رندر این صفحه از PDF');
    }finally{
      btn.disabled=false;btn.textContent=orig;
    }
  };
  document.getElementById('cls-pdf-remove-bg').onclick=()=>{
    clsResizeBoardTo(CLS_BOARD_DEFAULT_W,CLS_BOARD_DEFAULT_H);
    clsSetBoardBg(null);
    clsSend({type:'board-bg',data:null,w:CLS_BOARD_DEFAULT_W,h:CLS_BOARD_DEFAULT_H});
    toast('PDF از روی تخته حذف شد');
  };
  document.getElementById('cls-pdf-remove-file').onclick=()=>{
    if(!confirm('فایل PDF بارگذاری‌شده حذف شود؟ (اگر روی تخته نمایش داده شده، آن هم حذف می‌شود)'))return;
    clsPdfDoc=null;clsPdfFileName='';clsPdfCurrentPage=1;
    document.getElementById('cls-pdf-name').textContent='';
    document.getElementById('cls-pdf-nav').classList.add('hidden');
    document.getElementById('cls-pdf-remove-file').classList.add('hidden');
    document.getElementById('cls-pdf-file').value='';
    if(clsBoardBgImg){clsResizeBoardTo(CLS_BOARD_DEFAULT_W,CLS_BOARD_DEFAULT_H);clsSetBoardBg(null);clsSend({type:'board-bg',data:null,w:CLS_BOARD_DEFAULT_W,h:CLS_BOARD_DEFAULT_H});}
    toast('فایل PDF حذف شد');
  };

  let brdMode='pen'; // pen | eraser
  const BRD_COLOR='#000000';
  function clsSetEraser(on){
    brdMode = on ? 'eraser' : 'pen';
    const btn=document.getElementById('brd-tool-eraser');
    btn.classList.toggle('active', on);
    btn.textContent = on ? '✏️ برگشت به قلم' : '🧽 پاک‌کن';
  }
  document.getElementById('brd-tool-eraser').onclick=function(){ clsSetEraser(brdMode!=='eraser'); };

  function clsStartStroke(e){
    e.preventDefault();
    const pt=clsPointFromEvent(e);
    clsDrawing=true;
    const eraseOn=brdMode==='eraser';
    clsCurrentStroke={ color: BRD_COLOR, size: parseInt(document.getElementById('brd-size').value)||3, erase: eraseOn, points: [pt] };
  }
  function clsMoveStroke(e){
    if(!clsDrawing)return;
    e.preventDefault();
    const pt=clsPointFromEvent(e);
    clsCurrentStroke.points.push(pt);
    if(clsCurrentStroke.points.length>=2){
      const tail={ ...clsCurrentStroke, points: clsCurrentStroke.points.slice(-2) };
      clsDrawLocal(tail);
      clsSend({type:'draw', stroke: tail});
    }
  }
  function clsEndStroke(e){
    clsDrawing=false; clsCurrentStroke=null;
  }

  tBoard.addEventListener('mousedown',clsStartStroke);
  tBoard.addEventListener('mousemove',clsMoveStroke);
  window.addEventListener('mouseup',clsEndStroke);
  tBoard.addEventListener('touchstart',clsStartStroke,{passive:false});
  tBoard.addEventListener('touchmove',clsMoveStroke,{passive:false});
  tBoard.addEventListener('touchend',clsEndStroke);

  document.getElementById('brd-clear').onclick=function(){
    tCtx.clearRect(0,0,tBoard.width,tBoard.height);
    if(clsBoardBgImg)tCtx.drawImage(clsBoardBgImg,0,0,tBoard.width,tBoard.height);
    clsSend({type:'clear'});
  };

  // ===== بزرگ‌نمایی تخته توسط معلم (بدون تداخل با ترسیم) =====
  (function(){
    const zoomImg=document.getElementById('t-board-zoom-img');
    const backdrop=document.getElementById('t-board-zoom-backdrop');
    function closeZoom(){ zoomImg.classList.add('hidden'); backdrop.classList.add('hidden'); }
    function openZoom(){ zoomImg.src=tBoard.toDataURL(); zoomImg.classList.remove('hidden'); backdrop.classList.remove('hidden'); }
    document.getElementById('brd-zoom').onclick=openZoom;
    zoomImg.addEventListener('click',closeZoom);
    backdrop.addEventListener('click',closeZoom);
  })();

  function clsAddChat(entry){
    const box=document.getElementById('t-chatBox');
    const cls=entry.role==='teacher'?'teacher':'student';
    box.insertAdjacentHTML('beforeend','<div class="msg '+cls+'" style="padding:6px 10px;border-radius:10px;max-width:90%;font-size:14px;'+(cls==='teacher'?'background:#eef2ff;align-self:flex-start':'background:#dcfce7;align-self:flex-end;margin-inline-start:auto')+'"><div class="who" style="font-size:11px;color:#666;margin-bottom:2px">'+esc(entry.from)+'</div>'+esc(entry.text)+'</div>');
    box.scrollTop=box.scrollHeight;
  }
  function clsAddFile(f){
    const box=document.getElementById('t-chatBox');
    const cls=f.role==='teacher'?'teacher':'student';
    const align=cls==='teacher'?'background:#eef2ff;align-self:flex-start':'background:#dcfce7;align-self:flex-end;margin-inline-start:auto';
    let inner;
    if((f.mime||'').indexOf('image/')===0){
      inner='<a href="'+f.data+'" download="'+esc(f.name)+'" target="_blank"><img src="'+f.data+'" style="max-width:180px;max-height:180px;border-radius:8px;display:block"></a>';
    } else {
      inner='<a href="'+f.data+'" download="'+esc(f.name)+'" style="color:#2563eb;text-decoration:underline">📎 '+esc(f.name)+'</a>';
    }
    box.insertAdjacentHTML('beforeend','<div class="msg '+cls+'" style="padding:6px 10px;border-radius:10px;max-width:90%;font-size:14px;'+align+'"><div class="who" style="font-size:11px;color:#666;margin-bottom:2px">'+esc(f.from)+'</div>'+inner+'</div>');
    box.scrollTop=box.scrollHeight;
  }
  document.getElementById('t-btnSend').onclick=()=>{
    const inp=document.getElementById('t-chatInput');
    const text=inp.value.trim();
    if(!text)return;
    clsSend({type:'chat', text});
    inp.value='';
  };
  document.getElementById('t-chatInput').addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('t-btnSend').click();});
  document.getElementById('t-btnFile').onclick=()=>{document.getElementById('t-fileInput').click();};
  document.getElementById('t-fileInput').addEventListener('change',function(){
    const file=this.files&&this.files[0];
    this.value='';
    if(!file)return;
    if(file.size>2*1024*1024){toast('حجم فایل باید کمتر از ۲ مگابایت باشد');return;}
    const reader=new FileReader();
    reader.onload=function(){
      clsSend({type:'file', name:file.name, mime:file.type, data:reader.result});
    };
    reader.readAsDataURL(file);
  });

  function clsUpdateParticipants(list){
    document.getElementById('cls-online-count').textContent=list.filter(p=>p.role==='student').length;
    document.getElementById('cls-participants').innerHTML=list.map(p=>(p.role==='teacher'?'👨‍🏫 ':'👤 ')+esc(p.name)).join('<br>')||'<span class="muted">کسی متصل نیست</span>';
  }

  document.getElementById('btn-cls-start').onclick=async()=>{
    const startBtn=document.getElementById('btn-cls-start');
    startBtn.disabled=true;
    document.getElementById('t-cls-status').textContent='در حال بررسی...';
    try{
      const chk=await fetch('/api/classroom/ws?check=1&role=teacher');
      const chkData=await chk.json().catch(()=>({ok:false,error:'پاسخ نامعتبر از سرور'}));
      if(!chkData.ok){
        document.getElementById('t-cls-status').textContent='خطا: '+chkData.error;
        startBtn.disabled=false;
        toast(chkData.error);
        return;
      }
    }catch(e){
      document.getElementById('t-cls-status').textContent='خطا در ارتباط با سرور';
      startBtn.disabled=false;
      return;
    }
    startBtn.disabled=false;
    const proto=location.protocol==='https:'?'wss:':'ws:';
    clsWs=new WebSocket(proto+'//'+location.host+'/api/classroom/ws?role=teacher&name='+encodeURIComponent('معلم'));
    clsWs.onopen=()=>{
      document.getElementById('tdot').classList.add('on');
      document.getElementById('t-cls-status').textContent='کلاس آنلاین فعال است ✅';
      document.getElementById('btn-cls-start').classList.add('hidden');
      document.getElementById('btn-cls-stop').classList.remove('hidden');
      document.getElementById('btn-mic-toggle').classList.remove('hidden');
      document.getElementById('btn-cam-toggle').classList.remove('hidden');
      toast('کلاس آنلاین شروع شد');
    };
    clsWs.onclose=()=>{
      document.getElementById('tdot').classList.remove('on');
      document.getElementById('t-cls-status').textContent='کلاس آنلاین شروع نشده';
      document.getElementById('btn-cls-start').classList.remove('hidden');
      document.getElementById('btn-cls-stop').classList.add('hidden');
      document.getElementById('btn-mic-toggle').classList.add('hidden');
      document.getElementById('btn-cam-toggle').classList.add('hidden');
    };
    clsWs.onmessage=(evt)=>{
      let m;try{m=JSON.parse(evt.data);}catch(e){return;}
      if(m.type==='init'){
        if(m.boardBg){clsSetBoardBgAndReplay(m.boardBg,m.strokes||[]);}
        else{tCtx.clearRect(0,0,tBoard.width,tBoard.height);clsBoardBgImg=null;(m.strokes||[]).forEach(clsDrawLocal);}
        (m.chat||[]).forEach(clsAddChat);clsUpdateParticipants(m.participants||[]);
      }
      else if(m.type==='chat'){clsAddChat(m.entry);}
      else if(m.type==='file'){clsAddFile(m);}
      else if(m.type==='board-bg'){clsSetBoardBg(m.data);}
      else if(m.type==='error'){toast(m.message||'خطا');}
      else if(m.type==='presence'){clsUpdateParticipants(m.participants||[]);if(m.event==='join'&&m.role==='student')toast(m.name+' وارد کلاس شد');}
      else if(m.type==='raise-hand'){toast('✋ '+m.name+' دستش را بلند کرد');}
    };
  };
  document.getElementById('btn-cls-stop').onclick=()=>{
    if(clsRecorder&&clsRecorder.state!=='inactive')clsRecorder.stop();
    if(clsMicStream)clsMicStream.getTracks().forEach(t=>t.stop());
    clsMicStream=null;
    document.getElementById('btn-mic-toggle').textContent='🎙️ روشن کردن میکروفون';
    if(clsCamStream){clsCamStream.getTracks().forEach(t=>t.stop());clsCamStream=null;}
    if(clsCamInterval){clearInterval(clsCamInterval);clsCamInterval=null;}
    document.getElementById('t-cam-preview').classList.add('hidden');
    document.getElementById('t-cam-preview').srcObject=null;
    document.getElementById('btn-cam-toggle').textContent='📷 روشن کردن تصویر';
    document.getElementById('btn-cam-flip').classList.add('hidden');
    clsCamFacing='user';
    clsAudioFromCam=false;
    if(clsWs)clsWs.close();
  };

  document.getElementById('btn-cls-options-toggle').onclick=function(){
    document.getElementById('cls-options-drawer').classList.toggle('hidden');
  };

  function clsStartMicRecorder(stream){
    if(clsAudioActive) return; // جلوگیری از راه‌اندازی دوباره و همپوشانی صدا (علت اصلی تکرار صدا)
    clsMicStream=stream;
    clsAudioActive=true;
    clsAudioGen++;
    const myGen=clsAudioGen;
    const preferredMimes=['audio/webm;codecs=opus','audio/webm','audio/mp4'];
    const mime=preferredMimes.find(m=>window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
    function recordOneChunk(){
      if(myGen!==clsAudioGen || !clsAudioActive || !clsMicStream) return;
      let chunks=[];
      let rec;
      try{ rec=new MediaRecorder(clsMicStream, mime?{mimeType:mime}:undefined); }
      catch(e){ clsAudioActive=false; toast('امکان ضبط صدا در این مرورگر نیست'); return; }
      rec.ondataavailable=(e)=>{ if(e.data && e.data.size>0) chunks.push(e.data); };
      rec.onstop=async()=>{
        if(myGen!==clsAudioGen) return; // این نسل صدا دیگر معتبر نیست (متوقف یا دوباره‌شروع‌شده)
        if(chunks.length){
          const blob=new Blob(chunks, {type: mime||'audio/webm'});
          const buf=await blob.arrayBuffer();
          let binary='';const bytes=new Uint8Array(buf);
          for(let i=0;i<bytes.length;i++)binary+=String.fromCharCode(bytes[i]);
          clsSend({type:'audio', data: btoa(binary), mime: mime||'audio/webm'});
        }
        if(clsAudioActive && myGen===clsAudioGen) setTimeout(recordOneChunk, 15);
      };
      rec.start();
      clsRecorder=rec;
      // هر قطعه یک فایل صوتی کامل و مستقل است (نه یک استریم پیوسته)، برای سازگاری بین مرورگرها
      // مدت کوتاه‌تر = تأخیر کمتر در شنیدن صدای معلم (قبلاً ۳۸۰ میلی‌ثانیه بود؛ کوتاه‌تر شد تا دانش‌آموز کمتر عقب بماند)
      setTimeout(()=>{ if(rec.state==='recording') rec.stop(); }, 260);
    }
    recordOneChunk();
  }
  function clsStopMicRecorder(){
    clsAudioActive=false;
    clsAudioGen++; // هر حلقه‌ی در حال اجرا با چک نسل، خودش را متوقف می‌کند
    if(clsRecorder && clsRecorder.state==='recording')clsRecorder.stop();
    if(clsMicStream)clsMicStream.getTracks().forEach(t=>t.stop());
    clsMicStream=null;
    document.getElementById('btn-mic-toggle').textContent='🎙️ روشن کردن میکروفون';
  }

  document.getElementById('btn-mic-toggle').onclick=async function(){
    if(clsRecorder && clsRecorder.state==='recording'){
      clsStopMicRecorder();
      clsAudioFromCam=false;
      return;
    }
    try{
      const stream=await navigator.mediaDevices.getUserMedia({audio:true});
      clsStartMicRecorder(stream);
      clsAudioFromCam=false;
      this.textContent='🔴 خاموش کردن میکروفون';
      toast('میکروفون فعال شد');
    }catch(e){ toast('دسترسی به میکروفون داده نشد'); }
  };

  document.getElementById('btn-cam-toggle').onclick=async function(){
    const preview=document.getElementById('t-cam-preview');
    if(clsCamStream){
      clsCamStream.getVideoTracks().forEach(t=>t.stop());
      clsCamStream=null;
      if(clsCamInterval){clearInterval(clsCamInterval);clsCamInterval=null;}
      preview.classList.add('hidden');
      preview.srcObject=null;
      this.textContent='📷 روشن کردن تصویر';
      document.getElementById('btn-cam-flip').classList.add('hidden');
      clsCamFacing='user';
      clsSend({type:'video-stop'});
      if(clsAudioFromCam){ clsStopMicRecorder(); clsAudioFromCam=false; }
      return;
    }
    try{
      // نکته: عمداً فقط عرض تقریبی درخواست می‌شود، نه عرض+ارتفاع با هم؛ وقتی هر دو با هم
      // درخواست شوند و با نسبت واقعی دوربین گوشی جور نباشد، خیلی از گوشی‌های اندروید به‌جای
      // برش تصویر، دور آن را با نوار سیاه پر می‌کنند و تصویر خیلی کوچک و وسط‌چین دیده می‌شود.
      clsCamStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:clsCamFacing,width:{ideal:480}}, audio:true});
      preview.srcObject=clsCamStream;
      preview.classList.remove('hidden');
      clsUpdateCamLayout();
      this.textContent='🔴 خاموش کردن تصویر';
      document.getElementById('btn-cam-flip').classList.remove('hidden');
      // اگر میکروفون از قبل روشن نبود، صدا را هم همراه تصویر روشن کن (مثل یک تماس تصویری واقعی)
      if(!(clsRecorder && clsRecorder.state==='recording') && clsCamStream.getAudioTracks().length){
        clsStartMicRecorder(new MediaStream(clsCamStream.getAudioTracks()));
        clsAudioFromCam=true;
        document.getElementById('btn-mic-toggle').textContent='🔴 خاموش کردن میکروفون';
      }
      toast('تماس تصویری (با صدا) فعال شد');
      const cap=document.createElement('canvas');
      const capCtx=cap.getContext('2d');
      clsCamInterval=setInterval(function(){
        if(!clsCamStream)return;
        try{
          // اندازه‌ی بوم گرفتن عکس را دقیقاً برابر نسبت واقعی تصویر دوربین قرار می‌دهیم
          // تا فریم ارسالی بدون نوار سیاه و بدون کشیدگی باشد.
          const vw=preview.videoWidth||480, vh=preview.videoHeight||360;
          if(cap.width!==vw||cap.height!==vh){cap.width=vw;cap.height=vh;}
          capCtx.drawImage(preview,0,0,cap.width,cap.height);
          const dataUrl=cap.toDataURL('image/jpeg',0.7);
          clsSend({type:'video-frame', data: dataUrl});
        }catch(e){}
      },150); // حدود ۶-۷ فریم در ثانیه؛ کیفیت تصویر بالاتر رفته، سرعت کمی متعادل‌تر شده تا حجم ارسالی زیاد نشود
    }catch(e){ toast('دسترسی به دوربین یا میکروفون داده نشد'); }
  };

  document.getElementById('btn-cam-flip').onclick=async function(){
    if(!clsCamStream){toast('ابتدا دوربین را روشن کنید');return;}
    const preview=document.getElementById('t-cam-preview');
    const prevFacing=clsCamFacing;
    const nextFacing=clsCamFacing==='user'?'environment':'user';
    const wasAudioFromCam=clsAudioFromCam;
    if(wasAudioFromCam){ clsStopMicRecorder(); clsAudioFromCam=false; }
    // دوربین فعلی را قبل از درخواست دوربین جدید کاملاً آزاد می‌کنیم؛ خیلی از مرورگرها/دستگاه‌ها
    // اجازه نمی‌دهند دو دوربین همزمان باز باشند و همین باعث می‌شد چرخش دوربین کار نکند.
    clsCamStream.getTracks().forEach(t=>t.stop());
    clsCamStream=null;
    preview.srcObject=null;
    try{
      const newStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{exact:nextFacing},width:{ideal:480}}, audio:true});
      clsCamStream=newStream;
      clsCamFacing=nextFacing;
      preview.srcObject=clsCamStream;
      if(wasAudioFromCam && clsCamStream.getAudioTracks().length){
        clsStartMicRecorder(new MediaStream(clsCamStream.getAudioTracks()));
        clsAudioFromCam=true;
        document.getElementById('btn-mic-toggle').textContent='🔴 خاموش کردن میکروفون';
      }
      toast('دوربین عوض شد 🔄');
    }catch(e){
      toast('این دستگاه دوربین دومی ندارد یا اجازه دسترسی به آن را نمی‌دهد');
      // تلاش برای بازگرداندن دوربین قبلی تا تصویر کلاً قطع نشود
      try{
        clsCamStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:prevFacing,width:{ideal:480}}, audio:true});
        clsCamFacing=prevFacing;
        preview.srcObject=clsCamStream;
        if(wasAudioFromCam && clsCamStream.getAudioTracks().length){
          clsStartMicRecorder(new MediaStream(clsCamStream.getAudioTracks()));
          clsAudioFromCam=true;
          document.getElementById('btn-mic-toggle').textContent='🔴 خاموش کردن میکروفون';
        }
      }catch(e2){
        toast('دسترسی به دوربین قطع شد؛ لطفاً دوباره روی «روشن کردن تصویر» بزنید');
        document.getElementById('btn-cam-toggle').textContent='📷 روشن کردن تصویر';
        document.getElementById('btn-cam-flip').classList.add('hidden');
      }
    }
  };

  // ===================== دفتر مدیریت کلاسی =====================
  // --- ناوبری منو ---
  document.querySelectorAll('.lb-menu-btn').forEach(function(b){
    b.onclick=function(){
      document.getElementById('lb-menu').classList.add('hidden');
      const panel=document.getElementById('lb-panel-'+b.dataset.lb);
      if(panel)panel.classList.remove('hidden');
      if(b.dataset.lb==='pacing'){loadPacingTermIfNeeded().then(function(){lbRenderPacing();lbLoadPacingIfNeeded(lbSelectedGradeIdx());});}
      if(b.dataset.lb==='roster')lbLoadRosterIfNeeded();
      if(b.dataset.lb==='genderstats')lbLoadGenderStatsIfNeeded();
      if(b.dataset.lb==='passrate')lbLoadPassrateIfNeeded();
      if(b.dataset.lb==='attendance2')lbLoadAttendance2IfNeeded();
      if(b.dataset.lb==='grouping')lbLoadGroupingIfNeeded();
      if(b.dataset.lb==='performance'){
        document.getElementById('lbf-form-wrap').classList.add('hidden');
        LB_PERF_CURRENT_UUID=null;
        lbRenderPerfStudentList(lbSelectedPerfGradeIdx());
      }
      if(b.dataset.lb==='reportcard'){
        document.getElementById('rc-form-wrap').classList.add('hidden');
        RC_CURRENT_UUID=null;
        rcRenderStudentList(rcSelectedGradeIdx());
      }
      if(b.dataset.lb==='council')lbLoadCouncilIfNeeded();
      if(b.dataset.lb==='meetings')lbLoadMeetingsIfNeeded();
      if(b.dataset.lb==='weekly')lbLoadWeeklyIfNeeded();
      if(b.dataset.lb==='weekly2')lbLoadWeekly2IfNeeded();
      if(b.dataset.lb==='staff')lbLoadStaffIfNeeded();
      if(b.dataset.lb==='minutes')lbLoadMinutesIfNeeded();
      if(b.dataset.lb==='certificate')lbLoadCertificateIfNeeded();
    };
  });
  document.querySelectorAll('.lb-back-btn').forEach(function(b){
    b.onclick=function(){
      document.querySelectorAll('.lb-panel').forEach(function(p){p.classList.add('hidden');});
      document.getElementById('lb-menu').classList.remove('hidden');
    };
  });

  // --- ابزارهای مشترک خروجی ---
  function lbMetaBlock(fields){ // fields: [[label,inputId]]
    return '<p class="lb-meta">'+fields.map(function(f){
      var el=document.getElementById(f[1]);
      var val=el?el.value:'';
      return '<b>'+f[0]+':</b> '+esc(val||'.......................')+'&nbsp;&nbsp;&nbsp;&nbsp;';
    }).join('')+'</p>';
  }
  function lbFontFaceCss(fontFamily){
    var css='';
    if(fontFamily&&fontFamily.indexOf('Titr')!==-1)css+='@font-face{font-family:"BTitr";src:url(https://cdn.jsdelivr.net/gh/intuxicated/css-persian@master/fonts/BTitrBold.ttf)}';
    if(fontFamily&&fontFamily.indexOf('Nazanin')!==-1)css+='@font-face{font-family:"BNazanin";src:url(https://cdn.jsdelivr.net/gh/intuxicated/css-persian@master/fonts/BNazanin.ttf)}';
    if(fontFamily&&fontFamily.indexOf('Nastaliq')!==-1)css+='@import url(https://fonts.googleapis.com/css2?family=Noto+Nastaliq+Urdu:wght@400..700&display=swap);';
    if(fontFamily&&fontFamily.indexOf('Mitra')!==-1)css+='@font-face{font-family:"BMitra";src:url(https://cdn.jsdelivr.net/gh/intuxicated/css-persian@master/fonts/BMitra.ttf)}';
    if(fontFamily&&fontFamily.indexOf('Koodak')!==-1)css+='@font-face{font-family:"BKoodak";src:url(https://cdn.jsdelivr.net/gh/intuxicated/css-persian@master/fonts/BKoodakBold.ttf)}';
    if(fontFamily&&fontFamily.indexOf('Vazirmatn')!==-1)css+='@import url(https://cdn.jsdelivr.net/gh/rastikerdar/vazirmatn@v33.003/Vazirmatn-font-face.css);';
    return css;
  }
  function lbWordExport(title,bodyHtml,filename,landscape,fontFamily,fontSize){
    var pageCss=landscape
      ? '@page Section1 {size:29.7cm 21cm;mso-page-orientation:landscape;margin:1.2cm} div.Section1{page:Section1}'
      : '@page Section1 {size:21cm 29.7cm;margin:1.5cm} div.Section1{page:Section1}';
    var ff=fontFamily||'tahoma,Arial';
    var fs=fontSize||(landscape?10:12);
    var style='<style>'+lbFontFaceCss(fontFamily)+pageCss+' body{direction:rtl;font-family:'+ff+';padding:6px}h1,h2,h3{text-align:center}table{width:100%;border-collapse:collapse;margin:10px 0}th,td{border:1px solid #333;padding:'+(landscape?'4px':'6px')+';text-align:center;font-size:'+fs+'px;font-family:'+ff+'}th{background:#dbeafe}.lb-meta{margin-bottom:14px;font-size:14px}.lb-nowruz{background:#16a34a;color:#fff;font-weight:bold}.lb-table-zebra tbody tr:nth-child(odd){background:#f4f6f8}</style>';
    var blob=new Blob(['<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8">'+style+'<title>'+esc(title)+'</title></head><body><div class="Section1"><h2>'+esc(title)+'</h2>'+bodyHtml+'</div></body></html>'],{type:'application/msword'});
    var a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=filename+'.doc';document.body.appendChild(a);a.click();a.remove();
  }
  function lbPrintExport(title,bodyHtml,landscape,fontFamily,fontSize){
    var ff=fontFamily||'tahoma,Arial';
    var fs=fontSize||10;
    var style='<style>'+lbFontFaceCss(fontFamily)+'@page{size:A4 '+(landscape===false?'portrait':'landscape')+';margin:8mm}body{direction:rtl;font-family:'+ff+';padding:6px}h1,h2,h3{text-align:center}table{width:100%;border-collapse:collapse;margin:8px 0}th,td{border:1px solid #333;padding:4px;text-align:center;font-size:'+fs+'px;font-family:'+ff+'}th{background:#dbeafe}.lb-meta{margin-bottom:10px;font-size:12px}.lb-nowruz{background:#16a34a;color:#fff;font-weight:bold}.lb-table-zebra tbody tr:nth-child(odd){background:#f4f6f8}</style>';
    var w=window.open('','_blank');
    if(!w){toast('اجازه‌ی باز کردن پنجره‌ی چاپ داده نشد (popup blocked)');return;}
    w.document.write('<html><head><meta charset="utf-8">'+style+'<title>'+esc(title)+'</title></head><body><h2>'+esc(title)+'</h2>'+bodyHtml+'</body></html>');
    w.document.close();
    setTimeout(function(){w.print();},500);
  }
  // ابزار عمومی: بزرگ/کوچک کردن زنده‌ی فونت جدول‌های نمایشی + کشوی آچار برای تنظیمات چاپ (جهت صفحه/اندازه فونت)
  function lbLiveFontSize(tableSelector,inputId,incId,decId,defaultPx){
    function apply(px){
      px=Math.max(8,Math.min(30,parseInt(px,10)||defaultPx));
      var input=document.getElementById(inputId);
      if(input)input.value=px;
      document.querySelectorAll(tableSelector+' th,'+tableSelector+' td,'+tableSelector+' input,'+tableSelector+' textarea').forEach(function(el){el.style.fontSize=px+'px';});
      return px;
    }
    var input=document.getElementById(inputId);
    if(input)input.addEventListener('input',function(){apply(this.value);});
    var incBtn=document.getElementById(incId);
    if(incBtn)incBtn.onclick=function(){apply((parseInt(document.getElementById(inputId).value,10)||defaultPx)+1);};
    var decBtn=document.getElementById(decId);
    if(decBtn)decBtn.onclick=function(){apply((parseInt(document.getElementById(inputId).value,10)||defaultPx)-1);};
    return {apply:apply,current:function(){return parseInt((document.getElementById(inputId)||{}).value,10)||defaultPx;}};
  }
  function lbSetupPrintWrench(o){
    var toggle=document.getElementById(o.toggleId);
    if(toggle)toggle.onclick=function(){
      var drawer=document.getElementById(o.drawerId);
      if(drawer.classList.contains('hidden')&&o.currentSizeFn){
        var fsInp=document.getElementById(o.fontSizeId);
        if(fsInp)fsInp.value=o.currentSizeFn();
      }
      drawer.classList.toggle('hidden');
    };
    var printBtn=document.getElementById(o.printBtnId);
    if(printBtn)printBtn.onclick=function(){
      var landscape=document.getElementById(o.orientationId).value==='landscape';
      var fontSize=parseInt(document.getElementById(o.fontSizeId).value,10)||(o.currentSizeFn?o.currentSizeFn():10);
      lbPrintExport(o.title,o.exportFn(),landscape,o.fontFamilyFn?o.fontFamilyFn():'',fontSize);
    };
    var wordBtn=document.getElementById(o.wordBtnId);
    if(wordBtn)wordBtn.onclick=function(){
      var landscape=document.getElementById(o.orientationId).value==='landscape';
      var fontSize=parseInt(document.getElementById(o.fontSizeId).value,10)||(o.currentSizeFn?o.currentSizeFn():10);
      lbWordExport(o.title,o.exportFn(),o.filename,landscape,o.fontFamilyFn?o.fontFamilyFn():'',fontSize);
    };
  }
  async function lbExcelExport(filename,buildFn){
    try{
      await loadExcelJS();
      var wb=new ExcelJS.Workbook();
      await buildFn(wb);
      var buf=await wb.xlsx.writeBuffer();
      var blob=new Blob([buf],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
      var a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=filename+'.xlsx';document.body.appendChild(a);a.click();a.remove();
      toast('فایل اکسل ساخته شد ✅');
    }catch(e){toast('خطا در ساخت فایل اکسل');}
  }
  function lbAddExcelSheet(wb,sheetName,rows,styleHeader){
    var ws=wb.addWorksheet(sheetName.slice(0,31),{views:[{rightToLeft:true}]});
    rows.forEach(function(rowArr,ri){
      var row=ws.addRow(rowArr);
      if(ri===0 && styleHeader!==false){
        row.eachCell(function(cell){
          cell.font={bold:true};
          cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFDBEAFE'}};
          cell.alignment={horizontal:'center',vertical:'middle'};
        });
      }
    });
    ws.columns.forEach(function(col){
      var maxLen=10;
      col.eachCell({includeEmpty:true},function(cell){
        var len=(cell.value?String(cell.value).length:0);
        if(len>maxLen)maxLen=len;
      });
      col.width=Math.min(35,maxLen+3);
    });
    return ws;
  }

  // --- تبدیل جدول‌های پویا (ردیفی) به آرایه‌ی داده برای خروجی ---
  function lbTableToRows(tableEl){
    if(!tableEl)return [[]];
    var headers=Array.from(tableEl.querySelectorAll('thead th')).map(function(th){return th.textContent.trim();});
    var rows=[headers];
    tableEl.querySelectorAll('tbody tr').forEach(function(tr){
      var row=[];
      tr.querySelectorAll('td').forEach(function(td){
        var inp=td.querySelector('input,textarea');
        row.push(inp?inp.value:td.textContent.trim());
      });
      rows.push(row);
    });
    return rows;
  }
  // پاک کردن تمام مقادیر ورودی داخل یک جدول/بخش (بدون دست زدن به چک‌باکس‌ها)، با فراخوانی رویداد input تا داده‌های وابسته (LB_*_DATA) هم به‌روز شوند
  function lbClearContainer(containerId){
    if(!confirm('آیا از پاک‌کردن تمام اطلاعات این جدول مطمئن هستید؟ این کار قابل بازگشت نیست.'))return;
    var el=document.getElementById(containerId);
    if(!el)return;
    el.querySelectorAll('input,textarea').forEach(function(inp){
      if(inp.type==='checkbox'||inp.type==='radio')return;
      inp.value='';
      inp.dispatchEvent(new Event('input',{bubbles:true}));
    });
    toast('جدول پاک شد ✅');
  }
  window.lbClearContainer=lbClearContainer;
  function lbRowsToHtmlTable(rows){
    if(!rows.length)return '<table></table>';
    var h='<table><tr>'+rows[0].map(function(c){return '<th>'+esc(c)+'</th>';}).join('')+'</tr>';
    for(var i=1;i<rows.length;i++){
      h+='<tr>'+rows[i].map(function(c){return '<td>'+esc(c)+'</td>';}).join('')+'</tr>';
    }
    h+='</table>';
    return h;
  }
  function lbBuildSimpleTableHtml(headers,rowCount){
    var h='<thead><tr>'+headers.map(function(hd){return '<th>'+esc(hd)+'</th>';}).join('')+'</tr></thead><tbody>';
    for(var r=1;r<=rowCount;r++){
      h+='<tr><td>'+r+'</td>';
      for(var c=1;c<headers.length;c++){h+='<td><input type="text"></td>';}
      h+='</tr>';
    }
    h+='</tbody>';
    return h;
  }
  // سربرگ رنگی و شکلک‌دار مخصوص جدول لیست اسامی دانش‌آموزان
  var LB_ROSTER_ICONS=['🔢','👤','👨','🪪','📞','🏠','📝'];
  function lbBuildRosterTableHtml(headers,rowCount){
    var h='<thead><tr>'+headers.map(function(hd,i){
      return '<th class="lbr-th-'+i+'"><span class="lbr-th-ico">'+(LB_ROSTER_ICONS[i]||'')+'</span><span class="lbr-th-txt">'+esc(hd)+'</span></th>';
    }).join('')+'</tr></thead><tbody>';
    for(var r=1;r<=rowCount;r++){
      h+='<tr><td>'+r+'</td>';
      for(var c=1;c<headers.length;c++){h+='<td><input type="text"></td>';}
      h+='</tr>';
    }
    h+='</tbody>';
    return h;
  }
  function lbAddSimpleRow(tableId,colCount){
    var tbody=document.querySelector('#'+tableId+' tbody');
    if(!tbody)return;
    var rowNum=tbody.children.length+1;
    var tr=document.createElement('tr');
    var html='<td>'+rowNum+'</td>';
    for(var c=1;c<colCount;c++)html+='<td><input type="text"></td>';
    tr.innerHTML=html;
    tbody.appendChild(tr);
  }
  // چسباندن هوشمند (مثل اکسل): چند مقدار کپی‌شده از یک ستون (یا چند ستون) را در خانه‌های زیرین/کناری پخش می‌کند
  // و در صورت نیاز، بدون پاک‌کردن داده‌های موجود، ردیف‌های جدید هم اضافه می‌کند
  // نکته: ستون‌ها بر اساس موقعیت ورودی‌ها (input/textarea) در هر ردیف شمارش می‌شوند، نه موقعیت td/th؛
  // این باعث می‌شود جدول‌هایی با rowspan نامنظم (مثل برنامه هفتگی) هم درست تراز بمانند.
  function lbEnablePaste(tableId,allowAddRows){
    if(allowAddRows===undefined)allowAddRows=true;
    var tableEl=document.getElementById(tableId);
    if(!tableEl)return;
    tableEl.addEventListener('paste',function(e){
      var target=e.target;
      if(!target||(target.tagName!=='INPUT'&&target.tagName!=='TEXTAREA'))return;
      var tr=target.closest('tr');if(!tr)return;
      var tbody=tr.parentElement;
      var rowInputs=Array.from(tr.querySelectorAll('input,textarea'));
      var colIdx=rowInputs.indexOf(target);
      var rows=Array.from(tbody.children);
      var rowIdx=rows.indexOf(tr);
      var text=(e.clipboardData||window.clipboardData).getData('text');
      if(!text)return;
      var lines=text.replace(/\\r/g,'').split('\\n');
      while(lines.length>1&&lines[lines.length-1]==='')lines.pop();
      var grid=lines.map(function(l){return l.split('\\t');});
      var isMulti=grid.length>1||(grid[0]&&grid[0].length>1);
      if(!isMulti)return;
      e.preventDefault();
      if(allowAddRows){
        var colCount=tr.children.length;
        var neededRows=rowIdx+grid.length;
        while(rows.length<neededRows){
          lbAddSimpleRow(tableId,colCount);
          rows=Array.from(tbody.children);
        }
      }
      grid.forEach(function(rowArr,ri){
        var targetTr=rows[rowIdx+ri];
        if(!targetTr)return;
        var targetInputs=Array.from(targetTr.querySelectorAll('input,textarea'));
        rowArr.forEach(function(val,ci){
          var cc=colIdx+ci;
          if(cc>=targetInputs.length)return;
          var inp=targetInputs[cc];
          if(inp){
            inp.value=val.trim();
            inp.dispatchEvent(new Event('input',{bubbles:true}));
          }
        });
      });
      toast('چسبانده شد: '+grid.length+' ردیف ✅');
    });
  }
  // ساخت دوباره‌ی جدول (مثلاً با تعداد ردیف جدید) بدون پاک شدن اطلاعاتی که قبلاً تایپ شده
  function lbRebuildPreserving(tableId,headers,rowCount,headerHtmlBuilder){
    var tableEl=document.getElementById(tableId);
    var oldRows=tableEl.querySelector('tbody')?lbTableToRows(tableEl).slice(1):[];
    tableEl.innerHTML=(headerHtmlBuilder||lbBuildSimpleTableHtml)(headers,rowCount);
    var trs=tableEl.querySelectorAll('tbody tr');
    trs.forEach(function(tr,rIdx){
      var oldRow=oldRows[rIdx];
      if(!oldRow)return;
      var tds=tr.querySelectorAll('td');
      tds.forEach(function(td,cIdx){
        if(cIdx===0)return; // ستون ردیف را دست نمی‌زنیم
        var inp=td.querySelector('input,textarea');
        if(inp && oldRow[cIdx]!==undefined)inp.value=oldRow[cIdx];
      });
    });
  }

  // پر کردن جدول از داده‌های ذخیره‌شده (بازیابی از سرور)
  function lbFillTableRows(tableId,dataRows){
    var tableEl=document.getElementById(tableId);
    if(!tableEl||!dataRows)return;
    var trs=tableEl.querySelectorAll('tbody tr');
    trs.forEach(function(tr,rIdx){
      var row=dataRows[rIdx];
      if(!row)return;
      var tds=tr.querySelectorAll('td');
      tds.forEach(function(td,cIdx){
        if(cIdx===0)return;
        var inp=td.querySelector('input,textarea');
        if(inp && row[cIdx]!==undefined)inp.value=row[cIdx];
      });
    });
  }

  // ===================== ۱. جدول بودجه‌بندی =====================
  var LB_GRADES=[
    {title:'پایه اول دبستان',subjects:['فارسی','نگارش فارسی','ریاضی','علوم تجربی','قرآن','هدیه‌های آسمان']},
    {title:'پایه دوم دبستان',subjects:['فارسی','نگارش فارسی','ریاضی','علوم تجربی','قرآن','هدیه‌های آسمان']},
    {title:'پایه سوم دبستان',subjects:['فارسی','نگارش فارسی','ریاضی','علوم تجربی','مطالعات اجتماعی','قرآن','هدیه‌های آسمان']},
    {title:'پایه چهارم دبستان',subjects:['فارسی','نگارش فارسی','ریاضی','علوم تجربی','مطالعات اجتماعی','قرآن','هدیه‌های آسمان']},
    {title:'پایه پنجم دبستان',subjects:['فارسی','نگارش فارسی','ریاضی','علوم تجربی','مطالعات اجتماعی','قرآن','هدیه‌های آسمان']},
    {title:'پایه ششم دبستان',subjects:['فارسی (بخوانیم)','نگارش فارسی','ریاضی','علوم تجربی','مطالعات اجتماعی','قرآن','هدیه‌های آسمان','کار و فناوری','تفکر و پژوهش']}
  ];
  var LB_MONTHS1=['مهر','آبان','آذر','دی'];
  var LB_MONTHS2=['بهمن','اسفند','فروردین','اردیبهشت'];
  var LB_PACING_DATA={}; // { gradeIdx: [ [16 مقدار برای هر سطر درس], ... ] } - نگه‌داری مقادیر تایپ‌شده هر پایه در حافظه
  function lbBuildPacingTableHtml(gradeIdx,forExport,term){
    term=term||'both';
    var showT1=term==='both'||term==='t1';
    var showT2=term==='both'||term==='t2';
    var grade=LB_GRADES[gradeIdx];
    var subjects=grade.subjects;
    var saved=LB_PACING_DATA[gradeIdx];
    var h='<h3 class="lb-pacing-title">'+esc(grade.title)+'</h3><div class="lb-pacing-wrap"><table class="lb-pacing-table"><thead>';
    h+='<tr><th rowspan="3">موضوع</th>';
    if(showT1)h+='<th colspan="8">نوبت اول</th>';
    if(term==='both')h+='<th rowspan="3" class="lb-nowruz">تعطیلات<br>نوروز</th>';
    if(showT2)h+='<th colspan="8">نوبت دوم</th>';
    h+='</tr><tr>';
    if(showT1)h+=LB_MONTHS1.map(function(m){return '<th colspan="2">'+m+'</th>';}).join('');
    if(showT2)h+=LB_MONTHS2.map(function(m){return '<th colspan="2">'+m+'</th>';}).join('');
    h+='</tr><tr>';
    if(showT1)h+=Array(4).fill('<th>نیمه۱</th><th>نیمه۲</th>').join('');
    if(showT2)h+=Array(4).fill('<th>نیمه۱</th><th>نیمه۲</th>').join('');
    h+='</tr>';
    h+='</thead><tbody>';
    function cellHtml(rowIdx,colIdx){
      var val=(saved&&saved[rowIdx]&&saved[rowIdx][colIdx])||'';
      if(forExport)return '<td class="lb-cell">'+esc(val).replace(/\\n/g,'<br>')+'</td>';
      return '<td class="lb-cell"><textarea class="lb-pacing-input" data-grade="'+gradeIdx+'" data-row="'+rowIdx+'" data-col="'+colIdx+'" rows="3" placeholder="شماره درس / صفحات / زمان / توضیحات">'+esc(val)+'</textarea></td>';
    }
    subjects.forEach(function(subj,i){
      h+='<tr><td class="lb-subject">'+esc(subj)+'</td>';
      if(showT1)for(var c=0;c<8;c++)h+=cellHtml(i,c);
      if(i===0&&term==='both')h+='<td class="lb-nowruz" rowspan="'+subjects.length+'">تعطیلات<br>نوروز</td>';
      if(showT2)for(var c2=8;c2<16;c2++)h+=cellHtml(i,c2);
      h+='</tr>';
    });
    h+='</tbody></table></div>';
    return h;
  }
  function lbSelectedGradeIdx(){
    return parseInt(document.getElementById('lbp-grade-select').value,10)||0;
  }
  function lbSelectedGrade(){
    return LB_GRADES[lbSelectedGradeIdx()];
  }
  function lbSelectedPacingTerm(){
    var el=document.getElementById('lbp-term-select');
    return el?el.value:'both';
  }
  function lbRenderPacing(){
    var idx=lbSelectedGradeIdx();
    var term=lbSelectedPacingTerm();
    var el=document.getElementById('lb-pacing-preview');
    el.innerHTML=lbBuildPacingTableHtml(idx,false,term)+
      '<p><b>توضیحات:</b></p><p class="muted">این بودجه‌بندی پیشنهادی می‌باشد.</p>';
    // ذخیره‌ی زنده‌ی مقادیر تایپ‌شده در حافظه (تا با تغییر پایه از بین نروند)
    el.querySelectorAll('.lb-pacing-input').forEach(function(ta){
      ta.addEventListener('input',function(){
        var g=parseInt(ta.dataset.grade,10),r=parseInt(ta.dataset.row,10),c=parseInt(ta.dataset.col,10);
        if(!LB_PACING_DATA[g])LB_PACING_DATA[g]=[];
        if(!LB_PACING_DATA[g][r])LB_PACING_DATA[g][r]=[];
        LB_PACING_DATA[g][r][c]=ta.value;
      });
    });
  }
  document.getElementById('lbp-term-select').addEventListener('change',function(){
    lbRenderPacing();
    lbSave('pacing-term',document.getElementById('lbp-term-select').value,true);
  });
  var LB_PACING_TERM_LOADED=false;
  async function loadPacingTermIfNeeded(){
    if(LB_PACING_TERM_LOADED)return;
    LB_PACING_TERM_LOADED=true;
    var saved=await lbLoad('pacing-term');
    if(saved)document.getElementById('lbp-term-select').value=saved;
  }
  var LB_PACING_LOADED={};
  async function lbLoadPacingIfNeeded(idx){
    if(LB_PACING_LOADED[idx])return;
    LB_PACING_LOADED[idx]=true;
    var saved=await lbLoad('pacing:'+idx);
    if(saved){
      if(saved.data)LB_PACING_DATA[idx]=saved.data;
      if(saved.meta){
        document.getElementById('lbp-school').value=saved.meta.school||'';
        document.getElementById('lbp-teacher').value=saved.meta.teacher||'';
        document.getElementById('lbp-year').value=saved.meta.year||'';
      }
      lbRenderPacing();
    }
  }
  document.getElementById('lbp-grade-select').addEventListener('change',function(){
    lbLoadPacingIfNeeded(lbSelectedGradeIdx()).then(lbRenderPacing);
  });
  lbEnablePaste('lb-pacing-preview',false);
  document.getElementById('btn-lbp-save').onclick=function(){
    var idx=lbSelectedGradeIdx();
    lbSave('pacing:'+idx,{
      meta:{school:document.getElementById('lbp-school').value,teacher:document.getElementById('lbp-teacher').value,year:document.getElementById('lbp-year').value},
      data:LB_PACING_DATA[idx]||[]
    });
  };
  document.getElementById('btn-lbp-ai-fill').onclick=async function(){
    var idx=lbSelectedGradeIdx();
    var grade=LB_GRADES[idx];
    var subjects=grade.subjects;
    var btn=this;
    var oldText=btn.textContent;
    btn.disabled=true;btn.textContent='⏳ در حال تولید پیشنهاد...';
    var sys='شما دستیار برنامه‌ریزی درسی معلمان دوره‌ی ابتدایی ایران هستید. برای پایه‌ی «'+grade.title+'» بر اساس دروس زیر به همین ترتیب، یک بودجه‌بندی آموزشی پیشنهادی برای سال تحصیلی تولید کن. '+
      'دروس به ترتیب: '+subjects.join('، ')+'. '+
      'برای هر درس دقیقاً ۱۶ بازه‌ی زمانی به این ترتیب وجود دارد: نیمه۱ و نیمه۲ از هر یک از ماه‌های مهر، آبان، آذر، دی (۸ بازه‌ی نوبت اول)، سپس نیمه۱ و نیمه۲ از هر یک از ماه‌های بهمن، اسفند، فروردین، اردیبهشت (۸ بازه‌ی نوبت دوم). '+
      'برای هر بازه یک متن بسیار کوتاه (حداکثر ۸ تا ۱۰ کلمه) بنویس شامل شماره/نام درس یا فصل کتاب رسمی و در صورت لزوم صفحات تقریبی، طبق روال معمول و متعارف کتاب‌های درسی رسمی ایران برای این پایه. '+
      'خروجی را فقط و فقط به‌صورت یک آرایه‌ی JSON معتبر برگردان که شامل یک زیرآرایه به ازای هر درس (دقیقاً به همان ترتیب دروس بالا) است و هر زیرآرایه دقیقاً ۱۶ رشته دارد، بدون هیچ توضیح اضافه، بدون Markdown و بدون علامت‌های کد (بک‌تیک).';
    try{
      var res=await fetch('/api/teacher/ai/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:[{role:'system',content:sys},{role:'user',content:'بودجه‌بندی را طبق فرمت JSON خواسته‌شده تولید کن.'}],max_tokens:8192,provider:getAiProvider()})});
      var data=await res.json();
      if(data.error)throw new Error(data.error);
      var raw=(data.content||'').trim();
      var i1=raw.indexOf('['),i2=raw.lastIndexOf(']');
      if(i1===-1||i2===-1||i2<i1){
        console.error('پاسخ خام هوش مصنوعی برای بودجه‌بندی (غیرقابل تفسیر):',raw);
        throw new Error('پاسخ هوش مصنوعی ناقص یا خالی بود (احتمالاً به‌خاطر تعداد زیاد دروس این پایه بریده شده)؛ دوباره تلاش کنید');
      }
      var parsed=JSON.parse(raw.slice(i1,i2+1));
      if(!Array.isArray(parsed))throw new Error('پاسخ نامعتبر بود');
      var result=[];
      for(var i=0;i<subjects.length;i++){
        var row=Array.isArray(parsed[i])?parsed[i]:[];
        var fixedRow=[];
        for(var c=0;c<16;c++)fixedRow.push(typeof row[c]==='string'?row[c]:'');
        result.push(fixedRow);
      }
      LB_PACING_DATA[idx]=result;
      lbRenderPacing();
      toast('پیشنهاد بودجه‌بندی «'+grade.title+'» با هوش مصنوعی پر شد؛ لطفاً بررسی و در صورت نیاز ویرایش کنید ✅');
    }catch(e){
      toast('خطا در تولید پیشنهاد: '+e.message);
    }
    btn.disabled=false;btn.textContent=oldText;
  };
  function lbPacingFullHtml(){
    var idx=lbSelectedGradeIdx();
    var grade=LB_GRADES[idx];
    var term=lbSelectedPacingTerm();
    var showT1=term==='both'||term==='t1';
    var showT2=term==='both'||term==='t2';
    var meta=lbMetaBlock([['نام مدرسه','lbp-school'],['نام آموزگار','lbp-teacher'],['سال تحصیلی','lbp-year']]);
    meta+='<p><b>پایه تحصیلی:</b> '+esc(grade.title)+'</p>';
    var note='<p><b>توضیحات:</b></p><p>این بودجه‌بندی پیشنهادی می‌باشد.</p>';
    // فقط نوبتی که در انتخاب کاربر فعال است ساخته و چاپ می‌شود؛ اگر هر دو نوبت انتخاب شده باشند، هر دو در یک صفحه (بدون شکست صفحه) پشت سر هم می‌آیند
    var out='';
    if(showT1)out+=meta+'<p style="font-weight:700;font-size:15px;margin:6px 0">نوبت اول (مهر تا دی)</p>'+lbBuildPacingTableHtml(idx,true,'t1')+note;
    if(showT2)out+=meta+'<p style="font-weight:700;font-size:15px;margin:6px 0">نوبت دوم (بهمن تا اردیبهشت)</p>'+lbBuildPacingTableHtml(idx,true,'t2')+note;
    return out;
  }
  document.getElementById('btn-lb-pacing-word').onclick=function(){lbWordExport('جدول بودجه‌بندی آموزشی - '+lbSelectedGrade().title,lbPacingFullHtml(),'بودجه-بندی-'+lbSelectedGrade().title,true);};
  document.getElementById('btn-lb-pacing-pdf').onclick=function(){lbPrintExport('جدول بودجه‌بندی آموزشی - '+lbSelectedGrade().title,lbPacingFullHtml(),true);};
  document.getElementById('btn-lb-pacing-excel').onclick=function(){
    var idx=lbSelectedGradeIdx();
    var grade=LB_GRADES[idx];
    var saved=LB_PACING_DATA[idx]||[];
    lbExcelExport('بودجه-بندی-'+grade.title,function(wb){
      var headerRow1=['موضوع'].concat(LB_MONTHS1.reduce(function(a,m){return a.concat([m,'']);},[])).concat(['تعطیلات نوروز']).concat(LB_MONTHS2.reduce(function(a,m){return a.concat([m,'']);},[]));
      var headerRow2=[''].concat(Array(8).fill(0).map(function(_,i){return i%2===0?'نیمه۱':'نیمه۲';})).concat(['']).concat(Array(8).fill(0).map(function(_,i){return i%2===0?'نیمه۱':'نیمه۲';}));
      var rows=[headerRow1,headerRow2];
      grade.subjects.forEach(function(subj,i){
        var rowVals=saved[i]||[];
        var first8=[];for(var c=0;c<8;c++)first8.push(rowVals[c]||'');
        var second8=[];for(var c2=8;c2<16;c2++)second8.push(rowVals[c2]||'');
        rows.push([subj].concat(first8).concat(['']).concat(second8));
      });
      lbAddExcelSheet(wb,grade.title,rows);
    });
  };

  // ===================== ۲. لیست اسامی دانش‌آموزان =====================
  var LB_ROSTER_HEADERS=['ردیف','نام و نام خانوادگی دانش‌آموز','نام پدر','کد ملی','شماره تماس ولی','آدرس محل سکونت','توضیحات و پیگیری‌های لازم'];
  document.getElementById('btn-lbr-build').onclick=function(){
    var n=parseInt(document.getElementById('lbr-rows').value,10)||30;
    lbRebuildPreserving('lbr-table',LB_ROSTER_HEADERS,n,lbBuildRosterTableHtml);
  };
  document.getElementById('btn-lbr-addrow').onclick=function(){lbAddSimpleRow('lbr-table',LB_ROSTER_HEADERS.length);};
  document.getElementById('btn-lbr-build').click();
  lbEnablePaste('lbr-table');
  lbEnablePaste('lb-weekly-preview',false);
  lbEnablePaste('lb-weekly2-preview',false);
  function lbRosterExportHtml(){
    var meta=lbMetaBlock([['نام مدرسه','lbr-school'],['نام آموزگار','lbr-teacher'],['پایه تحصیلی','lbr-grade'],['سال تحصیلی','lbr-year']]);
    var rows=lbTableToRows(document.getElementById('lbr-table'));
    return meta+lbRowsToHtmlTable(rows)+'<p style="margin-top:14px"><b>ادامه اسامی دانش‌آموزان</b></p>';
  }
  document.getElementById('btn-lb-roster-word').onclick=function(){lbWordExport('جدول لیست اسامی دانش‌آموزان',lbRosterExportHtml(),'لیست-اسامی-دانش-آموزان',true);};
  document.getElementById('btn-lb-roster-pdf').onclick=function(){lbPrintExport('جدول لیست اسامی دانش‌آموزان',lbRosterExportHtml(),true);};
  document.getElementById('btn-lbr-print-opts-toggle').onclick=function(){
    document.getElementById('lbr-print-opts-drawer').classList.toggle('hidden');
  };
  var LBR_PRINT_FONTS={default:'',nazanin:"'B Nazanin','BNazanin',tahoma,Arial",mitra:"'B Mitra','BMitra',tahoma,Arial",titr:"'B Titr','BTitr',tahoma,Arial"};
  document.getElementById('btn-lbr-print-custom').onclick=function(){
    var landscape=document.getElementById('lbr-print-orientation').value==='landscape';
    var fontKey=document.getElementById('lbr-print-font').value;
    var fontSize=parseInt(document.getElementById('lbr-print-fontsize').value,10)||10;
    lbPrintExport('جدول لیست اسامی دانش‌آموزان',lbRosterExportHtml(),landscape,LBR_PRINT_FONTS[fontKey]||'',fontSize);
  };
  document.getElementById('btn-lbr-word-custom').onclick=function(){
    var landscape=document.getElementById('lbr-print-orientation').value==='landscape';
    var fontKey=document.getElementById('lbr-print-font').value;
    var fontSize=parseInt(document.getElementById('lbr-print-fontsize').value,10)||10;
    lbWordExport('جدول لیست اسامی دانش‌آموزان',lbRosterExportHtml(),'لیست-اسامی-دانش-آموزان',landscape,LBR_PRINT_FONTS[fontKey]||'',fontSize);
  };
  document.getElementById('btn-lb-roster-excel').onclick=function(){
    lbExcelExport('لیست-اسامی-دانش-آموزان',function(wb){
      lbAddExcelSheet(wb,'لیست اسامی',lbTableToRows(document.getElementById('lbr-table')));
    });
  };
  var LB_ROSTER_LOADED=false;
  async function lbLoadRosterIfNeeded(){
    if(LB_ROSTER_LOADED)return;
    LB_ROSTER_LOADED=true;
    var saved=await lbLoad('roster');
    if(!saved)return;
    if(saved.meta){
      document.getElementById('lbr-school').value=saved.meta.school||'';
      document.getElementById('lbr-teacher').value=saved.meta.teacher||'';
      document.getElementById('lbr-grade').value=saved.meta.grade||'';
      document.getElementById('lbr-year').value=saved.meta.year||'';
    }
    if(saved.rowCount){document.getElementById('lbr-rows').value=saved.rowCount;document.getElementById('btn-lbr-build').click();}
    if(saved.rows)lbFillTableRows('lbr-table',saved.rows);
  }
  document.getElementById('btn-lbr-save').onclick=function(){
    lbSave('roster',{
      meta:{school:document.getElementById('lbr-school').value,teacher:document.getElementById('lbr-teacher').value,grade:document.getElementById('lbr-grade').value,year:document.getElementById('lbr-year').value},
      rowCount:parseInt(document.getElementById('lbr-rows').value,10)||30,
      rows:lbTableToRows(document.getElementById('lbr-table')).slice(1)
    });
  };

  // ===================== آمار دانش‌آموزان به تفکیک جنسیت =====================
  var LBG_GRADE_NAMES=['اول','دوم','سوم','چهارم','پنجم','ششم'];
  function lbgRecalc(){
    var totalBoy=0,totalGirl=0;
    for(var g=1;g<=6;g++){
      var boyInp=document.querySelector('.lbg-boy[data-grade="'+g+'"]');
      var girlInp=document.querySelector('.lbg-girl[data-grade="'+g+'"]');
      var sumCell=document.querySelector('.lbg-sum[data-grade="'+g+'"]');
      var b=parseInt(toEnDigits(boyInp.value),10)||0;
      var gi=parseInt(toEnDigits(girlInp.value),10)||0;
      sumCell.textContent=toFaDigits(b+gi);
      totalBoy+=b;totalGirl+=gi;
    }
    document.getElementById('lbg-foot-boy').textContent=toFaDigits(totalBoy);
    document.getElementById('lbg-foot-girl').textContent=toFaDigits(totalGirl);
    document.getElementById('lbg-foot-all').textContent=toFaDigits(totalBoy+totalGirl);
    document.getElementById('lbg-total-boy').textContent=toFaDigits(totalBoy);
    document.getElementById('lbg-total-girl').textContent=toFaDigits(totalGirl);
    document.getElementById('lbg-total-all').textContent=toFaDigits(totalBoy+totalGirl);
  }
  document.getElementById('lbg-table').addEventListener('input',function(e){
    if(e.target && (e.target.classList.contains('lbg-boy')||e.target.classList.contains('lbg-girl'))){
      // فقط رقم مجاز است؛ هر عددی که تایپ می‌شود بلافاصله به رقم فارسی تبدیل می‌شود
      var cleaned=toEnDigits(e.target.value).replace(/[^0-9]/g,'').slice(0,3);
      e.target.value=toFaDigits(cleaned);
      lbgRecalc();
    }
  });
  // فونت: پیش‌فرض / B Titr / B Nazanin / B Mitra
  var LBG_FONTS={default:'',titr:"'B Titr','BTitr',Tahoma,Arial",nazanin:"'B Nazanin','BNazanin',Tahoma,Arial",mitra:"'B Mitra','BMitra',Tahoma,Arial"};
  function lbgFontKey(){
    var el=document.getElementById('lbg-font');
    return el?el.value:'default';
  }
  function lbgFontFamily(){
    return LBG_FONTS[lbgFontKey()]||undefined;
  }
  document.getElementById('lbg-font').addEventListener('change',function(){
    var key=lbgFontKey();
    var sheet=document.querySelector('#lb-panel-genderstats .lbg-sheet');
    if(sheet)sheet.style.fontFamily=LBG_FONTS[key]||'';
  });
  function lbgApplyFontSize(px){
    px=Math.max(8,Math.min(30,parseInt(px,10)||14));
    document.getElementById('lbg-fontsize').value=px;
    document.querySelectorAll('#lbg-table th,#lbg-table td,#lbg-table input').forEach(function(el){
      el.style.fontSize=px+'px';
    });
    return px;
  }
  document.getElementById('lbg-fontsize').addEventListener('input',function(){
    lbgApplyFontSize(this.value);
  });
  document.getElementById('btn-lbg-fontsize-inc').onclick=function(){
    lbgApplyFontSize((parseInt(document.getElementById('lbg-fontsize').value,10)||14)+1);
  };
  document.getElementById('btn-lbg-fontsize-dec').onclick=function(){
    lbgApplyFontSize((parseInt(document.getElementById('lbg-fontsize').value,10)||14)-1);
  };

  // ===== رنگ دلخواه هر ردیف (پایه) جدول آمار دانش‌آموزان =====
  var LBG_ROW_COLOR_HEX={pink:'#fbcfe8',blue:'#bfdbfe',red:'#fecaca',yellow:'#fef08a',orange:'#fed7aa',green:'#bbf7d0'};
  var lbgRowColors={};
  function lbgApplyRowColor(g,colorKey){
    var tr=document.querySelector('#lbg-tbody tr[data-grade="'+g+'"]');
    if(!tr)return;
    var hex=LBG_ROW_COLOR_HEX[colorKey]||'';
    tr.querySelectorAll('td').forEach(function(td){td.style.background=hex;});
  }
  function lbgRefreshRowColorDots(){
    document.querySelectorAll('#lbg-tbody .row-color-picker').forEach(function(picker){
      var g=picker.dataset.grade;
      var current=lbgRowColors[g]||'none';
      picker.querySelectorAll('.row-color-dot').forEach(function(dot){
        dot.classList.toggle('active',dot.dataset.color===current);
      });
      lbgApplyRowColor(g,current==='none'?'':current);
    });
  }
  document.getElementById('lbg-table').addEventListener('click',function(e){
    var dot=e.target.closest('.row-color-dot');
    if(!dot)return;
    var g=dot.dataset.grade;
    lbgRowColors[g]=dot.dataset.color;
    lbgRefreshRowColorDots();
    lbSave('lbg-row-colors',lbgRowColors,true);
  });

  var LB_GENDERSTATS_LOADED=false;
  async function lbLoadGenderStatsIfNeeded(){
    if(LB_GENDERSTATS_LOADED)return;
    LB_GENDERSTATS_LOADED=true;
    var saved=await lbLoad('genderstats');
    var savedColors=await lbLoad('lbg-row-colors');
    if(savedColors&&typeof savedColors==='object')lbgRowColors=savedColors;
    lbgRefreshRowColorDots();
    if(!saved)return;
    document.getElementById('lbg-school').value=saved.school||'';
    document.getElementById('lbg-year').value=saved.year||'';
    if(saved.font){
      document.getElementById('lbg-font').value=saved.font;
      var sheet=document.querySelector('#lb-panel-genderstats .lbg-sheet');
      if(sheet)sheet.style.fontFamily=LBG_FONTS[saved.font]||'';
    }
    if(saved.fontSize)lbgApplyFontSize(saved.fontSize);
    if(saved.grades){
      saved.grades.forEach(function(row,idx){
        var g=idx+1;
        var boyInp=document.querySelector('.lbg-boy[data-grade="'+g+'"]');
        var girlInp=document.querySelector('.lbg-girl[data-grade="'+g+'"]');
        if(boyInp)boyInp.value=toFaDigits(toEnDigits(row.boy||''));
        if(girlInp)girlInp.value=toFaDigits(toEnDigits(row.girl||''));
      });
    }
    lbgRecalc();
  }
  document.getElementById('btn-lbg-save').onclick=function(){
    var grades=[];
    for(var g=1;g<=6;g++){
      var boyInp=document.querySelector('.lbg-boy[data-grade="'+g+'"]');
      var girlInp=document.querySelector('.lbg-girl[data-grade="'+g+'"]');
      grades.push({boy:boyInp.value,girl:girlInp.value});
    }
    lbSave('genderstats',{school:document.getElementById('lbg-school').value,year:document.getElementById('lbg-year').value,font:lbgFontKey(),fontSize:parseInt(document.getElementById('lbg-fontsize').value,10)||14,grades:grades});
  };
  function lbgExportHtml(){
    var school=document.getElementById('lbg-school').value||'.......................';
    var year=document.getElementById('lbg-year').value||'.......................';
    var h='<p style="text-align:center;font-weight:bold;font-size:15px">آمار دانش‌آموزان مدرسه '+esc(school)+' به تفکیک جنسیت سال تحصیلی '+esc(year)+'</p>';
    h+='<table><tr><th>پایه</th><th>پسر</th><th>دختر</th><th>مجموع</th></tr>';
    var totalBoy=0,totalGirl=0;
    LBG_GRADE_NAMES.forEach(function(name,idx){
      var g=idx+1;
      var b=parseInt(toEnDigits(document.querySelector('.lbg-boy[data-grade="'+g+'"]').value),10)||0;
      var gi=parseInt(toEnDigits(document.querySelector('.lbg-girl[data-grade="'+g+'"]').value),10)||0;
      totalBoy+=b;totalGirl+=gi;
      var colorKey=(typeof lbgRowColors!=='undefined'&&lbgRowColors[g])||'';
      var hex=(typeof LBG_ROW_COLOR_HEX!=='undefined'&&LBG_ROW_COLOR_HEX[colorKey])||'';
      var rowStyle=hex?' style="background:'+hex+'"':'';
      h+='<tr'+rowStyle+'><td>'+name+'</td><td>'+b+'</td><td>'+gi+'</td><td>'+(b+gi)+'</td></tr>';
    });
    h+='<tr style="font-weight:bold;background:#dbeafe"><td>مجموع کل</td><td>'+totalBoy+'</td><td>'+totalGirl+'</td><td>'+(totalBoy+totalGirl)+'</td></tr>';
    h+='</table>';
    h+='<p style="margin-top:16px">تعداد دانش‌آموزان پسر: <b>'+totalBoy+'</b>&nbsp;&nbsp;&nbsp;&nbsp;تعداد دانش‌آموزان دختر: <b>'+totalGirl+'</b>&nbsp;&nbsp;&nbsp;&nbsp;تعداد کل دانش‌آموزان مدرسه: <b>'+(totalBoy+totalGirl)+'</b></p>';
    return h;
  }
  function lbgCurrentFontSize(){
    return parseInt(document.getElementById('lbg-fontsize').value,10)||14;
  }
  document.getElementById('btn-lbg-word').onclick=function(){lbWordExport('آمار دانش‌آموزان به تفکیک جنسیت',lbgExportHtml(),'آمار-دانش-آموزان',false,lbgFontFamily(),lbgCurrentFontSize());};
  document.getElementById('btn-lbg-pdf').onclick=function(){lbPrintExport('آمار دانش‌آموزان به تفکیک جنسیت',lbgExportHtml(),false,lbgFontFamily(),lbgCurrentFontSize());};
  document.getElementById('btn-lbg-print-opts-toggle').onclick=function(){
    var drawer=document.getElementById('lbg-print-opts-drawer');
    if(drawer.classList.contains('hidden'))document.getElementById('lbg-print-fontsize').value=lbgCurrentFontSize();
    drawer.classList.toggle('hidden');
  };
  document.getElementById('btn-lbg-print-custom').onclick=function(){
    var landscape=document.getElementById('lbg-print-orientation').value==='landscape';
    var fontSize=parseInt(document.getElementById('lbg-print-fontsize').value,10)||lbgCurrentFontSize();
    lbPrintExport('آمار دانش‌آموزان به تفکیک جنسیت',lbgExportHtml(),landscape,lbgFontFamily(),fontSize);
  };
  document.getElementById('btn-lbg-word-custom').onclick=function(){
    var landscape=document.getElementById('lbg-print-orientation').value==='landscape';
    var fontSize=parseInt(document.getElementById('lbg-print-fontsize').value,10)||lbgCurrentFontSize();
    lbWordExport('آمار دانش‌آموزان به تفکیک جنسیت',lbgExportHtml(),'آمار-دانش-آموزان',landscape,lbgFontFamily(),fontSize);
  };
  document.getElementById('btn-lbg-excel').onclick=function(){
    lbExcelExport('آمار-دانش-آموزان',function(wb){
      var rows=[['پایه','پسر','دختر','مجموع']];
      var totalBoy=0,totalGirl=0;
      LBG_GRADE_NAMES.forEach(function(name,idx){
        var g=idx+1;
        var b=parseInt(toEnDigits(document.querySelector('.lbg-boy[data-grade="'+g+'"]').value),10)||0;
        var gi=parseInt(toEnDigits(document.querySelector('.lbg-girl[data-grade="'+g+'"]').value),10)||0;
        totalBoy+=b;totalGirl+=gi;
        rows.push([name,b,gi,b+gi]);
      });
      rows.push(['مجموع کل',totalBoy,totalGirl,totalBoy+totalGirl]);
      lbAddExcelSheet(wb,'آمار دانش‌آموزان',rows);
    });
  };

  // ===================== درصد قبولی دانش‌آموزان =====================
  var LBPR_GRADE_NAMES=['اول','دوم','سوم','چهارم','پنجم','ششم'];
  // فونت: پیش‌فرض / B Titr / B Nazanin / B Mitra — اسم اول برای فونت سیستمی (اگر نصب باشد) و اسم دوم برای فونت وب بارگذاری‌شده در SHARED_CSS
  var LBPR_FONTS={default:'',titr:"'B Titr','BTitr',Tahoma,Arial",nazanin:"'B Nazanin','BNazanin',Tahoma,Arial",mitra:"'B Mitra','BMitra',Tahoma,Arial"};
  var LBPR_CANVAS_FONTS={default:'Tahoma, Arial',titr:"'B Titr','BTitr',Tahoma,Arial",nazanin:"'B Nazanin','BNazanin',Tahoma,Arial",mitra:"'B Mitra','BMitra',Tahoma,Arial"};
  function lbprFontKey(){
    var el=document.getElementById('lbpr-font');
    return el?el.value:'default';
  }
  function lbprFontFamily(){
    return LBPR_FONTS[lbprFontKey()]||undefined;
  }
  function lbprApplyFont(){
    var key=lbprFontKey();
    var panel=document.getElementById('lb-panel-passrate');
    if(panel)panel.style.fontFamily=LBPR_FONTS[key]||'';
    lbprRecalc();
  }
  document.getElementById('lbpr-font').addEventListener('change',lbprApplyFont);
  function lbprApplyFontSize(px){
    px=Math.max(8,Math.min(30,parseInt(px,10)||14));
    document.getElementById('lbpr-fontsize').value=px;
    document.querySelectorAll('#lbpr-table th,#lbpr-table td,#lbpr-table input').forEach(function(el){
      el.style.fontSize=px+'px';
    });
    return px;
  }
  function lbprCurrentFontSize(){
    return parseInt(document.getElementById('lbpr-fontsize').value,10)||14;
  }
  document.getElementById('lbpr-fontsize').addEventListener('input',function(){
    lbprApplyFontSize(this.value);
  });
  document.getElementById('btn-lbpr-fontsize-inc').onclick=function(){
    lbprApplyFontSize(lbprCurrentFontSize()+1);
  };
  document.getElementById('btn-lbpr-fontsize-dec').onclick=function(){
    lbprApplyFontSize(lbprCurrentFontSize()-1);
  };
  function lbprColorForPct(pct){
    if(pct<60)return{fill:'#fecaca',border:'#ef4444'};      // قرمز کم‌رنگ - ضعیف
    if(pct<85)return{fill:'#bfdbfe',border:'#3b82f6'};      // آبی کم‌رنگ - متوسط
    return{fill:'#bbf7d0',border:'#22c55e'};                // سبز کم‌رنگ - خوب
  }
  function lbprDrawChart(data){
    var canvas=document.getElementById('lbpr-chart');
    if(!canvas)return;
    var ctx=canvas.getContext('2d');
    var w=canvas.width,h=canvas.height;
    var cvFont=LBPR_CANVAS_FONTS[lbprFontKey()]||'Tahoma, Arial';
    ctx.clearRect(0,0,w,h);
    var padTop=26,padBottom=46,padLeft=44,padRight=20;
    var chartH=h-padTop-padBottom;
    var chartW=w-padLeft-padRight;
    var n=data.length;
    var gap=18;
    var barW=(chartW-gap*(n-1))/n;
    ctx.strokeStyle='#e5e7eb';
    ctx.fillStyle='#6b7280';
    ctx.lineWidth=1;
    [0,25,50,75,100].forEach(function(v){
      var y=padTop+chartH-(v/100)*chartH;
      ctx.beginPath();ctx.moveTo(padLeft,y);ctx.lineTo(w-padRight,y);ctx.stroke();
      ctx.textAlign='right';
      ctx.font='11px '+cvFont;
      ctx.fillText(toFaDigits(v),padLeft-6,y+4);
    });
    data.forEach(function(pct,i){
      var barH=(Math.max(0,Math.min(100,pct))/100)*chartH;
      var x=padLeft+i*(barW+gap);
      var y=padTop+chartH-barH;
      var c=lbprColorForPct(pct);
      ctx.fillStyle=c.fill;
      ctx.strokeStyle=c.border;
      ctx.lineWidth=2;
      ctx.fillRect(x,y,barW,barH);
      ctx.strokeRect(x,y,barW,barH);
      ctx.fillStyle='#111827';
      ctx.textAlign='center';
      ctx.font='bold 13px '+cvFont;
      ctx.fillText(toFaDigits(pct)+'٪',x+barW/2,Math.max(14,y-8));
      ctx.font='12px '+cvFont;
      ctx.fillStyle='#374151';
      ctx.fillText('پایه '+LBPR_GRADE_NAMES[i],x+barW/2,padTop+chartH+20);
    });
  }
  function lbprRecalc(){
    var data=[];
    for(var g=1;g<=6;g++){
      var totalInp=document.querySelector('.lbpr-total[data-grade="'+g+'"]');
      var passInp=document.querySelector('.lbpr-pass[data-grade="'+g+'"]');
      var pctCell=document.querySelector('.lbpr-pct[data-grade="'+g+'"]');
      var t=parseInt(toEnDigits(totalInp.value),10)||0;
      var p=parseInt(toEnDigits(passInp.value),10)||0;
      var pct=t>0?Math.round((p/t)*100):0;
      pctCell.textContent=toFaDigits(pct)+'٪';
      data.push(pct);
    }
    lbprDrawChart(data);
    return data;
  }
  document.getElementById('lbpr-table').addEventListener('input',function(e){
    if(e.target&&(e.target.classList.contains('lbpr-total')||e.target.classList.contains('lbpr-pass'))){
      var cleaned=toEnDigits(e.target.value).replace(/[^0-9]/g,'').slice(0,3);
      e.target.value=toFaDigits(cleaned);
      lbprRecalc();
    }
  });
  var LB_PASSRATE_LOADED=false;
  async function lbLoadPassrateIfNeeded(){
    if(LB_PASSRATE_LOADED){lbprRecalc();return;}
    LB_PASSRATE_LOADED=true;
    var saved=await lbLoad('passrate');
    if(saved){
      document.getElementById('lbpr-school').value=saved.school||'';
      document.getElementById('lbpr-year').value=saved.year||'';
      if(saved.font){
        document.getElementById('lbpr-font').value=saved.font;
        document.getElementById('lb-panel-passrate').style.fontFamily=LBPR_FONTS[saved.font]||'';
      }
      if(saved.fontSize)lbprApplyFontSize(saved.fontSize);
      if(saved.grades){
        saved.grades.forEach(function(row,idx){
          var g=idx+1;
          var totalInp=document.querySelector('.lbpr-total[data-grade="'+g+'"]');
          var passInp=document.querySelector('.lbpr-pass[data-grade="'+g+'"]');
          if(totalInp)totalInp.value=toFaDigits(toEnDigits(row.total||''));
          if(passInp)passInp.value=toFaDigits(toEnDigits(row.pass||''));
        });
      }
    }
    lbprRecalc();
  }
  document.getElementById('btn-lbpr-save').onclick=function(){
    var grades=[];
    for(var g=1;g<=6;g++){
      var totalInp=document.querySelector('.lbpr-total[data-grade="'+g+'"]');
      var passInp=document.querySelector('.lbpr-pass[data-grade="'+g+'"]');
      grades.push({total:totalInp.value,pass:passInp.value});
    }
    lbSave('passrate',{school:document.getElementById('lbpr-school').value,year:document.getElementById('lbpr-year').value,font:lbprFontKey(),fontSize:lbprCurrentFontSize(),grades:grades});
    toast('ذخیره شد ✅');
  };
  function lbprExportHtml(){
    var school=document.getElementById('lbpr-school').value||'.......................';
    var year=document.getElementById('lbpr-year').value||'.......................';
    var pcts=lbprRecalc();
    var canvas=document.getElementById('lbpr-chart');
    var imgData=canvas.toDataURL('image/png');
    var h='<p style="text-align:center;font-weight:bold;font-size:15px">نمودار درصد قبولی دانش‌آموزان مدرسه '+esc(school)+' - سال تحصیلی '+esc(year)+'</p>';
    h+='<table><tr><th>پایه</th><th>تعداد کل</th><th>تعداد قبول</th><th>درصد قبولی</th></tr>';
    LBPR_GRADE_NAMES.forEach(function(name,idx){
      var g=idx+1;
      var t=document.querySelector('.lbpr-total[data-grade="'+g+'"]').value||'۰';
      var p=document.querySelector('.lbpr-pass[data-grade="'+g+'"]').value||'۰';
      h+='<tr><td>'+esc(name)+'</td><td>'+esc(t)+'</td><td>'+esc(p)+'</td><td>'+toFaDigits(pcts[idx])+'٪</td></tr>';
    });
    h+='</table>';
    h+='<div style="text-align:center;margin-top:16px"><img src="'+imgData+'" style="max-width:100%;width:600px"></div>';
    h+='<p style="margin-top:10px;font-size:12px">رنگ‌بندی: قرمز کم‌رنگ = زیر ۶۰٪ | آبی کم‌رنگ = ۶۰ تا ۸۴٪ | سبز کم‌رنگ = ۸۵٪ به بالا</p>';
    return h;
  }
  document.getElementById('btn-lb-passrate-word').onclick=function(){lbWordExport('نمودار درصد قبولی دانش‌آموزان',lbprExportHtml(),'درصد-قبولی-دانش-آموزان',false,lbprFontFamily(),lbprCurrentFontSize());};
  document.getElementById('btn-lb-passrate-pdf').onclick=function(){lbPrintExport('نمودار درصد قبولی دانش‌آموزان',lbprExportHtml(),false,lbprFontFamily(),lbprCurrentFontSize());};
  document.getElementById('btn-lbpr-print-opts-toggle').onclick=function(){
    var drawer=document.getElementById('lbpr-print-opts-drawer');
    if(drawer.classList.contains('hidden'))document.getElementById('lbpr-print-fontsize').value=lbprCurrentFontSize();
    drawer.classList.toggle('hidden');
  };
  document.getElementById('btn-lbpr-print-custom').onclick=function(){
    var landscape=document.getElementById('lbpr-print-orientation').value==='landscape';
    var fontSize=parseInt(document.getElementById('lbpr-print-fontsize').value,10)||lbprCurrentFontSize();
    lbPrintExport('نمودار درصد قبولی دانش‌آموزان',lbprExportHtml(),landscape,lbprFontFamily(),fontSize);
  };
  document.getElementById('btn-lbpr-word-custom').onclick=function(){
    var landscape=document.getElementById('lbpr-print-orientation').value==='landscape';
    var fontSize=parseInt(document.getElementById('lbpr-print-fontsize').value,10)||lbprCurrentFontSize();
    lbWordExport('نمودار درصد قبولی دانش‌آموزان',lbprExportHtml(),'درصد-قبولی-دانش-آموزان',landscape,lbprFontFamily(),fontSize);
  };
  document.getElementById('btn-lb-passrate-excel').onclick=function(){
    var pcts=lbprRecalc();
    lbExcelExport('درصد-قبولی-دانش-آموزان',function(wb){
      var rows=[['پایه','تعداد کل','تعداد قبول','درصد قبولی']];
      LBPR_GRADE_NAMES.forEach(function(name,idx){
        var g=idx+1;
        var t=parseInt(toEnDigits(document.querySelector('.lbpr-total[data-grade="'+g+'"]').value),10)||0;
        var p=parseInt(toEnDigits(document.querySelector('.lbpr-pass[data-grade="'+g+'"]').value),10)||0;
        rows.push([name,t,p,pcts[idx]+'%']);
      });
      lbAddExcelSheet(wb,'درصد قبولی',rows);
    });
  };

  // ===================== ۳-۲. جدول حضور و غیاب هفتگی (طرح رنگی با هفته/روز) =====================
  var LB_ATT_WEEKS=['هفته اول','هفته دوم','هفته سوم','هفته چهارم'];
  var LB_ATT_DAYS=['شنبه','یکشنبه','دوشنبه','سه‌شنبه','چهارشنبه'];
  var LB_ATT_WEEK_CLASSES=['lbat-wk1','lbat-wk2','lbat-wk3','lbat-wk4'];
  var LB_ATT_CELL_CLASSES=['lbat-wk1-cell','lbat-wk2-cell','lbat-wk3-cell','lbat-wk4-cell'];
  function lbAttRowHtml(rowNum){
    var h='<tr><td class="lbat-row-col">'+rowNum+'</td><td class="lbat-name-col"><input type="text"></td>';
    for(var wi=0;wi<4;wi++){for(var di=0;di<5;di++){h+='<td class="'+LB_ATT_CELL_CLASSES[wi]+'"><input type="text"></td>';}}
    h+='</tr>';
    return h;
  }
  function lbAttBuildTableHtml(rowCount){
    var h='<thead><tr><th class="lbat-row-col" rowspan="2">ردیف</th><th class="lbat-name-col" rowspan="2">نام و نام خانوادگی دانش‌آموز</th>';
    LB_ATT_WEEKS.forEach(function(w,wi){h+='<th class="'+LB_ATT_WEEK_CLASSES[wi]+'" colspan="5">'+esc(w)+'</th>';});
    h+='</tr><tr>';
    LB_ATT_WEEKS.forEach(function(){LB_ATT_DAYS.forEach(function(d){h+='<th class="lbat-day">'+esc(d)+'</th>';});});
    h+='</tr></thead><tbody>';
    for(var r=1;r<=rowCount;r++)h+=lbAttRowHtml(r);
    h+='</tbody>';
    return h;
  }
  function lbAttRebuildPreserving(rowCount){
    var tableEl=document.getElementById('lbat-table');
    var oldRows=[];
    if(tableEl.querySelector('tbody')){
      tableEl.querySelectorAll('tbody tr').forEach(function(tr){
        var vals=[];
        tr.querySelectorAll('input').forEach(function(inp){vals.push(inp.value);});
        oldRows.push(vals);
      });
    }
    tableEl.innerHTML=lbAttBuildTableHtml(rowCount);
    tableEl.querySelectorAll('tbody tr').forEach(function(tr,rIdx){
      var oldRow=oldRows[rIdx];
      if(!oldRow)return;
      tr.querySelectorAll('input').forEach(function(inp,cIdx){if(oldRow[cIdx]!==undefined)inp.value=oldRow[cIdx];});
    });
  }
  document.getElementById('btn-lbat-build').onclick=function(){
    var n=parseInt(document.getElementById('lbat-rows').value,10)||20;
    lbAttRebuildPreserving(n);
  };
  document.getElementById('btn-lbat-addrow').onclick=function(){
    var tbody=document.querySelector('#lbat-table tbody');
    if(!tbody)return;
    var tr=document.createElement('tr');
    tr.innerHTML=lbAttRowHtml(tbody.children.length+1).replace(/^<tr>|<\\/tr>$/g,'');
    tbody.appendChild(tr);
  };
  document.getElementById('btn-lbat-build').click();
  lbEnablePaste('lbat-table');
  function lbAttGetRows(){
    var rows=[];
    document.querySelectorAll('#lbat-table tbody tr').forEach(function(tr){
      var vals=[];
      tr.querySelectorAll('input').forEach(function(inp){vals.push(inp.value);});
      rows.push(vals);
    });
    return rows;
  }
  function lbAttFillRows(rows){
    document.querySelectorAll('#lbat-table tbody tr').forEach(function(tr,rIdx){
      var row=rows[rIdx];
      if(!row)return;
      tr.querySelectorAll('input').forEach(function(inp,cIdx){if(row[cIdx]!==undefined)inp.value=row[cIdx];});
    });
  }
  function lbAttExportTableHtml(){
    var rows=lbAttGetRows();
    var wkColors=['#fbcfe8','#fed7aa','#bbf7d0','#bfdbfe'];
    var wkTextColors=['#9d174d','#9a3412','#14532d','#1e3a8a'];
    var h='<table class="lbat-export-table"><tr><th rowspan="2" style="background:#eef2ff;color:#3730a3">ردیف</th><th rowspan="2" style="background:#eef2ff;color:#3730a3">نام و نام خانوادگی دانش‌آموز</th>';
    LB_ATT_WEEKS.forEach(function(w,wi){h+='<th colspan="5" style="background:'+wkColors[wi]+';color:'+wkTextColors[wi]+'">'+esc(w)+'</th>';});
    h+='</tr><tr>';
    LB_ATT_WEEKS.forEach(function(){LB_ATT_DAYS.forEach(function(d){h+='<th style="font-size:10px">'+esc(d)+'</th>';});});
    h+='</tr>';
    rows.forEach(function(row,rIdx){
      h+='<tr><td>'+(rIdx+1)+'</td><td>'+esc(row[0]||'')+'</td>';
      for(var c=1;c<=20;c++)h+='<td>'+esc(row[c]||'')+'</td>';
      h+='</tr>';
    });
    h+='</table>';
    return h;
  }
  function lbAttendance2ExportHtml(){
    var meta=lbMetaBlock([['کلاس','lbat-class'],['معلم','lbat-teacher'],['ماه','lbat-month'],['سال تحصیلی','lbat-year'],['دوره','lbat-course']]);
    meta+='<p style="text-align:center;font-weight:800;font-size:18px;margin:6px 0">🗓️ جدول حضور و غیاب</p>';
    return meta+lbAttExportTableHtml()+'<p style="margin-top:14px"><b>ادامه جدول حضور و غیاب</b></p>';
  }
  var LBAT_FONTS={default:'',titr:"'B Titr','BTitr',Tahoma,Arial",nazanin:"'B Nazanin','BNazanin',Tahoma,Arial",mitra:"'B Mitra','BMitra',Tahoma,Arial"};
  function lbatFontFamily(){var el=document.getElementById('lbat-font');return LBAT_FONTS[el?el.value:'default']||undefined;}
  var lbatFontSizeCtl=lbLiveFontSize('#lbat-table','lbat-fontsize','btn-lbat-fontsize-inc','btn-lbat-fontsize-dec',11);
  document.getElementById('btn-lb-attendance2-word').onclick=function(){lbWordExport('جدول حضور و غیاب هفتگی',lbAttendance2ExportHtml(),'جدول-حضور-و-غیاب',true,lbatFontFamily(),lbatFontSizeCtl.current());};
  document.getElementById('btn-lb-attendance2-pdf').onclick=function(){lbPrintExport('جدول حضور و غیاب هفتگی',lbAttendance2ExportHtml(),true,lbatFontFamily(),lbatFontSizeCtl.current());};
  lbSetupPrintWrench({toggleId:'btn-lbat-print-opts-toggle',drawerId:'lbat-print-opts-drawer',orientationId:'lbat-print-orientation',fontSizeId:'lbat-print-fontsize',printBtnId:'btn-lbat-print-custom',wordBtnId:'btn-lbat-word-custom',exportFn:lbAttendance2ExportHtml,title:'جدول حضور و غیاب هفتگی',filename:'جدول-حضور-و-غیاب',fontFamilyFn:lbatFontFamily,currentSizeFn:lbatFontSizeCtl.current});
  document.getElementById('btn-lb-attendance2-excel').onclick=function(){
    lbExcelExport('جدول-حضور-و-غیاب',function(wb){
      var rows=lbAttGetRows();
      var headerRow=['ردیف','نام و نام خانوادگی دانش‌آموز'];
      LB_ATT_WEEKS.forEach(function(w){LB_ATT_DAYS.forEach(function(d){headerRow.push(w+' - '+d);});});
      var sheetRows=[headerRow];
      rows.forEach(function(row,rIdx){sheetRows.push([rIdx+1,row[0]||''].concat(row.slice(1,21)));});
      lbAddExcelSheet(wb,'حضور و غیاب',sheetRows);
    });
  };
  var LB_ATTENDANCE2_LOADED=false;
  var LB_ATT_CUR_MONTH=document.getElementById('lbat-month').value;
  function lbAttKeyFor(month){return 'attendance2-'+month;}
  async function lbAttSaveCurrentMonth(silent){
    lbSave(lbAttKeyFor(LB_ATT_CUR_MONTH),{
      meta:{cls:document.getElementById('lbat-class').value,teacher:document.getElementById('lbat-teacher').value,month:LB_ATT_CUR_MONTH,year:document.getElementById('lbat-year').value,course:document.getElementById('lbat-course').value},
      rowCount:parseInt(document.getElementById('lbat-rows').value,10)||20,
      rows:lbAttGetRows()
    },silent);
  }
  async function lbAttLoadMonth(month){
    var saved=await lbLoad(lbAttKeyFor(month));
    if(saved){
      if(saved.meta){
        document.getElementById('lbat-class').value=saved.meta.cls||'';
        document.getElementById('lbat-teacher').value=saved.meta.teacher||'';
        document.getElementById('lbat-year').value=saved.meta.year||'';
        document.getElementById('lbat-course').value=saved.meta.course||'';
      }
      document.getElementById('lbat-rows').value=saved.rowCount||20;
      lbAttRebuildPreserving(saved.rowCount||20);
      if(saved.rows)lbAttFillRows(saved.rows);
    }else{
      document.getElementById('lbat-class').value='';
      document.getElementById('lbat-teacher').value='';
      document.getElementById('lbat-year').value='';
      document.getElementById('lbat-course').value='';
      document.getElementById('lbat-rows').value=20;
      lbAttRebuildPreserving(20);
    }
    document.getElementById('lbat-month').value=month;
  }
  document.getElementById('lbat-month').onchange=async function(){
    var newMonth=this.value;
    await lbAttSaveCurrentMonth(true); // ذخیره خودکار و بی‌صدای ماه قبلی پیش از تعویض
    LB_ATT_CUR_MONTH=newMonth;
    await lbAttLoadMonth(newMonth);
    toast('نمایش جدول ماه '+newMonth);
  };
  async function lbLoadAttendance2IfNeeded(){
    if(LB_ATTENDANCE2_LOADED)return;
    LB_ATTENDANCE2_LOADED=true;
    await lbAttLoadMonth(LB_ATT_CUR_MONTH);
  }
  document.getElementById('btn-lbat-save').onclick=function(){
    lbAttSaveCurrentMonth(false);
  };

  // ===================== ۳-۳. گروه‌بندی دانش‌آموزان (گروه‌های پویا با امکان افزودن/حذف، به تفکیک پایه تحصیلی) =====================
  var LB_GROUP_HEADERS=['ردیف','نام و نام خانوادگی'];
  var LB_GROUP_ANIMALS=['🐢','🐰','🐝','🐦','🦊','🐬','🐸','🦋','🐧','🐨','🦁','🐯','🐼','🦄','🐳','🐙'];
  var LB_GROUP_COLORS=[
    {headBg:'#dcfce7',headColor:'#166534',border:'#86efac'},
    {headBg:'#fce7f3',headColor:'#9d174d',border:'#f9a8d4'},
    {headBg:'#fed7aa',headColor:'#9a3412',border:'#fdba74'},
    {headBg:'#bfdbfe',headColor:'#1e3a8a',border:'#93c5fd'},
    {headBg:'#f3e8ff',headColor:'#6b21a8',border:'#d8b4fe'},
    {headBg:'#fef9c3',headColor:'#854d0e',border:'#fde68a'}
  ];
  var LB_GROUP_GRADE_TITLES={1:'پایه اول',2:'پایه دوم',3:'پایه سوم',4:'پایه چهارم',5:'پایه پنجم',6:'پایه ششم'};
  var LB_GROUP_STATE=[];       // [{id, title}] گروه‌های پایه‌ی جاری
  var LB_GROUP_NEXT_ID=1;
  var LB_GROUP_CUR_GRADE='1';

  function lbGroupDefaultState(){
    LB_GROUP_NEXT_ID=7;
    return [1,2,3,4,5,6].map(function(i){return {id:i,title:'گروه '+toFaDigits(String(i))};});
  }

  function lbGroupCardHtml(g,idx){
    var c=LB_GROUP_COLORS[idx%LB_GROUP_COLORS.length];
    var icon=LB_GROUP_ANIMALS[idx%LB_GROUP_ANIMALS.length];
    return '<div class="lbgrp-card" data-gid="'+g.id+'" style="border-color:'+c.border+'">'
      +'<div class="lbgrp-card-head">'
        +'<span class="lbgrp-animal">'+icon+'</span>'
        +'<input type="text" class="lbgrp-pill lbgrp-name-input" data-gid="'+g.id+'" value="'+esc(g.title)+'" style="background:'+c.headBg+';color:'+c.headColor+'">'
        +'<button type="button" class="btn sm danger lbgrp-delgroup" data-gid="'+g.id+'" title="حذف این گروه">🗑️ حذف گروه</button>'
      +'</div>'
      +'<table class="lb-table lb-table-tight lbgrp-table" id="lbgrp-table-'+g.id+'"></table>'
      +'<button class="btn sm gray lbgrp-addrow" data-gid="'+g.id+'">➕ افزودن نفر</button>'
      +'</div>';
  }

  function lbGroupBindCardEvents(){
    document.querySelectorAll('.lbgrp-addrow').forEach(function(btn){
      btn.onclick=function(){lbAddSimpleRow('lbgrp-table-'+btn.dataset.gid,LB_GROUP_HEADERS.length);};
    });
    document.querySelectorAll('.lbgrp-delgroup').forEach(function(btn){
      btn.onclick=function(){
        if(LB_GROUP_STATE.length<=1){toast('حداقل باید یک گروه باقی بماند');return;}
        if(!confirm('آیا از حذف این گروه مطمئن هستید؟ این کار قابل بازگشت نیست.'))return;
        var gid=btn.dataset.gid;
        LB_GROUP_STATE=LB_GROUP_STATE.filter(function(g){return String(g.id)!==String(gid);});
        lbGroupRenderAll();
        toast('گروه حذف شد ✅');
      };
    });
    document.querySelectorAll('.lbgrp-name-input').forEach(function(inp){
      inp.oninput=function(){
        var gid=this.dataset.gid;
        var g=LB_GROUP_STATE.find(function(x){return String(x.id)===String(gid);});
        if(g)g.title=this.value;
      };
    });
  }

  function lbGroupRenderAll(){
    var container=document.getElementById('lbgrp-groups-container');
    container.innerHTML=LB_GROUP_STATE.map(function(g,idx){return lbGroupCardHtml(g,idx);}).join('');
    var n=parseInt(document.getElementById('lbgrp-rows').value,10)||10;
    LB_GROUP_STATE.forEach(function(g){
      lbRebuildPreserving('lbgrp-table-'+g.id,LB_GROUP_HEADERS,n);
      lbEnablePaste('lbgrp-table-'+g.id);
    });
    lbGroupBindCardEvents();
  }

  document.getElementById('btn-lbgrp-build').onclick=function(){
    var n=parseInt(document.getElementById('lbgrp-rows').value,10)||10;
    LB_GROUP_STATE.forEach(function(g){lbRebuildPreserving('lbgrp-table-'+g.id,LB_GROUP_HEADERS,n);});
  };
  document.getElementById('btn-lbgrp-addgroup').onclick=function(){
    LB_GROUP_STATE.push({id:LB_GROUP_NEXT_ID++,title:'گروه '+toFaDigits(String(LB_GROUP_STATE.length+1))});
    lbGroupRenderAll();
    toast('گروه جدید اضافه شد ✅');
  };

  function lbGroupCollectData(){
    return {
      meta:{school:document.getElementById('lbgrp-school').value,teacher:document.getElementById('lbgrp-teacher').value,year:document.getElementById('lbgrp-year').value},
      rowCount:parseInt(document.getElementById('lbgrp-rows').value,10)||10,
      groups:LB_GROUP_STATE.map(function(g){
        return {id:g.id,title:g.title,rows:lbTableToRows(document.getElementById('lbgrp-table-'+g.id)).slice(1)};
      })
    };
  }

  async function lbGroupSaveCurrentGrade(silent){
    await lbSave('grouping-g'+LB_GROUP_CUR_GRADE,lbGroupCollectData(),silent);
  }

  async function lbGroupLoadGrade(gradeKey){
    var saved=await lbLoad('grouping-g'+gradeKey);
    if(saved&&saved.groups&&saved.groups.length){
      document.getElementById('lbgrp-school').value=(saved.meta&&saved.meta.school)||'';
      document.getElementById('lbgrp-teacher').value=(saved.meta&&saved.meta.teacher)||'';
      document.getElementById('lbgrp-year').value=(saved.meta&&saved.meta.year)||'';
      document.getElementById('lbgrp-rows').value=saved.rowCount||10;
      var maxId=0;
      LB_GROUP_STATE=saved.groups.map(function(g,i){
        var id=g.id||(i+1);
        if(id>maxId)maxId=id;
        return {id:id,title:g.title||('گروه '+toFaDigits(String(i+1)))};
      });
      LB_GROUP_NEXT_ID=maxId+1;
      lbGroupRenderAll();
      LB_GROUP_STATE.forEach(function(g,idx){
        var origRows=saved.groups[idx]&&saved.groups[idx].rows;
        if(origRows)lbFillTableRows('lbgrp-table-'+g.id,origRows);
      });
    }else{
      document.getElementById('lbgrp-school').value='';
      document.getElementById('lbgrp-teacher').value='';
      document.getElementById('lbgrp-year').value='';
      document.getElementById('lbgrp-rows').value=10;
      LB_GROUP_STATE=lbGroupDefaultState();
      lbGroupRenderAll();
    }
  }

  document.getElementById('lbgrp-grade-select').onchange=async function(){
    var newGrade=this.value;
    await lbGroupSaveCurrentGrade(true); // ذخیره خودکار و بی‌صدای پایه‌ی قبلی پیش از تعویض
    LB_GROUP_CUR_GRADE=newGrade;
    await lbGroupLoadGrade(newGrade);
    toast('نمایش گروه‌های '+(LB_GROUP_GRADE_TITLES[newGrade]||''));
  };

  function lbGroupingGroupHtml(g,idx){
    var c=LB_GROUP_COLORS[idx%LB_GROUP_COLORS.length];
    var icon=LB_GROUP_ANIMALS[idx%LB_GROUP_ANIMALS.length];
    var rows=lbTableToRows(document.getElementById('lbgrp-table-'+g.id));
    var inner=lbRowsToHtmlTable(rows);
    return '<div style="border:2px dashed '+c.border+';border-radius:14px;padding:10px">'
      +'<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><span style="font-size:22px">'+icon+'</span><span style="background:'+c.headBg+';color:'+c.headColor+';padding:4px 14px;border-radius:12px;font-weight:800">'+esc(g.title)+'</span></div>'
      +inner+'</div>';
  }
  function lbGroupingExportHtml(){
    var gradeTitle=LB_GROUP_GRADE_TITLES[LB_GROUP_CUR_GRADE]||'';
    var meta='<p class="lb-meta">'
      +'<b>نام مدرسه:</b> '+esc(document.getElementById('lbgrp-school').value||'.......................')+'&nbsp;&nbsp;&nbsp;&nbsp;'
      +'<b>نام آموزگار:</b> '+esc(document.getElementById('lbgrp-teacher').value||'.......................')+'&nbsp;&nbsp;&nbsp;&nbsp;'
      +'<b>پایه تحصیلی:</b> '+esc(gradeTitle)+'&nbsp;&nbsp;&nbsp;&nbsp;'
      +'<b>سال تحصیلی:</b> '+esc(document.getElementById('lbgrp-year').value||'.......................')
      +'</p>';
    var cells=LB_GROUP_STATE.map(function(g,idx){return lbGroupingGroupHtml(g,idx);});
    var grid='<table style="width:100%;border:none;border-collapse:collapse">';
    for(var i=0;i<cells.length;i+=2){
      grid+='<tr><td style="border:none;width:50%;vertical-align:top;padding:6px">'+cells[i]+'</td>'
        +'<td style="border:none;width:50%;vertical-align:top;padding:6px">'+(cells[i+1]||'')+'</td></tr>';
    }
    grid+='</table>';
    return meta+'<p style="text-align:center;font-weight:800;font-size:18px;margin:6px 0">🧩 گروه‌بندی دانش‌آموزان — '+esc(gradeTitle)+'</p>'+grid;
  }
  document.getElementById('btn-lbgrp-word').onclick=function(){lbWordExport('گروه‌بندی دانش‌آموزان',lbGroupingExportHtml(),'گروه-بندی-دانش-آموزان',false);};
  document.getElementById('btn-lbgrp-pdf').onclick=function(){lbPrintExport('گروه‌بندی دانش‌آموزان',lbGroupingExportHtml(),false);};
  document.getElementById('btn-lbgrp-excel').onclick=function(){
    lbExcelExport('گروه-بندی-دانش-آموزان',function(wb){
      LB_GROUP_STATE.forEach(function(g){lbAddExcelSheet(wb,g.title,lbTableToRows(document.getElementById('lbgrp-table-'+g.id)));});
    });
  };
  document.getElementById('btn-lbgrp-clear').onclick=function(){
    if(!confirm('آیا از پاک‌کردن تمام گروه‌های این پایه مطمئن هستید؟ این کار قابل بازگشت نیست.'))return;
    LB_GROUP_STATE.forEach(function(g){
      document.querySelectorAll('#lbgrp-table-'+g.id+' input,#lbgrp-table-'+g.id+' textarea').forEach(function(inp){inp.value='';});
    });
    toast('همه گروه‌ها پاک شدند ✅');
  };
  var LB_GROUPING_LOADED=false;
  async function lbLoadGroupingIfNeeded(){
    if(LB_GROUPING_LOADED)return;
    LB_GROUPING_LOADED=true;
    document.getElementById('lbgrp-grade-select').value=LB_GROUP_CUR_GRADE;
    await lbGroupLoadGrade(LB_GROUP_CUR_GRADE);
  }
  document.getElementById('btn-lbgrp-save').onclick=function(){
    lbGroupSaveCurrentGrade(false);
  };

  // ===================== ۴. ثبت سطوح عملکرد دانش‌آموز (جدول شماره ۸) =====================
  // انتظارات آموزشی واقعی هر درس به تفکیک پایه (طبق جدول شماره ۷) - مقدار null یعنی این درس در این پایه تدریس نمی‌شود
  var LB_PERF_SUBJECTS_BY_GRADE=[
    {name:"قرآن",grades:[["جمع‌خوانی","روخوانی","آداب قرآن خواندن","پیام قرآنی","داستان‌های قرآنی"],["روخوانی","قرائت","آداب قرآن خواندن","پیام قرآنی","داستان‌های قرآنی"],["روخوانی","قرائت","آداب قرآن خواندن","پیام قرآنی","داستان‌های قرآنی"],["روخوانی","قرائت","ترجمه کلمات و عبارات قرآنی","پیام قرآنی","داستان‌های قرآنی"],["روخوانی","قرائت","ترجمه کلمات و عبارات قرآنی","پیام قرآنی","داستان‌های قرآنی"],["روخوانی","قرائت","ترجمه کلمات و عبارات قرآنی","پیام قرآنی","داستان‌های قرآنی"]]},
    {name:"هدیه‌های آسمان",grades:[null,["خداشناسی و تشکر از خدا","آشنایی با پیامبران و امامان","آشنایی با صفات و اخلاق خوب و مطلوب","آشنایی با وضو، نماز و انجام صحیح آن","توجه به مناسبت‌ها"],["تشکر از خدا","آشنایی با زندگی‌نامه پیامبران و امامان","آشنایی با روزه و نماز و جشن تکلیف","سرلوحه قرار دادن قرآن در زندگی"],["تشکر از خدا","آشنایی با زندگی‌نامه پیامبران و امامان","آشنایی با تیمم، نماز جماعت و نمازهای مناسبتی","قرآن در زندگی"],["تشکر از خدا و نظم در آفریده‌هایش","آشنایی با زندگی‌نامه پیامبران و امامان","آشنایی با صفات خوب و عمل به آن","نماز جمعه و تفاوت آن با سایر نمازهای روزانه","سرلوحه قرار دادن قرآن در زندگی"],["تشکر از خدا و نظم در آفریده‌هایش","آشنایی با زندگی‌نامه پیامبران و امامان","آشنایی با صفات خوب و عمل به آن","فروع دین، نماز مسافر و اعیاد مسلمانان","سرلوحه قرار دادن قرآن در زندگی"]]},
    {name:"فارسی",grades:[["گوش دادن","سخن گفتن","تصویرخوانی","خواندن","زیبانویسی","درست‌نویسی","جمله‌سازی"],["گوش دادن","سخن گفتن","خواندن","درست‌نویسی و املا","جمله‌سازی"],["گوش دادن","سخن گفتن","خواندن","درست‌نویسی و املا","انشا و نگارش"],["گوش دادن","سخن گفتن","خواندن","درست‌نویسی و املا","انشا و نگارش"],["گوش دادن","سخن گفتن","خواندن","درست‌نویسی و املا","انشا و نگارش"],["گوش دادن","سخن گفتن","خواندن","درست‌نویسی و املا","انشا و نگارش"]]},
    {name:"ریاضی",grades:[["شمارش تا اعداد سه رقمی","مقایسه اعداد","جمع و تفریق","موقعیت مکانی","اشکال هندسی","تقارن","طول","زمان","جرم","سرشماری و جدول داده‌ها","نمودار ستونی","راهبردهای حل مسئله","حل مسئله","مربع شگفت‌انگیز"],["شمارش تا عدد ۴ رقمی","پول و واحدهای آن","مقایسه اعداد","اعداد تقریبی","کسر","جمع و تفریق فرآیندی و تکنیکی","اشکال هندسی","تقارن","طول","زمان","آمار و سرشماری","رسم نمودار","احتمال","راهبردهای حل مسئله","حل مسئله"],["شمارش تا عدد ۵ رقمی","پول","مقایسه اعداد","اعداد تقریبی","کسر","مقایسه کسر","جمع","تفریق","ضرب","تقسیم","احجام","دایره","زاویه","خطوط","چندضلعی‌ها","تقارن","طول و محیط","مساحت","جرم","زمان","جدول داده‌ها","رسم نمودار","احتمال","راهبردهای حل مسئله","حل مسئله"],["الگوها","شمارش تا عدد ده رقمی","کسر و عدد مخلوط","عدد اعشاری تا یک رقم اعشار","مقایسه اعداد","مقایسه کسر و عدد مخلوط","جمع","تفریق","ضرب","تقسیم اعداد طبیعی","جمع، تفریق، ضرب کسر و اعداد مخلوط","بخش‌پذیری","محاسبه‌های تقریبی","زاویه","عمود و موازی","چهارضلعی‌ها","زاویه","زمان","طول و محیط","مساحت","نمودار خط شکسته","احتمال وقوع یک پیشامد","راهبردهای حل مسئله","حل مسئله","ترکیب راهبردها"],["الگوها","شمارش تا عدد سیزده رقمی","کسر و عدد مخلوط","عدد اعشاری تا یک رقم اعشار","مقایسه اعداد","اعداد مخلوط","اعداد اعشاری","جمع و تفریق عددهای مرکب، مخلوط و اعشاری","ضرب کسرها، اعداد مخلوط و اعداد اعشاری","تقسیم کسرها","نسبت و تناسب","درصد","تقارن محوری-مرکزی","نیمساز","خواص چندضلعی‌ها","محیط دایره","مساحت لوزی و ذوزنقه","حجم و گنجایش","جمع‌آوری داده‌ها و رسم نمودار","میانگین","احتمال","راهبردهای حل مسئله","حل مسئله"],["الگوها","شمارش تا عدد سیزده رقمی","کسر و عدد مخلوط","عدد اعشاری تا یک رقم اعشار","مقایسه اعداد صحیح","اعداد مخلوط","اعداد اعشاری","جمع، تفریق و ضرب عددهای صحیح، مخلوط و اعشاری","تقسیم کسرها، اعداد اعشاری","نسبت و تناسب","درصد","تقارن","دوران","مختصات","طول و سطح","جرم و حجم","خط و زاویه","راهبردهای حل مسئله","حل مسئله"]]},
    {name:"علوم",grades:[["زنگ علوم","سلام به من نگاه کن","چه می‌خواهم بسازم","از گذشته تا آینده","سالم باش","دنیای جانوران","دنیای گیاهان","زمین خانه پرآب","سنگی، خاکی","ما در اطراف ما هوا وجود دارد","دنیای سرد و گرم","از خانه تا مدرسه","آهن‌ربای من"],["زنگ علوم","ساخت وسیله","نان","زندگی ما و گردش زمین","صدا","نور","سوخت‌ها","هوای سالم، آب سالم","سرگذشت دانه","درون آشیانه‌ها","تغییرات بدن","مواد پرکاربرد","تأثیر آب بر مواد"],["زنگ علوم","ساخت وسیله‌ای با سه آینه","روش‌های مختلف نگهداری مواد غذایی","آب ماده باارزش","زندگی ما و آب","نور","نیرو","خوراکی‌ها","گیاهان","جانوران","مواد اطراف ما","اندازه‌گیری مواد"],["زنگ علوم","سنگ‌ها","آسمان شب","انرژی","انرژی الکتریکی","گرما و ماده","آهن‌ربا در زندگی","بدن ما","بی‌مهره‌ها","گوناگونی گیاهان","زیستگاه","مخلوط‌ها"],["زنگ علوم","برگی از تاریخ","خاک باارزش","تجزیه نور و کاربرد عدسی","اهرم، ماشین‌های ساده و مرکب","حرکت بدن","ساختمان چشم و گوش","حواس","بکارید و بخورید","ریشه تا برگ","ماده تغییر می‌کند","ارتباط، احساسات و عواطف و ضرورت وجود و رعایت آنها در بین افراد جامعه"],["روش علمی","ساخت وسایل متحرک","تغییرات فناوری در طول زمان","سفر به اعماق زمین","زمین پویا","ورزش و نیرو","سفر انرژی","میکروسکوپ","شگفتی‌های برگ","جنگل","سالم بمانیم","سرگذشت دفتر من","کارخانه کاغذسازی"]]},
    {name:"اجتماعی",grades:[null,null,["ضرورت نظم و مقررات در مکان‌های مختلف","نهادهای اجتماعی","شناخت فردی خود","آموزه‌های دینی و اخلاقی در مورد اعضای خانواده و مدرسه","تغییرات خود و محیط پیرامون","رابطه متقابل انسان و محیط","انواع مشاغل","منابع طبیعی","حقوق افراد"],["محله","شناخت نمادهای ملی","تقویم","ویژگی‌های شخصیتی امام خمینی","انواع زندگی","مورخان و باستان‌شناسان","سلسله‌های باستانی","ناهمواری‌ها","آب و هوا","امکانات عمومی محله","برنامه‌ریزی و خرید","پوشش گیاهی نواحی مختلف"],["مناسبت‌ها","شهرها و کشورهای مذهبی","ایران بعد از اسلام","آثار باستانی و شخصیت‌های ملی","آشنایی با همسایگان ایران","قاره‌ها","آشنایی با ایران به تفکیک سرفصل‌ها"],["تصمیم‌گیری","برنامه‌ریزی","دوست‌یابی","صفویه","دوره اسلامی","آداب و آموزه‌های دینی","استعمار","جنگ تحمیلی","تغییرات پدیده‌های زندگی","کشاورزی","دریاها و همسایگان ایران","مشاغل","تولید و مصرف","منابع انرژی"]]},
    {name:"تفکر و پژوهش",grades:[null,null,null,null,null,["تصمیم‌گیری و انتخاب آگاهانه","آشنایی با روند انجام پژوهش","آشنایی با سیستم و اجرای آنها","تفکر در هویت و ارزش‌های ایرانی و ملی"]]},
    {name:"کار و فناوری",grades:[null,null,null,null,null,["آشنایی با رایانه و استفاده مطلوب و بهینه از آن","دست‌ورزی و ارتباط آن با اقتصاد و درآمدزایی"]]},
    {name:"هنر",grades:[["زیبایی‌شناسی","ارتباط با طبیعت","تولید و نقد هنری","آشنایی با میراث فرهنگی","کاربرد درست ابزار","رعایت ایمنی"],["زیبایی‌شناسی","ارتباط با طبیعت","تولید و نقد هنری","آشنایی با میراث فرهنگی","کاربرد درست ابزار","رعایت ایمنی"],["زیبایی‌شناسی","ارتباط با طبیعت","تولید و نقد هنری","آشنایی با میراث فرهنگی","کاربرد درست ابزار","رعایت ایمنی"],["زیبایی‌شناسی","ارتباط با طبیعت","تولید و نقد هنری","آشنایی با میراث فرهنگی","کاربرد درست ابزار","رعایت ایمنی"],["زیبایی‌شناسی","ارتباط با طبیعت","تولید و نقد هنری","آشنایی با میراث فرهنگی","کاربرد درست ابزار","رعایت ایمنی"],["زیبایی‌شناسی","ارتباط با طبیعت","تولید و نقد هنری","آشنایی با میراث فرهنگی","کاربرد درست ابزار","رعایت ایمنی"]]},
    {name:"تربیت بدنی",grades:[["توسعه و بهبود عضلانی","تعادل","قلبی-عروقی","انعطاف‌پذیری","کسب مهارت در جهت‌یابی","راه رفتن، ایستادن و نشستن","دویدن","پرتاب و چرخیدن"],["توسعه و بهبود عضلانی","تعادل","قلبی-تنفسی","انعطاف‌پذیری","چابکی","کسب مهارت در خم و راست شدن","پریدن","به پهلو دویدن","پرتاب دو دست","لی‌لی کردن"],["توسعه و بهبود عضلانی","تعادل","قلبی-تنفسی","انعطاف‌پذیری","چابکی","کسب مهارت در خم و راست شدن","پریدن","به پهلو دویدن","پرتاب دو دست","لی‌لی"],["توسعه و بهبود قلبی-تنفسی","عضلانی","انعطاف‌پذیری","سرعت","بهداشت و ایمنی","کسب مهارت‌های فوتبال","والیبال","تنیس روی میز","طناب‌زنی","شرکت در فعالیت‌ها"],["توسعه و بهبود قلبی-تنفسی","انعطاف‌پذیری","سرعت","بهداشت و ایمنی در ورزش","کسب مهارت‌های بسکتبال","هندبال","بدمینتون","طناب‌زنی","شرکت در فعالیت‌ها"],["توسعه و بهبود قلبی-تنفسی","انعطاف‌پذیری","عضلانی","بهداشت و ایمنی در ورزش","کسب مهارت‌های دو سرعت و مارپیچ","پرش","پرتاب","بازی‌های بومی و محلی"]]},
    {name:"شایستگی‌های عمومی",grades:[["رعایت بهداشت و ایمنی","رعایت آموخته‌های اخلاقی","مسئولیت‌پذیری","مشارکت در کار گروهی","احترام به ارزش‌های ملی و مذهبی","توجه به مطالعه و کتابخوانی","تلاش برای یادگیری بیشتر"],["رعایت بهداشت و ایمنی","توجه به مطالعه برای یادگیری بیشتر","رعایت آموخته‌های اخلاقی","مسئولیت‌پذیری","مشارکت در کار گروهی","احترام به ارزش‌ها"],["رعایت بهداشت و ایمنی","توجه به مطالعه و کتابخوانی","تلاش برای یادگیری بیشتر","رعایت آموخته‌های اخلاقی","مسئولیت‌پذیری","مشارکت در کار گروهی","احترام به ارزش‌های ملی و مذهبی"],["رعایت بهداشت و ایمنی","توجه به مطالعه برای یادگیری بیشتر","رعایت آموخته‌های اخلاقی","مشارکت","مسئولیت‌پذیری","احترام به ارزش‌ها"],["رعایت بهداشت","توجه به مطالعه","رعایت آموخته‌های اخلاقی","مشارکت","مسئولیت‌پذیری","احترام به ارزش‌ها"],["رعایت بهداشت","توجه به مطالعه","رعایت آموخته‌های اخلاقی","مشارکت","مسئولیت‌پذیری","احترام به ارزش‌ها"]]},
  ];
  var LB_PERF_DATA={}; // { 'subjectName-rowIdx': {expect:'', desc:'', cols:['','', ...]} } - داده‌های دانش‌آموزِ در حال ویرایش
  var LB_PERF_CURRENT_UUID=null; // شناسه‌ی دانش‌آموزِ در حال ویرایش (null یعنی هنوز ذخیره نشده / جدید است)
  function lbPerfColsCount(){
    return parseInt(document.getElementById('lbf-cols').value,10)||12;
  }
  function lbSelectedPerfGradeIdx(){
    return parseInt(document.getElementById('lbf-grade-select').value,10)||0;
  }
  // فهرست دروس تدریس‌شده در پایه‌ی انتخاب‌شده، همراه با انتظارات آموزشی واقعی هر درس
  function lbPerfActiveSubjects(gradeIdx){
    var out=[];
    LB_PERF_SUBJECTS_BY_GRADE.forEach(function(subj){
      var items=subj.grades[gradeIdx];
      if(items && items.length)out.push({name:subj.name,items:items});
    });
    return out;
  }
  function lbBuildPerformanceHtml(forExport,colsCount){
    var cols=colsCount||lbPerfColsCount();
    var subjects=lbPerfActiveSubjects(lbSelectedPerfGradeIdx());
    var h='<table class="lb-table lb-table-tight"><thead>';
    h+='<tr><th rowspan="2">نام درس</th><th rowspan="2">مهم‌ترین انتظارات آموزشی</th><th colspan="'+cols+'">ثبت عملکرد دانش‌آموز</th><th rowspan="2" style="width:70px;max-width:70px">توصیف کوتاه موارد ضروری</th></tr>';
    h+='<tr>';
    for(var c=0;c<cols;c++){
      h+=forExport?'<th style="min-width:22px">'+(c+1)+'</th>':'<th style="min-width:34px">'+(c+1)+'</th>';
    }
    h+='</tr></thead><tbody id="lb-perf-tbody">';
    subjects.forEach(function(subj){
      var key=subj.name;
      var saved=LB_PERF_DATA[key]||{};
      var defaultExpect=subj.items.join('، ');
      var expectVal=(saved.expect!==undefined)?saved.expect:defaultExpect;
      h+='<tr data-subj="'+esc(subj.name)+'">';
      h+='<td style="font-weight:700;background:#f1f5f9">'+esc(subj.name)+'</td>';
      h+=forExport?'<td style="text-align:right">'+esc(expectVal)+'</td>':'<td><textarea class="lb-perf-expect" data-key="'+key+'" rows="3" placeholder="انتظار آموزشی">'+esc(expectVal)+'</textarea></td>';
      for(var c2=0;c2<cols;c2++){
        var v=(saved.cols&&saved.cols[c2])||'';
        h+=forExport?'<td>'+esc(v)+'</td>':'<td><input type="text" class="lb-perf-cell" data-key="'+key+'" data-col="'+c2+'" value="'+esc(v)+'"></td>';
      }
      h+=forExport?'<td style="width:70px;max-width:70px;font-size:10px">'+esc(saved.desc||'')+'</td>':'<td style="width:70px;max-width:70px"><textarea class="lb-perf-desc" data-key="'+key+'" rows="3" style="width:70px" placeholder="توضیح کوتاه">'+esc(saved.desc||'')+'</textarea></td>';
      h+='</tr>';
    });
    h+='</tbody></table>';
    return h;
  }
  function lbBindPerformanceInputs(el){
    el.querySelectorAll('.lb-perf-expect').forEach(function(ta){
      ta.addEventListener('input',function(){
        if(!LB_PERF_DATA[ta.dataset.key])LB_PERF_DATA[ta.dataset.key]={};
        LB_PERF_DATA[ta.dataset.key].expect=ta.value;
      });
    });
    el.querySelectorAll('.lb-perf-desc').forEach(function(ta){
      ta.addEventListener('input',function(){
        if(!LB_PERF_DATA[ta.dataset.key])LB_PERF_DATA[ta.dataset.key]={};
        LB_PERF_DATA[ta.dataset.key].desc=ta.value;
      });
    });
    el.querySelectorAll('.lb-perf-cell').forEach(function(inp){
      inp.addEventListener('input',function(){
        var key=inp.dataset.key,c=parseInt(inp.dataset.col,10);
        if(!LB_PERF_DATA[key])LB_PERF_DATA[key]={};
        if(!LB_PERF_DATA[key].cols)LB_PERF_DATA[key].cols=[];
        LB_PERF_DATA[key].cols[c]=inp.value;
      });
    });
  }
  function lbRenderPerformance(){
    var el=document.getElementById('lb-performance-preview');
    el.innerHTML=lbBuildPerformanceHtml(false);
    lbBindPerformanceInputs(el);
  }
  document.getElementById('btn-lbf-build').onclick=lbRenderPerformance;

  // --- لیست دانش‌آموزانِ ثبت‌شده برای پایه‌ی انتخاب‌شده (به‌صورت یک ردیف/کشویی، بدون اشغال فضا) ---
  async function lbRenderPerfStudentList(gradeIdx){
    var sel=document.getElementById('lbf-student-select');
    sel.innerHTML='<option value="">در حال بارگذاری...</option>';
    var list=(await lbLoad('performance:list:'+gradeIdx))||[];
    sel.innerHTML='<option value="">— انتخاب دانش‌آموز —</option>';
    list.forEach(function(s){
      var opt=document.createElement('option');
      opt.value=s.uuid;
      opt.textContent=s.name;
      sel.appendChild(opt);
    });
    if(!list.length){
      var opt2=document.createElement('option');
      opt2.value='';opt2.disabled=true;
      opt2.textContent='هنوز دانش‌آموزی برای این پایه ثبت نشده';
      sel.appendChild(opt2);
    }
  }
  async function lbUpdatePerfListEntry(gradeIdx,uuidStr,name){
    var key='performance:list:'+gradeIdx;
    var list=(await lbLoad(key))||[];
    var idx=list.findIndex(function(s){return s.uuid===uuidStr;});
    if(idx>=0)list[idx].name=name;else list.push({uuid:uuidStr,name:name});
    await lbSave(key,list,true);
  }
  // --- عکس پروفایل دانش‌آموز ---
  var LB_PERF_PHOTO='';
  function lbSetPerfPhoto(dataUrl){
    LB_PERF_PHOTO=dataUrl||'';
    var img=document.getElementById('lbf-photo-preview');
    var removeBtn=document.getElementById('btn-lbf-photo-remove');
    if(LB_PERF_PHOTO){img.src=LB_PERF_PHOTO;img.classList.remove('hidden');removeBtn.classList.remove('hidden');}
    else{img.src='';img.classList.add('hidden');removeBtn.classList.add('hidden');}
  }
  document.getElementById('lbf-photo-input').addEventListener('change',async function(){
    var f=this.files&&this.files[0];this.value='';
    if(!f)return;
    try{
      var dataUrl=await resizeProfilePhoto(f);
      lbSetPerfPhoto(dataUrl);
    }catch(e){toast(e.message);}
  });
  document.getElementById('btn-lbf-photo-remove').onclick=function(){lbSetPerfPhoto('');};
  // --- دانش‌آموز جدید: فرم خالی نشان داده می‌شود تا معلم نام را وارد کند ---
  function lbPerfNew(){
    LB_PERF_CURRENT_UUID=null;
    LB_PERF_DATA={};
    document.getElementById('lbf-student-name').value='';
    document.getElementById('lbf-cols').value=12;
    document.getElementById('lbf-student-select').value='';
    document.getElementById('btn-lbf-delete').classList.add('hidden');
    lbSetPerfPhoto('');
    document.getElementById('lbf-form-wrap').classList.remove('hidden');
    lbRenderPerformance();
  }
  document.getElementById('btn-lbf-new').onclick=lbPerfNew;
  // --- بارگذاری سطح عملکرد یک دانش‌آموز خاص با انتخاب نامش از لیست ---
  async function lbPerfLoadStudent(uuidStr){
    var rec=await lbLoad('performance:student:'+uuidStr);
    if(!rec){toast('اطلاعات این دانش‌آموز پیدا نشد');return;}
    LB_PERF_CURRENT_UUID=uuidStr;
    LB_PERF_DATA=rec.data||{};
    document.getElementById('lbf-student-name').value=rec.name||'';
    document.getElementById('lbf-cols').value=rec.cols||12;
    lbSetPerfPhoto(rec.photo||'');
    if(rec.meta){
      document.getElementById('lbf-school').value=rec.meta.school||'';
      document.getElementById('lbf-teacher').value=rec.meta.teacher||'';
      document.getElementById('lbf-year').value=rec.meta.year||'';
    }
    document.getElementById('btn-lbf-delete').classList.remove('hidden');
    document.getElementById('lbf-form-wrap').classList.remove('hidden');
    lbRenderPerformance();
  }
  document.getElementById('lbf-student-select').addEventListener('change',function(){
    if(this.value)lbPerfLoadStudent(this.value);
    else{document.getElementById('lbf-form-wrap').classList.add('hidden');document.getElementById('btn-lbf-delete').classList.add('hidden');}
  });
  // --- حذف دانش‌آموزِ در حال ویرایش از فهرست سطوح عملکرد ---
  document.getElementById('btn-lbf-delete').onclick=async function(){
    if(!LB_PERF_CURRENT_UUID)return;
    var studentName=document.getElementById('lbf-student-name').value||'این دانش‌آموز';
    if(!confirm('آیا از حذف «'+studentName+'» و تمام سطوح عملکرد ثبت‌شده‌ی او مطمئن هستید؟ این کار قابل بازگشت نیست.'))return;
    var gradeIdx=lbSelectedPerfGradeIdx();
    var ok=await lbSave('performance:student:'+LB_PERF_CURRENT_UUID,null,true);
    if(ok){
      var key='performance:list:'+gradeIdx;
      var list=(await lbLoad(key))||[];
      list=list.filter(function(s){return s.uuid!==LB_PERF_CURRENT_UUID;});
      await lbSave(key,list,true);
      await lbRenderPerfStudentList(gradeIdx);
      document.getElementById('lbf-form-wrap').classList.add('hidden');
      document.getElementById('btn-lbf-delete').classList.add('hidden');
      LB_PERF_CURRENT_UUID=null;
      toast('دانش‌آموز حذف شد ✅');
    }else{
      toast('خطا در حذف اطلاعات');
    }
  };
  // --- ذخیره‌ی سطح عملکرد دانش‌آموزِ در حال ویرایش ---
  document.getElementById('btn-lbf-save').onclick=async function(){
    var name=document.getElementById('lbf-student-name').value.trim();
    if(!name){toast('لطفاً ابتدا نام دانش‌آموز را وارد کنید');return;}
    var gradeIdx=lbSelectedPerfGradeIdx();
    if(!LB_PERF_CURRENT_UUID)LB_PERF_CURRENT_UUID=uid();
    var rec={
      uuid:LB_PERF_CURRENT_UUID,
      name:name,
      grade:gradeIdx,
      cols:lbPerfColsCount(),
      photo:LB_PERF_PHOTO,
      meta:{school:document.getElementById('lbf-school').value,teacher:document.getElementById('lbf-teacher').value,year:document.getElementById('lbf-year').value},
      data:LB_PERF_DATA
    };
    var ok=await lbSave('performance:student:'+LB_PERF_CURRENT_UUID,rec,true);
    if(ok){
      await lbUpdatePerfListEntry(gradeIdx,LB_PERF_CURRENT_UUID,name);
      var sel=document.getElementById('lbf-student-select');
      await lbRenderPerfStudentList(gradeIdx);
      sel.value=LB_PERF_CURRENT_UUID;
      toast('سطح عملکرد «'+name+'» ذخیره شد');
    }else{
      toast('خطا در ذخیره اطلاعات');
    }
  };
  // --- تغییر پایه: لیست دانش‌آموزان به‌روزرسانی می‌شود و فرم تا انتخاب/ساخت جدید مخفی می‌ماند ---
  document.getElementById('lbf-grade-select').addEventListener('change',function(){
    document.getElementById('lbf-form-wrap').classList.add('hidden');
    document.getElementById('btn-lbf-delete').classList.add('hidden');
    LB_PERF_CURRENT_UUID=null;
    lbRenderPerfStudentList(lbSelectedPerfGradeIdx());
  });
  function lbPerformanceExportHtml(){
    var gradeText=document.getElementById('lbf-grade-select').selectedOptions[0].textContent;
    var studentName=document.getElementById('lbf-student-name').value||'';
    var photoHtml=LB_PERF_PHOTO?('<img src="'+LB_PERF_PHOTO+'" style="float:left;width:36px;height:36px;border-radius:50%;object-fit:cover;border:1px solid #94a3b8;margin:0 8px 6px 0">'):'';
    var meta=lbMetaBlock([['نام مدرسه','lbf-school'],['نام آموزگار','lbf-teacher'],['سال تحصیلی','lbf-year'],['نام دانش‌آموز','lbf-student-name']]);
    meta=photoHtml+'<p class="lb-meta"><b>پایه تحصیلی:</b> '+esc(gradeText)+'</p>'+meta+'<div style="clear:both"></div>';
    var table=lbBuildPerformanceHtml(true,lbPerfColsCount());
    var note='<p style="margin-top:14px" class="muted">لازم به ذکر است انتظارات آموزشی تمامی پایه‌ها در جدول شماره ۸ ارائه گردیده. آموزگاران بر پایه بر انتظارات پیش‌بینی شده نسبت به تکمیل جدول اقدام می‌نمایند.</p>';
    return meta+table+note;
  }
  var LBF_FONTS={default:'',titr:"'B Titr','BTitr',Tahoma,Arial",nazanin:"'B Nazanin','BNazanin',Tahoma,Arial",mitra:"'B Mitra','BMitra',Tahoma,Arial"};
  function lbfFontFamily(){
    var el=document.getElementById('lbf-font');
    return LBF_FONTS[el?el.value:'default']||undefined;
  }
  var lbfFontSizeCtl=lbLiveFontSize('#lb-performance-preview','lbf-fontsize','btn-lbf-fontsize-inc','btn-lbf-fontsize-dec',11);
  document.getElementById('btn-lb-performance-word').onclick=function(){lbWordExport('جدول شماره ۸: ثبت سطوح عملکرد دانش‌آموز',lbPerformanceExportHtml(),'ثبت-سطوح-عملکرد-دانش-آموز',true,lbfFontFamily(),lbfFontSizeCtl.current());};
  document.getElementById('btn-lb-performance-pdf').onclick=function(){lbPrintExport('جدول شماره ۸: ثبت سطوح عملکرد دانش‌آموز',lbPerformanceExportHtml(),true,lbfFontFamily(),lbfFontSizeCtl.current());};
  lbSetupPrintWrench({toggleId:'btn-lbf-print-opts-toggle',drawerId:'lbf-print-opts-drawer',orientationId:'lbf-print-orientation',fontSizeId:'lbf-print-fontsize',printBtnId:'btn-lbf-print-custom',wordBtnId:'btn-lbf-word-custom',exportFn:lbPerformanceExportHtml,title:'جدول شماره ۸: ثبت سطوح عملکرد دانش‌آموز',filename:'ثبت-سطوح-عملکرد-دانش-آموز',fontFamilyFn:lbfFontFamily,currentSizeFn:lbfFontSizeCtl.current});
  document.getElementById('btn-lb-performance-excel').onclick=function(){
    var cols=lbPerfColsCount();
    var studentName=document.getElementById('lbf-student-name').value||'دانش‌آموز';
    var subjects=lbPerfActiveSubjects(lbSelectedPerfGradeIdx());
    lbExcelExport('ثبت-سطوح-عملکرد-'+studentName,function(wb){
      var header=['نام درس','مهم‌ترین انتظارات آموزشی'];
      for(var c=0;c<cols;c++)header.push(String(c+1));
      header.push('توصیف کوتاه موارد ضروری');
      var rows=[header];
      subjects.forEach(function(subj){
        var key=subj.name;
        var saved=LB_PERF_DATA[key]||{};
        var expectVal=(saved.expect!==undefined)?saved.expect:subj.items.join('، ');
        var row=[subj.name,expectVal];
        for(var c2=0;c2<cols;c2++)row.push((saved.cols&&saved.cols[c2])||'');
        row.push(saved.desc||'');
        rows.push(row);
      });
      lbAddExcelSheet(wb,'سطوح عملکرد',rows);
    });
  };


  // ===================== کارنامه‌ساز (ارزشیابی توصیفی) =====================
  function rcSelectedGradeIdx(){
    return parseInt(document.getElementById('rc-grade-select').value,10)||0;
  }
  function rcActiveSubjects(gradeIdx){
    var out=[];
    LB_PERF_SUBJECTS_BY_GRADE.forEach(function(subj){
      if(subj.grades[gradeIdx])out.push(subj.name);
    });
    return out;
  }
  var RC_DATA={}; // { subjectName: {level:'', note:''} }
  var RC_CURRENT_UUID=null;
  var RC_PHOTO='';
  function rcSelectedMonth(){
    return document.getElementById('rc-month-select').value;
  }
  function rcSetPhoto(dataUrl){
    RC_PHOTO=dataUrl||'';
    var img=document.getElementById('rc-photo-preview');
    var placeholder=document.getElementById('rc-photo-placeholder');
    var removeBtn=document.getElementById('btn-rc-photo-remove');
    if(RC_PHOTO){
      img.src=RC_PHOTO;img.classList.remove('hidden');
      placeholder.classList.add('hidden');
      removeBtn.classList.remove('hidden');
    }else{
      img.src='';img.classList.add('hidden');
      placeholder.classList.remove('hidden');
      removeBtn.classList.add('hidden');
    }
  }
  document.getElementById('rc-photo-input').addEventListener('change',async function(){
    var f=this.files&&this.files[0];this.value='';
    if(!f)return;
    try{
      var dataUrl=await resizeProfilePhoto(f);
      rcSetPhoto(dataUrl);
    }catch(e){toast(e.message);}
  });
  document.getElementById('btn-rc-photo-remove').onclick=function(){rcSetPhoto('');};

  // فونت: پیش‌فرض / B Titr / B Nazanin
  var RC_FONTS={default:'',titr:"'B Titr','BTitr',Tahoma,Arial",nazanin:"'B Nazanin','BNazanin',Tahoma,Arial",mitra:"'B Mitra','BMitra',Tahoma,Arial"};
  function rcFontKey(){
    var el=document.getElementById('rc-font');
    return el?el.value:'default';
  }
  function rcFontFamily(){
    return RC_FONTS[rcFontKey()]||undefined;
  }
  document.getElementById('rc-font').addEventListener('change',function(){
    var panel=document.getElementById('lb-panel-reportcard');
    if(panel)panel.style.fontFamily=RC_FONTS[rcFontKey()]||'';
  });
  var rcFontSizeCtl=lbLiveFontSize('#rc-subjects-preview','rc-fontsize','btn-rc-fontsize-inc','btn-rc-fontsize-dec',12);

  var RC_LEVEL_LABELS={excellent:'خیلی خوب',good:'خوب',acceptable:'قابل‌قبول','needs-improve':'نیاز به تلاش'};
  var RC_LEVEL_OPTIONS=[['excellent','خیلی خوب'],['good','خوب'],['acceptable','قابل‌قبول'],['needs-improve','نیاز به تلاش']];
  var RC_LEVEL_COLORS={excellent:{bg:'#dcfce7',color:'#166534'},good:{bg:'#dbeafe',color:'#1e40af'},acceptable:{bg:'#fef3c7',color:'#92400e'},'needs-improve':{bg:'#fee2e2',color:'#991b1b'}};
  function rcLevelBadgeInlineHtml(level){
    if(!level)return '<span style="display:inline-block;padding:3px 12px;border-radius:20px;font-size:12px;font-weight:700;background:#f1f5f9;color:#64748b">—</span>';
    var c=RC_LEVEL_COLORS[level]||{bg:'#f1f5f9',color:'#64748b'};
    return '<span style="display:inline-block;padding:3px 12px;border-radius:20px;font-size:12px;font-weight:700;background:'+c.bg+';color:'+c.color+'">'+esc(RC_LEVEL_LABELS[level]||'—')+'</span>';
  }
  function rcApplySelectColor(sel){
    var c=RC_LEVEL_COLORS[sel.value];
    if(c){sel.style.background=c.bg;sel.style.color=c.color;}
    else{sel.style.background='';sel.style.color='';}
  }
  function rcBuildSubjectsHtml(forExport){
    var subjects=rcActiveSubjects(rcSelectedGradeIdx());
    var h='<table class="lb-table"><thead><tr><th>نام درس</th><th>ارزشیابی</th><th>توضیح معلم (اختیاری)</th></tr></thead><tbody id="rc-subjects-tbody">';
    subjects.forEach(function(name){
      var saved=RC_DATA[name]||{};
      var level=saved.level||'';
      if(forExport){
        h+='<tr><td style="font-weight:700">'+esc(name)+'</td><td style="text-align:center">'+rcLevelBadgeInlineHtml(level)+'</td><td>'+esc(saved.note||'')+'</td></tr>';
      }else{
        var sel='<select class="rc-level" data-key="'+esc(name)+'"><option value="">—</option>';
        RC_LEVEL_OPTIONS.forEach(function(o){
          sel+='<option value="'+o[0]+'"'+(level===o[0]?' selected':'')+'>'+o[1]+'</option>';
        });
        sel+='</select>';
        h+='<tr><td style="font-weight:700;background:#f1f5f9">'+esc(name)+'</td><td>'+sel+'</td><td><input type="text" class="rc-note" data-key="'+esc(name)+'" value="'+esc(saved.note||'')+'" placeholder="توضیح کوتاه"></td></tr>';
      }
    });
    h+='</tbody></table>';
    return h;
  }
  function rcBindSubjectInputs(el){
    el.querySelectorAll('.rc-level').forEach(function(sel){
      rcApplySelectColor(sel);
      sel.addEventListener('change',function(){
        var key=sel.dataset.key;
        if(!RC_DATA[key])RC_DATA[key]={};
        RC_DATA[key].level=sel.value;
        rcApplySelectColor(sel);
      });
    });
    el.querySelectorAll('.rc-note').forEach(function(inp){
      inp.addEventListener('input',function(){
        var key=inp.dataset.key;
        if(!RC_DATA[key])RC_DATA[key]={};
        RC_DATA[key].note=inp.value;
      });
    });
  }
  function rcRenderSubjects(){
    var el=document.getElementById('rc-subjects-preview');
    el.innerHTML=rcBuildSubjectsHtml(false);
    rcBindSubjectInputs(el);
  }
  document.getElementById('rc-grade-select').addEventListener('change',function(){
    document.getElementById('rc-form-wrap').classList.add('hidden');
    document.getElementById('btn-rc-delete').classList.add('hidden');
    RC_CURRENT_UUID=null;
    rcRenderStudentList(rcSelectedGradeIdx());
  });
  document.getElementById('rc-month-select').addEventListener('change',function(){
    if(RC_CURRENT_UUID)rcLoadStudent(RC_CURRENT_UUID);
  });

  async function rcRenderStudentList(gradeIdx){
    // فهرست دانش‌آموزان همان فهرست واقعی و ثبت‌نامی کلاس است (همان شناسه‌ای که برای ورود دانش‌آموز
    // به پنل خودش استفاده می‌شود) تا کارنامه‌ی ذخیره‌شده دقیقاً زیر همان شناسه قرار بگیرد و در پنل
    // دانش‌آموز قابل مشاهده باشد. قبلاً این فهرست جدا و با شناسه‌های تصادفیِ بی‌ربط به حساب واقعی
    // دانش‌آموز نگه‌داری می‌شد که باعث می‌شد کارنامه هیچ‌وقت در پنل دانش‌آموز دیده نشود.
    // فهرست بر اساس همان «پایه»ی واقعی هر دانش‌آموز (که در بخش دانش‌آموزان تعیین می‌شود) فیلتر می‌شود
    // تا هر دانش‌آموز فقط زیر پایه‌ی خودش دیده شود.
    var sel=document.getElementById('rc-student-select');
    var prevVal=sel.value;
    sel.innerHTML='<option value="">در حال بارگذاری...</option>';
    var d=await api('/api/teacher/students');
    var all=(d&&d.ok&&d.students)||[];
    var list=all.filter(function(s){return (Number.isInteger(s.grade)?s.grade:0)===gradeIdx;});
    sel.innerHTML='<option value="">— انتخاب دانش‌آموز —</option>';
    list.forEach(function(s){
      var opt=document.createElement('option');
      opt.value=s.uuid;
      opt.textContent=s.label||'(بدون نام)';
      sel.appendChild(opt);
    });
    if(!list.length){
      var opt2=document.createElement('option');
      opt2.value='';opt2.disabled=true;
      opt2.textContent='دانش‌آموزی در این پایه ثبت نشده (از بخش «لیست اسامی دانش‌آموزان» اضافه کنید)';
      sel.appendChild(opt2);
    }else if(prevVal && list.some(function(s){return s.uuid===prevVal;})){
      sel.value=prevVal;
    }
  }
  async function rcLoadStudent(uuidStr){
    var month=rcSelectedMonth();
    var rec=await lbLoad('reportcard:student:'+uuidStr+':'+month);
    RC_CURRENT_UUID=uuidStr;
    if(!rec){
      // این دانش‌آموز برای این ماه هنوز کارنامه‌ای ندارد؛ فرم خالی نشان داده می‌شود تا معلم تکمیل کند
      RC_DATA={};
      var nameFromList=document.getElementById('rc-student-select').selectedOptions[0]?document.getElementById('rc-student-select').selectedOptions[0].textContent:'';
      document.getElementById('rc-student-name').value=nameFromList||'';
      document.getElementById('rc-absence').value='';
      document.getElementById('rc-general-note').value='';
      rcSetPhoto('');
      document.getElementById('btn-rc-delete').classList.add('hidden');
      document.getElementById('rc-form-wrap').classList.remove('hidden');
      rcRenderSubjects();
      toast('برای «'+(nameFromList||'این دانش‌آموز')+'» در ماه '+month+' هنوز کارنامه‌ای ثبت نشده؛ می‌توانید تکمیل کنید');
      return;
    }
    RC_DATA=rec.data||{};
    document.getElementById('rc-student-name').value=rec.name||'';
    document.getElementById('rc-absence').value=rec.absence||'';
    document.getElementById('rc-general-note').value=rec.generalNote||'';
    rcSetPhoto(rec.photo||'');
    if(rec.meta){
      document.getElementById('rc-school').value=rec.meta.school||'';
      document.getElementById('rc-teacher').value=rec.meta.teacher||'';
      document.getElementById('rc-year').value=rec.meta.year||'';
    }
    if(rec.font){
      document.getElementById('rc-font').value=rec.font;
      var panel=document.getElementById('lb-panel-reportcard');
      if(panel)panel.style.fontFamily=RC_FONTS[rec.font]||'';
    }
    document.getElementById('btn-rc-delete').classList.remove('hidden');
    document.getElementById('rc-form-wrap').classList.remove('hidden');
    rcRenderSubjects();
  }
  document.getElementById('rc-student-select').addEventListener('change',function(){
    if(this.value)rcLoadStudent(this.value);
    else{document.getElementById('rc-form-wrap').classList.add('hidden');document.getElementById('btn-rc-delete').classList.add('hidden');}
  });
  document.getElementById('btn-rc-delete').onclick=async function(){
    if(!RC_CURRENT_UUID)return;
    var studentName=document.getElementById('rc-student-name').value||'این دانش‌آموز';
    var month=rcSelectedMonth();
    if(!confirm('آیا از حذف کارنامه‌ی «'+studentName+'» برای ماه '+month+' مطمئن هستید؟ این کار قابل بازگشت نیست.'))return;
    var ok=await lbSave('reportcard:student:'+RC_CURRENT_UUID+':'+month,null,true);
    if(ok){
      toast('کارنامه‌ی ماه '+month+' حذف شد ✅');
      rcLoadStudent(RC_CURRENT_UUID);
    }else{
      toast('خطا در حذف اطلاعات');
    }
  };
  document.getElementById('btn-rc-save').onclick=async function(){
    var name=document.getElementById('rc-student-name').value.trim();
    if(!name){toast('لطفاً ابتدا نام دانش‌آموز را وارد کنید');return;}
    if(!RC_CURRENT_UUID){toast('لطفاً ابتدا دانش‌آموز را از فهرست «— انتخاب دانش‌آموز —» انتخاب کنید تا کارنامه در پنل خودش نمایش داده شود');return;}
    var gradeIdx=rcSelectedGradeIdx();
    var month=rcSelectedMonth();
    var rec={
      uuid:RC_CURRENT_UUID,
      name:name,
      grade:gradeIdx,
      month:month,
      absence:document.getElementById('rc-absence').value,
      generalNote:document.getElementById('rc-general-note').value,
      photo:RC_PHOTO,
      font:rcFontKey(),
      meta:{school:document.getElementById('rc-school').value,teacher:document.getElementById('rc-teacher').value,year:document.getElementById('rc-year').value},
      data:RC_DATA
    };
    var ok=await lbSave('reportcard:student:'+RC_CURRENT_UUID+':'+month,rec,true);
    if(ok){
      document.getElementById('btn-rc-delete').classList.remove('hidden');
      toast('کارنامه‌ی «'+name+'» برای ماه '+month+' ذخیره شد ✅ و در پنل دانش‌آموز قابل مشاهده است');
    }else{
      toast('خطا در ذخیره اطلاعات');
    }
  };
  function rcExportHtml(){
    var gradeText=document.getElementById('rc-grade-select').selectedOptions[0].textContent;
    var monthText=rcSelectedMonth();
    var photoHtml=RC_PHOTO
      ? '<img src="'+RC_PHOTO+'" style="width:62px;height:80px;object-fit:cover;border-radius:6px;border:1px solid #cbd5e1;background:#fff;display:block">'
      : '<div style="width:62px;height:80px;border:1.5px dashed #d6c67a;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:9px;color:#a68a1f;text-align:center;background:#fffdf5;box-sizing:border-box">بدون عکس</div>';
    var meta='<div style="background:#fefce8;border:2px solid #eab308;border-radius:10px;padding:14px;display:flex;align-items:flex-start;gap:14px;flex-wrap:wrap;margin-bottom:12px">';
    meta+='<div style="flex:0 0 auto">'+photoHtml+'</div>';
    meta+='<div style="flex:1;min-width:200px;font-size:13px;line-height:1.9">';
    meta+='<p style="margin:2px 0"><b>نام مدرسه:</b> '+esc(document.getElementById('rc-school').value||'.......................')+'</p>';
    meta+='<p style="margin:2px 0"><b>نام آموزگار:</b> '+esc(document.getElementById('rc-teacher').value||'.......................')+'</p>';
    meta+='<p style="margin:2px 0"><b>سال تحصیلی:</b> '+esc(document.getElementById('rc-year').value||'.......................')+'</p>';
    meta+='<p style="margin:2px 0"><b>نام دانش‌آموز:</b> '+esc(document.getElementById('rc-student-name').value||'.......................')+'</p>';
    meta+='<p style="margin:2px 0"><b>پایه تحصیلی:</b> '+esc(gradeText)+' &nbsp;&nbsp; <b>ماه:</b> '+esc(monthText)+' &nbsp;&nbsp; <b>تعداد غیبت:</b> '+esc(document.getElementById('rc-absence').value||'۰')+' روز</p>';
    meta+='</div></div>';
    var table=rcBuildSubjectsHtml(true);
    var note='<p style="margin-top:14px"><b>توضیحات کلی معلم:</b><br>'+esc(document.getElementById('rc-general-note').value||'')+'</p>';
    var sign='<p style="margin-top:30px">امضای آموزگار: ......................... &nbsp;&nbsp;&nbsp;&nbsp; امضای مدیر: .........................</p>';
    return meta+table+note+sign;
  }
  document.getElementById('btn-rc-word').onclick=function(){lbWordExport('کارنامه‌ی توصیفی دانش‌آموز',rcExportHtml(),'کارنامه-دانش-آموز',false,rcFontFamily(),rcFontSizeCtl.current());};
  document.getElementById('btn-rc-pdf').onclick=function(){lbPrintExport('کارنامه‌ی توصیفی دانش‌آموز',rcExportHtml(),false,rcFontFamily(),rcFontSizeCtl.current());};
  lbSetupPrintWrench({toggleId:'btn-rc-print-opts-toggle',drawerId:'rc-print-opts-drawer',orientationId:'rc-print-orientation',fontSizeId:'rc-print-fontsize',printBtnId:'btn-rc-print-custom',wordBtnId:'btn-rc-word-custom',exportFn:rcExportHtml,title:'کارنامه‌ی توصیفی دانش‌آموز',filename:'کارنامه-دانش-آموز',fontFamilyFn:rcFontFamily,currentSizeFn:rcFontSizeCtl.current});
  document.getElementById('btn-rc-excel').onclick=function(){
    var studentName=document.getElementById('rc-student-name').value||'دانش‌آموز';
    var subjects=rcActiveSubjects(rcSelectedGradeIdx());
    lbExcelExport('کارنامه-'+studentName,function(wb){
      var rows=[['نام درس','ارزشیابی','توضیح معلم']];
      subjects.forEach(function(name){
        var saved=RC_DATA[name]||{};
        rows.push([name, RC_LEVEL_LABELS[saved.level]||'', saved.note||'']);
      });
      lbAddExcelSheet(wb,'کارنامه',rows);
    });
  };


  // ===================== ۵. صورتجلسه شورای آموزشی اولیا =====================
  var LB_COUNCIL_HEADERS=['ردیف','نام و نام خانوادگی','سمت / نقش','امضاء'];
  document.getElementById('btn-lbc-build').onclick=function(){
    var n=parseInt(document.getElementById('lbc-rows').value,10)||10;
    lbRebuildPreserving('lbc-table',LB_COUNCIL_HEADERS,n);
  };
  document.getElementById('btn-lbc-addrow').onclick=function(){lbAddSimpleRow('lbc-table',LB_COUNCIL_HEADERS.length);};
  document.getElementById('btn-lbc-build').click();
  var LBC_FONTS={default:'',titr:"'B Titr','BTitr',Tahoma,Arial",nazanin:"'B Nazanin','BNazanin',Tahoma,Arial",mitra:"'B Mitra','BMitra',Tahoma,Arial"};
  function lbcFontFamily(){
    var el=document.getElementById('lbc-font');
    return LBC_FONTS[el?el.value:'default']||undefined;
  }
  var lbcFontSizeCtl=lbLiveFontSize('#lbc-table','lbc-fontsize','btn-lbc-fontsize-inc','btn-lbc-fontsize-dec',12);
  function lbCouncilExportHtml(){
    var meta=lbMetaBlock([['تاریخ برگزاری','lbc-date'],['موضوع جلسه','lbc-topic'],['شماره جلسه','lbc-num'],['ساعت تشکیل','lbc-time']]);
    var summary='<p><b>۱- خلاصه مباحث مطرح شده:</b></p><p style="border:1px solid #ccc;padding:10px;min-height:60px">'+esc(document.getElementById('lbc-summary').value||'')+'</p>';
    var decisions='<p><b>۲- تصمیمات و پیشنهادهای ارائه‌شده:</b></p><p style="border:1px solid #ccc;padding:10px;min-height:60px">'+esc(document.getElementById('lbc-decisions').value||'')+'</p>';
    var rows=lbTableToRows(document.getElementById('lbc-table'));
    var table='<p><b>۳- اسامی اعضای جلسه:</b></p>'+lbRowsToHtmlTable(rows);
    var sign='<p style="margin-top:16px"><b>امضاء و تأیید مدیر مدرسه:</b> .......................</p>';
    return meta+summary+decisions+table+sign;
  }
  document.getElementById('btn-lb-council-word').onclick=function(){lbWordExport('جدول شماره ۱: جلسات شورای آموزشی اولیا',lbCouncilExportHtml(),'صورتجلسه-شورای-آموزشی',false,lbcFontFamily(),lbcFontSizeCtl.current());};
  document.getElementById('btn-lb-council-pdf').onclick=function(){lbPrintExport('جدول شماره ۱: جلسات شورای آموزشی اولیا',lbCouncilExportHtml(),false,lbcFontFamily(),lbcFontSizeCtl.current());};
  lbSetupPrintWrench({toggleId:'btn-lbc-print-opts-toggle',drawerId:'lbc-print-opts-drawer',orientationId:'lbc-print-orientation',fontSizeId:'lbc-print-fontsize',printBtnId:'btn-lbc-print-custom',wordBtnId:'btn-lbc-word-custom',exportFn:lbCouncilExportHtml,title:'جدول شماره ۱: جلسات شورای آموزشی اولیا',filename:'صورتجلسه-شورای-آموزشی',fontFamilyFn:lbcFontFamily,currentSizeFn:lbcFontSizeCtl.current});
  document.getElementById('btn-lb-council-excel').onclick=function(){
    lbExcelExport('صورتجلسه-شورای-آموزشی',function(wb){
      var ws=wb.addWorksheet('صورتجلسه',{views:[{rightToLeft:true}]});
      ws.addRow(['تاریخ برگزاری',document.getElementById('lbc-date').value]);
      ws.addRow(['موضوع جلسه',document.getElementById('lbc-topic').value]);
      ws.addRow(['شماره جلسه',document.getElementById('lbc-num').value]);
      ws.addRow(['ساعت تشکیل',document.getElementById('lbc-time').value]);
      ws.addRow([]);
      ws.addRow(['خلاصه مباحث مطرح شده',document.getElementById('lbc-summary').value]);
      ws.addRow(['تصمیمات و پیشنهادها',document.getElementById('lbc-decisions').value]);
      ws.addRow([]);
      lbTableToRows(document.getElementById('lbc-table')).forEach(function(r){ws.addRow(r);});
      ws.columns.forEach(function(c){c.width=28;});
    });
  };
  var LB_COUNCIL_LOADED=false;
  async function lbLoadCouncilIfNeeded(){
    if(LB_COUNCIL_LOADED)return;
    LB_COUNCIL_LOADED=true;
    var saved=await lbLoad('council');
    if(!saved)return;
    if(saved.meta){
      document.getElementById('lbc-date').value=saved.meta.date||'';
      document.getElementById('lbc-topic').value=saved.meta.topic||'';
      document.getElementById('lbc-num').value=saved.meta.num||'';
      document.getElementById('lbc-time').value=saved.meta.time||'';
    }
    document.getElementById('lbc-summary').value=saved.summary||'';
    document.getElementById('lbc-decisions').value=saved.decisions||'';
    if(saved.rowCount){document.getElementById('lbc-rows').value=saved.rowCount;document.getElementById('btn-lbc-build').click();}
    if(saved.rows)lbFillTableRows('lbc-table',saved.rows);
  }
  document.getElementById('btn-lbc-save').onclick=function(){
    lbSave('council',{
      meta:{date:document.getElementById('lbc-date').value,topic:document.getElementById('lbc-topic').value,num:document.getElementById('lbc-num').value,time:document.getElementById('lbc-time').value},
      summary:document.getElementById('lbc-summary').value,
      decisions:document.getElementById('lbc-decisions').value,
      rowCount:parseInt(document.getElementById('lbc-rows').value,10)||10,
      rows:lbTableToRows(document.getElementById('lbc-table')).slice(1)
    });
  };

  // ===================== ۶. جلسات فردی با اولیا =====================
  var LB_MEET_HEADERS=['ردیف','نام و نام خانوادگی ولی','نسبت با دانش‌آموز','تاریخ دیدار','موضوع دیدار','نتایج (تصمیمات، راهکارها، پیگیری)'];
  document.getElementById('btn-lbm-build').onclick=function(){
    var n=parseInt(document.getElementById('lbm-rows').value,10)||15;
    lbRebuildPreserving('lbm-table',LB_MEET_HEADERS,n);
  };
  document.getElementById('btn-lbm-addrow').onclick=function(){lbAddSimpleRow('lbm-table',LB_MEET_HEADERS.length);};
  document.getElementById('btn-lbm-build').click();
  function lbMeetingsExportHtml(){
    var meta=lbMetaBlock([['نام مدرسه','lbm-school'],['نام آموزگار','lbm-teacher'],['پایه تحصیلی','lbm-grade'],['سال تحصیلی','lbm-year']]);
    var rows=lbTableToRows(document.getElementById('lbm-table'));
    return meta+lbRowsToHtmlTable(rows)+'<p style="margin-top:14px"><b>ادامه جلسات فردی با اولیا</b></p>';
  }
  document.getElementById('btn-lb-meetings-word').onclick=function(){lbWordExport('جدول ۱۰ - جلسات فردی با اولیا',lbMeetingsExportHtml(),'جلسات-فردی-با-اولیا',true);};
  document.getElementById('btn-lb-meetings-pdf').onclick=function(){lbPrintExport('جدول ۱۰ - جلسات فردی با اولیا',lbMeetingsExportHtml(),true);};
  document.getElementById('btn-lb-meetings-excel').onclick=function(){
    lbExcelExport('جلسات-فردی-با-اولیا',function(wb){
      lbAddExcelSheet(wb,'جلسات فردی',lbTableToRows(document.getElementById('lbm-table')));
    });
  };
  var LB_MEETINGS_LOADED=false;
  async function lbLoadMeetingsIfNeeded(){
    if(LB_MEETINGS_LOADED)return;
    LB_MEETINGS_LOADED=true;
    var saved=await lbLoad('meetings');
    if(!saved)return;
    if(saved.meta){
      document.getElementById('lbm-school').value=saved.meta.school||'';
      document.getElementById('lbm-teacher').value=saved.meta.teacher||'';
      document.getElementById('lbm-grade').value=saved.meta.grade||'';
      document.getElementById('lbm-year').value=saved.meta.year||'';
    }
    if(saved.rowCount){document.getElementById('lbm-rows').value=saved.rowCount;document.getElementById('btn-lbm-build').click();}
    if(saved.rows)lbFillTableRows('lbm-table',saved.rows);
  }
  document.getElementById('btn-lbm-save').onclick=function(){
    lbSave('meetings',{
      meta:{school:document.getElementById('lbm-school').value,teacher:document.getElementById('lbm-teacher').value,grade:document.getElementById('lbm-grade').value,year:document.getElementById('lbm-year').value},
      rowCount:parseInt(document.getElementById('lbm-rows').value,10)||15,
      rows:lbTableToRows(document.getElementById('lbm-table')).slice(1)
    });
  };

  // ===================== ۷. برنامه درسی هفتگی (ویژه چندپایه) - جدول ۱-۳-۱ =====================
  var LB_WEEKLY_DAYS=['شنبه','یکشنبه','دوشنبه','سه‌شنبه','چهارشنبه'];
  var LB_WEEKLY_GRADE_NAMES=['اول','دوم','سوم','چهارم','پنجم','ششم'];
  var LB_WEEKLY_DATA={}; // key: 'dayIdx-gradeIdx-sessionIdx' -> مقدار سلول (gradeIdx همیشه بر اساس شماره‌ی واقعی پایه ۰ تا ۵ است، حتی اگر آن پایه فعلاً انتخاب نشده باشد)
  function lbSelectedWeeklyGrades(){
    var out=[];
    document.querySelectorAll('.lbw-grade-chk').forEach(function(chk,idx){
      if(chk.checked)out.push(idx);
    });
    return out;
  }
  function lbBuildWeeklyHtml(forExport){
    var grades=lbSelectedWeeklyGrades();
    if(!grades.length)grades=[0,1,2,3,4,5];
    var h='<p style="font-weight:700;margin-bottom:6px">برنامه درسی چندپایه</p>';
    h+='<table class="lb-table lb-table-tight" style="width:100%"><thead><tr><th>روز</th><th>پایه</th><th>زنگ اول</th><th>زنگ دوم</th><th>زنگ سوم</th><th>زنگ چهارم</th><th>زنگ پنجم</th></tr></thead><tbody>';
    LB_WEEKLY_DAYS.forEach(function(day,dIdx){
      grades.forEach(function(gIdx,i){
        var rowKey='row-'+dIdx+'-'+gIdx;
        var rowHex=forExport?(ROW_COLOR_HEX[lbWeeklyRowColors[rowKey]]||''):'';
        h+='<tr'+(rowHex?' style="background:'+rowHex+'"':'')+'>';
        if(i===0)h+='<td rowspan="'+grades.length+'" style="font-weight:700;background:#f1f5f9">'+esc(day)+'</td>';
        h+='<td style="font-weight:700'+(rowHex?';background:'+rowHex:'')+'">'+LB_WEEKLY_GRADE_NAMES[gIdx]+(forExport?'':rowColorDotsHtml(rowKey))+'</td>';
        for(var s=0;s<5;s++){
          var key=dIdx+'-'+gIdx+'-'+s;
          var v=LB_WEEKLY_DATA[key]||'';
          h+=forExport?'<td style="background:'+(rowHex||'#fff')+'">'+esc(v).replace(/\\n/g,'<br>')+'</td>':'<td><textarea class="lb-weekly-cell" rows="1" data-key="'+key+'">'+esc(v)+'</textarea></td>';
        }
        h+='</tr>';
      });
    });
    h+='</tbody></table>';
    return h;
  }
  function lbBindWeeklyInputs(el){
    el.querySelectorAll('.lb-weekly-cell').forEach(function(inp){
      lbAutoResizeStaffTa(inp);
      inp.addEventListener('input',function(){LB_WEEKLY_DATA[inp.dataset.key]=inp.value;lbAutoResizeStaffTa(inp);});
    });
  }
  var lbWeeklyRowColors={};
  // --- فونت و اندازه‌ی جدول برنامه چندپایه ---
  function lbApplyWeeklyStyle(){
    var fontKey=document.getElementById('lbw-font').value;
    var size=parseInt(document.getElementById('lbw-font-size').value,10)||12;
    var family=lbStaffFontCss(fontKey);
    var el=document.getElementById('lb-weekly-preview');
    var tableEl=el.querySelector('table');
    if(!tableEl)return;
    tableEl.style.fontFamily=family;
    tableEl.style.fontWeight='bold';
    tableEl.style.fontSize=size+'px';
    tableEl.querySelectorAll('th,td').forEach(function(cell){
      cell.style.fontFamily=family;
      cell.style.fontWeight='bold';
      cell.style.fontSize=size+'px';
    });
    tableEl.querySelectorAll('textarea').forEach(function(ta){
      ta.style.fontFamily=family;
      ta.style.fontWeight='bold';
      ta.style.fontSize=size+'px';
      lbAutoResizeStaffTa(ta);
    });
  }
  document.getElementById('lbw-font').addEventListener('change',function(){
    lbApplyWeeklyStyle();
    lbSave('weekly-font',document.getElementById('lbw-font').value,true);
  });
  document.getElementById('lbw-font-size').addEventListener('input',lbApplyWeeklyStyle);
  document.getElementById('lbw-font-size').addEventListener('change',function(){
    lbApplyWeeklyStyle();
    lbSave('weekly-font-size',document.getElementById('lbw-font-size').value,true);
  });
  document.getElementById('lbw-font-size').addEventListener('keydown',function(e){if(e.key==='Enter')lbApplyWeeklyStyle();});
  function lbRenderWeekly(){
    var el=document.getElementById('lb-weekly-preview');
    el.innerHTML=lbBuildWeeklyHtml(false);
    lbBindWeeklyInputs(el);
    refreshRowColorPickers(el,lbWeeklyRowColors);
    lbApplyWeeklyStyle();
  }
  document.getElementById('lb-weekly-preview').addEventListener('click',function(e){
    var dot=e.target.closest('.row-color-dot');
    if(!dot)return;
    lbWeeklyRowColors[dot.dataset.key]=dot.dataset.color;
    refreshRowColorPickers(document.getElementById('lb-weekly-preview'),lbWeeklyRowColors);
    lbSave('weekly-row-colors',lbWeeklyRowColors,true);
  });
  document.getElementById('btn-lbw-build').onclick=lbRenderWeekly;
  var LB_WEEKLY_LOADED=false;
  async function lbLoadWeeklyIfNeeded(){
    if(LB_WEEKLY_LOADED){lbRenderWeekly();return;}
    LB_WEEKLY_LOADED=true;
    var saved=await lbLoad('weekly');
    var savedColors=await lbLoad('weekly-row-colors');
    var savedFont=await lbLoad('weekly-font');
    var savedFontSize=await lbLoad('weekly-font-size');
    if(savedColors&&typeof savedColors==='object')lbWeeklyRowColors=savedColors;
    if(saved){
      document.getElementById('lbw-school').value=saved.school||'';
      document.getElementById('lbw-teacher').value=saved.teacher||'';
      document.getElementById('lbw-class').value=saved.className||'';
      if(saved.data)LB_WEEKLY_DATA=saved.data;
      if(saved.grades&&saved.grades.length){
        document.querySelectorAll('.lbw-grade-chk').forEach(function(chk,idx){
          chk.checked=saved.grades.indexOf(idx)>=0;
        });
      }
      if(saved.font)document.getElementById('lbw-font').value=saved.font;
      if(saved.fontSize)document.getElementById('lbw-font-size').value=saved.fontSize;
    }
    if(savedFont)document.getElementById('lbw-font').value=savedFont;
    if(savedFontSize)document.getElementById('lbw-font-size').value=savedFontSize;
    lbRenderWeekly();
  }
  document.getElementById('btn-lbw-save').onclick=function(){
    lbSave('weekly',{
      school:document.getElementById('lbw-school').value,
      teacher:document.getElementById('lbw-teacher').value,
      className:document.getElementById('lbw-class').value,
      grades:lbSelectedWeeklyGrades(),
      data:LB_WEEKLY_DATA,
      font:document.getElementById('lbw-font').value,
      fontSize:document.getElementById('lbw-font-size').value
    });
  };
  function lbWeeklySignatureFooterHtml(){
    return '<table style="width:100%;border:none;margin-top:46px"><tr>'
      +'<td style="border:none;width:50%;text-align:center;vertical-align:top;padding:0 10px">نام مدیر مدرسه: .......................................<br><br><br>مهر و امضا</td>'
      +'<td style="border:none;width:50%;text-align:center;vertical-align:top;padding:0 10px">نام کارشناس آموزش منطقه: .......................................<br><br><br>مهر و امضا</td>'
      +'</tr></table>';
  }
  function lbWeeklyExportHtml(){
    var meta='<p class="lb-meta"><b>نام مدرسه:</b> '+esc(document.getElementById('lbw-school').value)+'&nbsp;&nbsp;&nbsp;&nbsp;<b>نام آموزگار:</b> '+esc(document.getElementById('lbw-teacher').value)+'&nbsp;&nbsp;&nbsp;&nbsp;<b>کلاس:</b> '+esc(document.getElementById('lbw-class').value)+'</p>';
    var fontKey=document.getElementById('lbw-font').value;
    var fontFamily=lbStaffFontCss(fontKey);
    var fontSize=parseInt(document.getElementById('lbw-font-size').value,10)||12;
    var style='<style>.lbw-export-wrap th,.lbw-export-wrap td{font-family:'+fontFamily+' !important;font-weight:bold !important;font-size:'+fontSize+'px !important}</style>';
    return style+'<div class="lbw-export-wrap">'+meta+lbBuildWeeklyHtml(true)+lbWeeklySignatureFooterHtml()+'</div>';
  }
  document.getElementById('btn-lb-weekly-word').onclick=function(){lbWordExport('جدول ۱-۳-۱ ـ برنامه درسی هفتگی (ویژه چندپایه)',lbWeeklyExportHtml(),'برنامه-درسی-هفتگی',false);};
  document.getElementById('btn-lb-weekly-pdf').onclick=function(){lbPrintExport('جدول ۱-۳-۱ ـ برنامه درسی هفتگی (ویژه چندپایه)',lbWeeklyExportHtml(),false);};
  document.getElementById('btn-lbw-print-opts-toggle').onclick=function(){
    document.getElementById('lbw-print-opts-drawer').classList.toggle('hidden');
  };
  document.getElementById('btn-lbw-print-custom').onclick=function(){
    var landscape=document.getElementById('lbw-print-orientation').value==='landscape';
    lbPrintExport('جدول ۱-۳-۱ ـ برنامه درسی هفتگی (ویژه چندپایه)',lbWeeklyExportHtml(),landscape);
  };
  document.getElementById('btn-lbw-word-custom').onclick=function(){
    var landscape=document.getElementById('lbw-print-orientation').value==='landscape';
    lbWordExport('جدول ۱-۳-۱ ـ برنامه درسی هفتگی (ویژه چندپایه)',lbWeeklyExportHtml(),'برنامه-درسی-هفتگی',landscape);
  };
  document.getElementById('btn-lb-weekly-excel').onclick=function(){
    var grades=lbSelectedWeeklyGrades();
    if(!grades.length)grades=[0,1,2,3,4,5];
    lbExcelExport('برنامه-درسی-هفتگی',function(wb){
      var rows=[['روز','پایه','زنگ اول','زنگ دوم','زنگ سوم','زنگ چهارم','زنگ پنجم']];
      LB_WEEKLY_DAYS.forEach(function(day,dIdx){
        grades.forEach(function(gIdx,i){
          var row=[i===0?day:'',LB_WEEKLY_GRADE_NAMES[gIdx]];
          for(var s=0;s<5;s++)row.push(LB_WEEKLY_DATA[dIdx+'-'+gIdx+'-'+s]||'');
          rows.push(row);
        });
      });
      lbAddExcelSheet(wb,'برنامه هفتگی',rows);
    });
  };

  // ===================== ۸. برنامه درسی هفتگی (کلاس تک‌پایه) - جدول ۳ =====================
  var LB_WEEKLY2_DAYS=['شنبه','یکشنبه','دوشنبه','سه‌شنبه','چهارشنبه'];
  var LB_WEEKLY2_SESSIONS=['زنگ اول','زنگ دوم','سوم','چهارم','پنجم'];
  var LB_WEEKLY2_DATA={}; // key: 'dayIdx-sessionIdx'
  function lbWeekly2DiagCellHtml(forExport){
    if(forExport){
      // استایل inline کامل تا در فایل Word/چاپ هم (بدون وابستگی به استایل صفحه) درست دیده شود
      return '<th style="position:relative;padding:0;height:44px;min-width:70px;'
        +'background:linear-gradient(to top left, transparent calc(50% - 1px), #94a3b8 calc(50% - 1px), #94a3b8 calc(50% + 1px), transparent calc(50% + 1px))">'
        +'<span style="position:absolute;top:2px;left:6px;font-size:10px;font-weight:700">زنگ</span>'
        +'<span style="position:absolute;bottom:2px;right:6px;font-size:10px;font-weight:700">روز</span>'
        +'</th>';
    }
    return '<th class="lb-diag-cell"><span class="lb-diag-top">زنگ</span><span class="lb-diag-bottom">روز</span></th>';
  }
  function lbBuildWeekly2Html(forExport){
    var h='<table class="lb-table lb-table-tight" style="width:100%"><thead><tr>';
    h+=lbWeekly2DiagCellHtml(forExport);
    LB_WEEKLY2_SESSIONS.forEach(function(s){h+='<th>'+esc(s)+'</th>';});
    h+='</tr></thead><tbody>';
    LB_WEEKLY2_DAYS.forEach(function(day,dIdx){
      var rowKey='day-'+dIdx;
      var rowHex=forExport?(ROW_COLOR_HEX[lbWeekly2RowColors[rowKey]]||''):'';
      h+='<tr><td style="font-weight:700;background:'+(rowHex||'#f1f5f9')+'">'+esc(day)+(forExport?'':rowColorDotsHtml(rowKey))+'</td>';
      LB_WEEKLY2_SESSIONS.forEach(function(s,sIdx){
        var key=dIdx+'-'+sIdx;
        var v=LB_WEEKLY2_DATA[key]||'';
        h+=forExport?'<td style="background:'+(rowHex||'#fff')+'">'+esc(v).replace(/\\n/g,'<br>')+'</td>':'<td><textarea class="lb-weekly2-cell" rows="1" data-key="'+key+'">'+esc(v)+'</textarea></td>';
      });
      h+='</tr>';
    });
    h+='</tbody></table>';
    return h;
  }
  function lbBindWeekly2Inputs(el){
    el.querySelectorAll('.lb-weekly2-cell').forEach(function(inp){
      lbAutoResizeStaffTa(inp);
      inp.addEventListener('input',function(){LB_WEEKLY2_DATA[inp.dataset.key]=inp.value;lbAutoResizeStaffTa(inp);});
    });
  }
  var lbWeekly2RowColors={};
  // --- فونت و اندازه‌ی جدول برنامه تک‌پایه ---
  function lbApplyWeekly2Style(){
    var fontKey=document.getElementById('lbw2-font').value;
    var size=parseInt(document.getElementById('lbw2-font-size').value,10)||12;
    var family=lbStaffFontCss(fontKey);
    var el=document.getElementById('lb-weekly2-preview');
    var tableEl=el.querySelector('table');
    if(!tableEl)return;
    tableEl.style.fontFamily=family;
    tableEl.style.fontWeight='bold';
    tableEl.style.fontSize=size+'px';
    tableEl.querySelectorAll('th,td').forEach(function(cell){
      cell.style.fontFamily=family;
      cell.style.fontWeight='bold';
      cell.style.fontSize=size+'px';
    });
    tableEl.querySelectorAll('textarea').forEach(function(ta){
      ta.style.fontFamily=family;
      ta.style.fontWeight='bold';
      ta.style.fontSize=size+'px';
      lbAutoResizeStaffTa(ta);
    });
  }
  document.getElementById('lbw2-font').addEventListener('change',function(){
    lbApplyWeekly2Style();
    lbSave('weekly2-font',document.getElementById('lbw2-font').value,true);
  });
  document.getElementById('lbw2-font-size').addEventListener('input',lbApplyWeekly2Style);
  document.getElementById('lbw2-font-size').addEventListener('change',function(){
    lbApplyWeekly2Style();
    lbSave('weekly2-font-size',document.getElementById('lbw2-font-size').value,true);
  });
  document.getElementById('lbw2-font-size').addEventListener('keydown',function(e){if(e.key==='Enter')lbApplyWeekly2Style();});
  function lbRenderWeekly2(){
    var el=document.getElementById('lb-weekly2-preview');
    el.innerHTML=lbBuildWeekly2Html(false);
    lbBindWeekly2Inputs(el);
    refreshRowColorPickers(el,lbWeekly2RowColors);
    lbApplyWeekly2Style();
  }
  document.getElementById('lb-weekly2-preview').addEventListener('click',function(e){
    var dot=e.target.closest('.row-color-dot');
    if(!dot)return;
    lbWeekly2RowColors[dot.dataset.key]=dot.dataset.color;
    refreshRowColorPickers(document.getElementById('lb-weekly2-preview'),lbWeekly2RowColors);
    lbSave('weekly2-row-colors',lbWeekly2RowColors,true);
  });
  var LB_WEEKLY2_LOADED=false;
  async function lbLoadWeekly2IfNeeded(){
    if(LB_WEEKLY2_LOADED){lbRenderWeekly2();return;}
    LB_WEEKLY2_LOADED=true;
    var saved=await lbLoad('weekly2');
    var savedColors=await lbLoad('weekly2-row-colors');
    var savedFont=await lbLoad('weekly2-font');
    var savedFontSize=await lbLoad('weekly2-font-size');
    if(savedColors&&typeof savedColors==='object')lbWeekly2RowColors=savedColors;
    if(saved){
      document.getElementById('lbw2-school').value=saved.school||'';
      document.getElementById('lbw2-teacher').value=saved.teacher||'';
      document.getElementById('lbw2-grade').value=saved.grade||'';
      document.getElementById('lbw2-class').value=saved.className||'';
      if(saved.data)LB_WEEKLY2_DATA=saved.data;
      if(saved.font)document.getElementById('lbw2-font').value=saved.font;
      if(saved.fontSize)document.getElementById('lbw2-font-size').value=saved.fontSize;
    }
    if(savedFont)document.getElementById('lbw2-font').value=savedFont;
    if(savedFontSize)document.getElementById('lbw2-font-size').value=savedFontSize;
    lbRenderWeekly2();
  }
  document.getElementById('btn-lbw2-save').onclick=function(){
    lbSave('weekly2',{school:document.getElementById('lbw2-school').value,teacher:document.getElementById('lbw2-teacher').value,grade:document.getElementById('lbw2-grade').value,className:document.getElementById('lbw2-class').value,data:LB_WEEKLY2_DATA,font:document.getElementById('lbw2-font').value,fontSize:document.getElementById('lbw2-font-size').value});
  };
  function lbWeekly2ExportHtml(){
    var meta='<p class="lb-meta"><b>نام مدرسه:</b> '+esc(document.getElementById('lbw2-school').value)+' &nbsp;&nbsp;&nbsp; <b>نام آموزگار:</b> '+esc(document.getElementById('lbw2-teacher').value)+' &nbsp;&nbsp;&nbsp; <b>پایه:</b> '+esc(document.getElementById('lbw2-grade').value)+' &nbsp;&nbsp;&nbsp; <b>کلاس:</b> '+esc(document.getElementById('lbw2-class').value)+'</p>';
    var fontKey=document.getElementById('lbw2-font').value;
    var fontFamily=lbStaffFontCss(fontKey);
    var fontSize=parseInt(document.getElementById('lbw2-font-size').value,10)||12;
    var style='<style>.lbw2-export-wrap th,.lbw2-export-wrap td{font-family:'+fontFamily+' !important;font-weight:bold !important;font-size:'+fontSize+'px !important}</style>';
    return style+'<div class="lbw2-export-wrap">'+meta+lbBuildWeekly2Html(true)+'</div>';
  }
  document.getElementById('btn-lb-weekly2-word').onclick=function(){lbWordExport('جدول ۳- برنامه درسی هفتگی (کلاس تک پایه)',lbWeekly2ExportHtml(),'برنامه-درسی-هفتگی-تک-پایه',false);};
  document.getElementById('btn-lb-weekly2-pdf').onclick=function(){lbPrintExport('جدول ۳- برنامه درسی هفتگی (کلاس تک پایه)',lbWeekly2ExportHtml(),false);};
  document.getElementById('btn-lbw2-print-opts-toggle').onclick=function(){
    document.getElementById('lbw2-print-opts-drawer').classList.toggle('hidden');
  };
  document.getElementById('btn-lbw2-print-custom').onclick=function(){
    var landscape=document.getElementById('lbw2-print-orientation').value==='landscape';
    lbPrintExport('جدول ۳- برنامه درسی هفتگی (کلاس تک پایه)',lbWeekly2ExportHtml(),landscape);
  };
  document.getElementById('btn-lbw2-word-custom').onclick=function(){
    var landscape=document.getElementById('lbw2-print-orientation').value==='landscape';
    lbWordExport('جدول ۳- برنامه درسی هفتگی (کلاس تک پایه)',lbWeekly2ExportHtml(),'برنامه-درسی-هفتگی-تک-پایه',landscape);
  };
  document.getElementById('btn-lb-weekly2-excel').onclick=function(){
    lbExcelExport('برنامه-درسی-هفتگی-تک-پایه',function(wb){
      var rows=[['روز'].concat(LB_WEEKLY2_SESSIONS)];
      LB_WEEKLY2_DAYS.forEach(function(day,dIdx){
        var row=[day];
        LB_WEEKLY2_SESSIONS.forEach(function(s,sIdx){row.push(LB_WEEKLY2_DATA[dIdx+'-'+sIdx]||'');});
        rows.push(row);
      });
      lbAddExcelSheet(wb,'برنامه هفتگی تک‌پایه',rows);
    });
  };

  // ===================== ۹. اطلاعات پرسنلی همکاران مدرسه =====================
  var LB_STAFF_HEADERS=['ردیف','کد پرسنلی','نام و نام خانوادگی','سمت','سابقه','مدرک','نوع استخدام','پایه تدریس'];
  var LB_STAFF_COL_WIDTHS=['5%','10%','20%','12%','8%','10%','12%','23%'];
  function lbBuildStaffTableHtml(rowCount){
    var h='<colgroup>'+LB_STAFF_COL_WIDTHS.map(function(w){return '<col style="width:'+w+'">';}).join('')+'</colgroup>';
    h+='<thead><tr>'+LB_STAFF_HEADERS.map(function(hd){return '<th>'+esc(hd)+'</th>';}).join('')+'</tr></thead><tbody>';
    for(var r=1;r<=rowCount;r++){
      h+='<tr><td>'+toFaDigits(r)+rowColorDotsHtml('r'+r)+'</td>';
      for(var c=1;c<LB_STAFF_HEADERS.length;c++)h+='<td><textarea class="lbs-cell-ta" rows="1"></textarea></td>';
      h+='</tr>';
    }
    h+='</tbody>';
    return h;
  }
  // مثل ورد: با زدن اینتر داخل خانه، متن به خط بعد می‌رود و ارتفاع همان خانه (و کل ردیف) به‌صورت خودکار بزرگ‌تر می‌شود
  function lbAutoResizeStaffTa(ta){
    ta.style.height='auto';
    ta.style.height=ta.scrollHeight+'px';
  }
  function lbWireStaffTextareas(){
    var tableEl=document.getElementById('lbs-table');
    if(!tableEl)return;
    tableEl.querySelectorAll('textarea.lbs-cell-ta').forEach(function(ta){
      lbAutoResizeStaffTa(ta);
      if(ta.dataset.lbsWired)return;
      ta.dataset.lbsWired='1';
      ta.addEventListener('input',function(){lbAutoResizeStaffTa(ta);});
    });
  }
  function lbRebuildStaffPreserving(rowCount){
    var tableEl=document.getElementById('lbs-table');
    var oldRows=tableEl.querySelector('tbody')?lbTableToRows(tableEl).slice(1):[];
    tableEl.innerHTML=lbBuildStaffTableHtml(rowCount);
    var trs=tableEl.querySelectorAll('tbody tr');
    trs.forEach(function(tr,rIdx){
      var oldRow=oldRows[rIdx];
      if(!oldRow)return;
      var tds=tr.querySelectorAll('td');
      tds.forEach(function(td,cIdx){
        if(cIdx===0)return;
        var inp=td.querySelector('textarea,input');
        if(inp && oldRow[cIdx]!==undefined)inp.value=oldRow[cIdx];
      });
    });
  }
  document.getElementById('btn-lbs-build').onclick=function(){
    var n=parseInt(document.getElementById('lbs-rows').value,10)||15;
    lbRebuildStaffPreserving(n);
    lbApplyStaffStyle();
    refreshRowColorPickers(document.getElementById('lbs-table'),lbStaffRowColors);
  };
  document.getElementById('btn-lbs-addrow').onclick=function(){
    var tbody=document.querySelector('#lbs-table tbody');
    var rowNum=tbody.children.length+1;
    var tr=document.createElement('tr');
    var html='<td>'+toFaDigits(rowNum)+rowColorDotsHtml('r'+rowNum)+'</td>';
    for(var c=1;c<LB_STAFF_HEADERS.length;c++)html+='<td><textarea class="lbs-cell-ta" rows="1"></textarea></td>';
    tr.innerHTML=html;
    tbody.appendChild(tr);
    lbApplyStaffStyle();
    refreshRowColorPickers(document.getElementById('lbs-table'),lbStaffRowColors);
  };
  var lbStaffRowColors={};
  document.getElementById('lbs-table').addEventListener('click',function(e){
    var dot=e.target.closest('.row-color-dot');
    if(!dot)return;
    lbStaffRowColors[dot.dataset.key]=dot.dataset.color;
    refreshRowColorPickers(document.getElementById('lbs-table'),lbStaffRowColors);
    lbSave('staff-row-colors',lbStaffRowColors,true);
  });

  // --- فونت و اندازه جدول (زنده روی صفحه) ---
  var LB_STAFF_FONTS={bnazanin:"'BNazanin','B Nazanin',Tahoma,Arial",bmitra:"'BMitra','B Mitra',Tahoma,Arial"};
  function lbStaffFontCss(key){return LB_STAFF_FONTS[key]||LB_STAFF_FONTS.bnazanin;}
  function lbApplyStaffStyle(){
    var fontKey=document.getElementById('lbs-font').value;
    var size=parseInt(document.getElementById('lbs-font-size').value,10)||12;
    var family=lbStaffFontCss(fontKey);
    var tableEl=document.getElementById('lbs-table');
    // فقط اندازه‌ی خود متن تغییر می‌کند؛ فاصله‌ی داخلی سلول‌ها (padding) ثابت می‌ماند
    // تا با تغییر اندازه‌ی فونت، جدول به‌جای «بزرگ‌شدن کلی»، صرفاً نوشته‌هایش بزرگ/کوچک شوند.
    tableEl.style.fontFamily=family;
    tableEl.style.fontWeight='bold';
    tableEl.style.fontSize=size+'px';
    tableEl.querySelectorAll('th,td').forEach(function(cell){
      cell.style.fontFamily=family;
      cell.style.fontWeight='bold';
      cell.style.fontSize=size+'px';
    });
    // چون ورودی‌های داخل جدول یک قانون CSS جداگانه با اندازه‌ی فونت ثابت دارند،
    // باید اندازه‌ی فونت روی خودشان هم مستقیماً تنظیم شود وگرنه تغییری دیده نمی‌شود.
    tableEl.querySelectorAll('textarea').forEach(function(inp){
      inp.style.fontFamily=family;
      inp.style.fontWeight='bold';
      inp.style.fontSize=size+'px';
    });
    lbWireStaffTextareas();
  }
  document.getElementById('lbs-font').onchange=lbApplyStaffStyle;
  document.getElementById('lbs-font-size').oninput=lbApplyStaffStyle;
  document.getElementById('lbs-font-size').onchange=lbApplyStaffStyle;
  document.getElementById('lbs-font-size').addEventListener('keydown',function(e){if(e.key==='Enter')lbApplyStaffStyle();});

  document.getElementById('btn-lbs-build').click();

  // --- بزرگ/کوچک کردن جدول با کشیدن گوشه (ماوس و لمسی) ---
  (function(){
    var handle=document.getElementById('lbs-resize-handle');
    var sizeInput=document.getElementById('lbs-font-size');
    var dragging=false,startX=0,startY=0,startSize=12;
    function pos(e){return e.touches&&e.touches[0]?{x:e.touches[0].clientX,y:e.touches[0].clientY}:{x:e.clientX,y:e.clientY};}
    function onDown(e){
      dragging=true;
      var p=pos(e);
      startX=p.x;startY=p.y;
      startSize=parseInt(sizeInput.value,10)||12;
      e.preventDefault();
    }
    function onMove(e){
      if(!dragging)return;
      var p=pos(e);
      var delta=((p.x-startX)+(p.y-startY))/8;
      var newSize=Math.max(8,Math.min(40,Math.round(startSize+delta)));
      sizeInput.value=newSize;
      lbApplyStaffStyle();
      e.preventDefault();
    }
    function onUp(){dragging=false;}
    handle.addEventListener('mousedown',onDown);
    document.addEventListener('mousemove',onMove);
    document.addEventListener('mouseup',onUp);
    handle.addEventListener('touchstart',onDown,{passive:false});
    document.addEventListener('touchmove',onMove,{passive:false});
    document.addEventListener('touchend',onUp);
  })();

  var LB_STAFF_LOADED=false;
  async function lbLoadStaffIfNeeded(){
    if(LB_STAFF_LOADED)return;
    LB_STAFF_LOADED=true;
    var saved=await lbLoad('staff');
    var savedColors=await lbLoad('staff-row-colors');
    if(savedColors&&typeof savedColors==='object')lbStaffRowColors=savedColors;
    if(!saved){refreshRowColorPickers(document.getElementById('lbs-table'),lbStaffRowColors);return;}
    document.getElementById('lbs-year').value=saved.year||'';
    if(saved.rowCount){document.getElementById('lbs-rows').value=saved.rowCount;document.getElementById('btn-lbs-build').click();}
    if(saved.rows)lbFillTableRows('lbs-table',saved.rows);
    if(saved.font)document.getElementById('lbs-font').value=saved.font;
    if(saved.fontSize)document.getElementById('lbs-font-size').value=saved.fontSize;
    lbApplyStaffStyle();
    refreshRowColorPickers(document.getElementById('lbs-table'),lbStaffRowColors);
  }
  document.getElementById('btn-lbs-save').onclick=function(){
    lbSave('staff',{
      year:document.getElementById('lbs-year').value,
      rowCount:parseInt(document.getElementById('lbs-rows').value,10)||15,
      rows:lbTableToRows(document.getElementById('lbs-table')).slice(1),
      font:document.getElementById('lbs-font').value,
      fontSize:document.getElementById('lbs-font-size').value
    });
  };
  function lbStaffExportHtml(){
    var year=document.getElementById('lbs-year').value;
    var fontKey=document.getElementById('lbs-font').value;
    var fontFamily=lbStaffFontCss(fontKey);
    var fontSize=parseInt(document.getElementById('lbs-font-size').value,10)||12;
    var head='<style>'
      +'@font-face{font-family:"BNazanin";src:url(https://cdn.jsdelivr.net/gh/intuxicated/css-persian@master/fonts/BNazanin.ttf)}'
      +'@font-face{font-family:"BMitra";src:url(https://cdn.jsdelivr.net/gh/intuxicated/css-persian@master/fonts/BMitra.ttf)}'
      +'.lbs-export-wrap{font-family:'+fontFamily+'}'
      +'.lbs-export-wrap th,.lbs-export-wrap td{font-family:'+fontFamily+' !important;font-weight:bold !important;font-size:'+fontSize+'px !important;text-align:center !important}'
      +'</style>';
    head+='<table style="width:100%;border:none;margin-bottom:10px"><tr>'
      +'<td style="border:none;text-align:right;font-weight:700;font-size:15px">اطلاعات پرسنلی همکاران مدرسه</td>'
      +'<td style="border:none;text-align:left;font-weight:700">سال تحصیلی: '+esc(year)+'</td>'
      +'</tr></table>';
    var rows=lbTableToRows(document.getElementById('lbs-table'));
    var table='<table class="lb-table-zebra">'+lbBuildStaffTableHtml(rows.length-1)+'</table>';
    // مقداردهی سلول‌های خروجی از روی جدول زنده (چون lbBuildStaffTableHtml فقط ساختار خالی می‌سازد)
    var tmp=document.createElement('div');
    tmp.innerHTML=table;
    var trs=tmp.querySelectorAll('tbody tr');
    rows.slice(1).forEach(function(r,rIdx){
      var tds=trs[rIdx]?trs[rIdx].querySelectorAll('td'):[];
      tds.forEach(function(td,cIdx){
        if(cIdx===0)return;
        var inp=td.querySelector('textarea,input');
        if(inp)td.innerHTML=esc(r[cIdx]||'').replace(/\\n/g,'<br>');
      });
    });
    return head+'<div class="lbs-export-wrap">'+tmp.innerHTML+'</div>';
  }
  document.getElementById('btn-lb-staff-word').onclick=function(){lbWordExport('اطلاعات پرسنلی همکاران مدرسه',lbStaffExportHtml(),'اطلاعات-پرسنلی-همکاران',true);};
  document.getElementById('btn-lb-staff-pdf').onclick=function(){lbPrintExport('اطلاعات پرسنلی همکاران مدرسه',lbStaffExportHtml(),true);};
  document.getElementById('btn-lb-staff-excel').onclick=function(){
    lbExcelExport('اطلاعات-پرسنلی-همکاران',function(wb){
      lbAddExcelSheet(wb,'پرسنل',lbTableToRows(document.getElementById('lbs-table')));
    });
  };
  // ===================== ۱۰. صورتجلسه (فرم عمومی) =====================
  var LB_MIN_DECISIONS=['','','',''];
  var LB_MIN_ATTENDEES=[{name:'',role:'',sign:''},{name:'',role:'',sign:''},{name:'',role:'',sign:''},{name:'',role:'',sign:''},
    {name:'',role:'',sign:''},{name:'',role:'',sign:''},{name:'',role:'',sign:''},{name:'',role:'',sign:''}];

  function lbBuildMinutesDecisionsHtml(forExport){
    if(forExport){
      var h='<table style="width:100%;border-collapse:collapse" class="lb-minutes-table"><thead><tr>'
        +'<th style="border:1px solid #333;padding:6px;width:8%">ردیف</th>'
        +'<th style="border:1px solid #333;padding:6px">مصوبات</th></tr></thead><tbody>';
      LB_MIN_DECISIONS.forEach(function(val,i){
        h+='<tr><td style="border:1px solid #333;padding:6px;text-align:center">'+toFaDigits(i+1)+'</td>'
          +'<td style="border:1px solid #333;padding:6px;text-align:right">'+toFaDigits(esc(val)).replace(/\\n/g,'<br>')+'</td></tr>';
      });
      h+='</tbody></table>';
      return h;
    }
    var h='<table class="lb-table" id="lbmin-decisions-table" style="width:100%"><thead><tr>'
      +'<th style="width:8%">ردیف</th><th>مصوبات</th><th style="width:44px"></th></tr></thead><tbody>';
    LB_MIN_DECISIONS.forEach(function(val,i){
      h+='<tr><td>'+toFaDigits(i+1)+'</td>'
        +'<td><input type="text" class="lbmin-decision-input" data-idx="'+i+'" value="'+esc(val)+'"></td>'
        +'<td><button type="button" class="btn sm danger lbmin-decision-del" data-idx="'+i+'" title="حذف این ردیف">🗑</button></td></tr>';
    });
    h+='</tbody></table>';
    return h;
  }
  function lbRenderMinutesDecisions(){
    var el=document.getElementById('lbmin-decisions-wrap');
    el.innerHTML=lbBuildMinutesDecisionsHtml(false);
    el.querySelectorAll('.lbmin-decision-input').forEach(function(inp){
      inp.addEventListener('input',function(){LB_MIN_DECISIONS[+inp.dataset.idx]=inp.value;});
    });
    el.querySelectorAll('.lbmin-decision-del').forEach(function(btn){
      btn.addEventListener('click',function(){
        if(LB_MIN_DECISIONS.length<=1){toast('حداقل یک ردیف باید باقی بماند');return;}
        LB_MIN_DECISIONS.splice(+btn.dataset.idx,1);
        lbRenderMinutesDecisions();
      });
    });
    lbApplyMinutesStyle();
  }
  document.getElementById('btn-lbmin-decision-add').onclick=function(){LB_MIN_DECISIONS.push('');lbRenderMinutesDecisions();};
  document.getElementById('btn-lbmin-decision-remove').onclick=function(){
    if(LB_MIN_DECISIONS.length<=1){toast('حداقل یک ردیف باید باقی بماند');return;}
    LB_MIN_DECISIONS.pop();lbRenderMinutesDecisions();
  };
  document.getElementById('btn-lbmin-decision-clearall').onclick=function(){
    if(!confirm('آیا از حذف همه‌ی ردیف‌های جدول مصوبات مطمئن هستید؟'))return;
    LB_MIN_DECISIONS=[''];
    lbRenderMinutesDecisions();
    toast('همه‌ی ردیف‌های جدول مصوبات حذف شد ✅');
  };

  function lbBuildMinutesAttendeesHtml(forExport){
    if(forExport){
      var n=LB_MIN_ATTENDEES.length;
      var half=Math.ceil(n/2);
      var h='<table style="width:100%;border-collapse:collapse" class="lb-minutes-table"><thead><tr>'
        +'<th style="border:1px solid #333;padding:6px;width:6%">ردیف</th><th style="border:1px solid #333;padding:6px">نام و نام خانوادگی</th><th style="border:1px solid #333;padding:6px;width:16%">سمت</th><th style="border:1px solid #333;padding:6px;width:14%">امضاء</th>'
        +'<th style="border:1px solid #333;padding:6px;width:6%">ردیف</th><th style="border:1px solid #333;padding:6px">نام و نام خانوادگی</th><th style="border:1px solid #333;padding:6px;width:16%">سمت</th><th style="border:1px solid #333;padding:6px;width:14%">امضاء</th>'
        +'</tr></thead><tbody>';
      for(var r=0;r<half;r++){
        var a=LB_MIN_ATTENDEES[r]||{name:'',role:'',sign:''};
        var b=LB_MIN_ATTENDEES[half+r];
        h+='<tr><td style="border:1px solid #333;padding:6px;text-align:center">'+toFaDigits(r+1)+'</td>'
          +'<td style="border:1px solid #333;padding:6px">'+toFaDigits(esc(a.name))+'</td>'
          +'<td style="border:1px solid #333;padding:6px">'+toFaDigits(esc(a.role))+'</td>'
          +'<td style="border:1px solid #333;padding:6px">'+toFaDigits(esc(a.sign))+'</td>';
        if(b){
          h+='<td style="border:1px solid #333;padding:6px;text-align:center">'+toFaDigits(half+r+1)+'</td>'
            +'<td style="border:1px solid #333;padding:6px">'+toFaDigits(esc(b.name))+'</td>'
            +'<td style="border:1px solid #333;padding:6px">'+toFaDigits(esc(b.role))+'</td>'
            +'<td style="border:1px solid #333;padding:6px">'+toFaDigits(esc(b.sign))+'</td>';
        }else{
          h+='<td style="border:1px solid #333;padding:6px"></td><td style="border:1px solid #333;padding:6px"></td><td style="border:1px solid #333;padding:6px"></td><td style="border:1px solid #333;padding:6px"></td>';
        }
        h+='</tr>';
      }
      h+='</tbody></table>';
      return h;
    }
    var h='<table class="lb-table" id="lbmin-attendees-table" style="width:100%"><thead><tr>'
      +'<th style="width:8%">ردیف</th><th>نام و نام خانوادگی</th><th style="width:22%">سمت</th><th style="width:18%">امضاء</th><th style="width:44px"></th></tr></thead><tbody>';
    LB_MIN_ATTENDEES.forEach(function(p,i){
      h+='<tr><td>'+toFaDigits(i+1)+'</td>'
        +'<td><input type="text" class="lbmin-att-name" data-idx="'+i+'" value="'+esc(p.name)+'"></td>'
        +'<td><input type="text" class="lbmin-att-role" data-idx="'+i+'" value="'+esc(p.role)+'"></td>'
        +'<td><input type="text" class="lbmin-att-sign" data-idx="'+i+'" value="'+esc(p.sign)+'"></td>'
        +'<td><button type="button" class="btn sm danger lbmin-att-del" data-idx="'+i+'" title="حذف این ردیف">🗑</button></td></tr>';
    });
    h+='</tbody></table>';
    return h;
  }
  function lbRenderMinutesAttendees(){
    var el=document.getElementById('lbmin-attendees-wrap');
    el.innerHTML=lbBuildMinutesAttendeesHtml(false);
    el.querySelectorAll('.lbmin-att-name').forEach(function(inp){inp.addEventListener('input',function(){LB_MIN_ATTENDEES[+inp.dataset.idx].name=inp.value;});});
    el.querySelectorAll('.lbmin-att-role').forEach(function(inp){inp.addEventListener('input',function(){LB_MIN_ATTENDEES[+inp.dataset.idx].role=inp.value;});});
    el.querySelectorAll('.lbmin-att-sign').forEach(function(inp){inp.addEventListener('input',function(){LB_MIN_ATTENDEES[+inp.dataset.idx].sign=inp.value;});});
    el.querySelectorAll('.lbmin-att-del').forEach(function(btn){
      btn.addEventListener('click',function(){
        if(LB_MIN_ATTENDEES.length<=1){toast('حداقل یک ردیف باید باقی بماند');return;}
        LB_MIN_ATTENDEES.splice(+btn.dataset.idx,1);
        lbRenderMinutesAttendees();
      });
    });
    lbApplyMinutesStyle();
  }
  // --- فونت و اندازه‌ی جداول صورتجلسه (زنده روی صفحه) ---
  // قبلاً «اندازه فونت» فقط روی فایل خروجی Word/PDF اعمال می‌شد و در جدول‌های
  // «اهم مصوبات» و «اسامی حاضرین» روی صفحه هیچ تغییری دیده نمی‌شد. این تابع
  // همان فونت/اندازه را روی خودِ جدول‌های زنده هم اعمال می‌کند.
  function lbApplyMinutesStyle(){
    var fontKey=document.getElementById('lbmin-font').value;
    var size=parseInt(document.getElementById('lbmin-font-size').value,10)||14;
    var family=lbMinutesFontCss(fontKey);
    ['lbmin-decisions-table','lbmin-attendees-table'].forEach(function(id){
      var tableEl=document.getElementById(id);
      if(!tableEl)return;
      tableEl.style.fontFamily=family;
      tableEl.style.fontWeight='bold';
      tableEl.style.fontSize=size+'px';
      tableEl.querySelectorAll('th,td').forEach(function(cell){
        cell.style.fontFamily=family;
        cell.style.fontWeight='bold';
        cell.style.fontSize=size+'px';
      });
      tableEl.querySelectorAll('input').forEach(function(inp){
        inp.style.fontFamily=family;
        inp.style.fontWeight='bold';
        inp.style.fontSize=size+'px';
      });
    });
    // دستور کار جلسه و خلاصه مذاکرات جلسه هم مثل جدول‌ها با همین فونت/اندازه نمایش داده شوند
    ['lbmin-agenda','lbmin-summary'].forEach(function(id){
      var ta=document.getElementById(id);
      if(!ta)return;
      ta.style.fontFamily=family;
      ta.style.fontWeight='bold';
      ta.style.fontSize=size+'px';
    });
  }
  document.getElementById('lbmin-font').addEventListener('change',lbApplyMinutesStyle);
  document.getElementById('lbmin-font-size').addEventListener('input',lbApplyMinutesStyle);
  document.getElementById('lbmin-font-size').addEventListener('change',lbApplyMinutesStyle);
  document.getElementById('lbmin-font-size').addEventListener('keydown',function(e){if(e.key==='Enter')lbApplyMinutesStyle();});

  document.getElementById('btn-lbmin-att-add').onclick=function(){LB_MIN_ATTENDEES.push({name:'',role:'',sign:''});lbRenderMinutesAttendees();};
  document.getElementById('btn-lbmin-att-remove').onclick=function(){
    if(LB_MIN_ATTENDEES.length<=1){toast('حداقل یک ردیف باید باقی بماند');return;}
    LB_MIN_ATTENDEES.pop();lbRenderMinutesAttendees();
  };
  document.getElementById('btn-lbmin-att-clearall').onclick=function(){
    if(!confirm('آیا از حذف همه‌ی ردیف‌های جدول حاضرین مطمئن هستید؟'))return;
    LB_MIN_ATTENDEES=[{name:'',role:'',sign:''}];
    lbRenderMinutesAttendees();
    toast('همه‌ی ردیف‌های جدول حاضرین حذف شد ✅');
  };

  function lbMinutesFontCss(key){
    var families={
      nazanin:"'B Nazanin','BNazanin',Tahoma,Arial",
      titr:"'B Titr','BTitr',Tahoma,Arial"
    };
    return families[key]||families.nazanin;
  }
  function lbMinutesExportHtml(){
    var num=document.getElementById('lbmin-num').value;
    var day=document.getElementById('lbmin-day').value;
    var date=document.getElementById('lbmin-date').value;
    var start=document.getElementById('lbmin-start').value;
    var place=document.getElementById('lbmin-place').value;
    var end=document.getElementById('lbmin-end').value;
    var agenda=document.getElementById('lbmin-agenda').value;
    var summary=document.getElementById('lbmin-summary').value;
    var title=document.getElementById('lbmin-title').value;
    var fontKey=document.getElementById('lbmin-font').value;
    var fontFamily=lbMinutesFontCss(fontKey);
    var fontSize=parseInt(document.getElementById('lbmin-font-size').value,10)||14;

    var h='<style>';
    h+='@font-face{font-family:"BNazanin";src:url(https://cdn.jsdelivr.net/gh/intuxicated/css-persian@master/fonts/BNazanin.ttf)}';
    h+='@font-face{font-family:"BTitr";src:url(https://cdn.jsdelivr.net/gh/intuxicated/css-persian@master/fonts/BTitrBold.ttf)}';
    // خروجی Word/PDF یک استایل پایه‌ی خودش دارد که روی th,td اندازه‌ی فونت ثابت (مثلاً 12px) می‌گذارد
    // و چون آن قانون مستقیماً روی خودِ th/td است، بر فونت انتخابی معلم (که فقط روی دیو بیرونی ست می‌شود) غالب می‌شود؛
    // اینجا با !important و کلاس lb-minutes-table آن را override می‌کنیم تا اندازه‌ی فونت انتخابی واقعاً در خروجی اعمال شود.
    h+='.lb-minutes-table th,.lb-minutes-table td{font-family:'+fontFamily+' !important;font-weight:bold !important;font-size:'+fontSize+'px !important}';
    h+='</style>';
    h+='<div style="font-family:'+fontFamily+';font-weight:bold;font-size:'+fontSize+'px;width:100%;box-sizing:border-box">';
    h+='<div style="text-align:left;font-weight:bold;margin:0 0 10px">شماره: '+toFaDigits(esc(num||'.......................'))+'<br>تاریخ: '+toFaDigits(esc(date||'.......................'))+'</div>';
    h+='<p style="text-align:center;font-weight:bold;font-size:1.15em;margin:0 0 10px">بسمه‌تعالی</p>';
    h+='<p style="text-align:center;font-weight:bold;font-size:1.08em;margin:0 0 10px">'+esc(title||'صورت جلسه')+'</p>';
    h+='<table style="width:100%;border-collapse:collapse;table-layout:fixed" class="lb-minutes-table"><tbody>';
    h+='<tr>'
      +'<td colspan="2" style="border:1px solid #333;padding:6px"><b>شماره جلسه:</b> '+toFaDigits(esc(num))+'</td>'
      +'<td style="border:1px solid #333;padding:6px"><b>روز:</b> '+toFaDigits(esc(day))+'</td>'
      +'<td style="border:1px solid #333;padding:6px"><b>تاریخ:</b> '+toFaDigits(esc(date))+'</td>'
      +'<td style="border:1px solid #333;padding:6px"><b>ساعت شروع:</b> '+toFaDigits(esc(start))+'</td></tr>';
    h+='<tr>'
      +'<td colspan="3" style="border:1px solid #333;padding:6px"><b>مکان برگزاری:</b> '+toFaDigits(esc(place))+'</td>'
      +'<td colspan="2" style="border:1px solid #333;padding:6px"><b>ساعت پایان:</b> '+toFaDigits(esc(end))+'</td></tr>';
    h+='<tr><td colspan="5" style="border:1px solid #333;padding:6px;word-break:break-word"><b>دستور کار جلسه:</b><br>'+toFaDigits(esc(agenda)).replace(/\\n/g,'<br>')+'</td></tr>';
    h+='<tr><td colspan="5" style="border:1px solid #333;padding:6px;height:110px;vertical-align:top;word-break:break-word"><b>خلاصه مذاکرات جلسه:</b><br>'+toFaDigits(esc(summary)).replace(/\\n/g,'<br>')+'</td></tr>';
    h+='<tr><td colspan="5" style="border:1px solid #333;padding:6px"><b>اهم مصوبات جلسه:</b></td></tr>';
    h+='</tbody></table>';
    h+=lbBuildMinutesDecisionsHtml(true);
    h+='<p style="font-weight:bold;margin:16px 0 6px">اسامی حاضرین در جلسه:</p>';
    h+=lbBuildMinutesAttendeesHtml(true);
    h+='<p style="text-align:center;font-weight:bold;margin-top:26px">مهر و امضای مدیر مدرسه</p>';
    h+='</div>';
    return h;
  }
  document.getElementById('btn-lb-minutes-word').onclick=function(){lbWordExport('صورتجلسه',lbMinutesExportHtml(),'صورتجلسه',false);};
  document.getElementById('btn-lb-minutes-pdf').onclick=function(){lbPrintExport('صورتجلسه',lbMinutesExportHtml(),false);};
  document.getElementById('btn-lbmin-clear').onclick=function(){
    if(!confirm('آیا از پاک‌کردن تمام اطلاعات صورتجلسه مطمئن هستید؟ این کار قابل بازگشت نیست.'))return;
    ['lbmin-num','lbmin-day','lbmin-date','lbmin-start','lbmin-place','lbmin-end','lbmin-agenda','lbmin-summary','lbmin-title'].forEach(function(id){
      document.getElementById(id).value='';
    });
    document.getElementById('lbmin-font').value='nazanin';
    document.getElementById('lbmin-font-size').value='14';
    LB_MIN_DECISIONS=['','','',''];
    LB_MIN_ATTENDEES=[{name:'',role:'',sign:''},{name:'',role:'',sign:''},{name:'',role:'',sign:''},{name:'',role:'',sign:''},
      {name:'',role:'',sign:''},{name:'',role:'',sign:''},{name:'',role:'',sign:''},{name:'',role:'',sign:''}];
    lbRenderMinutesDecisions();
    lbRenderMinutesAttendees();
    toast('فرم صورتجلسه پاک شد ✅');
  };
  document.getElementById('btn-lbmin-save').onclick=function(){
    lbSave('minutes',{
      num:document.getElementById('lbmin-num').value,
      day:document.getElementById('lbmin-day').value,
      date:document.getElementById('lbmin-date').value,
      start:document.getElementById('lbmin-start').value,
      place:document.getElementById('lbmin-place').value,
      end:document.getElementById('lbmin-end').value,
      agenda:document.getElementById('lbmin-agenda').value,
      summary:document.getElementById('lbmin-summary').value,
      title:document.getElementById('lbmin-title').value,
      font:document.getElementById('lbmin-font').value,
      fontSize:document.getElementById('lbmin-font-size').value,
      decisions:LB_MIN_DECISIONS,
      attendees:LB_MIN_ATTENDEES
    });
  };
  var LB_MIN_LOADED=false;
  async function lbLoadMinutesIfNeeded(){
    if(LB_MIN_LOADED){return;}
    LB_MIN_LOADED=true;
    lbRenderMinutesDecisions();
    lbRenderMinutesAttendees();
    var saved=await lbLoad('minutes');
    if(saved){
      document.getElementById('lbmin-num').value=saved.num||'';
      document.getElementById('lbmin-day').value=saved.day||'';
      document.getElementById('lbmin-date').value=saved.date||'';
      document.getElementById('lbmin-start').value=saved.start||'';
      document.getElementById('lbmin-place').value=saved.place||'';
      document.getElementById('lbmin-end').value=saved.end||'';
      document.getElementById('lbmin-agenda').value=saved.agenda||'';
      document.getElementById('lbmin-summary').value=saved.summary||'';
      document.getElementById('lbmin-title').value=saved.title||'';
      document.getElementById('lbmin-font').value=saved.font||'nazanin';
      document.getElementById('lbmin-font-size').value=saved.fontSize||'14';
      if(saved.decisions&&saved.decisions.length)LB_MIN_DECISIONS=saved.decisions;
      if(saved.attendees&&saved.attendees.length)LB_MIN_ATTENDEES=saved.attendees;
      lbRenderMinutesDecisions();
      lbRenderMinutesAttendees();
    }
  }

  /* ---- تقدیرنامه‌ساز ---- */
  var CERT_TPL='gold';
  var CERT_BG_IMG='';
  var CERT_BG_ZOOM=100;
  var CERT_BG_OFFX=0;
  var CERT_BG_OFFY=0;
  var CERT_BG_OPACITY=100;
  var CERT_BG_DRAGGING=false;
  var CERT_BG_DRAG_START=null;
  var CERT_SIGN_IMG='';
  var CERT_LOGO_IMG='';
  var CERT_STUDENTS_LOADED=false;
  async function lbCertLoadStudentsIfNeeded(){
    if(CERT_STUDENTS_LOADED)return;
    CERT_STUDENTS_LOADED=true;
    try{
      var d=await api('/api/teacher/students');
      var sel=document.getElementById('cert-student-select');
      (d.students||[]).forEach(function(s){
        var opt=document.createElement('option');
        opt.value=s.uuid;opt.textContent=s.label;
        opt.dataset.label=s.label;
        sel.appendChild(opt);
      });
    }catch(e){}
  }
  document.getElementById('cert-student-select').addEventListener('change',function(){
    var opt=this.selectedOptions[0];
    if(opt&&opt.dataset.label)document.getElementById('cert-name').value=opt.dataset.label;
    lbCertRenderPreview();
  });
  document.querySelectorAll('.lb-cert-tpl-btn').forEach(function(b){
    b.onclick=function(){
      document.querySelectorAll('.lb-cert-tpl-btn').forEach(function(x){x.classList.remove('active');});
      b.classList.add('active');
      CERT_TPL=b.dataset.tpl;
      lbCertRenderPreview();
    };
  });
  ['cert-kind','cert-num','cert-date','cert-salute','cert-name','cert-intro','cert-reason','cert-issuer','cert-font'].forEach(function(id){
    var el=document.getElementById(id);
    el.addEventListener('input',lbCertRenderPreview);
    el.addEventListener('change',lbCertRenderPreview);
  });
  document.getElementById('cert-font-size').addEventListener('input',function(){
    document.getElementById('cert-font-size-val').textContent=toFaDigits(this.value);
    lbCertRenderPreview();
  });
  document.getElementById('cert-bg-file').addEventListener('change',async function(){
    var f=this.files&&this.files[0];
    if(!f)return;
    try{
      toast('در حال بارگذاری تصویر...');
      var dataUrl=await compressWorksheetImage(f);
      CERT_BG_IMG=dataUrl;
      CERT_BG_ZOOM=100;CERT_BG_OFFX=0;CERT_BG_OFFY=0;CERT_BG_OPACITY=100;
      document.getElementById('cert-bg-zoom').value=100;
      document.getElementById('cert-bg-zoom-val').textContent='۱۰۰٪';
      document.getElementById('cert-bg-opacity').value=100;
      document.getElementById('cert-bg-opacity-val').textContent='۱۰۰٪';
      document.getElementById('cert-bg-controls').classList.remove('hidden');
      lbCertRenderPreview();
      toast('تصویر پس‌زمینه اضافه شد ✅');
    }catch(e){toast(e.message||'خطا در بارگذاری تصویر');}
    this.value='';
  });
  document.getElementById('btn-cert-bg-remove').onclick=function(){
    CERT_BG_IMG='';
    document.getElementById('cert-bg-controls').classList.add('hidden');
    lbCertRenderPreview();
  };
  document.getElementById('btn-cert-bg-center').onclick=function(){
    CERT_BG_OFFX=0;CERT_BG_OFFY=0;
    lbCertRenderPreview();
  };
  document.getElementById('cert-bg-zoom').addEventListener('input',function(){
    CERT_BG_ZOOM=parseInt(this.value,10)||100;
    document.getElementById('cert-bg-zoom-val').textContent=toFaDigits(this.value)+'٪';
    var fill=document.querySelector('#cert-preview .lb-cert-bg-fill');
    if(fill)fill.style.transform='scale('+(CERT_BG_ZOOM/100)+') translate('+CERT_BG_OFFX+'%,'+CERT_BG_OFFY+'%)';
  });
  document.getElementById('cert-bg-opacity').addEventListener('input',function(){
    CERT_BG_OPACITY=parseInt(this.value,10)||100;
    document.getElementById('cert-bg-opacity-val').textContent=toFaDigits(this.value)+'٪';
    var fill=document.querySelector('#cert-preview .lb-cert-bg-fill');
    if(fill)fill.style.opacity=(CERT_BG_OPACITY/100);
  });
  document.getElementById('cert-frame-pad').addEventListener('input',function(){
    document.getElementById('cert-frame-pad-val').textContent=toFaDigits(this.value);
    document.getElementById('cert-preview').style.setProperty('--cert-frame-pad',this.value+'px');
  });
  document.getElementById('cert-sign-file').addEventListener('change',async function(){
    var f=this.files&&this.files[0];
    if(!f)return;
    try{
      toast('در حال بارگذاری امضا...');
      var dataUrl=await compressWorksheetImage(f);
      CERT_SIGN_IMG=dataUrl;
      lbCertRenderPreview();
      toast('امضا اضافه شد ✅');
    }catch(e){toast(e.message||'خطا در بارگذاری امضا');}
    this.value='';
  });
  document.getElementById('btn-cert-sign-remove').onclick=function(){
    CERT_SIGN_IMG='';
    lbCertRenderPreview();
  };
  document.getElementById('cert-logo-file').addEventListener('change',async function(){
    var f=this.files&&this.files[0];
    if(!f)return;
    try{
      toast('در حال بارگذاری تصویر...');
      var dataUrl=await compressWorksheetImage(f);
      CERT_LOGO_IMG=dataUrl;
      lbCertRenderPreview();
      toast('نشان/عکس اضافه شد ✅');
    }catch(e){toast(e.message||'خطا در بارگذاری تصویر');}
    this.value='';
  });
  document.getElementById('btn-cert-logo-remove').onclick=function(){
    CERT_LOGO_IMG='';
    lbCertRenderPreview();
  };
  var LB_CERT_PRESETS={
    colleague:{kind:'تقدیرنامه',salute:'جناب آقای',intro:'این تقدیرنامه به پاس',reason:'همکاری صمیمانه، تعهد کاری و تلاش مستمر ایشان در راستای اهداف آموزشی مجموعه، با افتخار اهدا می‌گردد.'},
    student:{kind:'تقدیرنامه',salute:'دانش‌آموز عزیز',intro:'این تقدیرنامه به پاس',reason:'کسب رتبه برتر، تلاش و پشتکار در طول سال تحصیلی، با افتخار اهدا می‌گردد.'},
    teacher:{kind:'تقدیرنامه',salute:'جناب آقای',intro:'این تقدیرنامه به پاس',reason:'تلاش ارزشمند، دلسوزی و ارائه آموزش با کیفیت در طول سال تحصیلی، با افتخار اهدا می‌گردد.'}
  };
  document.querySelectorAll('.lb-cert-preset-btn').forEach(function(b){
    b.onclick=function(){
      var p=LB_CERT_PRESETS[b.dataset.preset];
      if(!p)return;
      document.getElementById('cert-kind').value=p.kind;
      document.getElementById('cert-salute').value=p.salute;
      document.getElementById('cert-intro').value=p.intro;
      document.getElementById('cert-reason').value=p.reason;
      lbCertRenderPreview();
      toast('متن پیشنهادی اعمال شد — می‌توانید ویرایش کنید ✅');
    };
  });
  function lbCertBadge(tpl){
    return {gold:'🏆',blue:'🎖️',green:'🌿',purple:'🎗️',champion:'🥇',white:'📜',royal:'👑',lapis:'🔷',emerald:'💎'}[tpl]||'🏆';
  }
  function lbCertBadgeHtml(d){
    if(d.logoImage&&d.logoImage.indexOf('data:image/')===0){
      return '<img src="'+d.logoImage+'" style="max-height:52px;max-width:130px;object-fit:contain">';
    }
    return lbCertBadge(d.tpl);
  }
  function lbCertFontFamilyCss(key){
    var m={titr:'"BTitr","B Titr",tahoma,Arial',nazanin:'"BNazanin","B Nazanin",tahoma,Arial',nastaliq:'"Noto Nastaliq Urdu",tahoma,Arial',vazirmatn:'"Vazirmatn",tahoma,Arial',koodak:'"BKoodak","B Koodak",tahoma,Arial',mitra:'"BMitra","B Mitra",tahoma,Arial'};
    return m[key]||m.nastaliq;
  }
  function lbCertBgLayerHtml(d){
    if(!d.bgImage||d.bgImage.indexOf('data:image/')!==0)return '';
    var zoom=parseInt(d.bgZoom,10)||100;
    var ox=parseFloat(d.bgOffX)||0,oy=parseFloat(d.bgOffY)||0;
    var op=(parseInt(d.bgOpacity,10)||100)/100;
    return '<div class="lb-cert-bg-layer"><div class="lb-cert-bg-fill" style="background-image:url('+d.bgImage+');opacity:'+op+';transform:scale('+(zoom/100)+') translate('+ox+'%,'+oy+'%)"></div></div>';
  }
  function lbCertSignHtml(d){
    if(!d.signImage&&!d.issuer)return '';
    var parts='';
    if(d.signImage&&d.signImage.indexOf('data:image/')===0)parts+='<img src="'+d.signImage+'" alt="امضا">';
    if(d.issuer)parts+='<span>'+esc(d.issuer)+'</span>';
    return parts?'<div class="cert-sign">'+parts+'</div>':'';
  }
  function lbCertData(){
    return {
      kind:document.getElementById('cert-kind').value,
      num:document.getElementById('cert-num').value,
      date:document.getElementById('cert-date').value,
      salute:document.getElementById('cert-salute').value,
      name:document.getElementById('cert-name').value,
      intro:document.getElementById('cert-intro').value,
      reason:document.getElementById('cert-reason').value,
      issuer:document.getElementById('cert-issuer').value,
      font:document.getElementById('cert-font').value,
      fontSize:document.getElementById('cert-font-size').value,
      tpl:CERT_TPL,
      bgImage:CERT_BG_IMG,
      bgZoom:CERT_BG_ZOOM,
      bgOffX:CERT_BG_OFFX,
      bgOffY:CERT_BG_OFFY,
      bgOpacity:CERT_BG_OPACITY,
      signImage:CERT_SIGN_IMG,
      logoImage:CERT_LOGO_IMG,
      framePad:document.getElementById('cert-frame-pad').value
    };
  }
  function lbCertFullName(d){
    var salute=d.salute||'';
    var name=d.name||'.......................';
    return (salute?salute+' ':'')+name;
  }
  function lbCertInnerHtml(d){
    var badge=lbCertBadgeHtml(d);
    var fs=parseInt(d.fontSize,10)||13;
    var h='';
    h+=lbCertBgLayerHtml(d);
    h+='<div class="cert-numbox">شماره: '+esc(d.num||'.......')+'<br>تاریخ: '+esc(d.date||'.......')+'</div>';
    if(d.tpl==='champion')h+='<p class="cert-bismillah">بسم الله الرحمن الرحیم</p>';
    h+='<div class="cert-badge">'+badge+'</div>';
    h+='<p class="cert-kind">'+esc(d.kind||'تقدیرنامه')+'</p>';
    h+='<p class="cert-intro">'+esc(d.intro||'این سند به پاس تلاش و شایستگی به')+'</p>';
    h+='<div class="cert-name">'+esc(lbCertFullName(d))+'</div>';
    h+='<p class="cert-reason" style="font-size:'+fs+'px">'+esc(d.reason||'')+'</p>';
    h+=lbCertSignHtml(d);
    return h;
  }
  function lbCertRenderPreview(){
    var d=lbCertData();
    var el=document.getElementById('cert-preview');
    el.className='lb-cert-sheet lb-cert-'+d.tpl+' lb-cert-font-'+d.font;
    el.style.setProperty('--cert-frame-pad',(parseInt(d.framePad,10)||10)+'px');
    el.innerHTML=lbCertInnerHtml(d);
    lbCertBindBgDrag();
  }
  function lbCertBindBgDrag(){
    var fill=document.querySelector('#cert-preview .lb-cert-bg-fill');
    if(!fill)return;
    var sheet=document.getElementById('cert-preview');
    fill.addEventListener('pointerdown',function(e){
      e.preventDefault();
      CERT_BG_DRAGGING=true;
      try{fill.setPointerCapture(e.pointerId);}catch(err){}
      CERT_BG_DRAG_START={x:e.clientX,y:e.clientY,ox:CERT_BG_OFFX,oy:CERT_BG_OFFY,w:sheet.offsetWidth||1,h:sheet.offsetHeight||1};
    });
    fill.addEventListener('pointermove',function(e){
      if(!CERT_BG_DRAGGING||!CERT_BG_DRAG_START)return;
      var dx=e.clientX-CERT_BG_DRAG_START.x,dy=e.clientY-CERT_BG_DRAG_START.y;
      var dxPct=(dx/CERT_BG_DRAG_START.w)*100,dyPct=(dy/CERT_BG_DRAG_START.h)*100;
      CERT_BG_OFFX=Math.max(-60,Math.min(60,CERT_BG_DRAG_START.ox+dxPct));
      CERT_BG_OFFY=Math.max(-60,Math.min(60,CERT_BG_DRAG_START.oy+dyPct));
      fill.style.transform='scale('+(CERT_BG_ZOOM/100)+') translate('+CERT_BG_OFFX+'%,'+CERT_BG_OFFY+'%)';
    });
    function endDrag(){CERT_BG_DRAGGING=false;}
    fill.addEventListener('pointerup',endDrag);
    fill.addEventListener('pointercancel',endDrag);
  }
  function lbCertExportHtml(){
    var d=lbCertData();
    var accents={gold:'#b8860b',blue:'#1d4ed8',green:'#15803d',purple:'#7e22ce',champion:'#1d4ed8',white:'#334155',royal:'#5b21b6',lapis:'#1e3a8a',emerald:'#065f46'};
    var bgs={gold:'#fdf6e3',blue:'#e6f0ff',green:'#e5f9ec',purple:'#f1e6ff',champion:'#fdfdfb',white:'#ffffff',royal:'#fdfaf5',lapis:'#fdfaf5',emerald:'#fdfaf5'};
    var accent=accents[d.tpl]||accents.gold;
    var bg=bgs[d.tpl]||bgs.gold;
    var badge=(d.logoImage&&d.logoImage.indexOf('data:image/')===0)?'<img src="'+d.logoImage+'" style="max-height:52px;max-width:130px;object-fit:contain">':lbCertBadge(d.tpl);
    var titleFont=lbCertFontFamilyCss(d.font);
    var nameFont=titleFont;
    var bodyFont=(d.font==='nastaliq'||d.font==='shik')?lbCertFontFamilyCss('nazanin'):titleFont;
    var metaFont=titleFont;
    if(d.font==='shik'){
      titleFont=lbCertFontFamilyCss('titr');
      nameFont=lbCertFontFamilyCss('nastaliq');
      metaFont=lbCertFontFamilyCss('mitra');
    }
    var fs=parseInt(d.fontSize,10)||13;
    var pad=parseInt(d.framePad,10)||10;
    var h='<div style="position:relative;width:100%;box-sizing:border-box;padding:26px;border:3px solid '+accent+';border-radius:6px;text-align:center;background:'+bg+';font-family:tahoma,Arial;overflow:visible">';
    h+='<div style="position:relative;padding:'+(16+pad)+'px 16px;border:1.5px solid '+accent+';border-radius:4px;overflow:visible">';
    if(d.bgImage&&d.bgImage.indexOf('data:image/')===0){
      var zoom=parseInt(d.bgZoom,10)||100;
      var ox=parseFloat(d.bgOffX)||0,oy=parseFloat(d.bgOffY)||0;
      var op=(parseInt(d.bgOpacity,10)||100)/100;
      h+='<div style="position:absolute;inset:0;overflow:hidden;border-radius:4px;z-index:0"><div style="position:absolute;inset:0;background-image:url('+d.bgImage+');background-size:cover;background-position:center;background-repeat:no-repeat;opacity:'+op+';transform:scale('+(zoom/100)+') translate('+ox+'%,'+oy+'%)"></div></div>';
    }
    h+='<div style="position:relative;z-index:1">';
    h+='<div style="position:absolute;top:6px;right:10px;text-align:right;font-size:11px;font-weight:700;color:#334155;line-height:1.8;font-family:'+metaFont+'">شماره: '+esc(d.num||'.......')+'<br>تاریخ: '+esc(d.date||'.......')+'</div>';
    if(d.tpl==='champion')h+='<p style="font-size:15px;font-weight:700;color:'+accent+';margin:2px 0 10px">بسم الله الرحمن الرحیم</p>';
    h+='<div style="font-size:40px;margin-top:'+(d.tpl==='champion'?'0':'6px')+'">'+badge+'</div>';
    h+='<p style="font-size:28px;font-weight:800;color:'+accent+';margin:8px auto;max-width:92%;overflow-wrap:break-word;word-break:break-word;font-family:'+titleFont+'">'+esc(d.kind||'تقدیرنامه')+'</p>';
    h+='<p style="font-size:13px;color:#334155;margin:6px auto 0;max-width:88%;overflow-wrap:break-word;word-break:break-word;font-family:'+bodyFont+'">'+esc(d.intro||'این سند به پاس تلاش و شایستگی به')+'</p>';
    h+='<div style="font-size:26px;font-weight:800;color:#1e293b;margin:10px auto;border-bottom:2px solid '+accent+';display:inline-block;padding-bottom:6px;max-width:92%;overflow-wrap:break-word;word-break:break-word;font-family:'+nameFont+'">'+esc(lbCertFullName(d))+'</div>';
    h+='<p style="font-size:'+fs+'px;color:#334155;max-width:88%;line-height:1.9;margin:6px auto;overflow-wrap:break-word;word-break:break-word;white-space:pre-line;font-family:'+bodyFont+'">'+esc(d.reason||'')+'</p>';
    if(d.signImage||d.issuer){
      h+='<div style="margin:22px auto 0;display:flex;flex-direction:column;align-items:center;gap:4px">';
      if(d.signImage&&d.signImage.indexOf('data:image/')===0)h+='<img src="'+d.signImage+'" style="max-height:70px;max-width:160px;object-fit:contain">';
      if(d.issuer)h+='<span style="font-size:12px;color:#475569;font-weight:700;font-family:'+metaFont+'">'+esc(d.issuer)+'</span>';
      h+='</div>';
    }
    h+='</div>';
    h+='</div></div>';
    return h;
  }
  document.getElementById('btn-cert-word').onclick=function(){
    var d=lbCertData();
    var landscape=document.getElementById('cert-print-orientation').value==='landscape';
    lbWordExport(d.kind||'تقدیرنامه',lbCertExportHtml(),'تقدیرنامه',landscape,lbCertFontFamilyCss(d.font));
  };
  document.getElementById('btn-cert-pdf').onclick=function(){
    var d=lbCertData();
    var landscape=document.getElementById('cert-print-orientation').value==='landscape';
    lbPrintExport(d.kind||'تقدیرنامه',lbCertExportHtml(),landscape,lbCertFontFamilyCss(d.font));
  };
  document.getElementById('btn-cert-save').onclick=function(){
    lbSave('certificate',lbCertData());
  };
  document.getElementById('btn-cert-clear').onclick=function(){
    if(!confirm('آیا از پاک‌کردن تمام اطلاعات تقدیرنامه مطمئن هستید؟ این کار قابل بازگشت نیست.'))return;
    ['cert-num','cert-date','cert-name','cert-intro','cert-reason','cert-issuer'].forEach(function(id){document.getElementById(id).value='';});
    document.getElementById('cert-kind').value='تقدیرنامه';
    document.getElementById('cert-salute').value='جناب آقای';
    document.getElementById('cert-font').value='shik';
    document.getElementById('cert-font-size').value='13';
    document.getElementById('cert-font-size-val').textContent='۱۳';
    document.getElementById('cert-student-select').value='';
    CERT_TPL='gold';
    CERT_BG_IMG='';CERT_BG_ZOOM=100;CERT_BG_OFFX=0;CERT_BG_OFFY=0;CERT_BG_OPACITY=100;CERT_SIGN_IMG='';CERT_LOGO_IMG='';
    document.getElementById('cert-bg-controls').classList.add('hidden');
    document.getElementById('cert-bg-zoom').value=100;
    document.getElementById('cert-bg-zoom-val').textContent='۱۰۰٪';
    document.getElementById('cert-bg-opacity').value=100;
    document.getElementById('cert-bg-opacity-val').textContent='۱۰۰٪';
    document.getElementById('cert-frame-pad').value=10;
    document.getElementById('cert-frame-pad-val').textContent='۱۰';
    document.getElementById('cert-print-orientation').value='portrait';
    document.querySelectorAll('.lb-cert-tpl-btn').forEach(function(x){x.classList.remove('active');});
    document.querySelector('.lb-cert-tpl-btn[data-tpl="gold"]').classList.add('active');
    lbCertRenderPreview();
    toast('فرم تقدیرنامه پاک شد ✅');
  };
  var LB_CERT_LOADED=false;
  async function lbLoadCertificateIfNeeded(){
    await lbCertLoadStudentsIfNeeded();
    if(LB_CERT_LOADED){lbCertRenderPreview();return;}
    LB_CERT_LOADED=true;
    var saved=await lbLoad('certificate');
    if(saved){
      document.getElementById('cert-kind').value=saved.kind||'تقدیرنامه';
      document.getElementById('cert-num').value=saved.num||'';
      document.getElementById('cert-date').value=saved.date||'';
      document.getElementById('cert-salute').value=saved.salute||'جناب آقای';
      document.getElementById('cert-name').value=saved.name||'';
      document.getElementById('cert-intro').value=saved.intro||'';
      document.getElementById('cert-reason').value=saved.reason||'';
      document.getElementById('cert-issuer').value=saved.issuer||'';
      document.getElementById('cert-font').value=saved.font||'shik';
      document.getElementById('cert-font-size').value=saved.fontSize||'13';
      document.getElementById('cert-font-size-val').textContent=toFaDigits(saved.fontSize||'13');
      CERT_TPL=saved.tpl||'gold';
      CERT_BG_IMG=saved.bgImage||'';
      CERT_BG_ZOOM=saved.bgZoom||100;
      CERT_BG_OFFX=saved.bgOffX||0;
      CERT_BG_OFFY=saved.bgOffY||0;
      CERT_BG_OPACITY=saved.bgOpacity||100;
      CERT_SIGN_IMG=saved.signImage||'';
      CERT_LOGO_IMG=saved.logoImage||'';
      document.getElementById('cert-bg-zoom').value=CERT_BG_ZOOM;
      document.getElementById('cert-bg-zoom-val').textContent=toFaDigits(String(CERT_BG_ZOOM))+'٪';
      document.getElementById('cert-bg-opacity').value=CERT_BG_OPACITY;
      document.getElementById('cert-bg-opacity-val').textContent=toFaDigits(String(CERT_BG_OPACITY))+'٪';
      document.getElementById('cert-bg-controls').classList.toggle('hidden',!CERT_BG_IMG);
      document.getElementById('cert-frame-pad').value=saved.framePad||10;
      document.getElementById('cert-frame-pad-val').textContent=toFaDigits(String(saved.framePad||10));
      document.querySelectorAll('.lb-cert-tpl-btn').forEach(function(x){x.classList.toggle('active',x.dataset.tpl===CERT_TPL);});
    }
    lbCertRenderPreview();
  }

  // ===================== پایان دفتر مدیریت کلاسی =====================

  // ===================== دریافت و ارسال اطلاعات =====================
  var INFOEX_LINKS=[];
  var INFOEX_SELECTED=null;
  function infoexFileRowHtml(f){
    var isImg=f.mime&&f.mime.indexOf('image/')===0;
    var h='<div class="info-file-row" style="display:flex;align-items:center;gap:8px;padding:6px 10px;border:1px solid var(--line);border-radius:8px;margin-top:6px;font-size:13px">📎 '+esc(f.name)+' &nbsp; <a href="'+f.data+'" download="'+esc(f.name)+'" style="color:var(--primary);font-weight:700;text-decoration:none;margin-inline-start:auto">دانلود</a></div>';
    if(isImg)h+='<img src="'+f.data+'" style="max-width:220px;border-radius:8px;margin-top:6px;border:1px solid var(--line)">';
    return h;
  }
  function infoexPopulateSendTarget(){
    var sel=document.getElementById('infoexchange-send-target-pick');
    sel.innerHTML='<option value="">— یا از لیست انتخاب کنید —</option>'+INFOEX_LINKS.map(function(l){
      return '<option value="'+l.uuid+'">'+esc(l.ownerName)+' ('+esc(l.ownerRole)+')</option>';
    }).join('');
  }
  document.getElementById('infoexchange-send-target-pick').addEventListener('change',function(){
    if(this.value)document.getElementById('infoexchange-send-target-input').value=location.origin+'/info/'+this.value;
  });
  function infoexParseTargetInput(raw){
    raw=(raw||'').trim();
    var origin='';
    var m2=raw.match(/^https?:\\/\\/[^\\/]+/);
    if(m2)origin=m2[0];
    var m=raw.match(/\\/info\\/([^\\/\\?\\#\\s]+)/);
    var code=m?decodeURIComponent(m[1]):raw.replace(/^\\/+|\\/+$/g,'');
    return {origin:origin,code:code};
  }
  async function infoexLoadLinks(){
    var d=await api('/api/teacher/info-links');
    INFOEX_LINKS=(d&&d.links)||[];
    infoexPopulateSendTarget();
    var wrap=document.getElementById('infoexchange-links-list');
    if(!INFOEX_LINKS.length){wrap.innerHTML='<p class="muted">هنوز لینکی نساخته‌اید.</p>';return;}
    wrap.innerHTML=INFOEX_LINKS.map(function(l){
      var link=location.origin+'/info/'+l.uuid;
      return '<div class="lb-cert-templates" style="justify-content:space-between;align-items:center;border:1px solid var(--line);border-radius:10px;padding:10px;margin-top:8px">'
        +'<div><b>'+esc(l.ownerName)+'</b> <span class="muted">('+esc(l.ownerRole)+')</span><br><span class="muted" style="font-size:12px">'+esc(link)+'</span></div>'
        +'<div style="display:flex;gap:6px;flex-wrap:wrap">'
        +'<button class="btn sm sec" data-copy="'+esc(link)+'">📋 کپی لینک</button>'
        +'<button class="btn sm gray" data-inbox="'+l.uuid+'">📥 صندوق دریافتی</button>'
        +'<button class="btn sm danger" data-del="'+l.uuid+'">🗑️ حذف</button>'
        +'</div></div>';
    }).join('');
    wrap.querySelectorAll('[data-copy]').forEach(function(b){
      b.onclick=function(){navigator.clipboard.writeText(b.dataset.copy).then(function(){toast('لینک کپی شد ✅');});};
    });
    wrap.querySelectorAll('[data-inbox]').forEach(function(b){
      b.onclick=function(){infoexOpenInbox(b.dataset.inbox);};
    });
    wrap.querySelectorAll('[data-del]').forEach(function(b){
      b.onclick=async function(){
        if(!confirm('آیا از حذف این لینک مطمئن هستید؟ تمام پیام‌های آن هم حذف می‌شود.'))return;
        await api('/api/teacher/info-links/'+encodeURIComponent(b.dataset.del),{method:'DELETE'});
        if(INFOEX_SELECTED===b.dataset.del){INFOEX_SELECTED=null;document.getElementById('infoexchange-inbox-wrap').classList.add('hidden');}
        infoexLoadLinks();
        toast('لینک حذف شد ✅');
      };
    });
  }
  var INFOEX_SEND_FILES=[];
  function infoexRenderSendFilesList(){
    document.getElementById('infoexchange-send-files-list').innerHTML=INFOEX_SEND_FILES.map(function(f,i){
      return '<div class="info-file-row" style="display:flex;align-items:center;gap:8px;padding:4px 8px;border:1px solid var(--line);border-radius:8px;margin-top:4px;font-size:12px">📎 '+esc(f.name)+'<button type="button" class="btn sm gray" data-rm="'+i+'" style="margin-inline-start:auto">حذف</button></div>';
    }).join('');
    document.querySelectorAll('#infoexchange-send-files-list [data-rm]').forEach(function(b){
      b.onclick=function(){INFOEX_SEND_FILES.splice(+b.dataset.rm,1);infoexRenderSendFilesList();};
    });
  }
  document.getElementById('infoexchange-send-files-input').addEventListener('change',async function(){
    var files=Array.from(this.files||[]);
    for(var i=0;i<files.length;i++){
      var file=files[i];
      if(INFOEX_SEND_FILES.length>=6){toast('حداکثر ۶ فایل می‌توانید بفرستید.');break;}
      try{
        var dataUrl;
        if(file.type.indexOf('image/')===0)dataUrl=await compressWorksheetImage(file);
        else{
          if(file.size>4*1024*1024){toast('حجم فایل «'+file.name+'» بیش از ۴ مگابایت است.');continue;}
          dataUrl=await new Promise(function(res,rej){var r=new FileReader();r.onload=function(){res(r.result);};r.onerror=rej;r.readAsDataURL(file);});
        }
        INFOEX_SEND_FILES.push({name:file.name,mime:file.type,data:dataUrl});
      }catch(e){toast(e.message||'خطا در بارگذاری فایل');}
    }
    this.value='';
    infoexRenderSendFilesList();
  });
  document.getElementById('btn-infoexchange-send').onclick=async function(){
    var targetRaw=document.getElementById('infoexchange-send-target-input').value;
    var target=infoexParseTargetInput(targetRaw);
    var senderName=document.getElementById('infoexchange-send-sender').value.trim();
    var message=document.getElementById('infoexchange-send-message').value.trim();
    if(!target.code){toast('لینک یا کد گیرنده را وارد کنید');return;}
    if(!senderName){toast('نام خود را وارد کنید');return;}
    if(!message&&!INFOEX_SEND_FILES.length){toast('پیام یا حداقل یک فایل لازم است');return;}
    var base=target.origin||location.origin;
    this.disabled=true;this.textContent='در حال ارسال...';
    try{
      var r=await fetch(base+'/api/info/link/'+encodeURIComponent(target.code)+'/send',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({senderName:senderName,message:message,files:INFOEX_SEND_FILES})});
      var d=await r.json();
      if(d&&d.ok){
        toast('ارسال شد ✅');
        var known=INFOEX_LINKS.find(function(l){return l.uuid===target.code;});
        var targetLabel=known?(known.ownerName+' ('+known.ownerRole+')'):(target.origin?(target.origin+'/info/'+target.code):target.code);
        api('/api/teacher/info-outbox',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({targetOrigin:target.origin||'',targetCode:target.code,targetLabel:targetLabel,senderName:senderName,message:message,files:INFOEX_SEND_FILES,trackingCode:d.code||''})}).then(infoexLoadOutbox);
        document.getElementById('infoexchange-send-message').value='';
        document.getElementById('infoexchange-send-target-input').value='';
        document.getElementById('infoexchange-send-target-pick').value='';
        INFOEX_SEND_FILES=[];infoexRenderSendFilesList();
        if(!target.origin&&INFOEX_SELECTED===target.code)infoexOpenInbox(target.code);
      }else toast((d&&d.error)||'لینک/کد گیرنده معتبر نیست یا ارسال ناموفق بود');
    }catch(e){toast('خطا در ارتباط با سرور — اگر لینک از یک پنل دیگر است، از صحیح‌بودن آدرس مطمئن شوید');}
    this.disabled=false;this.textContent='📤 ارسال';
  };
  async function infoexOpenInbox(linkUuid){
    INFOEX_SELECTED=linkUuid;
    var owner=INFOEX_LINKS.find(function(l){return l.uuid===linkUuid;});
    document.getElementById('infoexchange-inbox-wrap').classList.remove('hidden');
    document.getElementById('infoexchange-inbox-owner').textContent=owner?('— '+owner.ownerName+' ('+owner.ownerRole+')'):'';
    var listEl=document.getElementById('infoexchange-inbox-list');
    listEl.innerHTML='<p class="muted">در حال بارگذاری...</p>';
    var d=await api('/api/teacher/info-links/'+encodeURIComponent(linkUuid)+'/inbox');
    var inbox=(d&&d.inbox)||[];
    if(!inbox.length){listEl.innerHTML='<p class="muted">پیامی دریافت نشده.</p>';return;}
    listEl.innerHTML=inbox.map(function(t){
      var h='<div class="lb-preview" style="margin-top:10px"><p class="muted">از طرف <b>'+esc(t.senderName)+'</b> — '+new Date(t.createdAt).toLocaleString('fa-IR')+' &nbsp; <button type="button" class="btn sm danger infoex-inbox-del" data-code="'+t.code+'" style="margin-inline-start:6px">🗑️ حذف پیام</button></p>';
      if(t.message)h+='<p>'+esc(t.message)+'</p>';
      (t.files||[]).forEach(function(f){h+=infoexFileRowHtml(f);});
      if(t.reply){
        h+='<hr style="margin:10px 0;border:none;border-top:1px solid var(--line)"><p class="muted">پاسخ شما — '+new Date(t.reply.repliedAt).toLocaleString('fa-IR')+'</p>';
        if(t.reply.message)h+='<p>'+esc(t.reply.message)+'</p>';
        (t.reply.files||[]).forEach(function(f){h+=infoexFileRowHtml(f);});
      }else{
        h+='<div style="margin-top:10px">'
          +'<textarea class="lb-textarea infoex-reply-text" data-code="'+t.code+'" rows="2" placeholder="پاسخ خود را بنویسید..."></textarea>'
          +'<input type="file" class="infoex-reply-file" data-code="'+t.code+'" accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx" multiple style="margin-top:6px">'
          +'<div class="infoex-reply-files-list" data-code="'+t.code+'"></div>'
          +'<button class="btn sm primary infoex-reply-send" data-code="'+t.code+'" style="margin-top:6px">📤 ارسال پاسخ</button>'
          +'</div>';
      }
      h+='</div>';
      return h;
    }).join('');
    listEl.querySelectorAll('.infoex-inbox-del').forEach(function(b){
      b.onclick=async function(){
        if(!confirm('آیا از حذف این پیام مطمئن هستید؟'))return;
        await api('/api/teacher/info-links/'+encodeURIComponent(linkUuid)+'/thread/'+encodeURIComponent(b.dataset.code),{method:'DELETE'});
        infoexOpenInbox(linkUuid);
      };
    });
    var replyFilesMap={};
    listEl.querySelectorAll('.infoex-reply-file').forEach(function(inp){
      replyFilesMap[inp.dataset.code]=replyFilesMap[inp.dataset.code]||[];
      inp.addEventListener('change',async function(){
        var code=inp.dataset.code;
        var files=Array.from(inp.files||[]);
        for(var i=0;i<files.length;i++){
          var file=files[i];
          try{
            var dataUrl;
            if(file.type.indexOf('image/')===0)dataUrl=await compressWorksheetImage(file);
            else{
              if(file.size>4*1024*1024){toast('حجم فایل «'+file.name+'» بیش از ۴ مگابایت است.');continue;}
              dataUrl=await new Promise(function(res,rej){var r=new FileReader();r.onload=function(){res(r.result);};r.onerror=rej;r.readAsDataURL(file);});
            }
            replyFilesMap[code].push({name:file.name,mime:file.type,data:dataUrl});
          }catch(e){toast(e.message||'خطا در بارگذاری فایل');}
        }
        inp.value='';
        var listBox=listEl.querySelector('.infoex-reply-files-list[data-code="'+code+'"]');
        listBox.innerHTML=replyFilesMap[code].map(function(f,i){return '<div class="info-file-row" style="display:flex;align-items:center;gap:8px;padding:4px 8px;border:1px solid var(--line);border-radius:8px;margin-top:4px;font-size:12px">📎 '+esc(f.name)+'<button type="button" class="btn sm gray" data-rm="'+i+'" style="margin-inline-start:auto">حذف</button></div>';}).join('');
        listBox.querySelectorAll('[data-rm]').forEach(function(rb){
          rb.onclick=function(){replyFilesMap[code].splice(+rb.dataset.rm,1);rb.parentElement.remove();};
        });
      });
    });
    listEl.querySelectorAll('.infoex-reply-send').forEach(function(btn){
      btn.onclick=async function(){
        var code=btn.dataset.code;
        var msg=listEl.querySelector('.infoex-reply-text[data-code="'+code+'"]').value.trim();
        var files=replyFilesMap[code]||[];
        if(!msg&&!files.length){toast('پیام یا حداقل یک فایل برای پاسخ لازم است');return;}
        btn.disabled=true;btn.textContent='در حال ارسال...';
        var d=await api('/api/teacher/info-links/'+encodeURIComponent(linkUuid)+'/thread/'+encodeURIComponent(code)+'/reply',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:msg,files:files})});
        if(d&&d.ok){toast('پاسخ ارسال شد ✅');infoexOpenInbox(linkUuid);}
        else{toast((d&&d.error)||'خطا در ارسال پاسخ');btn.disabled=false;btn.textContent='📤 ارسال پاسخ';}
      };
    });
  }
  document.getElementById('btn-infoexchange-create').onclick=async function(){
    var name=document.getElementById('infoexchange-new-name').value.trim();
    var role=document.getElementById('infoexchange-new-role').value;
    if(!name){toast('نام خود را وارد کنید');return;}
    var d=await api('/api/teacher/info-links',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ownerName:name,ownerRole:role})});
    if(d&&d.ok){
      toast('لینک ساخته شد ✅');
      localStorage.setItem('infoex-my-name',name);
      document.getElementById('infoexchange-send-sender').value=name;
      document.getElementById('infoexchange-new-name').value='';
      infoexLoadLinks();
    }
    else toast((d&&d.error)||'خطا در ساخت لینک');
  };
  async function infoexLoadOutbox(){
    var listEl=document.getElementById('infoexchange-sent-list');
    var d=await api('/api/teacher/info-outbox');
    var outbox=(d&&d.outbox)||[];
    if(!outbox.length){listEl.innerHTML='<p class="muted">پیامی ارسال نشده.</p>';return;}
    listEl.innerHTML=outbox.map(function(s){
      var h='<div class="lb-preview" style="margin-top:10px"><p class="muted">به <b>'+esc(s.targetLabel||s.targetCode)+'</b> — '+new Date(s.createdAt).toLocaleString('fa-IR')+' &nbsp; <button type="button" class="btn sm danger infoex-sent-del" data-id="'+s.id+'" style="margin-inline-start:6px">🗑️ حذف پیام</button></p>';
      if(s.message)h+='<p>'+esc(s.message)+'</p>';
      (s.files||[]).forEach(function(f){h+='<div class="info-file-row" style="display:flex;align-items:center;gap:8px;padding:6px 10px;border:1px solid var(--line);border-radius:8px;margin-top:6px;font-size:13px">📎 '+esc(f.name)+'</div>';});
      h+='</div>';
      return h;
    }).join('');
    listEl.querySelectorAll('.infoex-sent-del').forEach(function(b){
      b.onclick=async function(){
        if(!confirm('آیا از حذف این پیام از فهرست ارسالی‌های خود مطمئن هستید؟'))return;
        await api('/api/teacher/info-outbox/'+encodeURIComponent(b.dataset.id),{method:'DELETE'});
        infoexLoadOutbox();
      };
    });
  }
  var INFOEX_LOADED=false;
  async function loadInfoExchangeIfNeeded(){
    if(INFOEX_LOADED)return;
    INFOEX_LOADED=true;
    var savedName=localStorage.getItem('infoex-my-name');
    if(savedName){
      document.getElementById('infoexchange-new-name').value=savedName;
      document.getElementById('infoexchange-send-sender').value=savedName;
    }
    infoexLoadLinks();
    infoexLoadOutbox();
  }
  // ===================== پایان دریافت و ارسال اطلاعات =====================

  checkAuth();
  `;
}
