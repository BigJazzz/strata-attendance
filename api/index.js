import express from 'express';
import { createClient } from '@libsql/client';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';

const app = express();
app.use(express.json());

// --- Turso Client Caching ---
let cachedDb = null;
function getDb() {
  if (cachedDb) return cachedDb;
  const url = process.env.TURSO_DATABASE_URL;
  const token = process.env.TURSO_AUTH_TOKEN;
  cachedDb = createClient({ url, authToken: token, config:{ syncUrl: null } });
  return cachedDb;
}

// --- JWT Middleware ---
function authenticate(req, res, next) {
  const auth = req.headers.authorization?.split(' ')[1];
  if (!auth) return res.status(401).send({ error: 'Missing token' });
  try {
    req.user = jwt.verify(auth, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).send({ error: 'Invalid token' });
  }
}

// --- 1. Login Endpoint ---
app.post('/api/login', async (req, res) => {
  const db = getDb();
  const { username, password } = req.body;
  if (!username || !password) 
    return res.status(400).json({ error: 'Missing credentials.' });

  // Fetch user record
  const result = await db.execute({
    sql: 'SELECT id, username, password_hash, role, plan_id FROM users WHERE username = ?',
    args: [username]
  });
  const user = result.rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  // Issue JWT
  const token = jwt.sign({
    id: user.id,
    username: user.username,
    role: user.role,
    plan_id: user.plan_id
  }, process.env.JWT_SECRET, { expiresIn: '7d' });

  res.json({
    success: true,
    token,
    user: { username: user.username, role: user.role, spAccess: user.plan_id }
  });
});

// --- 2. Strata Plans Endpoint ---
app.get('/api/strata-plans', authenticate, async (req, res) => {
  const db = getDb();
  const result = await db.execute('SELECT sp_number AS sp, suburb FROM strata_plans ORDER BY sp_number');
  res.json({ success: true, plans: result.rows.map(r => ({ sp: r[0], suburb: r[1] })) });
});

// … mount the rest of your endpoints here …

export default app;
