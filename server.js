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
io.on('connection', (socket) => {
    socket.emit('log', 'Client Connected');
    if (fs.existsSync('settings.json')) {
        try { settings = JSON.parse(fs.readFileSync('settings.json')); } catch (e) { }
    }
});

server.listen(PORT, () => {
    console.log(`Server v4.0 running on ${PORT}`);
    // Wipe on restart for fresh pairing
    if (fs.existsSync('auth_info_v4')) fs.rmSync('auth_info_v4', { recursive: true, force: true });
    startWhatsApp();
});
