const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
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

// --- STATE MANAGEMENT ---
let settings = {
    businessName: "My Business",
    apiKey: "",
    context: "I am a helpful assistant."
};
let lastStatus = "Initializing...";
let lastQR = "";

// --- MIDDLEWARE ---
app.use(express.static('public'));
app.use(express.json());

// --- UTILS ---
function updateStatus(msg) {
    lastStatus = msg;
    io.emit('status', msg);
    console.log(`[STATUS] ${msg}`);
}

// --- API ROUTES ---
app.post('/settings', (req, res) => {
    const { businessName, apiKey, context } = req.body;
    settings = { businessName, apiKey, context };

    // Simple file persistence
    fs.writeFileSync('settings.json', JSON.stringify(settings));

    console.log(`Settings updated for ${businessName}`);
    res.json({ message: 'Settings Saved. AI Ready.' });
});

// DEBUG Endpoint
app.get('/debug', (req, res) => {
    const debugInfo = {
        serverTime: new Date().toISOString(),
        settingsLoaded: !!settings.apiKey,
        sessionFolder: fs.existsSync('auth_info_live') ? 'Exists' : 'Missing',
        canWrite: false,
        socketStatus: sock ? 'Initialized' : 'Undefined',
        lastStatus,
        lastQR: lastQR ? 'Generated' : 'None'
    };

    try {
        if (!fs.existsSync('auth_info_live')) fs.mkdirSync('auth_info_live');
        fs.writeFileSync('auth_info_live/test.txt', 'write_test');
        fs.unlinkSync('auth_info_live/test.txt');
        debugInfo.canWrite = true;
    } catch (e) {
        debugInfo.writeError = e.message;
    }

    res.json(debugInfo);
});

// Load settings on start
if (fs.existsSync('settings.json')) {
    try {
        const data = fs.readFileSync('settings.json', 'utf8');
        if (data) settings = JSON.parse(data);
    } catch (e) {
        console.error("Error loading settings:", e);
    }
}

// --- WHATSAPP LOGIC (v3.3 STABLE) ---
let sock;

async function startWhatsApp() {
    updateStatus("Preparing Session...");

    // Cleanup previous socket if exists
    if (sock) {
        sock.ev.removeAllListeners();
        sock.end(undefined);
        sock = undefined;
    }

    // Ensure session dir exists (safely)
    if (!fs.existsSync('auth_info_live')) {
        fs.mkdirSync('auth_info_live', { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState('auth_info_live');

    updateStatus("Connecting to WhatsApp...");

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true, // Log QR to console (which goes to UI)
        logger: pino({ level: 'info' }),
        // browser: Use Default Baileys Signature (Safest)
        connectTimeoutMs: 60000,
        syncFullHistory: false,
        generateHighQualityLinkPreview: true,
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log(">> QR CODE GENERATED <<");
            lastQR = qr;
            io.emit('qr', qr);
            updateStatus("Scan QR Code Now");
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            const reason = (lastDisconnect.error)?.output?.payload?.message || lastDisconnect.error?.message || "Connection Closed";

            console.error(`DISCONNECTED: ${reason}`);
            updateStatus(`Disconnected: ${reason}`);

            if (shouldReconnect) {
                updateStatus("Reconnecting in 5s...");
                setTimeout(startWhatsApp, 5000); // 5s delay
            } else {
                updateStatus("Session Ended. Clearing Data...");
                try {
                    fs.rmSync('auth_info_live', { recursive: true, force: true });
                    setTimeout(startWhatsApp, 2000);
                } catch (e) { console.error(e); }
            }

        } else if (connection === 'open') {
            console.log(">> CONNECTED SUCCESSFULLY <<");
            updateStatus("Connected & Online ✅");
            io.emit('qr', "");
            io.emit('log', "WhatsApp Connected!");
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message) continue;

            // Extract text
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
            if (!text) continue;

            const remoteJid = msg.key.remoteJid;
            if (remoteJid === 'status@broadcast') continue;

            // AI Reply
            if (settings.apiKey) {
                try {
                    const reply = await getAIReply(text);
                    await sock.sendMessage(remoteJid, { text: reply });
                    console.log(`Replied to ${remoteJid}`);
                } catch (e) {
                    console.error("AI Error:", e.message);
                }
            }
        }
    });
}

// --- AI LOGIC ---
async function getAIReply(text) {
    const genAI = new GoogleGenerativeAI(settings.apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const prompt = `
    You are a helpful assistant for "${settings.businessName}".
    Context: ${settings.context}
    User: "${text}"
    Reply concisely.
    `;

    const result = await model.generateContent(prompt);
    return result.response.text();
}

// --- SOCKET.IO ---
io.on('connection', (socket) => {
    socket.emit('status', lastStatus);
    if (lastQR) socket.emit('qr', lastQR);
});

// --- START ---
// server.listen first, then start whatsapp
server.listen(PORT, () => {
    console.log(`Server v3.3 running on port ${PORT}`);

    // NUCLEAR RESET ON START (Fresh Session Concept)
    if (fs.existsSync('auth_info_live')) {
        console.log("Wiping old session (Fresh Start)...");
        try {
            fs.rmSync('auth_info_live', { recursive: true, force: true });
        } catch (e) {
            console.error("Reset Failed:", e);
        }
    }

    startWhatsApp();
});
