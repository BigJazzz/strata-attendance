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
    console.error("[SERVER LOG] /api/login: Cannot process request because database is not configured.");
    return res.status(500).json({ error: 'Server is not configured to connect to the database.' });
  }

  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  try {
    console.log(`[SERVER LOG] /api/login: Querying database for user "${username}".`);
    // CORRECTED: Using db.batch() instead of db.execute()
    const results = await db.batch([
        { sql: 'SELECT * FROM users WHERE username = ?', args: [username] }
    ], 'read');

    const userResult = results[0]; // Get the result of the first statement in the batch

    if (userResult.rows.length === 0) {
      console.warn(`[SERVER LOG] /api/login: Login failed for "${username}". User not found.`);
      return res.status(401).json({ error: 'Invalid username or password.' });
    }
    
    const user = userResult.rows[0];
    // In a real app, you would compare the hashed password here
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
    // CORRECTED: Using db.batch() instead of db.execute()
    const results = await db.batch([
        'SELECT * FROM strata_plans ORDER BY id'
    ], 'read');

    const plansResult = results[0]; // Get the result of the first statement in the batch

    if (plansResult && Array.isArray(plansResult.rows)) {
        const plans = plansResult.rows.map(row => ({
          sp: row[0],
          suburb: row[1]
        }));
        
        console.log(`[SERVER LOG] /api/strata-plans: Found and processed ${plans.length} plans.`);
        res.json({ success: true, plans: plans });
    } else {
        console.error("[SERVER LOG] /api/strata-plans: Database query did not return a valid 'rows' array.", plansResult);
        res.json({ success: true, plans: [] });
    }

  } catch (error) {
    console.error("[SERVER LOG] /api/strata-plans: An error occurred during database query.", error);
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

// Export the app object for Vercel's serverless environment
export default app;
