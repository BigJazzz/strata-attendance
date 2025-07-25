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
  // Using remoteOnly for better compatibility in serverless environments
  cachedDb = createClient({ url, authToken: token, remoteOnly: true });
  return cachedDb;
}

// --- Middleware ---
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Authentication failed: No token provided.' });
  }

  try {
    const user = jwt.verify(token, process.env.JWT_SECRET);
    req.user = user; // Add user payload to the request object
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Authentication failed: Invalid token.' });
  }
}

function isAdmin(req, res, next) {
    // This middleware must run *after* the authenticate middleware
    if (req.user && req.user.role === 'Admin') {
        next();
    } else {
        return res.status(403).json({ error: 'Forbidden: Admin access required.' });
    }
}


function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

// --- API Endpoints ---

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
    
    const { id, role, plan_id } = row;

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

app.get('/api/strata-plans', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const result = await db.execute(
      'SELECT sp_number, suburb FROM strata_plans ORDER BY sp_number'
    );
    // The client returns rows as an array of objects when column names are specified
    res.json({ success: true, plans: result.rows });
  } catch (err) {
    console.error('[STRATA PLANS ERROR]', err);
    res.status(500).json({ error: `Could not load strata plans: ${err.message}` });
  }
});

// --- User Management Endpoints (Admin Only, except for password change) ---

// Get all users
app.get('/api/users', authenticate, isAdmin, async (req, res) => {
    try {
        const db = getDb();
        const result = await db.execute('SELECT username, role, plan_id FROM users');
        res.json({ success: true, users: result.rows });
    } catch (err) {
        console.error('[GET USERS ERROR]', err);
        res.status(500).json({ error: 'Failed to fetch users.' });
    }
});

// Add a new user
app.post('/api/users', authenticate, isAdmin, async (req, res) => {
    const { username, password, role, spAccess } = req.body;
    if (!username || !password || !role) {
        return res.status(400).json({ error: 'Username, password, and role are required.' });
    }
    try {
        const db = getDb();
        const password_hash = hashPassword(password);
        await db.execute({
            sql: 'INSERT INTO users (username, password_hash, role, plan_id) VALUES (?, ?, ?, ?)',
            args: [username, password_hash, role, spAccess || null]
        });
        res.json({ success: true });
    } catch (err) {
        console.error('[ADD USER ERROR]', err);
        res.status(500).json({ error: 'Failed to add user. Username may already exist.' });
    }
});

// Remove a user
app.delete('/api/users/:username', authenticate, isAdmin, async (req, res) => {
    const { username } = req.params;
    if (username === req.user.username) {
        return res.status(400).json({ error: 'Cannot remove yourself.' });
    }
    try {
        const db = getDb();
        await db.execute({
            sql: 'DELETE FROM users WHERE username = ?',
            args: [username]
        });
        res.json({ success: true });
    } catch (err) {
        console.error('[DELETE USER ERROR]', err);
        res.status(500).json({ error: 'Failed to remove user.' });
    }
});

// Change own password (Authenticated)
app.patch('/api/users/:username/password', authenticate, async (req, res) => {
    const { username } = req.params;
    const { newPassword } = req.body;

    // Ensure users can only change their own password
    if (username !== req.user.username) {
        return res.status(403).json({ error: 'Forbidden: You can only change your own password.' });
    }
    if (!newPassword) {
        return res.status(400).json({ error: 'New password is required.' });
    }

    try {
        const db = getDb();
        const password_hash = hashPassword(newPassword);
        await db.execute({
            sql: 'UPDATE users SET password_hash = ? WHERE username = ?',
            args: [password_hash, username]
        });
        res.json({ success: true });
    } catch (err) {
        console.error('[CHANGE PASSWORD ERROR]', err);
        res.status(500).json({ error: 'Failed to change password.' });
    }
});

// Update a user's SP access (Admin Only)
app.patch('/api/users/:username/plan', authenticate, isAdmin, async (req, res) => {
    const { username } = req.params;
    const { plan_id } = req.body;
    try {
        const db = getDb();
        await db.execute({
            sql: 'UPDATE users SET plan_id = ? WHERE username = ?',
            args: [plan_id, username]
        });
        res.json({ success: true });
    } catch (err) {
        console.error('[UPDATE SP ACCESS ERROR]', err);
        res.status(500).json({ error: 'Failed to update SP access.' });
    }
});

// Reset a user's password (Admin Only)
app.post('/api/users/:username/reset-password', authenticate, isAdmin, async (req, res) => {
    const { username } = req.params;
    const newPassword = 'Password1'; // Default reset password
    try {
        const db = getDb();
        const password_hash = hashPassword(newPassword);
        await db.execute({
            sql: 'UPDATE users SET password_hash = ? WHERE username = ?',
            args: [password_hash, username]
        });
        res.json({ success: true });
    } catch (err) {
        console.error('[RESET PASSWORD ERROR]', err);
        res.status(500).json({ error: 'Failed to reset password.' });
    }
});


// --- Global JSON Error Handler ---
app.use((err, req, res, next) => {
  console.error('[GLOBAL ERROR]', err);
  res.status(500).json({ error: `Server encountered an error: ${err.message}` });
});

export default app;
