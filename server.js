const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay, Browsers } = require('@whiskeysockets/baileys');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const pino = require('pino');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// --- STATE ---
let settings = {
    businessName: "My Business",
    apiKey: "",
    context: "I am a helpful assistant."
};
let sock;

// --- MIDDLEWARE ---
app.use(express.static('public'));
app.use(express.json());

// --- ROUTES ---
app.post('/settings', (req, res) => {
    settings = req.body;
    fs.writeFileSync('settings.json', JSON.stringify(settings));
    io.emit('log', `Settings Updated: ${settings.businessName}`);
    res.json({ message: 'Settings Saved' });
});

app.post('/reset-session', (req, res) => {
    try {
        console.log("[RESET] Clearing session...");
        if (sock) {
            sock.end(undefined);
            sock = undefined;
        }
        if (fs.existsSync('auth_info_v4')) {
            fs.rmSync('auth_info_v4', { recursive: true, force: true });
        }
        startWhatsApp();
        res.json({ message: "Session Reset" });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/pair', async (req, res) => {
    const { phone } = req.body;
    console.log(`[PAIR] Request for ${phone}`);

    if (!sock) {
        console.log("[PAIR] System not ready (sock undefined)");
        return res.status(503).json({ error: 'System Initializing... Wait 10s.' });
    }

    try {
        if (!sock.authState.creds.me) {
            console.log("[PAIR] Requesting code from Baileys...");
            const code = await sock.requestPairingCode(phone);
            console.log(`[PAIR] Code received: ${code}`);
            io.emit('log', `Pairing Code Generated: ${code}`);
            res.json({ code });
        } else {
            console.log("[PAIR] Already connected");
            res.json({ message: 'Already Connected' });
        }
    } catch (e) {
        console.error("[PAIR] Error:", e);
        res.status(500).json({ error: "Failed: " + e.message });
    }
});

// --- CORE ---
async function startWhatsApp() {
    // Ensure clean slate
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_v4');

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ['Ubuntu', 'Chrome', '20.0.04'], // Standard Browser
        connectTimeoutMs: 60000,
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            currentQR = qr;
            io.emit('qr', qr);
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            io.emit('status', `Disconnected: ${lastDisconnect.error?.message}`);

            if (shouldReconnect) {
                setTimeout(startWhatsApp, 5000); // 5s Retry
            } else {
                // Logged out
                try {
                    fs.rmSync('auth_info_v4', { recursive: true, force: true });
                    startWhatsApp();
                } catch (e) { console.error(e); }
            }
        } else if (connection === 'open') {
            io.emit('status', 'Connected ✅');
            io.emit('qr', ''); // Clear QR
            currentQR = "";
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // AI Logic with Fallback and Debug Logs
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message) continue;

            const remoteJid = msg.key.remoteJid;
            const isMe = msg.key.fromMe;
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text;

            // Log every message receipt
            if (text) {
                io.emit('log', `Rx: ${text.substring(0, 10)}... (Me: ${isMe})`);
            }

            if (isMe) continue;
            if (!text) continue;

            // Check Settings
            if (!settings.apiKey) {
                io.emit('log', '⚠ No API Key set. Ignoring.');
                continue;
            }

            // AI Logic with Fallback
            const modelsToTry = ["gemini-1.5-flash", "gemini-1.5-pro", "gemini-pro"];
            let aiResponse = null;
            let lastError = null;

            for (const modelName of modelsToTry) {
                try {
                    io.emit('log', `🤖 Thinking with ${modelName}...`);
                    const genAI = new GoogleGenerativeAI(settings.apiKey);
                    const model = genAI.getGenerativeModel({ model: modelName });

                    const prompt = `Act as a support agent for ${settings.businessName}. user: ${text}`;
                    const result = await model.generateContent(prompt);
                    aiResponse = result.response.text();

                    // If successful, break loop
                    if (aiResponse) break;

                } catch (e) {
                    console.error(`Error with ${modelName}:`, e.message);
                    lastError = e.message;
                    // Continue to next model
                }
            }

            if (aiResponse) {
                await sock.sendMessage(remoteJid, { text: aiResponse });
                io.emit('log', `✅ Sent: ${aiResponse.substring(0, 10)}...`);
            } else {
                io.emit('log', `❌ All AI models failed. Last error: ${lastError}`);

                // --- FALLBACK (OFFLINE MODE) ---
                console.log("Switching to Basic Rule-Based Reply");
                const lowerText = text.toLowerCase();
                let reply = "";

                if (lowerText.includes('hello') || lowerText.includes('hi') || lowerText.includes('salam')) {
                    reply = "Walaikum Assalam! 👋\n(AI System is currently offline due to API Key issues, but I am here!)";
                } else if (lowerText.includes('help')) {
                    reply = "Since AI is down, I can only respond to basic commands.\nTry saying 'Hello'.";
                } else {
                    reply = "⚠️ AI Brain is disconnected (API Key Error).\n\nPlease update the API Key in settings.json to fix me.\n\nYou said: " + text;
                }

                await sock.sendMessage(remoteJid, { text: reply });
                io.emit('log', `✅ Sent (Fallback): ${reply.substring(0, 10)}...`);
            }
        }
    });
}

// --- INIT ---
let currentQR = ""; // Cache QR

io.on('connection', (socket) => {
    socket.emit('log', 'Client Connected');
    if (currentQR) socket.emit('qr', currentQR); // Send cached QR

    if (fs.existsSync('settings.json')) {
        try { settings = JSON.parse(fs.readFileSync('settings.json')); } catch (e) { }
    }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server v4.3 running on ${PORT}`);
    // Persistent Session: Do not wipe 'auth_info_v4' on restart
    console.log("Persistent Session Enabled");
    startWhatsApp();
});
