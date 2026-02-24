const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const pino = require('pino');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const path = require('path');

/**
 * MENTOR TIP: Structure your application into clear sections.
 * This makes it easier to maintain and scale as your project grows.
 */

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// CRASH DETECTION (DEBUG)
process.on('uncaughtException', (err) => {
    console.error('!!!!!!!! UNCAUGHT EXCEPTION !!!!!!!!');
    console.error(err.stack);
    fs.appendFileSync('crash.log', `${new Date().toISOString()} - ${err.stack}\n`);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('!!!!!!!! UNHANDLED REJECTION !!!!!!!!');
    console.error(reason);
    fs.appendFileSync('crash.log', `${new Date().toISOString()} - REJECTION: ${reason}\n`);
});

// --- STATE MANAGEMENT ---
let settings = {
    businessName: "My Business",
    apiKey: "",
    context: "I am a helpful assistant."
};
let sock;
let currentQR = "";
let connectionStatus = "Initializing...";

// --- LOGGING ---
const logsBuffer = [];
const MAX_LOGS = 100;

function addLog(message) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${message}`;
    logsBuffer.unshift(logEntry);
    if (logsBuffer.length > MAX_LOGS) logsBuffer.pop();
    io.emit('log', message);
    console.log(logEntry);
}

// Load settings
if (fs.existsSync('settings.json')) {
    try {
        const saved = JSON.parse(fs.readFileSync('settings.json'));
        settings = { ...settings, ...saved };
        addLog(`Loaded settings on startup: ${settings.businessName}`);
    } catch (e) {
        console.error("Failed to load settings.json:", e);
    }
}

// --- MIDDLEWARE ---
app.use(express.static('public'));
app.use(express.json());

// --- API ROUTES ---
app.get('/api/status', (req, res) => {
    res.json({
        status: connectionStatus,
        businessName: settings.businessName,
        botReady: !!(sock && sock.authState.creds.me)
    });
});

app.get('/api/logs', (req, res) => {
    res.json({ logs: logsBuffer });
});

app.post('/api/settings', (req, res) => {
    settings = { ...settings, ...req.body };
    fs.writeFileSync('settings.json', JSON.stringify(settings));
    addLog(`Settings Updated: ${settings.businessName}`);
    res.json({ message: 'Settings Saved Successfully', settings });
});

app.post('/api/send', async (req, res) => {
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ error: 'Phone and message are required' });
    if (!sock || !sock.authState.creds.me) return res.status(503).json({ error: 'WhatsApp bot is not connected' });

    try {
        const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: message });
        addLog(`API Sent Message: ${message.substring(0, 20)}...`);
        res.json({ success: true });
    } catch (e) {
        addLog(`API Fail: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

app.post('/pair', async (req, res) => {
    const { phone } = req.body;
    addLog(`Pairing request for ${phone}`);
    if (!sock) return res.status(503).json({ error: 'System Initializing... Wait 10s.' });

    try {
        if (!sock.authState.creds.me) {
            const code = await sock.requestPairingCode(phone);
            addLog(`Pairing Code Generated: ${code}`);
            res.json({ code });
        } else {
            res.json({ message: 'Already Connected' });
        }
    } catch (e) {
        addLog(`Pairing Error: ${e.message}`);
        res.status(500).json({ error: "Failed to generate pairing code: " + e.message });
    }
});

app.post('/api/contact', async (req, res) => {
    const { name, email, message } = req.body;
    if (!name || !email || !message) return res.status(400).json({ error: 'All fields are required' });

    try {
        const lead = {
            id: Date.now(),
            name,
            email,
            message,
            timestamp: new Date().toISOString()
        };

        let leads = [];
        if (fs.existsSync('leads.json')) {
            leads = JSON.parse(fs.readFileSync('leads.json'));
        }
        leads.push(lead);
        fs.writeFileSync('leads.json', JSON.stringify(leads, null, 2));

        addLog(`📩 New Lead: ${name} (${email})`);
        res.json({ success: true, message: 'Message received!' });
    } catch (e) {
        addLog(`Contact Error: ${e.message}`);
        res.status(500).json({ error: 'Failed to save message' });
    }
});

app.post('/reset-session', async (req, res) => {
    try {
        addLog("Clearing session...");
        if (sock) {
            sock.ev.removeAllListeners('connection.update');
            sock.end(undefined);
            sock = undefined;
        }
        if (fs.existsSync('auth_info_v4')) {
            fs.rmSync('auth_info_v4', { recursive: true, force: true });
        }
        setTimeout(startWhatsApp, 2000);
        res.json({ message: "Session Reset Started" });
    } catch (e) {
        addLog(`Reset Error: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

// Pages
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/contact', (req, res) => res.sendFile(path.join(__dirname, 'public', 'contact.html')));

// --- WHATSAPP CORE ---
async function startWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_v4');
    const { version } = await fetchLatestBaileysVersion();
    addLog(`WA Version: ${version.join('.')}`);

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Desktop'),
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            currentQR = qr;
            io.emit('qr', qr);
            addLog("QR Code generated");
        }

        if (connection === 'close') {
            const error = lastDisconnect?.error;
            const statusCode = error?.output?.statusCode;
            const reason = error?.message || 'Unknown reason';
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            console.error('--- DISCONNECT DETAILS ---', JSON.stringify(error, null, 2));
            addLog(`Connection closed: ${reason}. Reconnecting: ${shouldReconnect}`);

            connectionStatus = `Disconnected: ${reason}`;
            io.emit('status', connectionStatus);

            if (shouldReconnect) {
                setTimeout(startWhatsApp, 5000);
            } else {
                addLog("Logged out. Clearing auth folder...");
                if (fs.existsSync('auth_info_v4')) fs.rmSync('auth_info_v4', { recursive: true, force: true });
                startWhatsApp();
            }
        } else if (connection === 'open') {
            connectionStatus = 'Connected ✅';
            io.emit('status', connectionStatus);
            io.emit('qr', '');
            currentQR = "";
            addLog("WhatsApp Connection Opened Successfully");
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue;

            const remoteJid = msg.key.remoteJid;
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
            if (!text) continue;

            addLog(`Rx: ${text.substring(0, 20)}...`);

            if (!settings.apiKey) {
                addLog('⚠ No API Key. Skipping AI.');
                continue;
            }

            // AI Logic
            const genAI = new GoogleGenerativeAI(settings.apiKey, { apiVersion: 'v1' });
            // The year is 2026 - Stable models for this era:
            const models = ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash"];
            let aiResponse = null;
            let lastError = null;

            for (const modelName of models) {
                try {
                    addLog(`🤖 AI Thinking (${modelName})...`);
                    const model = genAI.getGenerativeModel({
                        model: modelName,
                        systemInstruction: `You are the Customer Success Manager for "${settings.businessName}". \nContext: ${settings.context}`
                    });

                    const result = await model.generateContent(text);
                    aiResponse = result.response.text();
                    if (aiResponse) {
                        addLog(`✅ AI Success with ${modelName}`);
                        break;
                    }
                } catch (e) {
                    lastError = e.message;
                    addLog(`❌ AI error (${modelName}): ${e.message}`);
                    if (e.message.includes("API_KEY_INVALID")) break;
                }
            }

            if (aiResponse) {
                await sock.sendMessage(remoteJid, { text: aiResponse.trim() });
                addLog(`✅ Sent AI Reply`);
            } else {
                addLog(`❌ AI Failed. sending fallback.`);
                const fallback = "I'm having a quick technical glitch with my AI brain. Let me get back to you shortly!";
                await sock.sendMessage(remoteJid, { text: fallback });
            }
        }
    });
}

// Start Server
server.listen(PORT, '0.0.0.0', () => {
    addLog(`Server running on port ${PORT}`);
    startWhatsApp();
}).on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} in use. exiting.`);
        process.exit(1);
    }
});

io.on('connection', (socket) => {
    socket.emit('status', connectionStatus);
    if (currentQR) socket.emit('qr', currentQR);
});
