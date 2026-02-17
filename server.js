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
