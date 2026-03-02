/**
 * Database connection helper
 */
import pg from 'pg';

const { Pool } = pg;

let pool;

export function getPostgresDb() {
    if (!pool) {
        pool = new Pool({
            host: process.env.DB_HOST || 'localhost',
            port: parseInt(process.env.DB_PORT || '5432'),
            user: process.env.DB_USER || 'crewswarm',
            password: process.env.DB_PASS || 'crewswarm',
            database: process.env.DB_DATABASE || 'crewswarm',
        });

        console.log('[db] PostgreSQL pool created');
    }

    return {
        query: async (text, params) => {
            const client = await pool.connect();
            try {
                return await client.query(text, params);
            } finally {
                client.release();
            }
        },
        end: () => pool.end(),
    };
}

// Initialize tables on first connection
export async function initDatabase() {
    const db = getPostgresDb();
    
    await db.query(`
        CREATE TABLE IF NOT EXISTS agent_sessions (
            id SERIAL PRIMARY KEY,
            user_id VARCHAR(255) NOT NULL,
            session_id VARCHAR(255) NOT NULL,
            agent_id VARCHAR(255) NOT NULL,
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW(),
            UNIQUE(user_id, session_id, agent_id)
        )
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS agent_messages (
            id SERIAL PRIMARY KEY,
            user_id VARCHAR(255) NOT NULL,
            session_id VARCHAR(255) NOT NULL,
            agent_id VARCHAR(255) NOT NULL,
            role VARCHAR(50) NOT NULL,
            content TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT NOW(),
            INDEX idx_session (user_id, session_id, agent_id, created_at)
        )
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS agent_memory (
            id SERIAL PRIMARY KEY,
            user_id VARCHAR(255) NOT NULL,
            agent_id VARCHAR(255) NOT NULL,
            key VARCHAR(255) NOT NULL,
            value TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW(),
            UNIQUE(user_id, agent_id, key)
        )
    `);

    console.log('[db] Tables initialized');
}
