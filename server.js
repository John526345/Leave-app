"use strict";
/* ============================================================
   Leave Tracker — standalone Node.js server (>=18, zero deps)
   Runs anywhere that keeps a normal Node process alive with a
   persistent disk: your own computer, Fly.io, Render (paid).
   Data: JSON file at DATA_DIR/db.json (atomic writes).

   For Netlify (serverless), use netlify/functions/api.js instead
   — it shares the same core.js logic but stores data in
   Netlify Blobs. You do NOT need this file on Netlify.
   ============================================================ */
const http = require("http");
const fs = require("fs");
const path = require("path");
const core = require("./core");

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const PUBLIC = fs.existsSync(path.join(__dirname, "public"))
  ? path.join(__dirname, "public") : __dirname;

/* ---------- storage (local file) ---------- */
let db;
try { db = Object.assign(core.freshDB(), JSON.parse(fs.readFileSync(DB_FILE, "utf8"))); }
catch (e) { db = core.freshDB(); }
function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}

/* ---------- email (optional — set BREVO_API_KEY and EMAIL_FROM) ---------- */
const EMAIL_KEY = process.env.BREVO_API_KEY || "";
const EMAIL_FROM = process.env.EMAIL_FROM || "";
const EMAIL_API = process.env.EMAIL_API_URL || "https://api.brevo.com/v3/smtp/email";
const emailEnabled = () => !!(EMAIL_KEY && EMAIL_FROM);
function sendEmail(to, subject, text) {
  if (!emailEnabled() || !to.length) return;
  fetch(EMAIL_API, {
    method: "POST",
    headers: { "api-key": EMAIL_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      sender: { email: EMAIL_FROM, name: db.settings.orgName },
      to: to.map(e => ({ email: e })),
      subject, textContent: text,
    }),
  }).then(r => { if (!r.ok) r.text().then(t => console.error("email failed:", t)); })
    .catch(e => console.error("email failed:", e.message));
}

/* ---------- static files ---------- */
const MIME = { ".html": "text/html; charset=utf-8", ".json": "application/json",
  ".jpg": "image/jpeg", ".png": "image/png", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };
const INDEX = fs.readFileSync(path.join(PUBLIC, "index.html"));
function serveStatic(res, pathname) {
  if (pathname === "/health") { res.writeHead(200); return res.end("ok"); }
  const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const file = path.join(PUBLIC, safe);
  const ext = path.extname(file).toLowerCase();
  // Only ever serve known static assets (never source files like core.js).
  if (MIME[ext] && file.startsWith(PUBLIC) && pathname !== "/" && fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.writeHead(200, { "Content-Type": MIME[ext],
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=86400" });
    return res.end(fs.readFileSync(file));
  }
  // SPA fallback (covers /join, /?reset=, etc.)
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
  return res.end(INDEX);
}

/* ---------- http server ---------- */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (!url.pathname.startsWith("/api/")) return serveStatic(res, url.pathname);

  let raw = "";
  req.on("data", c => { raw += c; if (raw.length > 1e6) req.destroy(); });
  req.on("end", () => {
    const send = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(obj));
    };
    let body = {};
    try { if (raw) body = JSON.parse(raw); } catch (e) { return send(400, { error: "Bad JSON" }); }
    const base = (req.headers["x-forwarded-proto"] || "http") + "://" +
      (req.headers["x-forwarded-host"] || req.headers.host || "");
    const result = core.dispatch(db, {
      method: req.method, pathname: url.pathname, body,
      authHeader: req.headers.authorization || "", base, emailEnabled: emailEnabled(),
    });
    if (result.dirty) { try { persist(); } catch (e) { console.error("save failed:", e.message); } }
    result.emails.forEach(e => sendEmail(e.to, e.subject, e.text));
    send(result.status, result.json);
  });
});

server.listen(PORT, () => console.log("Leave Tracker running on port " + PORT +
  (emailEnabled() ? " (email: on)" : " (email: off)")));
