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
    console.log(`Server v3.0 running on port ${PORT}`);

    // NUCLEAR RESET ON START (As requested by user "sara del karo")
    // We strictly delete the session folder on every cold boot of this specific version
    // to ensure the user gets a fresh QR every time they deploy/restart.
    if (fs.existsSync('auth_info_live')) {
        console.log("Wiping old session (Fresh Start)...");
        fs.rmSync('auth_info_live', { recursive: true, force: true });
    }

    startWhatsApp();
});
