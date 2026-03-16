require('dotenv').config();
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const bcrypt = require('bcrypt');
const path = require('path');

const dbPath = path.join(__dirname, 'database.sqlite');

let db;

// Initialize database
async function initDb() {
    db = await open({
        filename: dbPath,
        driver: sqlite3.Database
    });

    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            email         TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            businessName  TEXT DEFAULT NULL,
            agentName     TEXT DEFAULT NULL,
            apiKey        TEXT DEFAULT NULL,
            context       TEXT DEFAULT NULL,
            plan_id       TEXT DEFAULT 'free',
            is_paid       INTEGER DEFAULT 0,
            portfolio_config TEXT DEFAULT NULL,
            created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS quotas (
            user_id       INTEGER NOT NULL PRIMARY KEY,
            chats_used    INTEGER DEFAULT 0,
            message_limit INTEGER DEFAULT 10,
            reset_date    DATETIME DEFAULT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
    `);

    console.log('SQLite connected & tables ready.');
}

initDb().catch(err => console.error('DB Init Error:', err.message));

// ── Helper Functions ─────────────────────────────────────

const dbHelper = {

    createUser: async (email, password, businessName) => {
        const passwordHash = await bcrypt.hash(password, 10);
        const result = await db.run(
            `INSERT INTO users (email, password_hash, businessName, context) VALUES (?, ?, ?, ?)`,
            [email, passwordHash, businessName, 'I am a helpful assistant.']
        );
        const userId = result.lastID;
        await db.run(
            `INSERT INTO quotas (user_id, chats_used) VALUES (?, 0)`,
            [userId]
        );
        return userId;
    },

    getUserByEmail: async (email) => {
        return await db.get(`SELECT * FROM users WHERE email = ?`, [email]);
    },

    getUserById: async (id) => {
        return await db.get(`SELECT * FROM users WHERE id = ?`, [id]);
    },

    updateUserSettings: async (id, settings) => {
        const allowed = ['businessName', 'agentName', 'apiKey', 'context'];
        const updates = [];
        const values  = [];

        allowed.forEach(field => {
            if (settings[field] !== undefined) {
                updates.push(`${field} = ?`);
                values.push(settings[field]);
            }
        });

        if (updates.length === 0) return;

        values.push(id);
        await db.run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, values);
    },

    incrementQuota: async (userId) => {
        await db.run(
            `UPDATE quotas SET chats_used = chats_used + 1 WHERE user_id = ?`,
            [userId]
        );
    },

    getQuota: async (userId) => {
        const row = await db.get(
            `SELECT chats_used, message_limit, reset_date FROM quotas WHERE user_id = ?`,
            [userId]
        );
        if (!row) return { chats_used: 0, message_limit: 10 };

        // Auto-reset if reset_date has passed
        if (row.reset_date && new Date(row.reset_date) < new Date()) {
            await db.run(
                `UPDATE quotas SET chats_used = 0, reset_date = NULL WHERE user_id = ?`,
                [userId]
            );
            return { chats_used: 0, message_limit: row.message_limit };
        }

        return { chats_used: row.chats_used, message_limit: row.message_limit };
    },

    upgradeUserPlan: async (userId, planId, messageLimit) => {
        try {
            await db.run('BEGIN TRANSACTION');
            await db.run(
                `UPDATE users SET plan_id = ?, is_paid = 1 WHERE id = ?`,
                [planId, userId]
            );
            await db.run(
                `UPDATE quotas SET message_limit = ? WHERE user_id = ?`,
                [messageLimit, userId]
            );
            await db.run('COMMIT');
            return true;
        } catch (err) {
            await db.run('ROLLBACK');
            throw err;
        }
    },

    updatePortfolio: async (userId, config) => {
        await db.run(
            `UPDATE users SET portfolio_config = ? WHERE id = ?`,
            [JSON.stringify(config), userId]
        );
    },

    getPortfolio: async (userId) => {
        const row = await db.get(
            `SELECT portfolio_config FROM users WHERE id = ?`,
            [userId]
        );
        return row?.portfolio_config ? JSON.parse(row.portfolio_config) : { images: [], keyword: 'portfolio' };
    }
};

module.exports = dbHelper;
