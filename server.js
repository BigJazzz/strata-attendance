// server.js
import express from 'express';
import { createClient } from '@libsql/client'; // CORRECTED import statement
// You would also need a library like 'bcrypt' for password hashing
// import bcrypt from 'bcrypt'; 

const app = express();
app.use(express.json()); // Middleware to parse JSON bodies

// --- Database Configuration ---
// Make sure to replace these with your actual Turso credentials
const db = createClient({
  authToken: "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJpYXQiOjE3NTMzMTczNjcsImlkIjoiMDdkYWNjZjgtNzJjNi00YTFjLWIzNmUtMjFlZWQ3OTY2MDRjIiwicmlkIjoiOTAxODJkZTQtODAxMy00ZGUzLWJjNjQtNmIwNTljYzI4ZDgzIn0.aHy5js-cKSNph6sgZW1QmtmcumT11KQPWulpsI2FtVOKqXTmU-YUUFlafMlFKzBedWhjhTzHDNlszJIseO8uCg",
  url: "libsql://strata-attendance-vercel-icfg-zgjq9qumdckww1txt6voef9j.aws-ap-northeast-1.turso.io"
});

// --- API Endpoints ---
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  try {
    // Find the user in the database
    const result = await db.execute({
      sql: 'SELECT * FROM users WHERE username = ?',
      args: [username],
    });

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    const user = result.rows[0];
    
    // In a real app, you would compare the hashed password
    // const passwordMatch = await bcrypt.compare(password, user.password_hash);
    
    // For now, we'll just check if the user exists
    if (user) {
        // Successful login
        res.json({ 
            success: true, 
            user: { username: user.username, role: user.role } 
        });
    } else {
        res.status(401).json({ error: 'Invalid username or password.' });
    }

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

// --- Start the Server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});