"use strict";
/* ============================================================
   Leave Tracker — shared core logic (storage-agnostic)
   ------------------------------------------------------------
   Pure request handling. No file/network I/O lives here.
   `dispatch(db, ctx)` mutates the db object in memory and
   returns { status, json, dirty, emails }:
     - dirty  : caller should persist db (file / Netlify Blobs)
     - emails : [{to, subject, text}] the caller should send
   This lets the same logic run as a normal Node server OR as a
   stateless Netlify Function.

   Approval flow (single stage):
     Staff requests leave -> their department head approves or
     rejects (final). HR/admins are then notified (activity feed
     + WhatsApp-ready text + optional email). If a person has no
     department head, HR approves in one step.
   ============================================================ */
const crypto = require("crypto");

const TYPE_LABEL = { annual: "Annual", sick: "Sick", comp: "Compensate" };

function freshDB() {
  return {
    secret: crypto.randomBytes(32).toString("hex"),
    settings: { orgName: "Leave Tracker", countWeekends: false },
    users: [], requests: [], compCredits: [], notifications: [], holidays: [],
  };
}

/* ---------- small helpers ---------- */
const uid = () => Date.now().toString(36) + crypto.randomBytes(4).toString("hex");
const now = () => new Date().toISOString();
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
const yearOf = s => +String(s).slice(0, 4);
function err(code, msg) { const e = new Error(msg); e.code = code; return e; }

/* ---------- auth ---------- */
function hashPass(pw, salt) {
  salt = salt || crypto.randomBytes(16).toString("hex");
  return { salt, hash: crypto.scryptSync(pw, salt, 64).toString("hex") };
}
function checkPass(pw, p) {
  if (!p) return false;
  const h = crypto.scryptSync(pw, p.salt, 64);
  const stored = Buffer.from(p.hash, "hex");
  return stored.length === h.length && crypto.timingSafeEqual(stored, h);
}
function sign(db, id) {
  const body = id + "." + (Date.now() + 30 * 864e5);
  return body + "." + crypto.createHmac("sha256", db.secret).update(body).digest("hex");
}
function verify(db, tok) {
  if (!tok) return null;
  const i = tok.lastIndexOf(".");
  if (i < 0) return null;
  const body = tok.slice(0, i), sig = tok.slice(i + 1);
  const good = crypto.createHmac("sha256", db.secret).update(body).digest("hex");
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  const [id, exp] = body.split(".");
  if (+exp < Date.now()) return null;
  return db.users.find(u => u.id === id && u.active && u.pass) || null;
}

/* ---------- dates & balances ---------- */
function holidaySet(db) { return new Set((db.holidays || []).map(h => h.date)); }
function countDays(db, start, end, halfDay) {
  if (!isDate(start) || !isDate(end)) return 0;
  const a = new Date(start + "T00:00:00Z"), b = new Date(end + "T00:00:00Z");
  if (isNaN(a) || isNaN(b) || b < a) return 0;
  const hol = holidaySet(db);
  if (halfDay && start === end) {
    // a half day on a weekend/holiday still counts as 0
    const wd = a.getUTCDay();
    const iso = start;
    if (hol.has(iso)) return 0;
    if (!db.settings.countWeekends && (wd === 0 || wd === 6)) return 0;
    return 0.5;
  }
  let n = 0;
  for (let d = new Date(a); d <= b; d.setUTCDate(d.getUTCDate() + 1)) {
    const wd = d.getUTCDay();
    const iso = d.toISOString().slice(0, 10);
    if (hol.has(iso)) continue;                          // public holidays never count
    if (db.settings.countWeekends || (wd !== 0 && wd !== 6)) n++;
  }
  return n;
}
function usedDays(db, userId, type, year) {
  return db.requests
    .filter(r => r.userId === userId && r.type === type && r.status === "approved" && yearOf(r.start) === year)
    .reduce((s, r) => s + r.days, 0);
}
function compEarned(db, userId, year) {
  return db.compCredits
    .filter(c => c.userId === userId && yearOf(c.date) === year)
    .reduce((s, c) => s + c.days, 0);
}
function balancesFor(db, u) {
  const y = new Date().getFullYear();
  return {
    annual: (u.entitlements.annual || 0) - usedDays(db, u.id, "annual", y),
    sick: (u.entitlements.sick || 0) - usedDays(db, u.id, "sick", y),
    comp: compEarned(db, u.id, y) - usedDays(db, u.id, "comp", y),
    annualTotal: u.entitlements.annual || 0,
    sickTotal: u.entitlements.sick || 0,
    compEarned: compEarned(db, u.id, y),
  };
}

/* ---------- lookups & formatting ---------- */
const findUser = (db, id) => db.users.find(u => u.id === id);
const admins = db => db.users.filter(u => u.role === "admin" && u.active);
function approverOf(db, u) {                 // who approves this user's requests
  const m = u.managerId && findUser(db, u.managerId);
  return (m && m.active && m.pass) ? m : null; // null => any admin (HR)
}
function fmtD(s) {
  const d = new Date(s + "T00:00:00Z");
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}
function publicUser(u) { return { id: u.id, name: u.name, role: u.role, managerId: u.managerId || null }; }
function adminUser(u) {
  return Object.assign(publicUser(u), {
    email: u.email, active: u.active, entitlements: u.entitlements,
    joined: !!u.pass, inviteToken: u.pass ? null : u.inviteToken,
  });
}

/* ---------- role-scoped snapshot sent to the client ---------- */
function stateFor(db, u, emailEnabled) {
  const isAdmin = u.role === "admin";
  const reports = db.users.filter(x => x.managerId === u.id && x.active);
  const reqVisible = isAdmin ? db.requests
    : db.requests.filter(r => r.userId === u.id || reports.some(p => p.id === r.userId));
  const balUsers = isAdmin ? db.users.filter(x => x.active) : [u].concat(reports);
  const balances = {};
  balUsers.forEach(x => balances[x.id] = balancesFor(db, x));
  const today = now().slice(0, 10);
  const onLeaveToday = db.requests
    .filter(r => r.status === "approved" && r.start <= today && r.end >= today)
    .map(r => ({ name: (findUser(db, r.userId) || {}).name || "?", type: r.type }));
  const appr = approverOf(db, u);
  return {
    me: Object.assign(publicUser(u), { email: u.email, entitlements: u.entitlements }),
    settings: { orgName: db.settings.orgName, countWeekends: db.settings.countWeekends, emailEnabled: !!emailEnabled },
    holidays: (db.holidays || []).slice().sort((a, b) => a.date.localeCompare(b.date)),
    users: isAdmin ? db.users.map(adminUser) : db.users.filter(x => x.active).map(publicUser),
    requests: reqVisible.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    balances, onLeaveToday,
    approverName: appr ? appr.name : "HR",
    isManager: reports.length > 0,
    notifications: isAdmin
      ? db.notifications.slice().reverse().slice(0, 50)
          .map(n => ({ id: n.id, text: n.text, waText: n.waText, createdAt: n.createdAt, unread: !n.readBy.includes(u.id) }))
      : [],
    compCredits: (isAdmin ? db.compCredits
      : db.compCredits.filter(c => c.userId === u.id || reports.some(p => p.id === c.userId))),
  };
}

/* ============================================================
   dispatch — the single entry point
   ============================================================ */
function dispatch(db, ctx) {
  const { method, pathname, body, authHeader, base } = ctx;
  const emailEnabled = !!ctx.emailEnabled;
  const recoveryKey = String(ctx.recoveryKey || "");

  const emails = [];
  let dirty = false;
  const save = () => { dirty = true; };
  const queueEmail = (to, subject, text) => {
    to = [...new Set((to || []).filter(Boolean))];
    if (to.length) emails.push({ to, subject, text });
  };

  const requireAuth = u => { if (!u) throw err(401, "Please log in again"); };
  const requireAdmin = u => { requireAuth(u); if (u.role !== "admin") throw err(403, "Admins only"); };

  function notifyAdmins(text, waText, actorId) {
    db.notifications.push({
      id: uid(), text, waText: waText || null, createdAt: now(),
      readBy: actorId ? [actorId] : [],
    });
    if (db.notifications.length > 300) db.notifications = db.notifications.slice(-300);
  }

  const routes = {

    "GET /api/bootstrap": () => ({ needsSetup: db.users.length === 0, orgName: db.settings.orgName }),

    "POST /api/setup": (b) => {
      if (db.users.length) throw err(403, "Already set up");
      const { org, name, email, password } = b;
      if (!name || !email || !password || password.length < 6)
        throw err(400, "Name, email and a password of 6+ characters are required");
      db.settings.orgName = String(org || "Leave Tracker").trim();
      const u = {
        id: uid(), name: String(name).trim(), email: String(email).trim().toLowerCase(),
        role: "admin", managerId: null, active: true,
        entitlements: { annual: 18, sick: 12 },
        pass: hashPass(password), createdAt: now(),
      };
      db.users.push(u); save();
      return { token: sign(db, u.id) };
    },

    "POST /api/login": (b) => {
      const email = String(b.email || "").trim().toLowerCase();
      const u = db.users.find(x => x.email === email && x.active);
      if (!u || !u.pass || !checkPass(String(b.password || ""), u.pass))
        throw err(401, "Wrong email or password");
      return { token: sign(db, u.id) };
    },

    "POST /api/forgot": (b) => {
      const email = String(b.email || "").trim().toLowerCase();
      if (!email) throw err(400, "Type your email first");
      if (!emailEnabled) throw err(400, "Email sending is not set up yet — ask your admin");
      const t = db.users.find(x => x.email === email && x.active && x.pass);
      if (t) {
        t.resetToken = crypto.randomBytes(16).toString("hex");
        t.resetExpires = Date.now() + 60 * 60 * 1000;
        save();
        const link = (base || "") + "/?reset=" + t.resetToken;
        queueEmail([t.email],
          "Reset your " + db.settings.orgName + " leave app password",
          "Hi " + t.name + ",\n\nTap this link to choose a new password for " +
          db.settings.orgName + "'s leave tracker:\n\n" + link +
          "\n\nThe link works once and expires in 1 hour. If you didn't ask for this, just ignore this email — your password stays as it is.");
      }
      return { ok: true };
    },

    "GET /api/reset/:token": (b, u, token) => {
      const t = db.users.find(x => x.resetToken === token && x.active &&
        x.resetExpires && x.resetExpires > Date.now());
      if (!t) throw err(404, "This reset link is no longer valid. Go to the login page and request a new one.");
      return { name: t.name, org: db.settings.orgName };
    },

    "POST /api/reset": (b) => {
      const t = db.users.find(x => x.resetToken === b.token && x.active &&
        x.resetExpires && x.resetExpires > Date.now());
      if (!t) throw err(404, "This reset link is no longer valid. Go to the login page and request a new one.");
      if (!b.password || b.password.length < 6) throw err(400, "Password must be at least 6 characters");
      t.pass = hashPass(b.password); t.resetToken = null; t.resetExpires = null;
      save();
      return { token: sign(db, t.id) };
    },

    /* ---- emergency recovery (no email needed) ----
       Enabled only when a RECOVERY_KEY environment variable is set.
       Lets a locked-out person reset their own password by proving they
       know that key. Turn it off again (remove the env var) afterwards. */
    "GET /api/recover": () => ({ enabled: !!recoveryKey, org: db.settings.orgName }),

    "POST /api/recover": (b) => {
      if (!recoveryKey)
        throw err(403, "Recovery is turned off. Set a RECOVERY_KEY environment variable where the app is hosted, then try again.");
      const given = String(b.key || "");
      const a = Buffer.from(given), bk = Buffer.from(recoveryKey);
      if (a.length !== bk.length || !crypto.timingSafeEqual(a, bk))
        throw err(403, "That recovery key is wrong.");
      const email = String(b.email || "").trim().toLowerCase();
      const t = db.users.find(x => x.email === email && x.active);
      if (!t) throw err(404, "No active account uses that email.");
      if (!b.password || b.password.length < 6) throw err(400, "Password must be at least 6 characters");
      t.pass = hashPass(b.password);
      t.inviteToken = null; t.resetToken = null; t.resetExpires = null;
      save();
      return { token: sign(db, t.id), name: t.name };
    },

    "GET /api/state": (b, u) => { requireAuth(u); return stateFor(db, u, emailEnabled); },

    /* ---- users ---- */
    "POST /api/users": (b, u) => {
      requireAdmin(u);
      const { name, email, role, managerId, entitlements } = b;
      if (!name || !email) throw err(400, "Name and email are required");
      const em = String(email).trim().toLowerCase();
      if (db.users.some(x => x.email === em)) throw err(400, "That email is already added");
      const nu = {
        id: uid(), name: String(name).trim(), email: em,
        role: role === "admin" ? "admin" : "staff",
        managerId: managerId && findUser(db, managerId) ? managerId : null,
        active: true,
        entitlements: {
          annual: +((entitlements || {}).annual) || 0,
          sick: +((entitlements || {}).sick) || 0,
        },
        pass: null, inviteToken: crypto.randomBytes(16).toString("hex"), createdAt: now(),
      };
      db.users.push(nu); save();
      return { user: adminUser(nu) };
    },

    "POST /api/users/:id": (b, u, id) => {
      requireAdmin(u);
      const t = findUser(db, id); if (!t) throw err(404, "No such user");
      if (b.name) t.name = String(b.name).trim();
      if (b.email) {
        const em = String(b.email).trim().toLowerCase();
        if (db.users.some(x => x.email === em && x.id !== id)) throw err(400, "That email is already added");
        t.email = em;
      }
      if (b.role && id !== u.id) t.role = b.role === "admin" ? "admin" : "staff";
      if ("managerId" in b) t.managerId = (b.managerId && b.managerId !== id && findUser(db, b.managerId)) ? b.managerId : null;
      if (b.entitlements) t.entitlements = {
        annual: +b.entitlements.annual || 0, sick: +b.entitlements.sick || 0,
      };
      if ("active" in b && id !== u.id) t.active = !!b.active;
      save();
      return { user: adminUser(t) };
    },

    "POST /api/users/:id/delete": (b, u, id) => {
      requireAdmin(u);
      if (id === u.id) throw err(400, "You can't delete yourself — ask another admin to do it");
      const t = findUser(db, id); if (!t) throw err(404, "No such user");
      db.users = db.users.filter(x => x.id !== id);
      db.requests = db.requests.filter(r => r.userId !== id);
      db.compCredits = db.compCredits.filter(c => c.userId !== id);
      db.users.forEach(x => { if (x.managerId === id) x.managerId = null; });
      save();
      return { ok: true };
    },

    "POST /api/users/:id/sendinvite": (b, u, id) => {
      requireAdmin(u);
      const t = findUser(db, id); if (!t) throw err(404, "No such user");
      if (t.pass) throw err(400, "They already joined");
      if (!emailEnabled) throw err(400, "Email sending is not set up yet");
      if (!t.inviteToken) { t.inviteToken = crypto.randomBytes(16).toString("hex"); save(); }
      const link = (base || "") + "/join?t=" + t.inviteToken;
      queueEmail([t.email],
        "You're invited to " + db.settings.orgName + "'s leave app",
        "Hi " + t.name + ",\n\n" + u.name + " invited you to " + db.settings.orgName +
        "'s leave tracker — where you request leave and see your balances from your phone.\n\n" +
        "👉 Join here (set your own password): " + link +
        "\n\nSee you there!");
      return { ok: true };
    },

    "POST /api/users/:id/reinvite": (b, u, id) => {
      requireAdmin(u);
      const t = findUser(db, id); if (!t) throw err(404, "No such user");
      if (t.pass) throw err(400, "Already joined");
      t.inviteToken = crypto.randomBytes(16).toString("hex"); save();
      return { inviteToken: t.inviteToken };
    },

    "GET /api/invite/:token": (b, u, token) => {
      const t = db.users.find(x => x.inviteToken === token && !x.pass && x.active);
      if (!t) throw err(404, "This invite link is no longer valid. Ask your admin for a new one.");
      return { name: t.name, org: db.settings.orgName };
    },

    "POST /api/join": (b) => {
      const t = db.users.find(x => x.inviteToken === b.token && !x.pass && x.active);
      if (!t) throw err(404, "This invite link is no longer valid. Ask your admin for a new one.");
      if (!b.password || b.password.length < 6) throw err(400, "Password must be at least 6 characters");
      t.pass = hashPass(b.password); t.inviteToken = null; t.joinedAt = now();
      notifyAdmins(t.name + " joined the app 🎉", null, null);
      save();
      return { token: sign(db, t.id) };
    },

    /* ---- leave requests ---- */
    "POST /api/requests": (b, u) => {
      requireAuth(u);
      const { type, start, end, halfDay, reason } = b;
      if (!TYPE_LABEL[type]) throw err(400, "Bad leave type");
      const days = countDays(db, start, end, !!halfDay);
      if (days <= 0) throw err(400, "Check the dates — no working days selected");
      db.requests.push({
        id: uid(), userId: u.id, type, start, end, halfDay: !!halfDay, days,
        reason: String(reason || "").slice(0, 300), status: "pending", createdAt: now(),
      });
      save();
      const appr = approverOf(db, u);
      const range = start === end ? fmtD(start) : fmtD(start) + " to " + fmtD(end);
      const balLeft = balancesFor(db, u)[type];
      const approveLink = base ? base + "/?tab=approve" : "";
      queueEmail(
        (appr ? [appr.email] : admins(db).map(a => a.email)).filter(e => e !== u.email),
        "[Leave] " + u.name + " — " + TYPE_LABEL[type] + ", " + range + " (" + days + (days === 1 ? " day" : " days") + ")",
        u.name + " requested " + TYPE_LABEL[type].toLowerCase() + " leave.\n\n" +
        "When: " + range + " (" + days + (days === 1 ? " day" : " days") + ")\n" +
        (reason ? "Reason: " + String(reason).slice(0, 300) + "\n" : "") +
        "Their remaining " + TYPE_LABEL[type].toLowerCase() + " balance: " + balLeft + " days (before this request)\n" +
        "\n" + (appr ? "Approver: " + appr.name + " (department head)."
                     : "No department head assigned — HR approves.") +
        (approveLink ? "\n\n👉 Tap to approve or reject: " + approveLink : ""));
      queueEmail([u.email],
        "[Leave] Your request was submitted",
        "Your " + TYPE_LABEL[type].toLowerCase() + " leave request (" + range + ", " + days +
        (days === 1 ? " day" : " days") + ") was sent to " +
        (appr ? appr.name + " (your department head) for approval." : "HR for approval.") +
        "\nYou'll get an email when it's decided." +
        (base ? "\n\n" + base : ""));
      return { ok: true };
    },

    "POST /api/requests/:id/decide": (b, u, id) => {
      requireAuth(u);
      const r = db.requests.find(x => x.id === id); if (!r) throw err(404, "No such request");
      if (r.status !== "pending") throw err(400, "Already decided");
      const p = findUser(db, r.userId);
      const isAdm = u.role === "admin";
      const isMgr = !isAdm && p && p.managerId === u.id;
      if (!isAdm && !isMgr) throw err(403, "Only this person's department head or HR can decide");
      const approve = b.status === "approved";
      r.status = approve ? "approved" : "rejected";
      r.decidedBy = u.id; r.decidedAt = now();
      const range = r.start === r.end ? fmtD(r.start) : fmtD(r.start) + " to " + fmtD(r.end);
      const info = TYPE_LABEL[r.type].toLowerCase() + " leave (" + range + ", " + r.days + "d)";
      const decider = isMgr ? " (department head)" : " (HR)";
      const wa = (approve ? "✅ Leave approved" : "❌ Leave rejected") +
        "\nWho: " + p.name +
        "\nType: " + TYPE_LABEL[r.type] + " leave" +
        "\nWhen: " + range + " (" + r.days + (r.days === 1 ? " day" : " days") + ")" +
        (r.reason ? "\nReason: " + r.reason : "") +
        "\n" + (approve ? "Approved" : "Rejected") + " by: " + u.name + decider;
      // Notify HR/admins about the decision (activity feed + WhatsApp text)
      notifyAdmins(u.name + " " + (approve ? "approved" : "rejected") + " " + p.name + "'s " + info,
        wa, isAdm ? u.id : null);
      queueEmail(admins(db).map(a => a.email).filter(e => e !== u.email),
        "[Leave] " + (approve ? "Approved" : "Rejected") + ": " + p.name + " — " + info,
        u.name + decider + " " + (approve ? "approved" : "rejected") +
        " " + p.name + "'s " + info + "." +
        (r.reason ? "\nReason: " + r.reason : "") +
        "\n\nFor your information — no action needed." +
        (base ? "\n" + base : ""));
      queueEmail([p.email],
        "[Leave] Your request was " + (approve ? "approved ✅" : "rejected"),
        "Your " + info + " was " + (approve ? "approved" : "rejected") + " by " + u.name + "." +
        (base ? "\n\n" + base : ""));
      save();
      return { ok: true };
    },

    "POST /api/requests/:id/cancel": (b, u, id) => {
      requireAuth(u);
      const r = db.requests.find(x => x.id === id); if (!r) throw err(404, "No such request");
      if (r.userId !== u.id) throw err(403, "Not yours");
      if (r.status !== "pending") throw err(400, "Only pending requests can be cancelled");
      r.status = "cancelled"; save();
      return { ok: true };
    },

    /* ---- compensate credits ---- */
    "POST /api/credits": (b, u) => {
      requireAuth(u);
      const t = findUser(db, b.userId); if (!t) throw err(404, "No such user");
      if (u.role !== "admin" && t.managerId !== u.id) throw err(403, "Only their manager or an admin can add compensate days");
      const days = +b.days;
      if (!days || days <= 0 || days > 30) throw err(400, "Enter the days earned");
      db.compCredits.push({
        id: uid(), userId: t.id, days,
        date: isDate(b.date) ? b.date : now().slice(0, 10),
        note: String(b.note || "").slice(0, 200), addedBy: u.id, createdAt: now(),
      });
      save();
      return { ok: true };
    },

    /* ---- public holidays ---- */
    "POST /api/holidays": (b, u) => {
      requireAdmin(u);
      if (!isDate(b.date)) throw err(400, "Pick a valid date");
      const name = String(b.name || "").trim().slice(0, 80) || "Public holiday";
      if (!Array.isArray(db.holidays)) db.holidays = [];
      const existing = db.holidays.find(h => h.date === b.date);
      if (existing) { existing.name = name; }           // update name if date already added
      else db.holidays.push({ id: uid(), date: b.date, name });
      save();
      return { ok: true };
    },

    "POST /api/holidays/:id/delete": (b, u, id) => {
      requireAdmin(u);
      db.holidays = (db.holidays || []).filter(h => h.id !== id);
      save();
      return { ok: true };
    },

    /* ---- notifications ---- */
    "POST /api/notifications/read": (b, u) => {
      requireAdmin(u);
      db.notifications.forEach(n => { if (!n.readBy.includes(u.id)) n.readBy.push(u.id); });
      save();
      return { ok: true };
    },

    /* ---- settings / account ---- */
    "POST /api/settings": (b, u) => {
      requireAdmin(u);
      if (b.orgName) db.settings.orgName = String(b.orgName).trim().slice(0, 60);
      if ("countWeekends" in b) db.settings.countWeekends = !!b.countWeekends;
      save();
      return { ok: true };
    },

    "POST /api/password": (b, u) => {
      requireAuth(u);
      if (!checkPass(String(b.old || ""), u.pass)) throw err(400, "Current password is wrong");
      if (!b.password || b.password.length < 6) throw err(400, "New password must be at least 6 characters");
      u.pass = hashPass(b.password); save();
      return { ok: true };
    },

    /* ---- backup ---- */
    "GET /api/export": (b, u) => { requireAdmin(u); return db; },

    "POST /api/import": (b, u) => {
      requireAdmin(u);
      const incoming = (b && b.data) ? b.data : b;
      if (!incoming || !Array.isArray(incoming.users) || !incoming.users.length)
        throw err(400, "That file doesn't look like a valid backup (no users found).");
      // Keep the current signing secret so everyone stays logged in.
      const keepSecret = db.secret;
      ["settings", "users", "requests", "compCredits", "notifications", "holidays"].forEach(k => {
        if (incoming[k] !== undefined) db[k] = incoming[k];
      });
      if (!Array.isArray(db.holidays)) db.holidays = [];
      if (!Array.isArray(db.notifications)) db.notifications = [];
      db.secret = keepSecret;
      save();
      return { ok: true };
    },
  };

  /* ---- match & run ---- */
  let handler = routes[method + " " + pathname], param = null;
  if (!handler) {
    const parts = pathname.split("/").filter(Boolean);
    for (const key of Object.keys(routes)) {
      const sp = key.indexOf(" ");
      const m = key.slice(0, sp), p = key.slice(sp + 1);
      if (m !== method) continue;
      const kp = p.split("/").filter(Boolean);
      if (kp.length !== parts.length) continue;
      let ok = true, prm = null;
      for (let i = 0; i < kp.length; i++) {
        if (kp[i].startsWith(":")) prm = decodeURIComponent(parts[i]);
        else if (kp[i] !== parts[i]) { ok = false; break; }
      }
      if (ok) { handler = routes[key]; param = prm; break; }
    }
  }
  if (!handler) return { status: 404, json: { error: "Not found" }, dirty: false, emails: [] };

  const user = verify(db, (authHeader || "").replace(/^Bearer /, ""));
  try {
    const json = handler(body || {}, user, param, base) || { ok: true };
    return { status: 200, json, dirty, emails };
  } catch (e) {
    return { status: typeof e.code === "number" ? e.code : 500, json: { error: e.message || "Server error" }, dirty: false, emails: [] };
  }
}

module.exports = { freshDB, dispatch, TYPE_LABEL };
