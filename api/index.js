import express from 'express';

const app = express();
app.use(express.json());

// --- API Endpoints ---

// This is a simple diagnostic endpoint.
// It does not connect to any database.
app.post('/api/login', async (req, res) => {
  console.log('[SERVER LOG] /api/login endpoint was reached successfully.');
  
  const { username } = req.body;

  // Always return a successful response for testing purposes.
  res.json({ 
    success: true, 
    user: { 
      username: username || "test-user", 
      role: "Test" 
    } 
  });
});

app.get('/api/strata-plans', async (req, res) => {
    console.log('[SERVER LOG] /api/strata-plans endpoint was reached successfully.');
    // Return a hardcoded list of plans for testing.
    const testPlans = [
        { sp: 12345, suburb: 'Testville' },
        { sp: 67890, suburb: 'Sampleton' }
    ];
    res.json({ success: true, plans: testPlans });
});

// Export the app object for Vercel's serverless environment
export default app;
