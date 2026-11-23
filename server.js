const express = require("express");
const crypto = require("node:crypto");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: "32kb" }));

// Demo storage: memory only. It resets when the free service restarts/redeploys.
const sessions = new Map();
const users = new Map();
const logs = [];
const servers = new Map([
  ["default", { id: "default", status: "ONLINE", note: "Основной сервер" }]
]);

const loginAttempts = new Map();
function log(action, details = {}) {
  logs.unshift({ id: crypto.randomUUID(), action, details, at: new Date().toISOString() });
  if (logs.length > 300) logs.length = 300;
}
function cleanText(value, max = 180) {
  return String(value ?? "").trim().slice(0, max);
}
function validId(value) {
  return /^[a-zA-Z0-9_:@.-]{1,80}$/.test(String(value || ""));
}
function adminAuth(req, res, next) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    if (token) sessions.delete(token);
    return res.status(401).json({ ok: false, error: "Требуется вход администратора" });
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  next();
}
function ensureUser(id) {
  if (!users.has(id)) users.set(id, { id, demoBalance: 0, banned: false, banReason: "" });
  return users.get(id);
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "AIRTON-API", status: "online", version: "1.0.0" });
});
app.get("/api/config", (_req, res) => {
  res.json({
    ok: true,
    app: "AIRTON",
    serverStatus: servers.get("default").status,
    mode: "demo",
    realTonTransfers: false,
    persistentStorage: false
  });
});
app.get("/api/user/:id", (req, res) => {
  const id = cleanText(req.params.id, 80);
  if (!validId(id)) return res.status(400).json({ ok: false, error: "Некорректный ID" });
  const user = ensureUser(id);
  res.json({
    ok: true,
    id: user.id,
    demoBalance: user.demoBalance,
    banned: user.banned,
    serverStatus: servers.get("default").status
  });
});

app.post("/api/admin/login", (req, res) => {
  if (!ADMIN_SECRET) return res.status(503).json({ ok: false, error: "На сервере не задан ADMIN_SECRET" });
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const state = loginAttempts.get(ip) || { count: 0, until: 0 };
  if (state.until > Date.now() && state.count >= 8) {
    return res.status(429).json({ ok: false, error: "Слишком много попыток. Попробуйте позже" });
  }
  const supplied = String(req.body?.secret || "");
  const a = Buffer.from(supplied);
  const b = Buffer.from(ADMIN_SECRET);
  const matches = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!matches) {
    state.count += 1;
    if (state.count >= 8) state.until = Date.now() + 15 * 60 * 1000;
    loginAttempts.set(ip, state);
    return res.status(401).json({ ok: false, error: "Неверный секрет" });
  }
  loginAttempts.delete(ip);
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { expiresAt: Date.now() + SESSION_TTL_MS });
  log("admin_login");
  res.json({ ok: true, token, expiresIn: SESSION_TTL_MS });
});

app.get("/api/admin/overview", adminAuth, (_req, res) => {
  res.json({
    ok: true,
    server: servers.get("default"),
    users: [...users.values()],
    logs: logs.slice(0, 100),
    storage: "memory-only"
  });
});
app.post("/api/admin/server-status", adminAuth, (req, res) => {
  const status = String(req.body?.status || "").toUpperCase();
  if (!["ONLINE", "OFFLINE", "MAINTENANCE"].includes(status)) {
    return res.status(400).json({ ok: false, error: "Допустимые статусы: ONLINE, OFFLINE, MAINTENANCE" });
  }
  const server = servers.get("default");
  server.status = status;
  server.note = cleanText(req.body?.note, 180);
  log("server_status_changed", { status, note: server.note });
  res.json({ ok: true, server });
});
app.post("/api/admin/credit", adminAuth, (req, res) => {
  const userId = cleanText(req.body?.userId, 80);
  const amount = Number(req.body?.amount);
  const reason = cleanText(req.body?.reason, 180);
  if (!validId(userId)) return res.status(400).json({ ok: false, error: "Некорректный ID пользователя" });
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000) {
    return res.status(400).json({ ok: false, error: "Сумма должна быть больше 0 и не более 1 000 000" });
  }
  if (!reason) return res.status(400).json({ ok: false, error: "Укажите причину" });
  const user = ensureUser(userId);
  user.demoBalance = Number((user.demoBalance + amount).toFixed(6));
  log("demo_credit", { userId, amount, reason, balance: user.demoBalance });
  res.json({ ok: true, user, note: "Начислены демонстрационные единицы, не реальные TON" });
});
app.post("/api/admin/ban", adminAuth, (req, res) => {
  const userId = cleanText(req.body?.userId, 80);
  const reason = cleanText(req.body?.reason, 180);
  if (!validId(userId)) return res.status(400).json({ ok: false, error: "Некорректный ID пользователя" });
  if (!reason) return res.status(400).json({ ok: false, error: "Укажите причину блокировки" });
  const user = ensureUser(userId);
  user.banned = true;
  user.banReason = reason;
  log("user_banned", { userId, reason });
  res.json({ ok: true, user });
});
app.post("/api/admin/unban", adminAuth, (req, res) => {
  const userId = cleanText(req.body?.userId, 80);
  if (!validId(userId)) return res.status(400).json({ ok: false, error: "Некорректный ID пользователя" });
  const user = ensureUser(userId);
  user.banned = false;
  user.banReason = "";
  log("user_unbanned", { userId });
  res.json({ ok: true, user });
});
app.get("/api/admin/logs", adminAuth, (_req, res) => {
  res.json({ ok: true, logs: logs.slice(0, 200) });
});

app.use((err, _req, res, _next) => {
  if (err instanceof SyntaxError) return res.status(400).json({ ok: false, error: "Некорректный JSON" });
  res.status(500).json({ ok: false, error: "Внутренняя ошибка сервера" });
});
app.listen(PORT, "0.0.0.0", () => {
  console.log(`AIRTON-API listening on ${PORT}`);
});
