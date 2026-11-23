const express = require("express");
const crypto = require("node:crypto");
const path = require("node:path");
const { Pool } = require("pg");

const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : null;
let persistQueue = Promise.resolve();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const RENT_MS = 14 * 24 * 60 * 60 * 1000;

const TARIFFS = [
  { price: 3, income: 1.22, stock: 1000, power: 10 },
  { price: 4.12, income: 2.68, stock: 700, power: 20 },
  { price: 7.5, income: 3.94, stock: 400, power: 35 },
  { price: 12, income: 5.70, stock: 250, power: 50 },
  { price: 20, income: null, stock: 150, power: 80 },
  { price: 35, income: null, stock: 100, power: 120 },
  { price: 50, income: null, stock: 60, power: 180 },
  { price: 75, income: null, stock: 30, power: 250 },
  { price: 105, income: null, stock: 10, power: 350 }
];

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
async function persistState() {
  if (!pool) return;
  const snapshot = { users: [...users.entries()], stocks: [...stocks], server: { ...server }, logs: [...logs] };
  persistQueue = persistQueue.then(() => pool.query(
    "INSERT INTO airton_state (id, state, updated_at) VALUES (1, $1::jsonb, NOW()) ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = NOW()",
    [JSON.stringify(snapshot)]
  ));
  return persistQueue;
}

async function initDatabase() {
  if (!pool) { console.warn("DATABASE_URL is missing; AIRTON is running without persistent storage"); return; }
  await pool.query("CREATE TABLE IF NOT EXISTS airton_state (id SMALLINT PRIMARY KEY CHECK (id = 1), state JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  const result = await pool.query("SELECT state FROM airton_state WHERE id = 1");
  if (result.rows.length) {
    const state = result.rows[0].state;
    users.clear();
    for (const entry of (state.users || [])) users.set(entry[0], entry[1]);
    if (Array.isArray(state.stocks) && state.stocks.length === stocks.length) stocks.splice(0, stocks.length, ...state.stocks);
    if (state.server && typeof state.server === "object") Object.assign(server, state.server);
    logs.splice(0, logs.length, ...(state.logs || []).slice(0, 300));
  } else { await persistState(); }
  console.log("AIRTON PostgreSQL storage ready");
}

app.use((req, res, next) => {
  const sendJson = res.json.bind(res);
  res.json = (body) => {
    const shouldPersist = Boolean(pool) && ((req.method === "POST" && req.path.startsWith("/api/")) || (req.method === "GET" && (req.path.startsWith("/api/user/") || req.path === "/api/admin/overview")));
    if (!shouldPersist) return sendJson(body);
    persistState().then(() => sendJson(body)).catch(error => {
      console.error("AIRTON database save failed:", error.message);
      sendJson({ ok: false, error: "Не удалось сохранить данные. Повторите запрос" });
    });
    return res;
  };
  next();
});


// Runtime cache backed by PostgreSQL when DATABASE_URL is configured.
const sessions = new Map();
const users = new Map();
const logs = [];
const stocks = TARIFFS.map(t => t.stock);
const server = { id: "default", status: "ONLINE", note: "Основной сервер" };
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
function ensureUser(id) {
  if (!users.has(id)) {
    users.set(id, {
      id, balance: 0, earned: 0, servers: [], missions: [false, false],
      miningEnabled: false, lastTick: Date.now(), banned: false, banReason: ""
    });
  }
  return users.get(id);
}
function activeServers(user, now = Date.now()) {
  return user.servers.filter(s => s.end > now);
}
function totals(user) {
  const active = activeServers(user);
  return {
    income: active.reduce((sum, s) => sum + s.income, 0),
    power: active.reduce((sum, s) => sum + s.power, 0),
    count: active.length
  };
}
function settle(user) {
  const now = Date.now();
  const elapsed = Math.max(0, Math.min((now - user.lastTick) / 1000, 86400));
  const running = user.miningEnabled && server.status === "ONLINE" && !user.banned;
  const daily = totals(user).income;
  if (running && daily > 0) {
    const gain = daily * elapsed / 86400;
    user.balance = Number((user.balance + gain).toFixed(10));
    user.earned = Number((user.earned + gain).toFixed(10));
  }
  user.lastTick = now;
  if (!activeServers(user).length) user.miningEnabled = false;
}
function publicUser(user) {
  settle(user);
  return {
    id: user.id,
    balance: user.balance,
    earned: user.earned,
    servers: activeServers(user),
    missions: user.missions,
    miningEnabled: user.miningEnabled,
    banned: user.banned,
    banReason: user.banReason,
    ...totals(user),
    serverStatus: server.status
  };
}
function adminAuth(req, res, next) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    if (token) sessions.delete(token);
    return res.status(401).json({ ok: false, error: "Сессия администратора истекла. Войдите снова" });
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  next();
}
function getUserFromParam(req, res) {
  const id = cleanText(req.params.id, 80);
  if (!validId(id)) {
    res.status(400).json({ ok: false, error: "Некорректный ID пользователя" });
    return null;
  }
  return ensureUser(id);
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "AIRTON-API", status: "online", version: "1.1.0" });
});
app.get("/api/config", (_req, res) => {
  res.json({
    ok: true, app: "AIRTON", serverStatus: server.status, serverNote: server.note,
    mode: "demo", realTonTransfers: false, persistentStorage: Boolean(pool),
    tariffs: TARIFFS.map((t, i) => ({ ...t, stock: stocks[i] }))
  });
});
app.get("/api/user/:id", (req, res) => {
  const user = getUserFromParam(req, res);
  if (!user) return;
  res.json({ ok: true, user: publicUser(user) });
});
app.post("/api/user/:id/mining", (req, res) => {
  const user = getUserFromParam(req, res);
  if (!user) return;
  settle(user);
  if (user.banned) return res.status(403).json({ ok: false, error: "Аккаунт заблокирован" });
  const enabled = Boolean(req.body?.enabled);
  if (enabled && server.status !== "ONLINE") {
    return res.status(409).json({ ok: false, error: "Сервер сейчас недоступен" });
  }
  if (enabled && !activeServers(user).length) {
    return res.status(409).json({ ok: false, error: "Сначала арендуйте сервер" });
  }
  user.miningEnabled = enabled;
  user.lastTick = Date.now();
  log(enabled ? "mining_started" : "mining_stopped", { userId: user.id });
  res.json({ ok: true, user: publicUser(user) });
});
app.post("/api/user/:id/rent", (req, res) => {
  const user = getUserFromParam(req, res);
  if (!user) return;
  settle(user);
  if (user.banned) return res.status(403).json({ ok: false, error: "Аккаунт заблокирован" });
  if (server.status !== "ONLINE") return res.status(409).json({ ok: false, error: "Аренда временно недоступна" });
  const index = Number(req.body?.tariffIndex);
  if (!Number.isInteger(index) || index < 0 || index >= TARIFFS.length) {
    return res.status(400).json({ ok: false, error: "Неизвестный тариф" });
  }
  const tariff = TARIFFS[index];
  if (tariff.income === null) return res.status(409).json({ ok: false, error: "Этот тариф пока настраивается" });
  if (stocks[index] <= 0) return res.status(409).json({ ok: false, error: "Серверы закончились" });
  if (user.balance < tariff.price) return res.status(409).json({ ok: false, error: "Недостаточно виртуального баланса" });
  user.balance = Number((user.balance - tariff.price).toFixed(10));
  stocks[index] -= 1;
  user.servers.push({
    id: crypto.randomUUID(), price: tariff.price, income: tariff.income,
    power: tariff.power, end: Date.now() + RENT_MS
  });
  log("server_rented", { userId: user.id, tariffIndex: index, price: tariff.price });
  res.json({ ok: true, user: publicUser(user), config: { tariffs: TARIFFS.map((t, i) => ({ ...t, stock: stocks[i] })) } });
});
app.post("/api/user/:id/mission", (req, res) => {
  const user = getUserFromParam(req, res);
  if (!user) return;
  settle(user);
  if (user.banned) return res.status(403).json({ ok: false, error: "Аккаунт заблокирован" });
  const number = Number(req.body?.number);
  if (![1, 2].includes(number)) return res.status(400).json({ ok: false, error: "Неизвестная миссия" });
  const index = number - 1;
  if (user.missions[index]) return res.status(409).json({ ok: false, error: "Награда уже получена" });
  if (number === 2 && !activeServers(user).length) {
    return res.status(409).json({ ok: false, error: "Сначала арендуйте сервер" });
  }
  const reward = number === 1 ? 0.1 : 0.2;
  user.missions[index] = true;
  user.balance = Number((user.balance + reward).toFixed(10));
  log("mission_reward", { userId: user.id, number, reward });
  res.json({ ok: true, user: publicUser(user) });
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
    return res.status(401).json({ ok: false, error: "Неверный ключ доступа" });
  }
  loginAttempts.delete(ip);
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { expiresAt: Date.now() + SESSION_TTL_MS });
  log("admin_login");
  res.json({ ok: true, token, expiresIn: SESSION_TTL_MS });
});
app.get("/api/admin/overview", adminAuth, (_req, res) => {
  const allUsers = [...users.values()].map(user => publicUser(user));
  res.json({ ok: true, server, users: allUsers, logs: logs.slice(0, 100), storage: pool ? "postgresql" : "memory-only" });
});
app.post("/api/admin/server-status", adminAuth, (req, res) => {
  const status = String(req.body?.status || "").toUpperCase();
  if (!["ONLINE", "OFFLINE", "MAINTENANCE"].includes(status)) {
    return res.status(400).json({ ok: false, error: "Недопустимый статус" });
  }
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
    return res.status(400).json({ ok: false, error: "Некорректная сумма" });
  }
  if (!reason) return res.status(400).json({ ok: false, error: "Укажите причину" });
  const user = ensureUser(userId);
  settle(user);
  user.balance = Number((user.balance + amount).toFixed(10));
  log("demo_credit", { userId, amount, reason, balance: user.balance });
  res.json({ ok: true, user: publicUser(user), note: "Начислены виртуальные единицы, не реальные TON" });
});
app.post("/api/admin/ban", adminAuth, (req, res) => {
  const userId = cleanText(req.body?.userId, 80);
  const reason = cleanText(req.body?.reason, 180);
  if (!validId(userId)) return res.status(400).json({ ok: false, error: "Некорректный ID пользователя" });
  if (!reason) return res.status(400).json({ ok: false, error: "Укажите причину блокировки" });
  const user = ensureUser(userId);
  user.banned = true;
  user.banReason = reason;
  user.miningEnabled = false;
  log("user_banned", { userId, reason });
  res.json({ ok: true, user: publicUser(user) });
});
app.post("/api/admin/unban", adminAuth, (req, res) => {
  const userId = cleanText(req.body?.userId, 80);
  if (!validId(userId)) return res.status(400).json({ ok: false, error: "Некорректный ID пользователя" });
  const user = ensureUser(userId);
  user.banned = false;
  user.banReason = "";
  log("user_unbanned", { userId });
  res.json({ ok: true, user: publicUser(user) });
});
app.get("/api/admin/logs", adminAuth, (_req, res) => {
  res.json({ ok: true, logs: logs.slice(0, 200) });
});
app.post("/api/admin/clear-logs", adminAuth, (_req, res) => {
  logs.length = 0;
  log("admin_cleared_logs");
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));
app.use((err, _req, res, _next) => {
  if (err instanceof SyntaxError) return res.status(400).json({ ok: false, error: "Некорректный JSON" });
  res.status(500).json({ ok: false, error: "Внутренняя ошибка сервера" });
});
initDatabase()
  .then(() => app.listen(PORT, "0.0.0.0", () => console.log("AIRTON-API listening on " + PORT)))
  .catch(error => { console.error("AIRTON database initialization failed:", error); process.exit(1); });
