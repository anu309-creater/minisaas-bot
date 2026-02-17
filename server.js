const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const qrcode = require('qrcode');
const fs = require('fs');
const pino = require('pino');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// --- 1. LOGGING & DEBUGGING MIDDLEWARE ---
// Override console.log/error to emit events to the frontend
const originalLog = console.log;
console.log = function (...args) {
    originalLog.apply(console, args);
    if (io) {
        const msg = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
        io.emit('log', msg);
    }
};

const originalError = console.error;
console.error = function (...args) {
    originalError.apply(console, args);
    if (io) {
        const msg = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
        io.emit('log', `ERROR: ${msg}`);
    }
};

// Prevent silent crashes
process.on('uncaughtException', (err) => {
    console.error('CRITICAL UNCAUGHT EXCEPTION:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('CRITICAL UNHANDLED REJECTION:', reason);
});

// --- 2. CONFIGURATION & STATE ---
app.use(express.static('public'));
app.use(express.json());

let settings = {
    businessName: "My Business",
    apiKey: "",
    context: "I am a helpful assistant."
};
let lastStatus = "Starting System...";
let lastQR = "";

// Helper to update status
function updateStatus(msg) {
    lastStatus = msg;
    io.emit('status', msg);
    console.log(`STATUS: ${msg}`);
}

// Load settings
if (fs.existsSync('settings.json')) {
    try {
        const data = fs.readFileSync('settings.json', 'utf8');
        if (data.trim()) settings = JSON.parse(data);
    } catch (err) {
        console.error('Error reading settings.json:', err.message);
    }
}

// API Routes
app.post('/settings', (req, res) => {
    const { businessName, apiKey, context } = req.body;
    settings = { businessName, apiKey, context };
    fs.writeFileSync('settings.json', JSON.stringify(settings));
    console.log(`Settings updated for: ${businessName}`);
    res.json({ message: 'Settings saved.' });
});

// --- 3. WHATSAPP CONNECTION LOGIC ---
let sock;

async function startWhatsApp() {
    updateStatus("Performing Factory Reset...");

    // NUCLEAR CLEANUP: Delete ALL auth sessions to force fresh start
    const sessions = ['auth_info', 'auth_session_v2', 'auth_session_v3', 'auth_session_v4', 'auth_session_v5', 'nuclear_session'];
    for (const session of sessions) {
        if (fs.existsSync(session)) {
            try {
                fs.rmSync(session, { recursive: true, force: true });
                console.log(`Deleted corrupted session: ${session}`);
            } catch (e) {
                console.error(`Failed to delete ${session}: ${e.message}`);
            }
        }
    }

    updateStatus("Initializing Fresh Session...");

    // We use a completely new session folder
    const SESSION_DIR = 'nuclear_session';

    let state, saveCreds;
    try {
        ({ state, saveCreds } = await useMultiFileAuthState(SESSION_DIR));
        console.log("New Session Storage Created.");
    } catch (e) {
        console.error("Storage Initialization Error:", e);
        return;
    }

    updateStatus("Connecting to WhatsApp servers...");

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false, // We handle QR manually
        logger: pino({ level: 'info' }), // Basic logging
        browser: ['Business AI', 'Chrome', '1.0.0'], // Custom browser signature
        connectTimeoutMs: 60000,
        syncFullHistory: false
    });

    // Event Listener for Connection Updates
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log(">> QR CODE RECEIVED FROM SERVERS <<");
            lastQR = qr;
            io.emit('qr', qr); // Send raw string to client to render
            updateStatus("QR Code Ready. Scan now!");
            console.log(`Debug QR: ${qr.substring(0, 15)}...`);
        }

        if (connection === 'close') {
            const error = lastDisconnect?.error;
            const statusCode = error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            const reason = error?.output?.payload?.message || error?.message || "Unknown";

            console.error(`Connection Closed: ${reason} (Code: ${statusCode})`);
            updateStatus(`Disconnected: ${reason}`);

            if (shouldReconnect) {
                updateStatus(`Reconnecting in 5 seconds...`);
                setTimeout(startWhatsApp, 5000);
            } else {
                updateStatus("Session Expired. Please restart server or clear cache manually.");
            }

        } else if (connection === 'open') {
            console.log(">> CONNECTION SUCCESSFUL <<");
            updateStatus("Connected & Active ✅");
            io.emit('qr', ""); // Clear QR
        } else if (connection === 'connecting') {
            updateStatus("Negotiating Connection...");
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // Message Handling
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            try {
                if (msg.key.remoteJid === 'status@broadcast') continue;

                const userText = msg.message?.conversation ||
                    msg.message?.extendedTextMessage?.text;

                if (!userText) continue;

                console.log(`Msg from ${msg.key.remoteJid}: ${userText}`);

                // AI Processing
                if (settings.apiKey) {
                    const reply = await getAIReply(userText);
                    await sock.sendMessage(msg.key.remoteJid, { text: reply });
                    console.log(`Sent AI Reply: ${reply}`);
                }
            } catch (e) {
                console.error("Message Handler Error:", e);
            }
        }
    });
}

// --- 4. AI LOGIC ---
async function getAIReply(text) {
    try {
        const genAI = new GoogleGenerativeAI(settings.apiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const result = await model.generateContent(`Act as a support agent for ${settings.businessName}. Context: ${settings.context}. User says: "${text}". Keep it brief.`);
        return result.response.text();
    } catch (e) {
        return "I'm having trouble processing that request right now.";
    }
}

// --- 5. SERVER STARTUP ---
io.on('connection', (socket) => {
    console.log('Client connected.');
    socket.emit('status', lastStatus);
    if (lastQR) socket.emit('qr', lastQR);
});

server.listen(PORT, () => {
    console.log(`Server Online on PORT ${PORT}`);
    startWhatsApp();
});
