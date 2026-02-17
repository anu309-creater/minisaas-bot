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
        console.log('Cleared auth_info session cache.');
    } catch (err) {
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
