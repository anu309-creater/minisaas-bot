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
        logger: pino({ level: 'info' }),
        browser: ['WhatsApp AI Bot', 'Chrome', '1.0.0']
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
                // Add a small delay before reconnecting
                setTimeout(connectToWhatsApp, 2000);
            }
        } else if (connection === 'open') {
            console.log('Opened connection to WhatsApp!');
            io.emit('status', 'Connected');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        console.log(`Received Message Event: Type=${type}, Count=${messages.length}`);

        for (const msg of messages) {
            try {
                // Log strictly necessary info to avoid clutter
                // console.log('Raw Message:', JSON.stringify(msg, null, 2));

                if (type !== 'notify') {
                    // console.log('Skipping non-notify message type');
                    continue;
                }

                if (msg.key.remoteJid === 'status@broadcast') return;

                // Extract message text from various possible locations
                const msgContent = msg.message;
                const userMsg = msgContent?.conversation ||
                    msgContent?.extendedTextMessage?.text ||
                    msgContent?.ephemeralMessage?.message?.extendedTextMessage?.text ||
                    msgContent?.ephemeralMessage?.message?.conversation;

                if (!userMsg) {
                    console.log('Skipping: No text content found in message.');
                    continue;
                }

                const sender = msg.key.remoteJid;
                console.log(`Msg from ${sender}: ${userMsg}`);

                if (settings.apiKey) {
                    console.log('Generating AI Reply...');
                    try {
                        const reply = await getAIReply(userMsg);
                        console.log('AI Reply Generated:', reply);

                        await sock.sendMessage(sender, { text: reply });
                        console.log('Reply Sent!');
                    } catch (aiErr) {
                        console.error('AI Processing Error:', aiErr);
                    }
                } else {
                    console.log('No API Key set. Skipping AI reply.');
                }
            } catch (err) {
                console.error('Error in message loop:', err);
            }
        }
    });
}

async function getAIReply(userMsg) {
    try {
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
    } catch (err) {
        console.error('Gemini API Error:', err);
        return "I am currently experiencing technical difficulties. Please try again later.";
    }
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
