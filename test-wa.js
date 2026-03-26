const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, Browsers } = require("@whiskeysockets/baileys");
const pino = require("pino");
const fs = require("fs");
const path = require("path");

async function testWA() {
  const folderPath = path.join(__dirname, "auth_info_test");
  if (fs.existsSync(folderPath)) fs.rmSync(folderPath, { recursive: true, force: true });
  
  const { state, saveCreds } = await useMultiFileAuthState(folderPath);
  
  let version = [2, 3000, 1017531207];
  try {
    const latest = await fetchLatestBaileysVersion();
    version = latest.version;
    console.log("Fetched latest version:", version);
  } catch (e) {
    console.error("Failed to fetch version");
  }

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true, // We want to see it in terminal
    logger: pino({ level: "trace" }), // Enable verbose logging to see exactly why it fails
    browser: Browsers.ubuntu("Chrome"),
    connectTimeoutMs: 60000,
  });

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log("✅ QR RECEIVED!");
      process.exit(0);
    }
    if (connection === 'close') {
      console.log("❌ Connection Closed:", lastDisconnect?.error);
      process.exit(1);
    }
  });

  sock.ev.on("creds.update", saveCreds);
}

testWA().catch(console.error);
