import express from 'express';
import { createClient } from '@libsql/client';

const app = express();
app.use(express.json());

// --- Database Configuration ---
let db;
const dbUrl = process.env.sa_TURSO_DATABASE_URL;
const dbToken = process.env.sa_TURSO_AUTH_TOKEN;

console.log(`[SERVER LOG] Checking Environment Variables...`);
console.log(`[SERVER LOG] sa_TURSO_DATABASE_URL is: ${dbUrl ? 'found' : 'MISSING'}`);
console.log(`[SERVER LOG] sa_TURSO_AUTH_TOKEN is: ${dbToken ? 'found' : 'MISSING'}`);

if (dbUrl && dbToken) {
  try {
    // FINAL CORRECTION: Using remoteOnly for a simpler, more compatible connection
    db = createClient({
      url: dbUrl,
      authToken: dbToken,
      remoteOnly: true, // This can resolve handshake issues in serverless environments
    });
    console.log("[SERVER LOG] Successfully created Turso DB client with remoteOnly.");
  } catch (e) {
    console.error("[SERVER LOG] Failed to create Turso DB client:", e);
    db = null;
  }
} else {
    console.error("[SERVER LOG] CRITICAL: Database environment variables are not set.");
    db = null;
}


// --- API Endpoints ---
app.post('/api/login', async (req, res) => {
  if (!db) {
    console.error("[SERVER LOG] /api/login: Cannot process request because database is not configured.");
    return res.status(500).json({ error: 'Server is not configured to connect to the database.' });
  }

  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  try {
    console.log(`[SERVER LOG] /api/login: Querying database for user "${username}".`);
    const result = await db.execute({
      sql: 'SELECT * FROM users WHERE username = ?',
      args: [username],
    });

    if (result.rows.length === 0) {
      console.warn(`[SERVER LOG] /api/login: Login failed for "${username}". User not found.`);
      return res.status(401).json({ error: 'Invalid username or password.' });
    }
    
    const user = result.rows[0];
    console.log(`[SERVER LOG] /api/login: Login successful for "${username}".`);
    res.json({ success: true, user: { username: user.username, role: user.role } });

  } catch (error) {
    console.error("[SERVER LOG] /api/login: An error occurred during database query.", error);
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

app.get('/api/strata-plans', async (req, res) => {
  if (!db) {
    console.error("[SERVER LOG] /api/strata-plans: Cannot process request because database is not configured.");
    return res.status(500).json({ error: 'Server is not configured to connect to the database.' });
  }
  
  try {
    console.log("[SERVER LOG] /api/strata-plans: Querying database for all strata plans.");
    const result = await db.execute('SELECT * FROM strata_plans ORDER BY id');

    if (result && Array.isArray(result.rows)) {
        const plans = result.rows.map(row => ({
          sp: row[0],
          suburb: row[1]
        }));
        
        console.log(`[SERVER LOG] /api/strata-plans: Found and processed ${plans.length} plans.`);
        res.json({ success: true, plans: plans });
    } else {
        console.error("[SERVER LOG] /api/strata-plans: Database query did not return a valid 'rows' array.", result);
        res.json({ success: true, plans: [] });
    }

  } catch (error) {
    console.error("[SERVER LOG] /api/strata-plans: An error occurred during database query.", error);
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

// Export the app object for Vercel's serverless environment
export default app;
