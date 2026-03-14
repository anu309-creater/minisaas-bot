require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const pino = require('pino');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const dbHelper = require('./database');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_minisaas_key_2026';

// CRASH DETECTION (DEBUG)
process.on('uncaughtException', (err) => {
    console.error('!!!!!!!! UNCAUGHT EXCEPTION !!!!!!!!');
    console.error(err.stack);
    fs.appendFileSync('crash.log', `${new Date().toISOString()} - ${err.stack}\n`);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('!!!!!!!! UNHANDLED REJECTION !!!!!!!!');
    console.error(reason);
    fs.appendFileSync('crash.log', `${new Date().toISOString()} - REJECTION: ${reason}\n`);
});

// --- STATE MANAGEMENT ---
let activeSockets = {}; // { userId: sock }
let startingSockets = {}; // { userId: promise }
let currentQRs = {}; // { userId: "qr_string" }
let connectionStatuses = {}; // { userId: "Status" }

// --- LOGGING ---
const MAX_LOGS = 100;
const logsBuffers = {}; // { userId: [logs] }

function addLog(userId, message) {
    if (!userId) return;
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${message}`;
    
    if (!logsBuffers[userId]) logsBuffers[userId] = [];
    logsBuffers[userId].unshift(logEntry);
    if (logsBuffers[userId].length > MAX_LOGS) logsBuffers[userId].pop();
    
    io.to(`user_${userId}`).emit('log', message);
    console.log(`[User ${userId}] ` + logEntry);
}

// --- MIDDLEWARE ---
app.use(express.static('public'));
app.use(express.static(__dirname)); // Fallback if files are uploaded to root
app.use(express.json());

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Forbidden' });
        req.user = user;
        next();
    });
}

// --- AUTH ROUTES ---
app.post('/api/auth/register', async (req, res) => {
    const { email, password, businessName } = req.body;
    if (!email || !password || !businessName) return res.status(400).json({ error: 'All fields required' });
    
    try {
        const userId = await dbHelper.createUser(email, password, businessName);
        const token = jwt.sign({ id: userId, email }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ success: true, token, userId });
    } catch (e) {
        if (e.message.includes('UNIQUE constraint')) {
            return res.status(400).json({ error: 'Email already exists' });
        }
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    try {
        const user = await dbHelper.getUserByEmail(email);
        if (!user) return res.status(400).json({ error: 'Invalid credentials' });

        const match = await bcrypt.compare(password, user.password_hash);
        if (!match) return res.status(400).json({ error: 'Invalid credentials' });

        const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ success: true, token, userId: user.id });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/auth/me', authenticateToken, async (req, res) => {
    try {
        const user = await dbHelper.getUserById(req.user.id);
        const quota = await dbHelper.getQuota(req.user.id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        
        user.password_hash = undefined; // Don't send password hash
        res.json({ user, quota });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- PROTECTED API ROUTES ---
app.get('/api/status', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    const user = await dbHelper.getUserById(userId);
    let sock = activeSockets[userId];

    // Auto-resume session if credentials exist but socket isn't running
    const authFolder = path.join(__dirname, `auth_info_v4/user_${userId}`);
    if (!sock && fs.existsSync(authFolder)) {
        addLog(userId, `Auto-resuming saved session...`);
        startWhatsApp(userId).catch(e => console.error(e));
    }
    
    res.json({
        status: connectionStatuses[userId] || "Not Initialized",
        businessName: user ? user.businessName : "Unknown",
        botReady: !!(sock && sock.authState && sock.authState.creds && sock.authState.creds.me)
    });
});

app.get('/api/logs', authenticateToken, (req, res) => {
    res.json({ logs: logsBuffers[req.user.id] || [] });
});

app.post('/api/settings', authenticateToken, async (req, res) => {
    try {
        await dbHelper.updateUserSettings(req.user.id, req.body);
        addLog(req.user.id, `Settings Updated`);
        const updatedUser = await dbHelper.getUserById(req.user.id);
        updatedUser.password_hash = undefined;
        res.json({ message: 'Settings Saved Successfully', settings: updatedUser });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/pair', authenticateToken, async (req, res) => {
    const { phone } = req.body;
    const userId = req.user.id;
    
    addLog(userId, `Pairing request for ${phone}`);
    
    // Auto-start if not running
    if (!activeSockets[userId]) {
        await startWhatsApp(userId);
        return res.status(503).json({ error: 'System Initializing... Request again in 5s.' });
    }
    
    const sock = activeSockets[userId];
    try {
        if (!sock.authState.creds.me) {
            const code = await sock.requestPairingCode(phone);
            addLog(userId, `Pairing Code Generated: ${code}`);
            res.json({ code });
        } else {
            res.json({ message: 'Already Connected' });
        }
    } catch (e) {
        addLog(userId, `Pairing Error: ${e.message}`);
        res.status(500).json({ error: "Failed to generate pairing code: " + e.message });
    }
});

app.post('/reset-session', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    try {
        addLog(userId, "Clearing session...");
        let sock = activeSockets[userId];
        if (sock) {
            sock.ev.removeAllListeners('connection.update');
            sock.end(undefined);
            delete activeSockets[userId];
            connectionStatuses[userId] = "Disconnected (Reset)";
        }
        
        const folderPath = `auth_info_v4/user_${userId}`;
        if (fs.existsSync(folderPath)) {
            fs.rmSync(folderPath, { recursive: true, force: true });
        }
        
        // Re-init socket after clear
        setTimeout(() => startWhatsApp(userId), 2000);
        res.json({ message: "Session Reset Started" });
    } catch (e) {
        addLog(userId, `Reset Error: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

// Admin / Public endpoints
app.post('/api/contact', async (req, res) => {
    const { name, email, message } = req.body;
    if (!name || !email || !message) return res.status(400).json({ error: 'All fields are required' });

    try {
        const lead = { id: Date.now(), name, email, message, timestamp: new Date().toISOString() };
        let leads = [];
        if (fs.existsSync('leads.json')) leads = JSON.parse(fs.readFileSync('leads.json'));
        leads.push(lead);
        fs.writeFileSync('leads.json', JSON.stringify(leads, null, 2));

        res.json({ success: true, message: 'Message received!' });
    } catch (e) {
        res.status(500).json({ error: 'Failed to save message' });
    }
});

// --- STRIPE PAYMENTS ---


// Pages
app.post('/api/manual-upgrade', authenticateToken, async (req, res) => {
    const { plan } = req.body;
    const userId = req.user.id;

    let messageLimit = 10;
    if (plan === 'starter') messageLimit = 100;
    else if (plan === 'pro') messageLimit = 1000;
    else if (plan === 'enterprise') messageLimit = -1;
    else return res.status(400).json({ error: 'Invalid plan' });

    try {
        await dbHelper.upgradeUserPlan(userId, plan, messageLimit);
        addLog(userId, `Manual Upgrade Successful: ${plan.toUpperCase()} Plan.`);
        res.json({ success: true, message: `Successfully upgraded to ${plan.toUpperCase()}!` });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Pages
app.get('/dashboard', (req, res) => {
    const pPath = path.join(__dirname, 'public', 'dashboard.html');
    if (fs.existsSync(pPath)) return res.sendFile(pPath);
    res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/contact', (req, res) => {
    const pPath = path.join(__dirname, 'public', 'contact.html');
    if (fs.existsSync(pPath)) return res.sendFile(pPath);
    res.sendFile(path.join(__dirname, 'contact.html'));
});

app.get('/login', (req, res) => {
    const pPath = path.join(__dirname, 'public', 'login.html');
    if (fs.existsSync(pPath)) return res.sendFile(pPath);
    res.sendFile(path.join(__dirname, 'login.html'));
});

app.get('/signup', (req, res) => {
    const pPath = path.join(__dirname, 'public', 'signup.html');
    if (fs.existsSync(pPath)) return res.sendFile(pPath);
    res.sendFile(path.join(__dirname, 'signup.html'));
});

// --- WHATSAPP CORE ---
async function startWhatsApp(userId) {
    if (activeSockets[userId]) return activeSockets[userId];
    if (startingSockets[userId]) return startingSockets[userId];

    startingSockets[userId] = (async () => {
        try {
            const folderPath = `auth_info_v4/user_${userId}`;
            if (!fs.existsSync('auth_info_v4')) fs.mkdirSync('auth_info_v4');
            
            const { state, saveCreds } = await useMultiFileAuthState(folderPath);
            
            // Use a fallback version if fetching fails to avoid hangs
            let version = [2, 3000, 1015901307]; 
            try {
                const latest = await fetchLatestBaileysVersion();
                version = latest.version;
            } catch (e) {
                console.error("Failed to fetch latest WA version, using fallback", e.message);
            }
            
            addLog(userId, `WA Version: ${version.join('.')}`);

            const sock = makeWASocket({
                version,
                auth: state,
                printQRInTerminal: false,
                logger: pino({ level: 'silent' }),
                browser: Browsers.ubuntu('Chrome'),
                connectTimeoutMs: 60000,
                defaultQueryTimeoutMs: 60000,
                keepAliveIntervalMs: 30000,
                generateHighQualityLinkPreview: true,
            });

            activeSockets[userId] = sock;
            connectionStatuses[userId] = "Initializing...";

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            currentQRs[userId] = qr;
            io.to(`user_${userId}`).emit('qr', qr);
            addLog(userId, "QR Code generated");
        }

        if (connection === 'close') {
            const error = lastDisconnect?.error;
            const statusCode = error?.output?.statusCode;
            const reason = error?.message || 'Unknown reason';
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            addLog(userId, `Connection closed: ${reason}. Reconnecting: ${shouldReconnect}`);

            connectionStatuses[userId] = `Disconnected: ${reason}`;
            io.to(`user_${userId}`).emit('status', connectionStatuses[userId]);
            delete activeSockets[userId];

            if (shouldReconnect) {
                setTimeout(() => startWhatsApp(userId), 5000);
            } else {
                addLog(userId, "Logged out. Clearing auth folder...");
                if (fs.existsSync(folderPath)) fs.rmSync(folderPath, { recursive: true, force: true });
                // We don't auto-restart on logout, user must manual pair again.
            }
        } else if (connection === 'open') {
            connectionStatuses[userId] = 'Connected ✅';
            io.to(`user_${userId}`).emit('status', connectionStatuses[userId]);
            io.to(`user_${userId}`).emit('qr', '');
            currentQRs[userId] = "";
            addLog(userId, "WhatsApp Connection Opened Successfully");
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        // Fetch latest user data for settings and quota
        const user = await dbHelper.getUserById(userId);
        if (!user) return; // User deleted?

        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue;

            const remoteJid = msg.key.remoteJid;
            if (remoteJid.endsWith('@g.us') || remoteJid.includes('status@broadcast')) continue; // Skip groups & status
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
            if (!text) continue;

            addLog(userId, `Rx: ${text.substring(0, 20)}...`);
            
            // Check SaaS Quota
            let quota = await dbHelper.getQuota(userId);
            if (quota.message_limit !== -1 && quota.chats_used >= quota.message_limit) {
                // User reached limit
                addLog(userId, `⚠ Quota exceeded (${quota.chats_used}/${quota.message_limit}). Sending limit notice.`);
                const notice = "Powered by MiniSaaS: The business owner has reached their automated response limit. Please wait for a human to reply.";
                await sock.sendMessage(remoteJid, { text: notice });
                return; // Stop processing further for this batch
            }

            if (!process.env.OPENROUTER_API_KEY) {
                addLog(userId, '⚠ No global OPENROUTER_API_KEY configured. Skipping AI.');
                continue;
            }

            // AI Logic via OpenRouter with verified Fallback Models
            let aiResponse = null;
            const fallbackModels = [
                "google/gemini-2.0-flash-lite:free",
                "meta-llama/llama-3.3-70b-instruct:free",
                "meta-llama/llama-3.2-3b-instruct:free",
                "mistralai/mistral-7b-instruct:free",
                "openrouter/free"
            ];
            
            for (const modelId of fallbackModels) {
                if (aiResponse) break;
                
                try {
                    addLog(userId, `🤖 Trying AI (${modelId.split('/')[1]})...`);
                    
                    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                        method: "POST",
                        headers: {
                            "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
                            "Content-Type": "application/json",
                            "HTTP-Referer": "http://localhost:3000",
                            "X-Title": "MiniSaaS Assistant"
                        },
                        body: JSON.stringify({
                            "model": modelId,
                            "messages": [
                                {
                                    "role": "system",
                                    "content": `You are a Senior Business Consultant for "${user.businessName}".

YOUR STYLE:
- Professional, concise, and helpful.
- For services (Web Dev, SEO, etc.), give a brief overview and benefits.
- Use simple bullet points (-) for readability.
- Max 2-3 short paragraphs. Avoid long essays.

STRICT GUIDELINES:
1. Stay strictly on business services mentioned in the CONTEXT.
2. If asked about something else, say: "I am here to help you with our services at ${user.businessName}. Currently, I can guide you on [mention 2 services from context]."
3. NEVER mention being an AI/bot. Act as a human consultant named ${user.agentName || "the Support Lead"}.

BUSINESS CONTEXT:
${user.context || "We provide premium tech and digital marketing solutions."}

FORMATTING for WhatsApp:
- Plain text only. No Markdown symbols (*, #, _).
- Use clear spacing between points.`
                                },
                                {
                                    "role": "user",
                                    "content": text
                                }
                            ]
                        })
                    });

                    const data = await response.json();
                    if (data.choices && data.choices.length > 0) {
                        aiResponse = data.choices[0].message.content;
                        addLog(userId, `✅ AI Active (${modelId.split('/')[1]})`);
                    } else {
                        const errorMsg = data.error?.message || "Model Busy";
                        addLog(userId, `⚠ ${modelId.split('/')[1]} busy...`);
                    }
                } catch (e) {
                    addLog(userId, `❌ Error: ${modelId.split('/')[1]}`);
                }
            }

            if (aiResponse) {
                await sock.sendMessage(remoteJid, { text: aiResponse.trim() });
                addLog(userId, `✅ Sent AI Reply`);
                
                // Increment quota on successful send
                await dbHelper.incrementQuota(userId);
            } else {
                addLog(userId, `❌ AI Failed. sending fallback.`);
                const fallback = "I'm having a quick technical glitch with my AI brain. Let me get back to you shortly!";
                await sock.sendMessage(remoteJid, { text: fallback });
            }
        }
    });
    
    return sock;
} catch (err) {
    addLog(userId, `Fatal Start Error: ${err.message}`);
    throw err;
} finally {
    delete startingSockets[userId];
}
})();

return startingSockets[userId];
}

// Start Server
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
    // Optional: We could start DB users' sockets automatically on boot,
    // but for large scale SaaS, we'd wait for user login/request.
    // Let's just initialize them lazily via /api/status or /pair.
}).on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} in use. exiting.`);
        process.exit(1);
    }
});

io.on('connection', (socket) => {
    const token = socket.handshake.query.token;
    if (token) {
        jwt.verify(token, JWT_SECRET, (err, user) => {
            if (!err) {
                socket.join(`user_${user.id}`);
                if (connectionStatuses[user.id]) socket.emit('status', connectionStatuses[user.id]);
                if (currentQRs[user.id]) socket.emit('qr', currentQRs[user.id]);
                
                // Auto-start WA if they connect to dashboard
                startWhatsApp(user.id).catch(e => console.error("Auto-start WA error:", e));
            }
        });
    }
});
