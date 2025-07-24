// api/index.js
import express from 'express';
import { createClient } from '@libsql/client';

const app = express();
app.use(express.json());

// --- Database Configuration ---
const db = createClient({
  url: process.env.TURSO_DATABASE_URL, // Use Environment Variables for security
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// --- API Endpoints ---
app.post('/api/login', async (req, res) => {
  // Your login logic remains the same...
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  try {
    const result = await db.execute({
      sql: 'SELECT * FROM users WHERE username = ?',
      args: [username],
    });

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    const user = result.rows[0];
    // In a real app, you would add password hash comparison here
    res.json({ success: true, user: { username: user.username, role: user.role } });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

// IMPORTANT: Export the app object for Vercel
export default app;