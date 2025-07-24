import express from 'express';
import { createClient } from '@libsql/client';

const app = express();
app.use(express.json());

// --- Database Configuration ---
const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// --- API Endpoints ---
app.post('/api/login', async (req, res) => {
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
    res.json({ success: true, user: { username: user.username, role: user.role } });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

app.get('/api/strata-plans', async (req, res) => {
  try {
    const result = await db.execute('SELECT * FROM strata_plans ORDER BY id');
    
    const plans = result.rows.map(row => ({
      sp: row[0],
      suburb: row[1]
    }));

    res.json({ success: true, plans: plans });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

// Export the app object for Vercel's serverless environment
export default app;
