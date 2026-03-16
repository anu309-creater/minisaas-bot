const fetch = require('node-fetch');

async function checkHealth() {
    try {
        const res = await fetch('http://localhost:3000/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'test@example.com', password: 'test' })
        });
        console.log('Health Check (Auth API):', res.status === 400 ? 'OK (Handled Missing User)' : res.status);
    } catch (e) {
        console.error('Health Check Failed (Is server running?):', e.message);
    }
}

checkHealth();
