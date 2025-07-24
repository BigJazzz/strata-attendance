// api/index.js

import express from 'express';
import { createClient } from '@libsql/client';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';

const app = express();
app.use(express.json());

// --- Turso Client Caching ---
let cachedDb = null;
function getDb() {
  if (cachedDb) return cachedDb;
  const url = process.env.TURSO_DATABASE_URL;
  const token = process.env.TURSO_AUTH_TOKEN;
  cachedDb = createClient({ url, authToken: token, config: { syncUrl: null } });
  return cachedDb;
}

// --- JWT Middleware ---
function authenticate(req, res, next) {
  const auth = req.headers.authorization?.split(' ')[1];
  if (!auth) return res.status(401).json({ error: 'Missing token' });
  try {
    req.user = jwt.verify(auth, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// --- 1. Login ---
app.post('/api/login', async (req, res) => {
  const db = getDb();
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Missing credentials.' });
  }

  // Fetch user
  const result = await db.execute({
    sql: 'SELECT id, username, password_hash, role, plan_id FROM users WHERE username = ?',
    args: [username]
  });
  const row = result.rows[0];
  if (!row || !(await bcrypt.compare(password, row[2]))) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  const [id, , , role, plan_id] = row;
  const token = jwt.sign({ id, username, role, plan_id }, process.env.JWT_SECRET, { expiresIn: '7d' });

  res.json({
    success: true,
    token,
    user: { username, role, spAccess: plan_id }
  });
});

// --- 2. List Strata Plans ---
app.get('/api/strata-plans', authenticate, async (req, res) => {
  const db = getDb();
  const result = await db.execute(`
    SELECT sp_number AS sp, suburb 
      FROM strata_plans 
    ORDER BY sp_number
  `);
  res.json({
    success: true,
    plans: result.rows.map(r => ({ sp: r[0], suburb: r[1] }))
  });
});

// --- 3. Fetch Strata Roll (owners) ---
app.get('/api/roll/:sp', authenticate, async (req, res) => {
  const sp = req.params.sp;
  const db = getDb();

  // Lookup plan_id
  const planRes = await db.execute(
    'SELECT id FROM strata_plans WHERE sp_number = ?',
    [sp]
  );
  if (!planRes.rows.length) {
    return res.status(404).json({ error: 'Strata plan not found.' });
  }
  const plan_id = planRes.rows[0][0];

  // Fetch owners for that plan
  // Make sure you have created an 'owners' table:
  //   CREATE TABLE owners (
  //     id INTEGER PRIMARY KEY AUTOINCREMENT,
  //     plan_id INTEGER REFERENCES strata_plans(id),
  //     lot TEXT, unit TEXT, main_contact TEXT, full_name TEXT
  //   );
  const ownersRes = await db.execute(
    'SELECT lot, unit, main_contact, full_name FROM owners WHERE plan_id = ?',
    [plan_id]
  );

  // Build a map: lot → [unit, main_contact, full_name]
  const names = {};
  ownersRes.rows.forEach(([lot, unit, main, full]) => {
    names[lot] = [unit, main, full];
  });

  res.json({ success: true, names });
});

// --- 4. Batch‐Submit Attendance ---
app.post('/api/attendance', authenticate, async (req, res) => {
  const submissions = req.body.submissions;
  if (!Array.isArray(submissions)) {
    return res.status(400).json({ error: 'Expected "submissions" array.' });
  }
  const db = getDb();

  for (const sub of submissions) {
    const { sp, lot, names, companyRep, proxyHolderLot, financial } = sub;

    // Lookup plan_id
    const planRes = await db.execute(
      'SELECT id FROM strata_plans WHERE sp_number = ?',
      [sp]
    );
    if (!planRes.rows.length) continue;
    const plan_id = planRes.rows[0][0];

    // Compose owner_name column
    let ownerName;
    if (proxyHolderLot) {
      ownerName = `Proxy - Lot ${proxyHolderLot}`;
    } else if (companyRep) {
      ownerName = `${names[0]} - ${companyRep}`;
    } else {
      ownerName = names.join(', ');
    }

    await db.execute({
      sql: `INSERT INTO attendance 
              (plan_id, lot, owner_name, rep_name, is_proxy, is_financial)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        plan_id,
        lot,
        ownerName,
        proxyHolderLot || null,
        !!proxyHolderLot,
        financial ? 1 : 0
      ]
    });
  }

  res.json({ success: true });
});

// --- 5. Get Attendance for Reports ---
app.get('/api/attendance', authenticate, async (req, res) => {
  const { plan, date } = req.query;
  if (!plan || !date) {
    return res.status(400).json({ error: 'Missing plan or date.' });
  }
  const db = getDb();

  // Find plan_id
  const planRes = await db.execute(
    'SELECT id FROM strata_plans WHERE sp_number = ?',
    [plan]
  );
  if (!planRes.rows.length) {
    return res.status(404).json({ error: 'Strata plan not found.' });
  }
  const plan_id = planRes.rows[0][0];

  // Query attendance by date (YYYY-MM-DD)
  // Assumes timestamp column is stored with full DATETIME
  const rows = await db.execute({
    sql: `
      SELECT lot, owner_name, rep_name, is_proxy, is_financial
        FROM attendance 
       WHERE plan_id = ?
         AND DATE(timestamp) = ?
    `,
    args: [plan_id, date]
  });

  const records = rows.rows.map(r => ({
    lot: r[0],
    name: r[1],
    proxyHolderLot: r[2],
    isProxy: !!r[3],
    isFinancial: !!r[4]
  }));

  res.json({ success: true, records });
});

// --- 6. Delete a Single Attendance Record ---
app.delete('/api/attendance', authenticate, async (req, res) => {
  const { plan, lot } = req.query;
  if (!plan || !lot) {
    return res.status(400).json({ error: 'Missing plan or lot.' });
  }
  const db = getDb();

  // Resolve plan_id
  const planRes = await db.execute(
    'SELECT id FROM strata_plans WHERE sp_number = ?',
    [plan]
  );
  if (!planRes.rows.length) {
    return res.status(404).json({ error: 'Strata plan not found.' });
  }
  const plan_id = planRes.rows[0][0];

  // Delete by plan_id & lot
  await db.execute(
    'DELETE FROM attendance WHERE plan_id = ? AND lot = ?',
    [plan_id, lot]
  );

  res.json({ success: true });
});

// --- 7. List Report Dates (unique dates with submissions) ---
app.get('/api/report-dates', authenticate, async (req, res) => {
  const plan = req.query.plan;
  if (!plan) {
    return res.status(400).json({ error: 'Missing plan.' });
  }
  const db = getDb();

  // Find plan_id
  const planRes = await db.execute(
    'SELECT id FROM strata_plans WHERE sp_number = ?',
    [plan]
  );
  if (!planRes.rows.length) {
    return res.status(404).json({ error: 'Strata plan not found.' });
  }
  const plan_id = planRes.rows[0][0];

  // Select distinct DATE(timestamp)
  const datesRes = await db.execute({
    sql: `
      SELECT DISTINCT DATE(timestamp) AS d
        FROM attendance
       WHERE plan_id = ?
    `,
    args: [plan_id]
  });

  const dates = datesRes.rows.map(r => r[0]);
  res.json({ success: true, dates });
});

// …you can append the User-Management endpoints here (GET/POST/DELETE /api/users, PATCH /api/users/:username, etc.)…

export default app;
