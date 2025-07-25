import express from 'express';
import { createClient } from '@libsql/client';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import Papa from 'papaparse';

const app = express();
app.use(express.json({ limit: '10mb' }));

// --- Turso Client Caching & DB Helpers ---
let cachedDb = null;
function getDb() {
  if (cachedDb) return cachedDb;
  const url = process.env.TURSO_DATABASE_URL;
  const token = process.env.TURSO_AUTH_TOKEN;
  cachedDb = createClient({ url, authToken: token, remoteOnly: true });
  return cachedDb;
}

function rowsToObjects(result) {
    if (!result.rows || result.rows.length === 0) return [];
    return result.rows.map(row => {
        const obj = {};
        result.columns.forEach((col, index) => {
            obj[col] = row[index];
        });
        return obj;
    });
}

// --- Middleware ---
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Authentication failed: No token provided.' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Authentication failed: Invalid token.' });
  }
}

function isAdmin(req, res, next) {
    if (req.user && req.user.role === 'Admin') next();
    else return res.status(403).json({ error: 'Forbidden: Admin access required.' });
}

// --- CSV IMPORT ENDPOINT ---
app.post('/api/import-data', authenticate, isAdmin, async (req, res) => {
    const { csvData } = req.body;
    if (!csvData) {
        return res.status(400).json({ error: 'No CSV data provided.' });
    }

    const db = getDb();
    let transaction;
    try {
        const parsed = Papa.parse(csvData, { header: false, skipEmptyLines: true });
        const rows = parsed.data.slice(1);

        if (rows.length === 0) {
            return res.status(400).json({ error: 'CSV file contains no data rows.' });
        }

        transaction = await db.transaction('write');

        for (const row of rows) {
            const sp_number = row[0];
            const lot_number = row[2];
            const unit_number = row[3];
            const name_on_title = row[5] || '';         // Column F
            const main_contact_name = row[6] || '';     // Column G
            const levy_entitlement = parseInt(row[23], 10) || 0;

            if (!sp_number || !lot_number) continue;

            let plan_id;
            const planResult = await transaction.execute({
                sql: 'SELECT id FROM strata_plans WHERE sp_number = ?',
                args: [sp_number],
            });

            if (planResult.rows.length > 0) {
                plan_id = planResult.rows[0][0];
            } else {
                const newPlanResult = await transaction.execute({
                    sql: 'INSERT INTO strata_plans (sp_number, suburb) VALUES (?, ?) RETURNING id',
                    args: [sp_number, 'Imported'],
                });
                plan_id = newPlanResult.rows[0][0];
            }

            // Corrected SQL to match the final schema
            await transaction.execute({
                sql: `
                    INSERT INTO strata_owners (plan_id, lot_number, unit_number, name_on_title, main_contact_name, levy_entitlement)
                    VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(plan_id, lot_number) DO UPDATE SET
                        unit_number = excluded.unit_number,
                        name_on_title = excluded.name_on_title,
                        main_contact_name = excluded.main_contact_name,
                        levy_entitlement = excluded.levy_entitlement;
                `,
                args: [plan_id, lot_number, unit_number, name_on_title, main_contact_name, levy_entitlement],
            });
        }

        await transaction.commit();
        res.json({ success: true, message: `Successfully imported/updated ${rows.length} records.` });

    } catch (err) {
        if (transaction) await transaction.rollback();
        console.error('[IMPORT ERROR]', err);
        res.status(500).json({ error: `An error occurred during import: ${err.message}` });
    }
});


// --- Existing API Endpoints ---
app.post('/api/login', async (req, res) => {
  try {
    const db = getDb();
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Missing credentials.' });
    }

    const result = await db.execute({
      sql: 'SELECT id, username, password_hash, role, plan_id FROM users WHERE username = ?',
      args: [username]
    });

    if (result.rows.length === 0) {
        return res.status(401).json({ error: 'Invalid username or password.' });
    }

    const userObject = rowsToObjects(result)[0];

    if (!bcrypt.compareSync(password, userObject.password_hash)) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }
    
    const { id, role, plan_id } = userObject;
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

app.get('/api/strata-plans', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const result = await db.execute('SELECT sp_number, suburb FROM strata_plans ORDER BY sp_number');
    const plans = rowsToObjects(result);
    res.json({ success: true, plans });
  } catch (err) {
    console.error('[STRATA PLANS ERROR]', err);
    res.status(500).json({ error: `Could not load strata plans: ${err.message}` });
  }
});

app.get('/api/users', authenticate, isAdmin, async (req, res) => {
    try {
        const db = getDb();
        const result = await db.execute('SELECT u.username, u.role, sp.sp_number as spAccess FROM users u LEFT JOIN strata_plans sp ON u.plan_id = sp.id');
        const users = rowsToObjects(result);
        res.json({ success: true, users });
    } catch (err) {
        console.error('[GET USERS ERROR]', err);
        res.status(500).json({ error: 'Failed to fetch users.' });
    }
});

app.post('/api/users', authenticate, isAdmin, async (req, res) => {
    try {
        const { username, password, role, spAccess } = req.body;
        const db = getDb();

        if (!username || !password || !role) {
            return res.status(400).json({ error: 'Username, password, and role are required.' });
        }
        
        let plan_id = null;
        if (role === 'User') {
            if (!spAccess) return res.status(400).json({ error: 'SP Access is required for the User role.' });
            
            const planResult = await db.execute({
                sql: 'SELECT id FROM strata_plans WHERE sp_number = ?',
                args: [spAccess]
            });

            if (planResult.rows.length === 0) return res.status(400).json({ error: `Strata Plan with number ${spAccess} not found.` });
            plan_id = planResult.rows[0][0];
        }

        const salt = bcrypt.genSaltSync(10);
        const password_hash = bcrypt.hashSync(password, salt);

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

app.delete('/api/users/:username', authenticate, isAdmin, async (req, res) => {
    try {
        const { username } = req.params;
        if (username === req.user.username) return res.status(400).json({ error: 'Cannot delete your own user account.' });
        
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

app.patch('/api/users/:username/password', authenticate, async (req, res) => {
    try {
        const { username } = req.params;
        const { newPassword } = req.body;

        if (username !== req.user.username) return res.status(403).json({ error: 'Forbidden: You can only change your own password.' });
        if (!newPassword) return res.status(400).json({ error: 'New password is required.' });
        
        const db = getDb();
        const salt = bcrypt.genSaltSync(10);
        const password_hash = bcrypt.hashSync(newPassword, salt);

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

app.patch('/api/users/:username/plan', authenticate, isAdmin, async (req, res) => {
    try {
        const { username } = req.params;
        const { plan_id: spNumber } = req.body; 
        const db = getDb();
        
        let newPlanId = null;
        if (spNumber) {
            const planResult = await db.execute({
                sql: 'SELECT id FROM strata_plans WHERE sp_number = ?',
                args: [spNumber]
            });
            if (planResult.rows.length === 0) return res.status(400).json({ error: `Strata Plan with number ${spNumber} not found.`});
            newPlanId = planResult.rows[0][0];
        }

        await db.execute({
            sql: 'UPDATE users SET plan_id = ? WHERE username = ?',
            args: [newPlanId, username]
        });
        res.json({ success: true, message: 'Plan access updated.' });
    } catch (err) {
        console.error('[UPDATE PLAN ERROR]', err);
        res.status(500).json({ error: 'Failed to update plan access.' });
    }
});

app.post('/api/users/:username/reset-password', authenticate, isAdmin, async (req, res) => {
    try {
        const { username } = req.params;
        const defaultPassword = 'Password123!';
        
        const salt = bcrypt.genSaltSync(10);
        const password_hash = bcrypt.hashSync(defaultPassword, salt);
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

app.use((err, req, res, next) => {
  console.error('[GLOBAL ERROR]', err);
  res.status(500).json({ error: `Server encountered an error: ${err.message}` });
});

export default app;