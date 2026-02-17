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

app.use(express.static('public'));
app.use(express.json());

let settings = {
    businessName: "My Business",
    apiKey: "",
    context: "I am a helpful assistant."
};

// Load settings if exists
if (fs.existsSync('settings.json')) {
    try {
        const data = fs.readFileSync('settings.json', 'utf8');
        if (data.trim()) {
            settings = JSON.parse(data);
        }
    } catch (err) {
        console.error('Error reading settings.json:', err);
    }
}

let sock;

// API to save settings
app.post('/settings', (req, res) => {
    const { businessName, apiKey, context } = req.body;
    settings = { businessName, apiKey, context };
    fs.writeFileSync('settings.json', JSON.stringify(settings));
    console.log('Settings updated:', settings.businessName);
    res.json({ message: 'Settings saved! AI is ready.' });
});

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('QR Code generated');
            qrcode.toDataURL(qr, (err, url) => {
                io.emit('qr', url);
            });
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed. Reconnecting:', shouldReconnect);
            io.emit('status', 'Disconnected');
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('Opened connection to WhatsApp!');
            io.emit('status', 'Connected');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            console.log('Raw message:', JSON.stringify(msg.key)); // Debug log

            // Ignore status updates
            if (msg.key.remoteJid === 'status@broadcast') return;

            // Allow self-messages for testing (Commented out the check)
            // if (msg.key.fromMe) return; 

            // Only reply to private chats (optional, remove this line if you want group support)
            if (!msg.key.remoteJid.endsWith('@s.whatsapp.net')) return;

            if (msg.message) {
                const userMsg = msg.message.conversation || msg.message.extendedTextMessage?.text;
                if (!userMsg) continue;

                const sender = msg.key.remoteJid;
                console.log(`Msg from ${sender}: ${userMsg}`);

                if (settings.apiKey) {
                    try {
                        const reply = await getAIReply(userMsg);
                        await sock.sendMessage(sender, { text: reply });
                    } catch (err) {
                        console.error('AI Error:', err);
                    }
                } else {
                    console.log('No API Key set. Skipping AI reply.');
                }
            }
        }
    });
}

async function getAIReply(userMsg) {
    const genAI = new GoogleGenerativeAI(settings.apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-pro" });

    const prompt = `
    You are a customer support agent for a business named "${settings.businessName}".
    
    Business Context:
    ${settings.context}

    User Message: "${userMsg}"
    
    Reply politely and helpfully based on the context. Keep it concise.
    `;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    return response.text();
}

io.on('connection', (socket) => {
    console.log('Client connected to dashboard');
    if (sock && sock.user) {
        socket.emit('status', 'Connected');
    } else {
        socket.emit('status', 'Disconnected/Waiting');
    }
});

// Start
connectToWhatsApp();

server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
