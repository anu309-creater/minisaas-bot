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

// Override console.log to send logs to frontend
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

// Prevent crash on unhandled errors
process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT EXCEPTION:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('UNHANDLED REJECTION:', reason);
});

app.use(express.static('public'));
app.use(express.json());

let settings = {
    businessName: "My Business",
    apiKey: "",
    context: "I am a helpful assistant."
};

// State persistence for dashboard
let lastStatus = "Waiting for Server...";
let lastQR = "";

function updateStatus(msg) {
    lastStatus = msg;
    io.emit('status', msg);
    console.log('Status Update:', msg);
}

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

// Clear auth_info on startup to force fresh session
if (fs.existsSync('auth_info')) {
    try {
        fs.rmSync('auth_info', { recursive: true, force: true });
        console.log('Cleared old auth_info session cache.');
    } catch (err) {
        console.error('Failed to clear auth_info (Permission Error?):', err.message);
    }
}

async function connectToWhatsApp() {
    updateStatus('Initializing Baileys...');

    // Use v3 session to ensure fresh start
    // We added a simple try-catch here to prevent crashes during auth load
    try {
        console.log('Loading Auth Session v3...');
        const { state, saveCreds } = await useMultiFileAuthState('auth_session_v3');
        console.log('Auth Loaded Successfully.');

        updateStatus('Auth Loaded. Creating Socket...');

        sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'info' }),
            browser: ['Ubuntu', 'Chrome', '20.0.04'],
            connectTimeoutMs: 60000,
            syncFullHistory: false
        });
    } catch (err) {
        console.error('CRITICAL ERROR loading auth:', err);
        updateStatus(`Critical Error: ${err.message}`);
        return; // Stop here if auth fails
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('QR Code generated');
            lastQR = qr;
            io.emit('qr', qr);
            updateStatus('QR Generated. Please Scan.');
            // Also send as image data url for fallback
            qrcode.toDataURL(qr, (err, url) => {
                io.emit('qr_url', url);
            });
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            const errorReason = (lastDisconnect.error)?.output?.payload?.message || lastDisconnect.error?.message || "Unknown Error";

            updateStatus(`Disconnected: ${errorReason}`);

            if (shouldReconnect) {
                updateStatus(`Reconnecting in 5s due to: ${errorReason}`);
                setTimeout(connectToWhatsApp, 5000);
            }
        } else if (connection === 'open') {
            updateStatus('Connected ✅');
            lastQR = ""; // Clear QR on connect
            io.emit('qr', "");
        } else if (connection === 'connecting') {
            updateStatus('Connecting to WhatsApp...');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        console.log(`Received Message Event: Type=${type}, Count=${messages.length}`);

        for (const msg of messages) {
            try {
                if (type !== 'notify') continue;
                if (msg.key.remoteJid === 'status@broadcast') return;

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
    const genAI = new GoogleGenerativeAI(settings.apiKey);
    const modelsToTry = ["gemini-1.5-flash", "gemini-1.5-flash-001", "gemini-1.0-pro", "gemini-pro"];

    const prompt = `
    You are a customer support agent for a business named "${settings.businessName}".
    
    Business Context:
    ${settings.context}

    User Message: "${userMsg}"
    
    Reply politely and helpfully based on the context. Keep it concise.
    `;

    for (const modelName of modelsToTry) {
        try {
            console.log(`Trying model: ${modelName}`);
            const model = genAI.getGenerativeModel({ model: modelName });
            const result = await model.generateContent(prompt);
            const response = await result.response;
            return response.text();
        } catch (err) {
            console.warn(`Failed with ${modelName}:`, err.message);
            if (modelName === modelsToTry[modelsToTry.length - 1]) {
                return `⚠️ DEBUG ERROR (All Models Failed): ${err.message}\n\nPlease check your API Key.`;
            }
        }
    }
}

io.on('connection', (socket) => {
    console.log('Client connected to dashboard');
    // Send current state immediately
    socket.emit('status', lastStatus);
    if (lastQR) {
        socket.emit('qr', lastQR);
    }
});

// Start
connectToWhatsApp();

server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
