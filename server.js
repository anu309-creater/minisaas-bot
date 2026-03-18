require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const multer = require("multer");
const pino = require("pino");
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require("@whiskeysockets/baileys");

const dbHelper = require("./database");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET || JWT_SECRET === "super_secret_minisaas_key_2026") {
  if (process.env.NODE_ENV === "production") {
    console.error("CRITICAL: JWT_SECRET is not set or using default in production! Exiting...");
    process.exit(1);
  } else {
    console.warn("WARNING: JWT_SECRET is not set or using default. This is insecure.");
  }
}

process.on("uncaughtException", (err) => {
  console.error("CRITICAL: Uncaught Exception:", err);
  fs.appendFileSync("crash.log", `[${new Date().toISOString()}] Uncaught Exception: ${err.stack}\n`);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("CRITICAL: Unhandled Rejection at:", promise, "reason:", reason);
  fs.appendFileSync("crash.log", `[${new Date().toISOString()}] Unhandled Rejection: ${reason}\n`);
});

// Simple Rate Limiter for Auth
const loginAttempts = new Map();
function rateLimitAuth(req, res, next) {
  const ip = req.ip;
  const now = Date.now();
  const limit = 5; // 5 attempts
  const window = 60000; // 1 minute

  if (!loginAttempts.has(ip)) {
    loginAttempts.set(ip, []);
  }
  const attempts = loginAttempts.get(ip).filter(t => now - t < window);
  attempts.push(now);
  loginAttempts.set(ip, attempts);

  if (attempts.length > limit) {
    return res.status(429).json({ error: "Too many attempts. Try again in a minute." });
  }
  next();
}

// --- STATE MANAGEMENT ---
let activeSockets = {}; // { userId: sock }
let startingSockets = {}; // { userId: promise }
let currentQRs = {}; // { userId: "qr_string" }
let connectionStatuses = {}; // { userId: "Status" }
const logsBuffers = {}; // { userId: [logs] }
const MAX_LOGS = 100;

function addLog(userId, message) {
  if (!userId) return;
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] ${message}`;
  if (!logsBuffers[userId]) logsBuffers[userId] = [];
  logsBuffers[userId].unshift(logEntry);
  if (logsBuffers[userId].length > MAX_LOGS) logsBuffers[userId].pop();
  io.to(`user_${userId}`).emit("log", message);
  console.log(`[User ${userId}] ` + logEntry);
}

// =========================
// BASIC MIDDLEWARE
// =========================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(path.join(__dirname, "public", "uploads")));

// =========================
// MULTER FILE UPLOAD
// =========================
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, "public", "uploads");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const name = Date.now() + "-" + file.originalname.replace(/\s+/g, "_");
    cb(null, name);
  },
});
const upload = multer({ storage });

// =========================
// AUTH MIDDLEWARE
// =========================
function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  if (!authHeader) return res.status(401).json({ error: "Unauthorized" });
  const token = authHeader.split(" ")[1];
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Forbidden" });
    req.user = user;
    next();
  });
}

// =========================
// AUTH ROUTES
// =========================
app.post("/api/auth/register", rateLimitAuth, async (req, res) => {
  try {
    const { email, password, businessName } = req.body;
    if (!email || !password || !businessName) return res.status(400).json({ error: "Missing fields" });
    const userId = await dbHelper.createUser(email, password, businessName);
    const token = jwt.sign({ id: userId, email }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ success: true, token, userId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/auth/login", rateLimitAuth, async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await dbHelper.getUserByEmail(email);
    if (!user) return res.status(400).json({ error: "Invalid credentials" });
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(400).json({ error: "Invalid credentials" });
    const token = jwt.sign({ id: user.id, email }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ success: true, token, userId: user.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/auth/me", authenticateToken, async (req, res) => {
  try {
    const user = await dbHelper.getUserById(req.user.id);
    const quota = await dbHelper.getQuota(req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });
    user.password_hash = undefined;
    res.json({ user, quota });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =========================
// BOT API ROUTES
// =========================
app.get("/api/status", authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const user = await dbHelper.getUserById(userId);
  let sock = activeSockets[userId];
  const authFolder = path.join(__dirname, `auth_info_v4/user_${userId}`);
  if (!sock && fs.existsSync(authFolder)) {
    addLog(userId, "Auto-resuming session...");
    startWhatsApp(userId).catch((e) => console.error(e));
  }
  res.json({
    status: connectionStatuses[userId] || "Not Initialized",
    businessName: user ? user.businessName : "Unknown",
    botReady: !!(sock && sock.authState && sock.authState.creds && sock.authState.creds.me),
  });
});

app.post("/pair", authenticateToken, async (req, res) => {
  const { phone } = req.body;
  const userId = req.user.id;
  if (!activeSockets[userId]) {
    await startWhatsApp(userId);
    return res.status(503).json({ error: "Initializing... try again in 5s" });
  }
  const sock = activeSockets[userId];
  try {
    const code = await sock.requestPairingCode(phone);
    addLog(userId, `Pairing Code: ${code}`);
    res.json({ code });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/reset-session", authenticateToken, async (req, res) => {
  const userId = req.user.id;
  try {
    let sock = activeSockets[userId];
    if (sock) {
      sock.ev.removeAllListeners("connection.update");
      sock.end(undefined);
      delete activeSockets[userId];
    }
    const folderPath = path.join(__dirname, `auth_info_v4/user_${userId}`);
    if (fs.existsSync(folderPath)) fs.rmSync(folderPath, { recursive: true, force: true });
    setTimeout(() => startWhatsApp(userId), 2000);
    res.json({ message: "Session Resetting" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =========================
// PORTFOLIO API
// =========================
app.get("/api/portfolio", authenticateToken, async (req, res) => {
  try {
    const config = await dbHelper.getPortfolio(req.user.id);
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/portfolio/upload", authenticateToken, upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file" });
    const config = await dbHelper.getPortfolio(req.user.id);
    config.images.push({ id: Date.now().toString(), filename: req.file.filename, originalName: req.file.originalname });
    await dbHelper.updatePortfolio(req.user.id, config);
    res.json({ success: true, config });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/portfolio/settings", authenticateToken, async (req, res) => {
  try {
    const { keyword } = req.body;
    const config = await dbHelper.getPortfolio(req.user.id);
    config.keyword = keyword || "portfolio";
    await dbHelper.updatePortfolio(req.user.id, config);
    res.json({ success: true, config });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/portfolio/:id", authenticateToken, async (req, res) => {
  try {
    const config = await dbHelper.getPortfolio(req.user.id);
    const idx = config.images.findIndex((img) => img.id === req.params.id);
    if (idx !== -1) {
      const img = config.images[idx];
      const p = path.join(__dirname, "public", "uploads", img.filename);
      if (fs.existsSync(p)) fs.unlinkSync(p);
      config.images.splice(idx, 1);
      await dbHelper.updatePortfolio(req.user.id, config);
    }
    res.json({ success: true, config });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =========================
// WHATSAPP CORE
// =========================
async function startWhatsApp(userId) {
  if (activeSockets[userId]) return activeSockets[userId];
  if (startingSockets[userId]) return startingSockets[userId];

  startingSockets[userId] = (async () => {
    try {
      const folderPath = path.join(__dirname, `auth_info_v4/user_${userId}`);
      if (!fs.existsSync(path.join(__dirname, "auth_info_v4"))) fs.mkdirSync(path.join(__dirname, "auth_info_v4"));
      const { state, saveCreds } = await useMultiFileAuthState(folderPath);
      let version = [2, 3000, 1015901307];
      try {
        const latest = await fetchLatestBaileysVersion();
        version = latest.version;
      } catch (e) {}

      const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: "silent" }),
        browser: Browsers.ubuntu("Chrome"),
        connectTimeoutMs: 60000,
      });

      activeSockets[userId] = sock;
      connectionStatuses[userId] = "Connecting...";

      sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
          currentQRs[userId] = qr;
          io.to(`user_${userId}`).emit("qr", qr);
        }
        if (connection === "close") {
          const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
          delete activeSockets[userId];
          if (shouldReconnect) setTimeout(() => startWhatsApp(userId), 5000);
          connectionStatuses[userId] = "Disconnected";
        } else if (connection === "open") {
          connectionStatuses[userId] = "Connected ✅";
          currentQRs[userId] = "";
          io.to(`user_${userId}`).emit("status", "Connected ✅");
          addLog(userId, "WhatsApp Connected");
        }
      });

      sock.ev.on("creds.update", saveCreds);

      sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== "notify") return;
        const user = await dbHelper.getUserById(userId);
        if (!user) return;

        for (const msg of messages) {
          if (!msg.message || msg.key.fromMe) continue;
          const remoteJid = msg.key.remoteJid;
          if (remoteJid.endsWith("@g.us")) continue;
          const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
          if (!text) continue;

          addLog(userId, `Msg: ${text.substring(0, 20)}`);

          // PORTFOLIO CHECK
          const portConfig = await dbHelper.getPortfolio(userId);
          if (text.toLowerCase().includes(portConfig.keyword?.toLowerCase() || "portfolio")) {
            for (const img of portConfig.images) {
              const p = path.join(__dirname, "public", "uploads", img.filename);
              if (fs.existsSync(p)) {
                await sock.sendMessage(remoteJid, { image: fs.readFileSync(p), caption: "Portfolio Sample" });
              }
            }
            continue;
          }

          // AI REPLY
          if (!process.env.OPENROUTER_API_KEY) continue;
          try {
            const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                model: "google/gemini-2.0-flash-lite:free",
                messages: [
                  { role: "system", content: `You are the AI assistant for ${user.businessName}. Context: ${user.context}` },
                  { role: "user", content: text },
                ],
              }),
            });
            const data = await response.json();
            const aiTxt = data.choices?.[0]?.message?.content;
            if (aiTxt) {
              await sock.sendMessage(remoteJid, { text: aiTxt });
              await dbHelper.incrementQuota(userId);
            }
          } catch (e) {
            console.error("AI Error:", e);
          }
        }
      });

      return sock;
    } catch (err) {
      delete startingSockets[userId];
      throw err;
    } finally {
      delete startingSockets[userId];
    }
  })();
  return startingSockets[userId];
}

// =========================
// PAGE ROUTES
// =========================
app.get("/", (req, res) => {
  console.log("Serving index.html");
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
app.get("/dashboard/?", (req, res) => {
  console.log("Serving dashboard.html");
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});
app.get("/login/?", (req, res) => {
  console.log("Serving login.html");
  res.sendFile(path.join(__dirname, "public", "login.html"));
});
app.get("/signup/?", (req, res) => {
  console.log("Serving signup.html");
  res.sendFile(path.join(__dirname, "public", "signup.html"));
});

// =========================
// SERVER START
// =========================
app.post("/api/settings", authenticateToken, async (req, res) => {
  try {
    await dbHelper.updateUserSettings(req.user.id, req.body);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

dbHelper.initPromise.then(() => {
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server on port ${PORT}`);
  }).on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`Port ${PORT} is in use. Please kill the process using it or wait a few seconds.`);
      process.exit(1);
    }
  });
});

io.on("connection", (socket) => {
  const token = socket.handshake.query.token;
  if (token) {
    jwt.verify(token, JWT_SECRET, (err, user) => {
      if (!err) {
        socket.join(`user_${user.id}`);
        startWhatsApp(user.id).catch(console.error);
      }
    });
  }
});