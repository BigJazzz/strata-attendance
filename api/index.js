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

// User Login
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

// Get All Strata Plans
app.get('/api/strata-plans', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const result = await db.execute(
      'SELECT sp_number, suburb FROM strata_plans ORDER BY sp_number'
    );
    res.json({ success: true, plans: result.rows });
  } catch (err) {
    console.error('[STRATA PLANS ERROR]', err);
    res.status(500).json({ error: `Could not load strata plans: ${err.message}` });
  }
});


// --- User Management Endpoints (Admin) ---

// Get All Users
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

// Add a New User
app.post('/api/users', authenticate, isAdmin, async (req, res) => {
    try {
        const { username, password, role, spAccess } = req.body;

        if (!username || !password || !role) {
            return res.status(400).json({ error: 'Username, password, and role are required.' });
        }
        if (role === 'User' && !spAccess) {
            return res.status(400).json({ error: 'SP Access is required for the User role.' });
        }

        const db = getDb();
        const password_hash = hashPassword(password);
        const plan_id = role === 'Admin' ? null : spAccess;

        await db.execute({
            sql: 'INSERT INTO users (username, password_hash, role, plan_id) VALUES (?, ?, ?, ?)',
            args: [username, password_hash, role, plan_id]
        });

        res.status(201).json({ success: true, message: 'User created successfully.' });

    } catch (err) {
        if (err.message && err.message.includes('UNIQUE constraint failed: users.username')) {
             return res.status(409).json({ error: `Username "${req.body.username}" already exists.` });
        }
        console.error('[ADD USER ERROR]', err);
        res.status(500).json({ error: 'Failed to add user.' });
    }
});

// Delete a User
app.delete('/api/users/:username', authenticate, isAdmin, async (req, res) => {
    try {
        const { username } = req.params;
        if (username === req.user.username) {
            return res.status(400).json({ error: 'Cannot delete your own user account.' });
        }
        const db = getDb();
        await db.execute({
            sql: 'DELETE FROM users WHERE username = ?',
            args: [username]
        });
        res.json({ success: true, message: 'User deleted.' });
    } catch (err) {
        console.error('[DELETE USER ERROR]', err);
        res.status(500).json({ error: 'Failed to delete user.' });
    }
});

// Change User's Own Password
app.patch('/api/users/:username/password', authenticate, async (req, res) => {
    try {
        const { username } = req.params;
        const { newPassword } = req.body;

        // Ensure users can only change their own password
        if (username !== req.user.username) {
            return res.status(403).json({ error: 'Forbidden: You can only change your own password.' });
        }
        if (!newPassword) {
            return res.status(400).json({ error: 'New password is required.' });
        }
        
        const db = getDb();
        const password_hash = hashPassword(newPassword);

        await db.execute({
            sql: 'UPDATE users SET password_hash = ? WHERE username = ?',
            args: [password_hash, username]
        });

        res.json({ success: true, message: 'Password updated successfully.' });
    } catch (err) {
        console.error('[CHANGE PASSWORD ERROR]', err);
        res.status(500).json({ error: 'Failed to update password.' });
    }
});

// Update a User's Plan Access (Admin only)
app.patch('/api/users/:username/plan', authenticate, isAdmin, async (req, res) => {
    try {
        const { username } = req.params;
        const { plan_id } = req.body;
        const db = getDb();
        await db.execute({
            sql: 'UPDATE users SET plan_id = ? WHERE username = ?',
            args: [plan_id, username]
        });
        res.json({ success: true, message: 'Plan access updated.' });
    } catch (err) {
        console.error('[UPDATE PLAN ERROR]', err);
        res.status(500).json({ error: 'Failed to update plan access.' });
    }
});

// Reset a User's Password (Admin only)
app.post('/api/users/:username/reset-password', authenticate, isAdmin, async (req, res) => {
    try {
        const { username } = req.params;
        // For simplicity, we'll reset it to a known password. 
        // In a real-world app, you might generate a random one and email it.
        const defaultPassword = 'Password123!';
        const password_hash = hashPassword(defaultPassword);
        const db = getDb();

        await db.execute({
            sql: 'UPDATE users SET password_hash = ? WHERE username = ?',
            args: [password_hash, username]
        });

        res.json({ success: true, message: `Password for ${username} has been reset.` });
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