const socket = io();

// Elements
const el = {
    qrContainer: document.getElementById('qr-container'),
    status: document.getElementById('status'),
    logs: document.getElementById('logs'),
    saveStatus: document.getElementById('saveStatus'),
    settingsView: document.getElementById('settings-view'),
    connectionView: document.getElementById('connection-view'),
    businessName: document.getElementById('businessName'),
    apiKey: document.getElementById('apiKey'),
    context: document.getElementById('context'),
    phone: document.getElementById('phone'),
    pairingCode: document.getElementById('pairing-code'),
    pairInstruction: document.getElementById('pair-instruction'),
    resetMsg: document.getElementById('resetMsg'),
    tabQr: document.getElementById('tab-qr'),
    tabPair: document.getElementById('tab-pair'),
    btnTabQr: document.getElementById('btn-tab-qr'),
    btnTabPair: document.getElementById('btn-tab-pair'),
    btnSave: document.getElementById('btn-save-settings'),
    btnGetCode: document.getElementById('btn-get-code')
};

// --- LOGGING ---
function log(msg) {
    const div = document.createElement('div');
    div.innerText = `> ${msg}`;
    el.logs.prepend(div);
}

// --- TABS ---
function switchTab(mode) {
    if (mode === 'qr') {
        el.tabQr.style.display = 'block';
        el.tabPair.style.display = 'none';
        el.btnTabQr.style.background = '#008069';
        el.btnTabQr.style.color = 'white';
        el.btnTabPair.style.background = '#eee';
        el.btnTabPair.style.color = '#333';
    } else {
        el.tabQr.style.display = 'none';
        el.tabPair.style.display = 'block';
        el.btnTabQr.style.background = '#eee';
        el.btnTabQr.style.color = '#333';
        el.btnTabPair.style.background = '#008069';
        el.btnTabPair.style.color = 'white';
    }
}

el.btnTabQr.addEventListener('click', () => switchTab('qr'));
el.btnTabPair.addEventListener('click', () => switchTab('pair'));

// --- SOCKET EVENTS ---
socket.on('connect', () => {
    log('Connected to server');
});

socket.on('status', (status) => {
    el.status.innerText = status;
    log(`Status: ${status}`);

    if (status.includes('Connected') || status === 'Connected ✅') {
        el.qrContainer.innerHTML = '<h3>✅ Connected!</h3><p>Bot is active.</p>';
        el.connectionView.innerHTML = "<h3>✅ Connected!</h3><p>Bot is active and ready to reply.</p><br><button onclick='resetSession()'>Logout</button>";
    }
});

socket.on('qr', (qrCode) => {
    log('Received QR Code');
    el.qrContainer.innerHTML = ""; // Clear previous

    if (!qrCode) return;

    try {
        new QRCode(el.qrContainer, {
            text: qrCode,
            width: 200,
            height: 200,
            colorDark: "#000000",
            colorLight: "#ffffff",
            correctLevel: QRCode.CorrectLevel.H
        });
        el.status.innerText = "Scan QR Code quickly!";
        if (el.tabPair.style.display !== 'block') {
            switchTab('qr'); // Auto switch if not in pair mode
        }
    } catch (e) {
        log('Error rendering QR: ' + e.message);
        el.qrContainer.innerText = "Error rendering QR Code";
    }
});

socket.on('log', (message) => {
    log(message);
});

// --- ACTIONS ---

// Save Settings
el.btnSave.addEventListener('click', async () => {
    const businessName = el.businessName.value;
    const apiKey = el.apiKey.value;
    const context = el.context.value;

    if (!businessName || !apiKey) {
        alert('Please fill Business Name and API Key');
        return;
    }

    try {
        const res = await fetch('/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ businessName, apiKey, context })
        });

        const data = await res.json();
        el.saveStatus.innerText = data.message;

        // Move to connection view
        el.settingsView.style.display = 'none';
        el.connectionView.style.display = 'block';
        switchTab('qr'); // Default to QR

    } catch (e) {
        alert("Error saving: " + e.message);
    }
});

// Get Pairing Code
el.btnGetCode.addEventListener('click', async () => {
    const phone = el.phone.value;
    if (!phone) return alert("Enter Phone Number");

    const originalText = el.btnGetCode.innerText;
    el.btnGetCode.innerText = "Generating...";
    el.btnGetCode.disabled = true;

    try {
        const res = await fetch('/pair', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone })
        });
        const data = await res.json();

        if (data.code) {
            el.pairingCode.innerText = data.code;
            el.pairingCode.style.display = 'block';
            el.pairInstruction.style.display = 'block';
            log(`Pairing code generated: ${data.code}`);
        } else {
            alert(data.error || data.message);
        }
    } catch (e) {
        alert("Error: " + e.message);
    } finally {
        el.btnGetCode.innerText = originalText;
        el.btnGetCode.disabled = false;
    }
});

// Reset Session
window.resetSession = async function () {
    if (!confirm("Are you sure? This will delete all session data and restart the bot.")) return;

    if (el.resetMsg) el.resetMsg.innerText = "Reseting...";

    // Add endpoint to server.js if not exists, or just use rmSync logic via a trigger?
    // Actually, server.js doesn't have a reset endpoint. I should add one.
    // For now, let's assume the user manually restarts or we add the endpoint.

    // START_TEMPORARY fix: Trigger a reset via a specific payload to settings or a new route?
    // The previous client.js had /reset-session endpoint usage but it wasn't in server.js!
    // I will add the route to server.js in the next step.

    try {
        await fetch('/reset-session', { method: 'POST' });
        alert("Session reset. Page will reload.");
        location.reload();
    } catch (e) {
        alert("Error: " + e.message);
    }
}
