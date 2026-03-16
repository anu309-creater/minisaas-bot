require('dotenv').config();
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');

// Create MySQL connection pool
const pool = mysql.createPool({
    host:     process.env.DB_HOST     || 'localhost',
    user:     process.env.DB_USER     || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME     || 'minisaas',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Initialize tables on startup
async function initDb() {
    const conn = await pool.getConnection();
    try {
        await conn.query(`
            CREATE TABLE IF NOT EXISTS users (
                id            INT AUTO_INCREMENT PRIMARY KEY,
                email         VARCHAR(255) NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                businessName  VARCHAR(255) DEFAULT NULL,
                agentName     VARCHAR(255) DEFAULT NULL,
                apiKey        TEXT DEFAULT NULL,
                context       TEXT DEFAULT NULL,
                plan_id          VARCHAR(50) DEFAULT 'free',
                is_paid          TINYINT(1) DEFAULT 0,
                portfolio_config TEXT DEFAULT NULL,
                created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        await conn.query(`
            CREATE TABLE IF NOT EXISTS quotas (
                user_id       INT NOT NULL PRIMARY KEY,
                chats_used    INT DEFAULT 0,
                message_limit INT DEFAULT 10,
                reset_date    DATETIME DEFAULT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        console.log('MySQL connected & tables ready.');
    } finally {
        conn.release();
    }
}

initDb().catch(err => console.error('DB Init Error:', err.message));

// ── Helper Functions ─────────────────────────────────────

const dbHelper = {

    createUser: async (email, password, businessName) => {
        const passwordHash = await bcrypt.hash(password, 10);
        const [result] = await pool.query(
            `INSERT INTO users (email, password_hash, businessName, context) VALUES (?, ?, ?, ?)`,
            [email, passwordHash, businessName, 'I am a helpful assistant.']
        );
        const userId = result.insertId;
        await pool.query(
            `INSERT INTO quotas (user_id, chats_used) VALUES (?, 0)`,
            [userId]
        );
        return userId;
    },

    getUserByEmail: async (email) => {
        const [rows] = await pool.query(`SELECT * FROM users WHERE email = ?`, [email]);
        return rows[0] || null;
    },

    getUserById: async (id) => {
        const [rows] = await pool.query(`SELECT * FROM users WHERE id = ?`, [id]);
        return rows[0] || null;
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
        await pool.query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, values);
    },

    incrementQuota: async (userId) => {
        await pool.query(
            `UPDATE quotas SET chats_used = chats_used + 1 WHERE user_id = ?`,
            [userId]
        );
    },

    getQuota: async (userId) => {
        const [rows] = await pool.query(
            `SELECT chats_used, message_limit, reset_date FROM quotas WHERE user_id = ?`,
            [userId]
        );
        const row = rows[0];
        if (!row) return { chats_used: 0, message_limit: 10 };

        // Auto-reset if reset_date has passed
        if (row.reset_date && new Date(row.reset_date) < new Date()) {
            await pool.query(
                `UPDATE quotas SET chats_used = 0, reset_date = NULL WHERE user_id = ?`,
                [userId]
            );
            return { chats_used: 0, message_limit: row.message_limit };
        }

        return { chats_used: row.chats_used, message_limit: row.message_limit };
    },

    upgradeUserPlan: async (userId, planId, messageLimit) => {
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            await conn.query(
                `UPDATE users SET plan_id = ?, is_paid = 1 WHERE id = ?`,
                [planId, userId]
            );
            await conn.query(
                `UPDATE quotas SET message_limit = ? WHERE user_id = ?`,
                [messageLimit, userId]
            );
            await conn.commit();
            return true;
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }
    },

    updatePortfolio: async (userId, config) => {
        await pool.query(
            `UPDATE users SET portfolio_config = ? WHERE id = ?`,
            [JSON.stringify(config), userId]
        );
    },

    getPortfolio: async (userId) => {
        const [rows] = await pool.query(
            `SELECT portfolio_config FROM users WHERE id = ?`,
            [userId]
        );
        return rows[0]?.portfolio_config ? JSON.parse(rows[0].portfolio_config) : { images: [], keyword: 'portfolio' };
    }
};

module.exports = dbHelper;
