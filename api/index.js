import express from 'express';
import { createClient } from '@libsql/client';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const app = express();
app.use(express.json());

// --- Turso Client Caching ---
let cachedDb = null;
function getDb() {
  if (cachedDb) return cachedDb;
  const url = process.env.TURSO_DATABASE_URL;
  const token = process.env.TURSO_AUTH_TOKEN;
  cachedDb = createClient({ url, authToken: token, config: { syncUrl: null } });
  return cachedDb;
}

// --- JWT Middleware ---
function authenticate(req, res, next) {
  const auth = req.headers.authorization?.split(' ')[1];
  if (!auth) return res.status(401).json({ error: 'Missing token' });
  try {
    req.user = jwt.verify(auth, process.env.JWT_SECRET);
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

app.post('/api/login', async (req, res) => {
  try {
    const db = getDb();
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Missing credentials.' });
    }

    const hashed = hashPassword(password);
    const result = await db.execute({
      sql: 'SELECT id, username, password_hash, role, plan_id FROM users WHERE username = ?',
      args: [username]
    });

    const row = result.rows[0];
    if (!row || row.password_hash !== hashed) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    const id = row.id;
    const role = row.role;
    const plan_id = row.plan_id;

    const token = jwt.sign({ id, username, role, plan_id }, process.env.JWT_SECRET, { expiresIn: '7d' });

    res.json({
      success: true,
      token,
      user: { username, role, spAccess: plan_id }
    });

  } catch (err) {
    console.error('[LOGIN ERROR]', err);
    res.status(500).json({ error: 'Internal server error during login.' });
  }
});



// --- Strata Plans Endpoint ---
app.get('/api/strata-plans', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const result = await db.execute(
      'SELECT sp_number AS sp, suburb FROM strata_plans ORDER BY sp_number'
    );
    res.json({
      success: true,
      plans: result.rows.map(r => ({ sp: r[0], suburb: r[1] }))
    });
  } catch (err) {
    console.error('[STRATA PLANS ERROR]', err);
    res.status(500).json({ error: `Could not load strata plans: ${err.message}` });
  }
});

// --- Global JSON Error Handler ---
app.use((err, req, res, next) => {
  console.error('[GLOBAL ERROR]', err);
  res.status(500).json({ error: `Server encountered an error: ${err.message}` });
});

export default app;
