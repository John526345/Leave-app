"use strict";
/* ============================================================
   Leave Tracker — Netlify Function
   Handles every /api/* request. Uses the shared core.js logic
   and stores all data in Netlify Blobs (built in, persistent,
   zero setup — survives deploys and restarts).
   ============================================================ */
const { getStore } = require("@netlify/blobs");
const core = require("../../core");

const STORE = "leave-tracker";
const KEY = "db";

async function loadDB() {
  const store = getStore(STORE);
  const saved = await store.get(KEY, { type: "json" });
  return saved ? Object.assign(core.freshDB(), saved) : core.freshDB();
}
async function saveDB(db) {
  const store = getStore(STORE);
  await store.setJSON(KEY, db);
}

/* ---------- email (optional — set BREVO_API_KEY and EMAIL_FROM) ---------- */
const EMAIL_KEY = process.env.BREVO_API_KEY || "";
const EMAIL_FROM = process.env.EMAIL_FROM || "";
const EMAIL_API = process.env.EMAIL_API_URL || "https://api.brevo.com/v3/smtp/email";
const emailEnabled = () => !!(EMAIL_KEY && EMAIL_FROM);
async function sendEmail(orgName, to, subject, text) {
  if (!emailEnabled() || !to.length) return;
  try {
    const r = await fetch(EMAIL_API, {
      method: "POST",
      headers: { "api-key": EMAIL_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        sender: { email: EMAIL_FROM, name: orgName },
        to: to.map(e => ({ email: e })),
        subject, textContent: text,
      }),
    });
    if (!r.ok) console.error("email failed:", await r.text().catch(() => r.status));
  } catch (e) { console.error("email failed:", e.message); }
}

exports.handler = async (event) => {
  const json = (code, obj) => ({
    statusCode: code,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(obj),
  });

  // Original request URL (works whether or not the redirect rewrote the path)
  let url;
  try { url = new URL(event.rawUrl); }
  catch (e) {
    const proto = event.headers["x-forwarded-proto"] || "https";
    const host = event.headers.host || event.headers.Host || "localhost";
    url = new URL(proto + "://" + host + (event.path || "/"));
  }

  let body = {};
  try { if (event.body) body = JSON.parse(event.body); }
  catch (e) { return json(400, { error: "Bad JSON" }); }

  let db;
  try { db = await loadDB(); }
  catch (e) { console.error("storage load failed:", e.message); return json(500, { error: "Storage unavailable" }); }

  const authHeader = event.headers.authorization || event.headers.Authorization || "";
  const result = core.dispatch(db, {
    method: event.httpMethod, pathname: url.pathname, body,
    authHeader, base: url.origin, emailEnabled: emailEnabled(),
  });

  if (result.dirty) {
    try { await saveDB(db); }
    catch (e) { console.error("storage save failed:", e.message); return json(500, { error: "Couldn't save — try again" }); }
  }
  if (result.emails && result.emails.length) {
    await Promise.allSettled(result.emails.map(e => sendEmail(db.settings.orgName, e.to, e.subject, e.text)));
  }
  return json(result.status, result.json);
};
