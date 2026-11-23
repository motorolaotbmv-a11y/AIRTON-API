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
let tariffs = TARIFFS.map(t => ({ ...t }));

const NFT_CATALOG = [
  { type:"snooper", name:"Snooper", rarity:"Обычный", icon:"🐶", art:"linear-gradient(145deg,#1c3d47,#72c9b7)" },
  { type:"berry", name:"Berry Box", rarity:"Обычный", icon:"🫐", art:"linear-gradient(145deg,#301a56,#9b78ed)" },
  { type:"candle", name:"Magic Candle", rarity:"Обычный", icon:"🕯️", art:"linear-gradient(145deg,#4c2940,#ff9d9d)" },
  { type:"heart", name:"Heart Locket", rarity:"Редкий", icon:"💝", art:"linear-gradient(145deg,#6b193c,#ff6f9f)" },
  { type:"ring", name:"Moon Ring", rarity:"Редкий", icon:"💍", art:"linear-gradient(145deg,#123d59,#69c8e8)" },
  { type:"bunny", name:"Jelly Bunny", rarity:"Редкий", icon:"🐰", art:"linear-gradient(145deg,#244d43,#8fe3bb)" },
  { type:"pepe", name:"Plush Friend", rarity:"Эпический", icon:"🐸", art:"linear-gradient(145deg,#163f36,#67db9c)" },
  { type:"rocket", name:"Rocket", rarity:"Эпический", icon:"🚀", art:"linear-gradient(145deg,#33245f,#b59aff)" },
  { type:"diamond", name:"Blue Diamond", rarity:"Эпический", icon:"💎", art:"linear-gradient(145deg,#123d67,#7ce4ff)" },
  { type:"crown", name:"Golden Crown", rarity:"Легендарный", icon:"👑", art:"linear-gradient(145deg,#63400c,#ffd56d)" },
  { type:"trophy", name:"Golden Trophy", rarity:"Легендарный", icon:"🏆", art:"linear-gradient(145deg,#5c3510,#ffca65)" },
  { type:"planet", name:"Mini Planet", rarity:"Легендарный", icon:"🪐", art:"linear-gradient(145deg,#34205d,#bba1ff)" }
];
const marketListings = [];
const marketSales = [];
const MARKET_FEE_PERCENT = 5;
function createNft(type) {
  const gift = NFT_CATALOG.find(item => item.type === type) || NFT_CATALOG[0];
  return {
    id: crypto.randomUUID(), type: gift.type, name: gift.name, rarity: gift.rarity,
    icon: gift.icon, art: gift.art, serial: Math.floor(1000 + Math.random() * 8999),
    mintedAt: new Date().toISOString()
  };
}


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
  const snapshot = { users: [...users.entries()], stocks: [...stocks], tariffs: tariffs.map(t => ({ ...t })), server: { ...server }, logs: [...logs], marketListings: [...marketListings], marketSales: marketSales.slice(0, 100) };
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
    if (Array.isArray(state.tariffs) && state.tariffs.length === tariffs.length) tariffs.splice(0, tariffs.length, ...state.tariffs.map(t => ({ ...t })));
    if (state.server && typeof state.server === "object") Object.assign(server, state.server);
    logs.splice(0, logs.length, ...(state.logs || []).slice(0, 300));
    marketListings.splice(0, marketListings.length, ...(state.marketListings || []));
    marketSales.splice(0, marketSales.length, ...(state.marketSales || []).slice(0, 100));
  } else { await persistState(); }
  console.log("AIRTON PostgreSQL storage ready");
}

app.use((req, res, next) => {
  const sendJson = res.json.bind(res);
  res.json = (body) => {
    const shouldPersist = Boolean(pool) && ((req.method === "POST" && req.path.startsWith("/api/")) || (req.method === "GET" && (req.path.startsWith("/api/user/") || req.path.startsWith("/api/market/") || req.path === "/api/admin/overview")));
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
      id, balance: 3, earned: 0, servers: [], missions: [false, false],
      miningEnabled: false, lastTick: Date.now(), banned: false, banReason: "",
      starterBonusGranted: true, nfts: [], nftStarterGranted: false
    });
  }
  const user = users.get(id);
  // One-time migration: give 3 virtual TON to existing untouched accounts.
  if (user.starterBonusGranted !== true) {
    const untouched = Number(user.balance || 0) === 0 &&
      Number(user.earned || 0) === 0 &&
      (!Array.isArray(user.servers) || user.servers.length === 0) &&
      (!Array.isArray(user.missions) || user.missions.every(value => !value));
    if (untouched) user.balance = 3;
    user.starterBonusGranted = true;
  }
  if (!Array.isArray(user.nfts)) user.nfts = [];
  if (user.nftStarterGranted !== true) {
    user.nfts.push(createNft("snooper"), createNft("heart"), createNft("diamond"));
    user.nftStarterGranted = true;
  }
  return user;
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
    tariffs: tariffs.map((t, i) => ({ ...t, stock: stocks[i] }))
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
  if (!Number.isInteger(index) || index < 0 || index >= tariffs.length) {
    return res.status(400).json({ ok: false, error: "Неизвестный тариф" });
  }
  const tariff = tariffs[index];
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
  res.json({ ok: true, user: publicUser(user), config: { tariffs: tariffs.map((t, i) => ({ ...t, stock: stocks[i] })) } });
});

app.get("/api/market/:id", (req, res) => {
  const user = getUserFromParam(req, res);
  if (!user) return;
  settle(user);
  res.json({
    ok: true,
    user: { id: user.id, balance: user.balance, nfts: user.nfts || [], banned: user.banned },
    listings: marketListings.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 100),
    sales: marketSales.slice(0, 50),
    feePercent: MARKET_FEE_PERCENT,
    catalog: NFT_CATALOG
  });
});
app.post("/api/market/:id/list", (req, res) => {
  const user = getUserFromParam(req, res);
  if (!user) return;
  settle(user);
  if (user.banned) return res.status(403).json({ ok: false, error: "Аккаунт заблокирован" });
  const nftId = cleanText(req.body?.nftId, 80);
  const price = Number(req.body?.price);
  if (!Number.isFinite(price) || price < 0.01 || price > 1000000) {
    return res.status(400).json({ ok: false, error: "Цена должна быть от 0.01 до 1 000 000 виртуальных TON" });
  }
  const index = (user.nfts || []).findIndex(item => item.id === nftId);
  if (index < 0) return res.status(404).json({ ok: false, error: "NFT не найден в инвентаре" });
  if (marketListings.some(item => item.nft.id === nftId)) return res.status(409).json({ ok: false, error: "Этот NFT уже выставлен" });
  const nft = user.nfts.splice(index, 1)[0];
  const listing = { id: crypto.randomUUID(), sellerId: user.id, nft, price: Number(price.toFixed(4)), createdAt: new Date().toISOString() };
  marketListings.unshift(listing);
  log("market_listed", { userId: user.id, nftId, price: listing.price });
  res.json({ ok: true, listing, balance: user.balance, nfts: user.nfts });
});
app.post("/api/market/:id/buy", (req, res) => {
  const buyer = getUserFromParam(req, res);
  if (!buyer) return;
  settle(buyer);
  if (buyer.banned) return res.status(403).json({ ok: false, error: "Аккаунт заблокирован" });
  const listingId = cleanText(req.body?.listingId, 80);
  const index = marketListings.findIndex(item => item.id === listingId);
  if (index < 0) return res.status(404).json({ ok: false, error: "Объявление уже недоступно" });
  const listing = marketListings[index];
  if (listing.sellerId === buyer.id) return res.status(409).json({ ok: false, error: "Нельзя купить собственный NFT" });
  if (buyer.balance < listing.price) return res.status(409).json({ ok: false, error: "Недостаточно виртуальных TON" });
  const seller = ensureUser(listing.sellerId);
  settle(seller);
  const fee = Number((listing.price * MARKET_FEE_PERCENT / 100).toFixed(4));
  const sellerReceives = Number((listing.price - fee).toFixed(4));
  buyer.balance = Number((buyer.balance - listing.price).toFixed(10));
  seller.balance = Number((seller.balance + sellerReceives).toFixed(10));
  buyer.nfts.push(listing.nft);
  marketListings.splice(index, 1);
  const sale = {
    id: crypto.randomUUID(), nft: listing.nft, price: listing.price, fee,
    sellerId: seller.id, buyerId: buyer.id, soldAt: new Date().toISOString()
  };
  marketSales.unshift(sale);
  if (marketSales.length > 100) marketSales.length = 100;
  log("market_sold", { buyerId: buyer.id, sellerId: seller.id, nftId: listing.nft.id, price: listing.price, fee });
  res.json({ ok: true, balance: buyer.balance, nfts: buyer.nfts, sale });
});
app.post("/api/market/:id/delist", (req, res) => {
  const user = getUserFromParam(req, res);
  if (!user) return;
  const listingId = cleanText(req.body?.listingId, 80);
  const index = marketListings.findIndex(item => item.id === listingId && item.sellerId === user.id);
  if (index < 0) return res.status(404).json({ ok: false, error: "Ваше объявление не найдено" });
  const [listing] = marketListings.splice(index, 1);
  user.nfts.push(listing.nft);
  log("market_delisted", { userId: user.id, nftId: listing.nft.id });
  res.json({ ok: true, nfts: user.nfts });
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
  res.json({ ok: true, server, users: allUsers, tariffs: tariffs.map((t, i) => ({ ...t, stock: stocks[i] })), logs: logs.slice(0, 100), storage: pool ? "postgresql" : "memory-only" });
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
app.post("/api/admin/tariff", adminAuth, (req, res) => {
  const index = Number(req.body?.index);
  const price = Number(req.body?.price);
  const incomeRaw = req.body?.income;
  const income = incomeRaw === "" || incomeRaw === null ? null : Number(incomeRaw);
  const power = Number(req.body?.power);
  const stock = Number(req.body?.stock);
  if (!Number.isInteger(index) || index < 0 || index >= tariffs.length) {
    return res.status(400).json({ ok: false, error: "Неизвестный тариф" });
  }
  if (!Number.isFinite(price) || price <= 0 || price > 1000000 ||
      (income !== null && (!Number.isFinite(income) || income <= 0 || income > 1000000)) ||
      !Number.isFinite(power) || power <= 0 || power > 1000000 ||
      !Number.isInteger(stock) || stock < 0 || stock > 1000000) {
    return res.status(400).json({ ok: false, error: "Проверь цену, доход, мощность и остаток" });
  }
  tariffs[index] = { ...tariffs[index], price, income, power };
  stocks[index] = stock;
  log("admin_tariff_updated", { index, price, income, power, stock });
  res.json({ ok: true, tariffs: tariffs.map((t, i) => ({ ...t, stock: stocks[i] })) });
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
