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
  cachedDb = createClient({ url, authToken: token });
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

// --- Meeting Endpoints ---
app.get('/api/meetings/:spNumber/:date', authenticate, async (req, res) => {
    try {
        const { spNumber, date } = req.params;
        const db = getDb();
        const result = await db.execute({
            sql: `SELECT m.meeting_type, m.quorum_total 
                  FROM meetings m
                  JOIN strata_plans sp ON m.plan_id = sp.id
                  WHERE sp.sp_number = ? AND m.meeting_date = ?`,
            args: [spNumber, date],
        });
        if (result.rows.length > 0) {
            res.json({ success: true, meeting: rowsToObjects(result)[0] });
        } else {
            res.json({ success: false, message: 'No meeting found for this date.' });
        }
    } catch (err) {
        console.error('[GET MEETING ERROR]', err);
        res.status(500).json({ error: 'Failed to check for meeting.' });
    }
});

app.post('/api/meetings', authenticate, async (req, res) => {
    try {
        const { spNumber, meetingDate, meetingType, quorumTotal } = req.body;
        if (!spNumber || !meetingDate || !meetingType || !quorumTotal) {
            return res.status(400).json({ error: 'Missing meeting details.' });
        }
        const db = getDb();
        const planResult = await db.execute({
            sql: 'SELECT id FROM strata_plans WHERE sp_number = ?',
            args: [spNumber],
        });
        if (planResult.rows.length === 0) {
            return res.status(404).json({ error: 'Strata plan not found.' });
        }
        const plan_id = planResult.rows[0][0];
        await db.execute({
            sql: 'INSERT INTO meetings (plan_id, meeting_date, meeting_type, quorum_total) VALUES (?, ?, ?, ?)',
            args: [plan_id, meetingDate, meetingType, quorumTotal],
        });
        res.status(201).json({ success: true, message: 'Meeting created successfully.' });
    } catch (err) {
        if (err.message && err.message.includes('UNIQUE constraint failed')) {
            return res.status(409).json({ error: 'A meeting for this plan already exists on this date.' });
        }
        console.error('[CREATE MEETING ERROR]', err);
        res.status(500).json({ error: 'Failed to create meeting.' });
    }
});

// --- ATTENDANCE ENDPOINTS (Corrected for the confirmed schema) ---

// GET all synced attendance records for a specific meeting date
app.get('/api/attendance/:spNumber/:date', authenticate, async (req, res) => {
    try {
        const { spNumber, date } = req.params;
        const db = getDb();
        const result = await db.execute({
            sql: `SELECT a.lot, a.owner_name, a.rep_name, a.is_financial, a.is_proxy
                  FROM attendance a
                  JOIN strata_plans sp ON a.plan_id = sp.id
                  WHERE sp.sp_number = ? AND date(a.timestamp) = ?`,
            args: [spNumber, date]
        });
        res.json({ success: true, attendees: rowsToObjects(result) });
    } catch (err) {
        console.error('[GET ATTENDANCE ERROR]', err);
        res.status(500).json({ error: 'Failed to fetch attendance records.' });
    }
});

// DELETE a single synced attendance record for a specific date
app.delete('/api/attendance/:spNumber/:date/:lot', authenticate, async (req, res) => {
    try {
        const { spNumber, date, lot } = req.params;
        const db = getDb();
        const planResult = await db.execute({
            sql: 'SELECT id FROM strata_plans WHERE sp_number = ?',
            args: [spNumber],
        });
        if (planResult.rows.length === 0) {
            return res.status(404).json({ error: 'Strata plan not found.' });
        }
        const plan_id = planResult.rows[0][0];

        await db.execute({
            sql: 'DELETE FROM attendance WHERE plan_id = ? AND lot = ? AND date(timestamp) = ?',
            args: [plan_id, lot, date]
        });
        res.status(204).send();
    } catch (err) {
        console.error('[DELETE ATTENDANCE ERROR]', err);
        res.status(500).json({ error: 'Failed to delete attendance record.' });
    }
});

// POST a batch of submissions from the offline queue
app.post('/api/attendance/batch', authenticate, async (req, res) => {
    const { submissions } = req.body;
    if (!submissions || !Array.isArray(submissions) || submissions.length === 0) {
        return res.status(400).json({ error: 'No submissions provided.' });
    }

    const db = getDb();
    const tx = await db.transaction('write');
    try {
        const spNumbers = [...new Set(submissions.map(s => s.sp))];
        const planIdsResult = await tx.execute({
            sql: `SELECT id, sp_number FROM strata_plans WHERE sp_number IN (${'?,'.repeat(spNumbers.length).slice(0, -1)})`,
            args: spNumbers
        });
        const planIdMap = new Map(planIdsResult.rows.map(row => [row[1], row[0]]));

        for (const sub of submissions) {
            const plan_id = planIdMap.get(sub.sp);
            if (!plan_id) continue;

            // "Upsert" logic: Delete any existing record for this lot on this day, then insert the new one.
            await tx.execute({
                sql: `DELETE FROM attendance WHERE plan_id = ? AND lot = ? AND date(timestamp) = ?`,
                args: [plan_id, sub.lot, sub.meetingDate]
            });

            await tx.execute({
                sql: `INSERT INTO attendance (plan_id, lot, owner_name, rep_name, is_financial, is_proxy)
                      VALUES (?, ?, ?, ?, ?, ?)`,
                args: [plan_id, sub.lot, sub.owner_name, sub.rep_name, sub.is_financial, sub.is_proxy]
            });
        }

        await tx.commit();
        res.status(201).json({ success: true, message: 'Batch processed successfully.' });
    } catch (err) {
        await tx.rollback();
        console.error('[BATCH SUBMIT ERROR]', err);
        res.status(500).json({ error: `An error occurred during batch submission: ${err.message}` });
    }
});


// --- User & Plan Endpoints ---
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
    const { role, plan_id } = req.user;
    let result;
    if (role === 'Admin') {
      result = await db.execute('SELECT sp_number, suburb FROM strata_plans ORDER BY sp_number');
    } else {
      result = await db.execute({
          sql: 'SELECT sp_number, suburb FROM strata_plans WHERE id = ?',
          args: [plan_id],
      });
    }
    const plans = rowsToObjects(result);
    res.json({ success: true, plans });
  } catch (err) {
    console.error('[STRATA PLANS ERROR]', err);
    res.status(500).json({ error: `Could not load strata plans: ${err.message}` });
  }
});

app.get('/api/strata-plans/:planId/owners', authenticate, async (req, res) => {
    try {
        const { planId } = req.params;
        const db = getDb();
        const planResult = await db.execute({
            sql: 'SELECT id FROM strata_plans WHERE sp_number = ?',
            args: [planId],
        });
        if (planResult.rows.length === 0) {
            return res.status(404).json({ error: 'Strata plan not found.' });
        }
        const internalPlanId = planResult.rows[0][0];
        const ownersResult = await db.execute({
            sql: 'SELECT lot_number, unit_number, name_on_title, main_contact_name FROM strata_owners WHERE plan_id = ?',
            args: [internalPlanId],
        });
        const owners = rowsToObjects(ownersResult);
        res.json({ success: true, owners });
    } catch (err) {
        console.error('[GET OWNERS ERROR]', err);
        res.status(500).json({ error: 'Failed to fetch owner data.' });
    }
});

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
            const name_on_title = row[5] || '';
            const main_contact_name = row[6] || '';
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
        res.json({ success: true, message: 'Password changed successfully.' });
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