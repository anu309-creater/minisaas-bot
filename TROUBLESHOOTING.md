# 🛠️ CodeXcel Troubleshooting Guide

If you are facing issues where the website is not loading or the WhatsApp bot is not connecting, follow these steps:

### 1. "Website Not Loading" or "Connection Refused"
*   **Port Conflict**: This usually happens if another app is already using port 3000.
    *   **Fix (Windows)**: Run `FORCE_RESTART.bat` from the folder.
    *   **Fix (Linux)**: Run `sh restart_server.sh`.
*   **Firewall**: Ensure your server allows traffic on port 3000. You may need to open port 3000 in your hosting panel (e.g., Azure, AWS, DigitalOcean).

### 2. "QR Code Error" or "Disconnected"
*   **Timeout**: Scan the QR code quickly (within 1 minute). 
*   **Session Reset**: If you can't see the QR, click **"Reset Session / Logout"** on the Dashboard. This clears all old data and restarts the bot cleanly.

### 3. Dependencies Missing
*   If you just uploaded the files, you MUST run:
    ```bash
    npm install
    ```
    before starting the server with `node server.js`.

### 4. Running 24/7
*   To keep the website live even after closing the terminal, use **PM2**:
    ```bash
    npm install -g pm2
    pm2 start server.js --name codexcel
    ```

**Still Stuck?** Check the logs in the Dashboard or your terminal for specific error messages.
