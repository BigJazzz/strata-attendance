import express from 'express';
import { createClient } from '@libsql/client';

const app = express();
app.use(express.json());

// --- Database Configuration ---
let db;
const dbUrl = process.env.sa_TURSO_DATABASE_URL;
const dbToken = process.env.sa_TURSO_AUTH_TOKEN;

// Add detailed logging to check if the environment variables are loaded
console.log(`[SERVER LOG] Checking Environment Variables...`);
console.log(`[SERVER LOG] sa_TURSO_DATABASE_URL is: ${dbUrl ? 'found' : 'MISSING'}`);
console.log(`[SERVER LOG] sa_TURSO_AUTH_TOKEN is: ${dbToken ? 'found' : 'MISSING'}`);

// Only attempt to create the client if both variables exist
if (dbUrl && dbToken) {
  try {
    // Reverting to the standard 'url' property as the issue is variable loading
    db = createClient({
      url: dbUrl,
      authToken: dbToken,
    });
    console.log("[SERVER LOG] Successfully created Turso DB client.");
  } catch (e) {
    console.error("[SERVER LOG] Failed to create Turso DB client:", e);
    db = null; // Ensure db is null if creation fails
  }
} else {
    console.error("[SERVER LOG] CRITICAL: Database environment variables are not set.");
    db = null;
}


// --- API Endpoints ---
app.post('/api/login', async (req, res) => {
  // Check if the database connection was successful
  if (!db) {
    return res.status(500).json({ error: 'Server is not configured to connect to the database.' });
  }

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
  if (!db) {
    return res.status(500).json({ error: 'Server is not configured to connect to the database.' });
  }
  
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
