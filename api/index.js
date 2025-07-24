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

// Asynchronously initialize the database connection
async function initializeDatabase() {
  if (dbUrl && dbToken) {
    try {
      const client = createClient({
        url: dbUrl,
        authToken: dbToken,
      });
      console.log("[SERVER LOG] Turso DB client created. Performing warm-up query...");
      
      // Perform a simple query to ensure the connection is live and ready
      await client.execute("SELECT 1");
      
      console.log("[SERVER LOG] Database warm-up query successful. Connection is live.");
      return client;
    } catch (e) {
      console.error("[SERVER LOG] CRITICAL: Database initialization failed.", e);
      return null;
    }
  } else {
      console.error("[SERVER LOG] CRITICAL: Database environment variables are not set.");
      return null;
  }
}

// Initialize the database when the server starts
initializeDatabase().then(client => {
  db = client;
});


// --- API Endpoints ---
app.post('/api/login', async (req, res) => {
  if (!db) {
    console.error("[SERVER LOG] /api/login: Cannot process request because database is not configured or initialization failed.");
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
    console.error("[SERVER LOG] /api/login: An error occurred during database query.", error);
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

app.get('/api/strata-plans', async (req, res) => {
  if (!db) {
    console.error("[SERVER LOG] /api/strata-plans: Cannot process request because database is not configured or initialization failed.");
    return res.status(500).json({ error: 'Server is not configured to connect to the database.' });
  }
  
  try {
    const result = await db.execute('SELECT * FROM strata_plans ORDER BY id');

    if (result && Array.isArray(result.rows)) {
        const plans = result.rows.map(row => ({
          sp: row[0],
          suburb: row[1]
        }));
        
        res.json({ success: true, plans: plans });
    } else {
        res.json({ success: true, plans: [] });
    }

  } catch (error) {
    console.error("[SERVER LOG] /api/strata-plans: An error occurred during database query.", error);
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

// Export the app object for Vercel's serverless environment
export default app;
