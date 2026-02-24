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
        el.btnTabQr.style.background = 'linear-gradient(45deg, var(--primary), var(--secondary))';
        el.btnTabQr.style.color = 'white';
        el.btnTabPair.style.background = 'rgba(255, 255, 255, 0.05)';
        el.btnTabPair.style.color = 'var(--text-muted)';
    } else {
        el.tabQr.style.display = 'none';
        el.tabPair.style.display = 'block';
        el.btnTabQr.style.background = 'rgba(255, 255, 255, 0.05)';
        el.btnTabQr.style.color = 'var(--text-muted)';
        el.btnTabPair.style.background = 'linear-gradient(45deg, var(--primary), var(--secondary))';
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
    el.status.innerHTML = `<i class="fas fa-circle-notch fa-spin"></i> ${status}`;
    log(`Status: ${status}`);

    if (status.includes('Connected') || status === 'Connected ✅') {
        el.status.innerHTML = `<i class="fas fa-check-circle" style="color:#10b981"></i> ${status}`;
        el.qrContainer.innerHTML = '<div style="font-size:3rem; margin-bottom:1rem;">✅</div><h3>Connected!</h3><p>Bot is active and thinking.</p>';
        el.connectionView.innerHTML = `
            <div style="text-align:center; padding: 2rem;">
                <div style="font-size:4rem; margin-bottom:1.5rem;">🎉</div>
                <h3 style="margin-bottom:1rem;">Successfully Connected!</h3>
                <p style="color:var(--text-muted); margin-bottom:2rem;">Your AI Business Assistant is now live and waiting for messages.</p>
                <button onclick='resetSession()' class="btn-secondary" style="width: auto; padding: 0.8rem 2rem;">Logout / Disconnect</button>
            </div>
        `;
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
        el.status.innerHTML = '<i class="fas fa-qrcode"></i> Scan QR Code quickly!';
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

    const originalText = el.btnSave.innerText;
    el.btnSave.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
    el.btnSave.disabled = true;

    try {
        const res = await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ businessName, apiKey, context })
        });

        const data = await res.json();

        // Success animation
        el.btnSave.innerHTML = '<i class="fas fa-check"></i> Saved!';

        setTimeout(() => {
            // Move to connection view
            el.settingsView.style.display = 'none';
            el.connectionView.style.display = 'block';
            switchTab('qr'); // Default to QR
        }, 800);

    } catch (e) {
        alert("Error saving: " + e.message);
        el.btnSave.innerHTML = originalText;
        el.btnSave.disabled = false;
    }
});

// Get Pairing Code
el.btnGetCode.addEventListener('click', async () => {
    const phone = el.phone.value;
    if (!phone) return alert("Enter Phone Number");

    const originalText = el.btnGetCode.innerText;
    el.btnGetCode.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Generating...';
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

    try {
        log("Sending reset request...");
        await fetch('/reset-session', { method: 'POST' });
        alert("Session reset requested. The bot will restart and the page will reload.");
        location.reload();
    } catch (e) {
        alert("Error: " + e.message);
    }
}
