require('dotenv').config();
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const path = require('path');

const dbPath = path.join(__dirname, 'database.sqlite');
const isMySQL = process.env.DB_HOST && process.env.DB_USER && process.env.DB_NAME;

let db;
let pool;

async function initDb() {
    if (isMySQL) {
        console.log('Connecting to MySQL...');
        pool = mysql.createPool({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0
        });
        
        // MySQL uses slightly different syntax for AUTO_INCREMENT
        await pool.execute(`
            CREATE TABLE IF NOT EXISTS users (
                id            INT AUTO_INCREMENT PRIMARY KEY,
                email         VARCHAR(255) NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                businessName  VARCHAR(255) DEFAULT NULL,
                agentName     VARCHAR(255) DEFAULT NULL,
                apiKey        TEXT DEFAULT NULL,
                context       TEXT DEFAULT NULL,
                plan_id       VARCHAR(50) DEFAULT 'free',
                is_paid       TINYINT(1) DEFAULT 0,
                portfolio_config TEXT DEFAULT NULL,
                created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        `);

        await pool.execute(`
            CREATE TABLE IF NOT EXISTS quotas (
                user_id       INT NOT NULL PRIMARY KEY,
                chats_used    INT DEFAULT 0,
                message_limit INT DEFAULT 10,
                reset_date    DATETIME DEFAULT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        `);
        console.log('MySQL connected & tables ready.');
    } else {
        console.log('Connecting to SQLite...');
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
}

const initPromise = initDb().catch(err => {
    console.error('DB Init Error:', err.message);
    process.exit(1);
});

// ── Helper Functions ─────────────────────────────────────

// Wrap MySQL executes to match SQLite syntax roughly
async function runQuery(sql, params) {
    if (isMySQL) {
        // Convert ? to MySQL placeholders (MySQL already uses ?)
        const [result] = await pool.execute(sql, params);
        return { lastID: result.insertId, changes: result.affectedRows };
    } else {
        return await db.run(sql, params);
    }
}

async function getQuery(sql, params) {
    if (isMySQL) {
        const [rows] = await pool.execute(sql, params);
        return rows[0];
    } else {
        return await db.get(sql, params);
    }
}

async function getAllQuery(sql, params) {
    if (isMySQL) {
        const [rows] = await pool.execute(sql, params);
        return rows;
    } else {
        return await db.all(sql, params);
    }
}

const dbHelper = {
    initPromise,
    createUser: async (email, password, businessName) => {
        await initPromise;
        const passwordHash = await bcrypt.hash(password, 12);
        const result = await runQuery(
            `INSERT INTO users (email, password_hash, businessName, context) VALUES (?, ?, ?, ?)`,
            [email, passwordHash, businessName, 'I am a helpful assistant.']
        );
        const userId = result.lastID;
        await runQuery(
            `INSERT INTO quotas (user_id, chats_used) VALUES (?, 0)`,
            [userId]
        );
        return userId;
    },

    getUserByEmail: async (email) => {
        await initPromise;
        return await getQuery(`SELECT * FROM users WHERE email = ?`, [email]);
    },

    getUserById: async (id) => {
        await initPromise;
        return await getQuery(`SELECT * FROM users WHERE id = ?`, [id]);
    },

    updateUserSettings: async (id, settings) => {
        await initPromise;
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
        await runQuery(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, values);
    },

    incrementQuota: async (userId) => {
        await initPromise;
        await runQuery(
            `UPDATE quotas SET chats_used = chats_used + 1 WHERE user_id = ?`,
            [userId]
        );
    },

    getQuota: async (userId) => {
        await initPromise;
        const row = await getQuery(
            `SELECT chats_used, message_limit, reset_date FROM quotas WHERE user_id = ?`,
            [userId]
        );
        if (!row) return { chats_used: 0, message_limit: 10 };

        // Auto-reset if reset_date has passed
        if (row.reset_date && new Date(row.reset_date) < new Date()) {
            await runQuery(
                `UPDATE quotas SET chats_used = 0, reset_date = NULL WHERE user_id = ?`,
                [userId]
            );
            return { chats_used: 0, message_limit: row.message_limit };
        }

        return { chats_used: row.chats_used, message_limit: row.message_limit };
    },

    upgradeUserPlan: async (userId, planId, messageLimit) => {
        await initPromise;
        if (isMySQL) {
            const conn = await pool.getConnection();
            try {
                await conn.beginTransaction();
                await conn.execute(`UPDATE users SET plan_id = ?, is_paid = 1 WHERE id = ?`, [planId, userId]);
                await conn.execute(`UPDATE quotas SET message_limit = ? WHERE user_id = ?`, [messageLimit, userId]);
                await conn.commit();
                return true;
            } catch (err) {
                await conn.rollback();
                throw err;
            } finally {
                conn.release();
            }
        } else {
            try {
                await db.run('BEGIN TRANSACTION');
                await db.run(`UPDATE users SET plan_id = ?, is_paid = 1 WHERE id = ?`, [planId, userId]);
                await db.run(`UPDATE quotas SET message_limit = ? WHERE user_id = ?`, [messageLimit, userId]);
                await db.run('COMMIT');
                return true;
            } catch (err) {
                await db.run('ROLLBACK');
                throw err;
            }
        }
    },

    updatePortfolio: async (userId, config) => {
        await initPromise;
        await runQuery(
            `UPDATE users SET portfolio_config = ? WHERE id = ?`,
            [JSON.stringify(config), userId]
        );
    },

    getPortfolio: async (userId) => {
        await initPromise;
        const row = await getQuery(
            `SELECT portfolio_config FROM users WHERE id = ?`,
            [userId]
        );
        return row?.portfolio_config ? JSON.parse(row.portfolio_config) : { images: [], keyword: 'portfolio' };
    }
};

module.exports = dbHelper;
