import express from 'express';
import { createClient } from '@libsql/client';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import Papa from 'papaparse';
import nodemailer from 'nodemailer';
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';


const app = express();
app.use(express.json({ limit: '10mb' }));

// --- Email and PDF Endpoint ---
app.post('/api/report/email', authenticate, async (req, res) => {
    const { recipientEmail, reportHtml, meetingTitle } = req.body;

    if (!recipientEmail || !reportHtml || !meetingTitle) {
        return res.status(400).json({ error: 'Missing required report data.' });
    }

    try {
        // 1. Generate PDF from HTML
        const browser = await puppeteer.launch({
            args: chromium.args,
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
        });
        const page = await browser.newPage();
        await page.setContent(reportHtml, { waitUntil: 'networkidle0' });
        const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
        await browser.close();
    
        // 2. Send Email with PDF Attachment
        // IMPORTANT: Replace with your own email service credentials from environment variables
        const transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST, // e.g., 'smtp.gmail.com'
            port: process.env.SMTP_PORT, // e.g., 587
            secure: process.env.SMTP_PORT == 465, // true for 465, false for other ports
            auth: {
                user: process.env.SMTP_USER, // Your email address
                pass: process.env.SMTP_PASS, // Your email password or app-specific password
            },
        });

        await transporter.sendMail({
            from: `"Strata Attendance App" <${process.env.SMTP_USER}>`,
            to: recipientEmail,
            subject: `Attendance Report: ${meetingTitle}`,
            text: `Please find the attendance report for "${meetingTitle}" attached.`,
            attachments: [
                {
                    filename: 'Attendance-Report.pdf',
                    content: pdfBuffer,
                    contentType: 'application/pdf',
                },
            ],
        });

        res.json({ success: true, message: `Report sent to ${recipientEmail}` });

    } catch (err) {
        console.error('[EMAIL REPORT ERROR]', err);
        res.status(500).json({ error: `Failed to send report: ${err.message}` });
    }
});


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
app.get('/api/meetings/:spNumber', authenticate, async (req, res) => {
    try {
        const { spNumber } = req.params;
        const db = getDb();
        const result = await db.execute({
            sql: `SELECT m.id, m.meeting_date, m.meeting_type, m.quorum_total
                  FROM meetings m
                  JOIN strata_plans sp ON m.plan_id = sp.id
                  WHERE sp.sp_number = ?
                  ORDER BY m.meeting_date DESC`,
            args: [spNumber],
        });
        res.json({ success: true, meetings: rowsToObjects(result) });
    } catch (err) {
        console.error('[GET ALL MEETINGS ERROR]', err);
        res.status(500).json({ error: 'Failed to fetch meetings.' });
    }
});

app.get('/api/meetings/:spNumber/:date', authenticate, async (req, res) => {
    try {
        const { spNumber, date } = req.params;
        const db = getDb();
        const result = await db.execute({
            sql: `SELECT m.id, m.meeting_date, m.meeting_type, m.quorum_total 
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

        let meetingResult = await db.execute({
            sql: 'SELECT id, meeting_type, quorum_total FROM meetings WHERE plan_id = ? AND meeting_date = ? AND meeting_type = ?',
            args: [plan_id, meetingDate, meetingType],
        });

        if (meetingResult.rows.length > 0) {
            return res.status(200).json({
                success: true,
                message: 'Existing meeting found.',
                meeting: rowsToObjects(meetingResult)[0]
            });
        }

        const insertResult = await db.execute({
            sql: 'INSERT INTO meetings (plan_id, meeting_date, meeting_type, quorum_total) VALUES (?, ?, ?, ?) RETURNING id',
            args: [plan_id, meetingDate, meetingType, quorumTotal],
        });

        const newMeetingId = insertResult.rows[0][0];

        res.status(201).json({
            success: true,
            message: 'Meeting created successfully.',
            meeting: {
                id: newMeetingId,
                meeting_type: meetingType,
                quorum_total: quorumTotal
            }
        });

    } catch (err) {
        if (err.message && err.message.includes('UNIQUE constraint failed')) {
            return res.status(409).json({ error: 'A meeting for this plan already exists on this date with a different type.' });
        }
        console.error('[CREATE MEETING ERROR]', err);
        res.status(500).json({ error: 'Failed to create meeting.' });
    }
});


// --- ATTENDANCE ENDPOINTS ---
app.get('/api/attendance/:spNumber/:date', authenticate, async (req, res) => {
    try {
        const { spNumber, date } = req.params;
        const db = getDb();
        const result = await db.execute({
            sql: `SELECT a.id, a.lot, a.owner_name, a.rep_name, a.is_financial, a.is_proxy
                  FROM attendance a
                  JOIN meetings m ON a.meeting_id = m.id
                  JOIN strata_plans sp ON m.plan_id = sp.id
                  WHERE sp.sp_number = ? AND m.meeting_date = ?`,
            args: [spNumber, date]
        });
        res.json({ success: true, attendees: rowsToObjects(result) });
    } catch (err) {
        console.error('[GET ATTENDANCE ERROR]', err);
        res.status(500).json({ error: 'Failed to fetch attendance records.' });
    }
});

app.delete('/api/attendance/:id', authenticate, async (req, res) => {
    try {
        const { id } = req.params;
        const db = getDb();
        await db.execute({
            sql: 'DELETE FROM attendance WHERE id = ?',
            args: [id]
        });
        res.status(204).send();
    } catch (err) {
        console.error('[DELETE ATTENDANCE ERROR]', err);
        res.status(500).json({ error: 'Failed to delete attendance record.' });
    }
});

app.post('/api/attendance/batch', authenticate, async (req, res) => {
    const { meetingId, submissions } = req.body;

    if (!meetingId || !submissions || !Array.isArray(submissions) || submissions.length === 0) {
        return res.status(400).json({ error: 'meetingId and submissions array are required.' });
    }

    const db = getDb();
    const tx = await db.transaction('write');
    try {
        const spNumbers = [...new Set(submissions.map(s => String(s.sp)))];
        
        const planIdsResult = await tx.execute({
            sql: `SELECT id, sp_number FROM strata_plans WHERE sp_number IN (${'?,'.repeat(spNumbers.length).slice(0, -1)})`,
            args: spNumbers
        });

        const planIdMap = new Map(
            planIdsResult.rows.map(row => [String(row[1]), row[0]])
        );

        for (const sub of submissions) {
            const plan_id = planIdMap.get(String(sub.sp));
            
            if (!plan_id) {
                console.warn(`[SKIPPED] SP number not found in map: "${sub.sp}"`);
                continue;
            }

            const rep_name = sub.rep_name || null;

            await tx.execute({
                sql: `DELETE FROM attendance
                      WHERE meeting_id = ? AND lot = ? AND owner_name = ? AND rep_name = ?`,
                args: [meetingId, sub.lot, sub.owner_name, rep_name]
            });

            await tx.execute({
                sql: `INSERT INTO attendance (plan_id, lot, owner_name, rep_name, is_financial, is_proxy, meeting_id)
                      VALUES (?, ?, ?, ?, ?, ?, ?)`,
                args: [plan_id, sub.lot, sub.owner_name, rep_name, sub.is_financial ? 1 : 0, sub.is_proxy ? 1 : 0, meetingId]
            });
        }

        await tx.commit();
        res.status(201).json({ success: true, message: 'Batch processed successfully.' });
        
    } catch (err) {
        if (tx) await tx.rollback();
        console.error('[BATCH SUBMIT ERROR]', {
            message: err.message,
            stack: err.stack,
        });
        res.status(500).json({ error: `An error occurred during batch submission: ${err.message}` });
    }
});


app.post('/api/attendance/verify', authenticate, async (req, res) => {
    const { records } = req.body;
    if (!records || !Array.isArray(records) || records.length === 0) {
        return res.status(400).json({ error: 'No records provided for verification.' });
    }

    const db = getDb();
    try {
        const conditions = [];
        const args = [];
        for (const record of records) {
            conditions.push(`(sp.sp_number = ? AND a.lot = ? AND date(a.timestamp) = ?)`);
            args.push(record.sp, record.lot, record.meetingDate);
        }

        const sql = `
            SELECT sp.sp_number, a.lot, date(a.timestamp) as meeting_date
            FROM attendance a
            JOIN strata_plans sp ON a.plan_id = sp.id
            WHERE ${conditions.join(' OR ')}
        `;

        const result = await db.execute({ sql, args });
        res.json({ success: true, verified: rowsToObjects(result) });

    } catch (err) {
        console.error('[VERIFY ATTENDANCE ERROR]', err);
        res.status(500).json({ error: 'Failed to verify attendance records.' });
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
