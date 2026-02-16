const socket = io();

// Elements
const qrContainer = document.getElementById('qr-container');
const statusEl = document.getElementById('connection-status');
const logsEl = document.getElementById('logs');
const saveStatusEl = document.getElementById('saveStatus');

// Connect
socket.on('connect', () => {
    log('Connected to server');
});

// QR Code
socket.on('qr', (qrImage) => {
    qrContainer.innerHTML = `<img src="${qrImage}" alt="Scan me">`;
    statusEl.innerText = "Scan QR Code quickly!";
});

// Status
socket.on('status', (status) => {
    statusEl.innerText = status;
    log(`Status: ${status}`);
    if (status === 'Connected') {
        qrContainer.innerHTML = '<h3>Connected to WhatsApp! ✅</h3><p>Now message this number from another phone to test the AI.</p>';
    }
});

// Logs
socket.on('log', (message) => {
    log(message);
});

// Save Settings
async function saveSettings() {
    const businessName = document.getElementById('businessName').value;
    const apiKey = document.getElementById('apiKey').value;
    const context = document.getElementById('context').value;

    if (!businessName || !apiKey || !context) {
        alert('Please fill all fields');
        return;
    }

    const res = await fetch('/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ businessName, apiKey, context })
    });

    const data = await res.json();
    saveStatusEl.innerText = data.message;
    setTimeout(() => saveStatusEl.innerText = '', 3000);
}

function log(msg) {
    const p = document.createElement('p');
    p.innerText = `> ${msg}`;
    logsEl.prepend(p);
}
