// --- Imports and Express Setup ---
import express from 'express';
import { createClient } from '@libsql/client';

const app = express();
app.use(express.json());

// --- Cached Client Setup ---
let cachedClient = null;

function getDatabaseClient() {
  if (cachedClient) return cachedClient;

  const dbUrl = process.env.sa_TURSO_DATABASE_URL;
  const dbToken = process.env.sa_TURSO_AUTH_TOKEN;

  if (!dbUrl || !dbToken) {
    console.error("[DB INIT] Environment variables missing.");
    return null;
  }

  try {
    cachedClient = createClient({
      url: dbUrl,
      authToken: dbToken,
      config: {
        syncUrl: null  // Disables migration job checks
      }
    });
    console.log("[DB INIT] Turso client cached.");
    return cachedClient;
  } catch (e) {
    console.error("[DB INIT] Failed to initialize Turso client.", e);
    return null;
  }
}
// --- Login Endpoint ---
app.post('/api/login', async (req, res) => {
  const db = getDatabaseClient();
  if (!db) return res.status(500).json({ error: 'Database client unavailable.' });

  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });

  try {
    const result = await db.execute({
      sql: 'SELECT * FROM users WHERE username = ?',
      args: [username],
    });

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const user = result.rows[0];
    res.json({ success: true, user: { username: user.username, role: user.role } });
  } catch (error) {
    console.error("[LOGIN ERROR]", error);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// --- Strata Plans Endpoint ---
app.get('/api/strata-plans', async (req, res) => {
  const db = getDatabaseClient();
  if (!db) return res.status(500).json({ error: 'Database client unavailable.' });

  try {
    const result = await db.execute('SELECT * FROM strata_plans ORDER BY id');

    const plans = result.rows.map(row => ({
      sp: row[0],
      suburb: row[1],
    }));

    res.json({ success: true, plans });
  } catch (error) {
    console.error("[STRATA PLANS ERROR]", error);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// --- Export App for Vercel ---
export default app;
