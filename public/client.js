const token = localStorage.getItem('token');
if (!token) {
    window.location.href = '/login';
}

const socket = io({ query: { token } });

// Elements
const el = {
    qrContainer: document.getElementById('qr-container'),
    status: document.getElementById('status'),
    logs: document.getElementById('logs'),
    saveStatus: document.getElementById('saveStatus'),
    settingsView: document.getElementById('settings-view'),
    connectionView: document.getElementById('connection-view'),
    businessName: document.getElementById('businessName'),
    agentName: document.getElementById('agentName'),
    context: document.getElementById('context'),
    phone: document.getElementById('phone'),
    pairingCode: document.getElementById('pairing-code'),
    pairInstruction: document.getElementById('pair-instruction'),
    tabQr: document.getElementById('tab-qr'),
    tabPair: document.getElementById('tab-pair'),
    btnTabQr: document.getElementById('btn-tab-qr'),
    btnTabPair: document.getElementById('btn-tab-pair'),
    btnSave: document.getElementById('btn-save-settings'),
    btnGetCode: document.getElementById('btn-get-code'),
    portfolioView: document.getElementById('portfolio-view'),
    navPortfolio: document.getElementById('nav-portfolio-link'),
    portfolioGrid: document.getElementById('portfolio-grid'),
    portfolioFile: document.getElementById('portfolioFile'), // Fixed ID mismatch
    portfolioKeyword: document.getElementById('portfolioKeyword'),
    btnSavePortfolioKeyword: document.getElementById('btn-save-portfolio-keyword'),
    backToSettings: document.getElementById('back-to-settings')
};

// INITIAL LOAD
async function loadUserData() {
    try {
        const res = await fetch('/api/auth/me', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.status === 401 || res.status === 403) {
            console.error("Session expired or invalid. Redirecting...");
            localStorage.removeItem('token');
            window.location.href = '/login';
            return;
        }
        const data = await res.json();
        if (!data.user) throw new Error("User data missing");
        
        // Populate settings
        el.businessName.value = data.user.businessName || '';
        el.agentName.value = data.user.agentName || '';
        el.context.value = data.user.context || '';
        
        // Quota Handling (Safe check)
        if (data.quota) {
            const { chats_used, message_limit } = data.quota;
            const planName = data.user.plan_id ? data.user.plan_id.toUpperCase() : 'FREE';
            
            const badge = document.getElementById('quotaBadge');
            if (message_limit === -1) {
                badge.innerHTML = `${planName} Plan 🌟 (Unlimited)`;
            } else {
                if (chats_used >= message_limit) {
                    badge.innerHTML = `Limit Reached (${chats_used}/${message_limit})`;
                    badge.className = 'badge warning'; // Assuming badge styles exist
                } else {
                    badge.innerHTML = `${planName} Chats: ${chats_used}/${message_limit}`;
                }
            }
        }

        // Check bot connection status
        const statusRes = await fetch('/api/status', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        // DO NOT auto-switch the view. Always let the user see and review their Business Details first.
        // The bot connection will still run in the background.

    } catch(e) {
        console.error("Dashboard Error:", e);
        // If we can't get data, the user is likely not supposed to be here
        localStorage.removeItem('token');
        window.location.href = '/login';
    }
}
loadUserData();

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
        
        // Use a safer update that doesn't wipe the whole view if not needed
        const connectionSuccessHTML = `
            <div style="text-align:center; padding: 2rem;">
                <div style="font-size:4rem; margin-bottom:1.5rem;">🎉</div>
                <h3 style="margin-bottom:1rem;">Successfully Connected!</h3>
                <p style="color:var(--text-muted); margin-bottom:2rem;">Your AI Business Assistant is now live and waiting for messages.</p>
                
                <div style="display: flex; flex-wrap: wrap; justify-content: center; gap: 1rem;">
                    <button onclick='editSettings()' class="btn-primary" style="padding: 0.8rem 2rem;">Edit Business Info</button>
                    <button onclick='resetSession()' class="btn-secondary" style="padding: 0.8rem 2rem;">Logout WhatsApp</button>
                </div>
            </div>
        `;
        if (!el.connectionView.innerHTML.includes('Successfully Connected!')) {
            el.connectionView.innerHTML = connectionSuccessHTML;
        }
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
        if (el.tabPair?.style?.display !== 'block') {
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
    const agentName = el.agentName.value;
    const context = el.context.value;

    if (!businessName) {
        alert('Please fill Business Name');
        return;
    }

    const originalText = el.btnSave.innerText;
    el.btnSave.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
    el.btnSave.disabled = true;

    try {
        const res = await fetch('/api/settings', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ businessName, agentName, context })
        });

        const data = await res.json();

        // Success animation
        el.btnSave.innerHTML = '<i class="fas fa-check"></i> Saved!';

        setTimeout(() => {
            el.settingsView.style.display = 'none';
            el.connectionView.style.display = 'block';
            if (!el.connectionView.innerHTML.includes('Successfully Connected!')) {
                switchTab('qr'); // Default to QR
            }
        }, 800);

    } catch (e) {
        alert("Error saving: " + e.message);
        el.btnSave.innerHTML = originalText;
        el.btnSave.disabled = false;
    }
});

// --- PORTFOLIO LOGIC ---
async function loadPortfolio() {
    try {
        const res = await fetch('/api/portfolio', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        el.portfolioKeyword.value = data.keyword || 'portfolio';
        
        el.portfolioGrid.innerHTML = '';
        if (data.images && data.images.length > 0) {
            data.images.forEach(img => {
                const div = document.createElement('div');
                div.style.position = 'relative';
                div.style.borderRadius = '8px';
                div.style.overflow = 'hidden';
                div.style.border = '1px solid var(--glass-border)';
                div.innerHTML = `
                    <img src="/uploads/${img.filename}" style="width: 100%; height: 100px; object-fit: cover;">
                    <button onclick="deletePortfolioImage('${img.id}')" style="position: absolute; top: 5px; right: 5px; background: #ef4444; color: white; border: none; padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 10px; width: auto; margin: 0;">
                        <i class="fas fa-trash"></i>
                    </button>
                `;
                el.portfolioGrid.appendChild(div);
            });
        } else {
            el.portfolioGrid.innerHTML = '<p style="grid-column: span 2; font-size: 12px; color: var(--text-muted);">No images uploaded yet.</p>';
        }
    } catch (e) {
        console.error("Error loading portfolio:", e);
    }
}

window.deletePortfolioImage = async function(id) {
    if (!confirm("Remove this image?")) return;
    try {
        await fetch(`/api/portfolio/${id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        loadPortfolio();
    } catch (e) {
        alert("Delete failed: " + e.message);
    }
}

el.navPortfolio.addEventListener('click', (e) => {
    e.preventDefault();
    el.settingsView.style.display = 'none';
    el.connectionView.style.display = 'none';
    el.portfolioView.style.display = 'block';
    loadPortfolio();
});

el.backToSettings.addEventListener('click', () => {
    el.portfolioView.style.display = 'none';
    el.settingsView.style.display = 'block';
    el.connectionView.style.display = 'none';
});

document.getElementById('portfolioFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('image', file);

    try {
        const res = await fetch('/api/portfolio/upload', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` },
            body: formData
        });
        const data = await res.json();
        if (data.success) {
            loadPortfolio();
        } else {
            alert(data.error || "Upload failed");
        }
    } catch (e) {
        alert("Upload error: " + e.message);
    }
});

el.btnSavePortfolioKeyword.addEventListener('click', async () => {
    const keyword = el.portfolioKeyword.value;
    try {
        await fetch('/api/portfolio/settings', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ keyword })
        });
        alert("Keyword updated!");
    } catch (e) {
        alert("Update failed: " + e.message);
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
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ phone })
        });
        const data = await res.json();

        if (data.code) {
            el.pairingCode.innerText = data.code;
            el.pairingCode.style.display = 'block';
            el.pairInstruction.style.display = 'block';
            log(`Pairing code generated: ${data.code}`);
        } else {
            alert(data.error || data.message || "Initializing... try scanning QR instead.");
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
    if (!confirm("Are you sure? This will disconnect your WhatsApp.")) return;

    try {
        log("Sending reset request...");
        await fetch('/reset-session', { 
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        alert("Session reset requested!");
        location.reload();
    } catch (e) {
        alert("Error: " + e.message);
    }
}

window.editSettings = function() {
    el.connectionView.style.display = 'none';
    el.settingsView.style.display = 'block';
    el.btnSave.innerHTML = "Save & Return";
}

window.logoutDashboard = function() {
    localStorage.removeItem('token');
    window.location.href = '/login';
}
