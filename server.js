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

app.post('/pair', async (req, res) => {
    const { phone } = req.body;
    if (!sock) return res.status(503).json({ error: 'System Initializing...' });

    try {
        if (!sock.authState.creds.me) {
            const code = await sock.requestPairingCode(phone);
            io.emit('log', `Pairing Code: ${code}`);
            res.json({ code });
        } else {
            res.json({ message: 'Already Connected' });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
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
        browser: Browsers.macOS('Desktop'),
        connectTimeoutMs: 60000,
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) io.emit('qr', qr);

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
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // AI Logic with Debug Logs
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

            try {
                io.emit('log', '🤖 AI Thinking...');
                const genAI = new GoogleGenerativeAI(settings.apiKey);
                const model = genAI.getGenerativeModel({ model: "gemini-pro" });

                const prompt = `Act as a support agent for ${settings.businessName}. user: ${text}`;
                const result = await model.generateContent(prompt);
                const response = result.response.text();

                await sock.sendMessage(remoteJid, { text: response });
                io.emit('log', `✅ Sent: ${response.substring(0, 10)}...`);

            } catch (e) {
                console.error('AI Error:', e.message);
                io.emit('log', `❌ AI Error: ${e.message}`);
            }
        }
    });
}

// --- INIT ---
io.on('connection', (socket) => {
    socket.emit('log', 'Client Connected');
    if (fs.existsSync('settings.json')) {
        try { settings = JSON.parse(fs.readFileSync('settings.json')); } catch (e) { }
    }
});

server.listen(PORT, () => {
    console.log(`Server v4.3 running on ${PORT}`);
    // Wipe on restart for fresh pairing
    if (fs.existsSync('auth_info_v4')) {
        try { fs.rmSync('auth_info_v4', { recursive: true, force: true }); } catch (e) { }
    }
    startWhatsApp();
});
