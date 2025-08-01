## api/index.js
```javascript
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
        console.log('Chromium executable path:', await chromium.executablePath());
        // 1. Generate PDF from HTML
        const browser = await puppeteer.launch({
            // FIX: Add the '--no-sandbox' flag to the arguments.
            args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox'],
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(),
            headless: "new",
        });
        const page = await browser.newPage();
        await page.setContent(reportHtml, { waitUntil: 'networkidle0' });
        const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
        await browser.close();
    
        // 2. Send Email with PDF Attachment
        const transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: process.env.SMTP_PORT,
            secure: process.env.SMTP_PORT == 465,
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS,
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

```

## api/test-chrome.js
```javascript
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';

// export default async function handler(req, res) {
//   try {
//     const browser = await puppeteer.launch({
//       args: [...chromium.args, '--no-sandbox'],
//       executablePath: await chromium.executablePath(),
//       headless: 'new',
//     });
//     const page = await browser.newPage();
//     await page.setContent('<h1>Hello from Puppeteer</h1>');
//     const pdf = await page.pdf({ format: 'A4' });
//     await browser.close();
//     res.setHeader('Content-Type', 'application/pdf');
//     res.send(pdf);
//   } catch (err) {
//     console.error('[TEST CHROME ERROR]', err);
//     res.status(500).json({ error: err.message });
//   }
// }

export default function handler(req, res) {
  res.status(200).json({ message: "API route is working!" });
}

// api/test-chrome.js
```

## package.json
```json
{
  "name": "strata-attendance-fullstack",
  "version": "1.0.0",
  "description": "Full-stack Strata Attendance App",
  "main": "api/index.js",
  "type": "module",
  "scripts": {
    "start": "node api/index.js"
  },
  "dependencies": {
    "@libsql/client": "^0.15.10",
    "@sparticuz/chromium": "^123.0.1",
    "bcrypt": "^6.0.0",
    "express": "^4.19.2",
    "jsonwebtoken": "^9.0.2",
    "nodemailer": "^6.9.14",
    "papaparse": "^5.5.3",
    "puppeteer-core": "^22.12.1"
  },
  "engines": {
    "node": ">=18.x"
  }
}

```

## public/app.js
```javascript
import {
  handleLogin,
  handleLogout,
  loadUsers,
  handleAddUser,
  handleChangePassword,
  handleChangeSpAccess,
  handleResetPassword,
  handleRemoveUser,
  handleImportCsv
} from './auth.js';

import {
    showModal,
    clearStrataCache,
    apiGet,
    apiPost,
    apiDelete,
    showToast,
    debounce,
    showMeetingModal,
    getSubmissionQueue,
    saveSubmissionQueue
} from './utils.js';

import {
    renderStrataPlans,
    resetUiOnPlanChange,
    renderOwnerCheckboxes,
    updateDisplay,
    updateSyncButton
} from './ui.js';

import { EMAIL_REGEX } from './config.js';

// --- DOM Elements ---
const loginForm = document.getElementById('login-form');
const logoutBtn = document.getElementById('logout-btn');
const changePasswordBtn = document.getElementById('change-password-btn');
const addUserBtn = document.getElementById('add-user-btn');
const clearCacheBtn = document.getElementById('clear-cache-btn');
const userListBody = document.getElementById('user-list-body');
const loginSection = document.getElementById('login-section');
const mainApp = document.getElementById('main-app');
const userDisplay = document.getElementById('user-display');
const adminPanel = document.getElementById('admin-panel');
const strataPlanSelect = document.getElementById('strata-plan-select');
const lotNumberInput = document.getElementById('lot-number');
const checkInTabBtn = document.getElementById('check-in-tab-btn');
const meetingDateBtn = document.getElementById('meeting-date-btn');
const emailPdfBtn = document.getElementById('email-pdf-btn');

// --- App State ---
let currentStrataPlan = null;
let currentMeetingId = null;
let currentMeetingDate = null;
let currentMeetingType = null;
let strataPlanCache = {};
let currentSyncedAttendees = [];
let currentTotalLots = 0;
let isSyncing = false;
let autoSyncIntervalId = null;
let isAppInitialized = false;

/**
 * Generates the HTML content for the PDF report.
 */
function generateReportHtml() {
    const allAttendees = [...currentSyncedAttendees, ...getSubmissionQueue().filter(s => s.sp === currentStrataPlan)];
    allAttendees.sort((a, b) => a.lot - b.lot);

    let tableRows = '';
    let uniqueLots = new Set();
    let peopleCount = 0;
    let proxyCount = 0;
    let companyCount = 0;

    allAttendees.forEach((item, index) => {
        const lotData = strataPlanCache ? strataPlanCache[item.lot] : null;
        const unitNumber = lotData ? (lotData[2] || 'N/A') : 'N/A';
        const isProxy = item.is_proxy;
        const isCompany = !isProxy && item.rep_name && item.rep_name !== 'N/A';
        
        let ownerRepName;
        let companyName = '';

        uniqueLots.add(item.lot);

        if (isProxy) {
            ownerRepName = item.rep_name;
            proxyCount++;
        } else if (isCompany) {
            ownerRepName = item.owner_name;
            companyName = item.rep_name;
            companyCount++;
            if (item.rep_name) peopleCount++; // Count the rep as a person
        } else {
            ownerRepName = item.owner_name;
            // Count multiple people if "and" or "&" is present
            peopleCount += (ownerRepName.match(/(&|and)/gi) || []).length + 1;
        }

        const rowStyle = index % 2 === 0 ? '' : 'background-color: #f0f0f2;';

        tableRows += `
            <tr style="${rowStyle}">
                <td style="border: 1px solid #ddd; padding: 10px;">${item.lot}</td>
                <td style="border: 1px solid #ddd; padding: 10px;">${unitNumber}</td>
                <td style="border: 1px solid #ddd; padding: 10px;">${ownerRepName}</td>
                <td style="border: 1px solid #ddd; padding: 10px;">${companyName}</td>
            </tr>
        `;
    });

    const formattedDate = new Date(currentMeetingDate + 'T00:00:00').toLocaleDateString('en-AU', {
        day: 'numeric', month: 'long', year: 'numeric'
    });

    return `
        <!DOCTYPE html>
        <html>
        <head>
            <title>Attendance Report</title>
            <style>
                body { font-family: Arial, sans-serif; margin: 20px; color: #333; }
                table { width: 100%; border-collapse: collapse; }
                th, td { border: 1px solid #ddd; padding: 10px; text-align: left; }
                th { background-color: #f2f2f2; }
            </style>
        </head>
        <body>
            <div style="text-align: center; margin-bottom: 20px;">
                <h1 style="margin: 0; font-size: 24px;">Strata Plan ${currentStrataPlan} - Attendance Report</h1>
                <p style="margin: 5px 0 0; font-size: 16px; color: #555;">
                    <strong>Meeting Type:</strong> ${currentMeetingType} | <strong>Date:</strong> ${formattedDate}
                </p>
            </div>
            <table>
                <thead>
                    <tr>
                        <th>Lot</th>
                        <th>Unit</th>
                        <th>Owner/Rep</th>
                        <th>Company</th>
                    </tr>
                </thead>
                <tbody>
                    ${tableRows}
                </tbody>
            </table>
            <div style="margin-top: 25px; padding-top: 15px; border-top: 1px solid #ccc; width: 300px; margin-left: auto;">
                <div style="display: flex; justify-content: space-between; padding: 4px 0;">
                    <span style="font-weight: bold;">Unique Lots Represented:</span>
                    <span>${uniqueLots.size}</span>
                </div>
                <div style="display: flex; justify-content: space-between; padding: 4px 0;">
                    <span style="font-weight: bold;">People in Attendance:</span>
                    <span>${peopleCount}</span>
                </div>
                <div style="display: flex; justify-content: space-between; padding: 4px 0;">
                    <span style="font-weight: bold;">Proxies Received:</span>
                    <span>${proxyCount}</span>
                </div>
                <div style="display: flex; justify-content: space-between; padding: 4px 0;">
                    <span style="font-weight: bold;">Companies Represented:</span>
                    <span>${companyCount}</span>
                </div>
            </div>
        </body>
        </html>
    `;
}


/**
 * Handles the click event for the "Email PDF Report" button.
 */
async function handleEmailReport() {
    if (!currentStrataPlan || !currentMeetingDate) {
        showToast('Please select a meeting before generating a report.', 'error');
        return;
    }

    const res = await showModal('Enter the recipient\'s email address:', { showInput: true, confirmText: 'Send Email' });
    if (!res.confirmed || !res.value) return;

    const recipientEmail = res.value.trim();
    if (!EMAIL_REGEX.test(recipientEmail)) {
        showToast('Invalid email address provided.', 'error');
        return;
    }

    showToast('Generating and sending report...', 'info');
    emailPdfBtn.disabled = true;

    try {
        const reportHtml = generateReportHtml();
        const meetingTitle = `${currentMeetingType} - SP ${currentStrataPlan}`;
        
        const result = await apiPost('/report/email', {
            recipientEmail,
            reportHtml,
            meetingTitle
        });

        if (result.success) {
            showToast(result.message, 'success');
        } else {
            throw new Error(result.error);
        }
    } catch (err) {
        console.error('Failed to email report:', err);
        showToast(`Error: ${err.message}`, 'error');
    } finally {
        emailPdfBtn.disabled = false;
    }
}


/**
 * Handles the main form submission for checking in an attendee.
 */
function handleFormSubmit(event) {
    event.preventDefault();
    const form = event.target;

    const lot = lotNumberInput.value.trim();
    if (!currentStrataPlan || !lot) {
        showToast('Please select a plan and enter a lot number.', 'error');
        return;
    }

    const companyRep = document.getElementById('company-rep').value.trim();
    const proxyHolderLot = document.getElementById('proxy-holder-lot').value.trim();
    const isFinancial = document.getElementById('is-financial').checked;
    const isProxy = document.getElementById('is-proxy').checked;

    const companyNameHidden = document.getElementById('company-name-hidden');
    const companyName = companyNameHidden ? companyNameHidden.value : null;
    const selectedNames = Array.from(document.querySelectorAll('input[name="owner"]:checked')).map(cb => cb.value);

    let owner_name = companyName || selectedNames.join(', ');

    if (isProxy) {
        const ownerData = strataPlanCache[lot];
        if (ownerData) {
            owner_name = ownerData[0] || ownerData[1];
        }
    }

    if (!owner_name) {
        showToast(`Could not find owner data for Lot ${lot}. Please check the lot number.`, 'error');
        return;
    }
     if (isProxy && !proxyHolderLot) {
        showToast('Please enter the Proxy Holder Lot Number.', 'error');
        return;
    }

    let rep_name;
    if (isProxy) {
        rep_name = `Proxy - Lot ${proxyHolderLot}`;
    } else if (companyName) {
        rep_name = companyRep;
    } else {
        rep_name = 'N/A';
    }

    const submission = {
        submissionId: `sub_${Date.now()}_${Math.random()}`,
        sp: currentStrataPlan,
        lot: lot,
        owner_name: owner_name,
        rep_name: rep_name,
        is_financial: isFinancial,
        is_proxy: isProxy,
    };

    const queue = getSubmissionQueue();
    queue.push(submission);
    saveSubmissionQueue(queue);

    updateDisplay(currentStrataPlan, currentSyncedAttendees, currentTotalLots, strataPlanCache);
    showToast(`Lot ${lot} queued for submission.`, 'info');

    form.reset();
    document.getElementById('company-rep-group').style.display = 'none';
    document.getElementById('proxy-holder-group').style.display = 'none';
    document.getElementById('checkbox-container').innerHTML = '<p>Enter a Lot Number.</p>';
    
    document.getElementById('checkbox-container').style.display = 'block';
    document.getElementById('owner-label').style.display = 'block';

    lotNumberInput.focus();
}

/**
 * Sends the queued submissions to the server.
 */
async function syncSubmissions() {
    if (isSyncing || !navigator.onLine) return;

    const allItems = getSubmissionQueue();
    if (allItems.length === 0) {
        updateSyncButton();
        return;
    }
    
    // Isolate the batch to be synced.
    const batchToSync = allItems.filter(item => item.sp === currentStrataPlan);
    if (batchToSync.length === 0) return;

    // Remove the items for the current plan from the main queue
    const remainingItems = allItems.filter(item => item.sp !== currentStrataPlan);
    saveSubmissionQueue(remainingItems);

    isSyncing = true;
    updateSyncButton(true);
    showToast(`Syncing ${batchToSync.length} item(s)...`, 'info');

    document.querySelectorAll('.delete-btn[data-type="queued"]').forEach(btn => btn.disabled = true);

    try {
        const postResult = await apiPost('/attendance/batch', {
            meetingId: currentMeetingId,
            submissions: batchToSync
        });

        if (!postResult || !postResult.success) {
            throw new Error(postResult.error || 'Batch submission failed.');
        }

        showToast(`Successfully synced ${batchToSync.length} item(s).`, 'success');

    } catch (error) {
        console.error('[SYNC FAILED]', error);
        showToast(`Sync failed: ${error.message}. Items have been re-queued.`, 'error');

        const currentQueue = getSubmissionQueue();
        saveSubmissionQueue([...batchToSync, ...currentQueue]);

    } finally {
        isSyncing = false;
        if (currentStrataPlan && currentMeetingDate) {
            const data = await apiGet(`/attendance/${currentStrataPlan}/${currentMeetingDate}`);
            if (data.success) {
                currentSyncedAttendees = data.attendees.map(a => ({...a, status: 'synced'}));
            }
        }
        updateDisplay(currentStrataPlan, currentSyncedAttendees, currentTotalLots, strataPlanCache);
    }
}

/**
 * Handles deleting an attendee record.
 */
async function handleDelete(event) {
    const button = event.target;
    if (!button.matches('.delete-btn')) return;

    const type = button.dataset.type;

    if (type === 'queued') {
        const submissionId = button.dataset.submissionId;
        let queue = getSubmissionQueue();
        queue = queue.filter(item => item.submissionId !== submissionId);
        saveSubmissionQueue(queue);
        updateDisplay(currentStrataPlan, currentSyncedAttendees, currentTotalLots, strataPlanCache);
        showToast('Queued item removed.', 'info');
    } else if (type === 'synced') {
        const attendanceId = button.dataset.id;
        const lotValue = button.dataset.lot;
        const confirm = await showModal(`Are you sure you want to delete the record for Lot ${lotValue}? This cannot be undone.`, { confirmText: 'Yes, Delete' });
        if (!confirm.confirmed) return;

        try {
            await apiDelete(`/attendance/${attendanceId}`);
            currentSyncedAttendees = currentSyncedAttendees.filter(a => a.id != attendanceId);
            updateDisplay(currentStrataPlan, currentSyncedAttendees, currentTotalLots, strataPlanCache);
            showToast(`Record for Lot ${lotValue} deleted.`, 'success');
        } catch (error) {
            console.error('Delete failed:', error);
            showToast(`Failed to delete record: ${error.message}`, 'error');
        }
    }
}

/**
 * Loads the main application view for a given meeting.
 */
async function loadMeeting(spNumber, meetingData) {
    try {
        const { id, meetingDate, meetingType, quorumTotal } = meetingData;
        
        sessionStorage.setItem('activeMeeting', JSON.stringify({ spNumber, ...meetingData }));

        currentStrataPlan = spNumber;
        currentMeetingId = id;
        currentMeetingDate = meetingDate;
        currentMeetingType = meetingType;
        currentTotalLots = quorumTotal;

        const formattedDate = new Date(meetingDate + 'T00:00:00').toLocaleDateString('en-AU', {
            day: 'numeric', month: 'long', year: 'numeric'
        });
        document.getElementById('meeting-title').textContent = `${meetingType} - SP ${spNumber}`;
        meetingDateBtn.textContent = formattedDate;
        meetingDateBtn.style.display = 'inline-block';

        const cachedData = localStorage.getItem(`strata_${spNumber}`);
        if (cachedData) {
            strataPlanCache = JSON.parse(cachedData);
        } else {
            const data = await apiGet(`/strata-plans/${spNumber}/owners`);
            if (!data.success) throw new Error(data.error);
            if (Array.isArray(data.owners)) {
                strataPlanCache = data.owners.reduce((acc, owner) => {
                    acc[owner.lot_number] = [owner.main_contact_name, owner.name_on_title, owner.unit_number];
                    return acc;
                }, {});
            } else {
                strataPlanCache = {};
            }
            localStorage.setItem(`strata_${spNumber}`, JSON.stringify(strataPlanCache));
        }

        const attendeesData = await apiGet(`/attendance/${spNumber}/${meetingDate}`);
        if (attendeesData.success) {
            currentSyncedAttendees = attendeesData.attendees.map(a => ({...a, status: 'synced'}));
        }

        updateDisplay(spNumber, currentSyncedAttendees, currentTotalLots, strataPlanCache);
        document.getElementById('lot-number').disabled = false;
        document.getElementById('lot-number').focus();

        if (autoSyncIntervalId) clearInterval(autoSyncIntervalId);
        autoSyncIntervalId = setInterval(syncSubmissions, 60000);

    } catch (err) {
        console.error(`Failed to load data for SP ${spNumber}:`, err);
        showToast(`Error loading data for SP ${spNumber}: ${err.message}`, 'error');
        resetUiOnPlanChange();
    }
}

/**
 * Prompts the user to select or create a meeting.
 */
async function promptForMeeting(spNumber) {
    try {
        const allMeetingsResult = await apiGet(`/meetings/${spNumber}`);
        const existingMeetings = allMeetingsResult.success ? allMeetingsResult.meetings : [];

        const chosenMeetingResult = await showMeetingModal(existingMeetings);

        if (!chosenMeetingResult) {
            strataPlanSelect.value = '';
            currentStrataPlan = null;
            return;
        }

        let meetingDataToLoad;

        if (chosenMeetingResult.isNew) {
            const newMeetingResponse = await apiPost('/meetings', { spNumber, ...chosenMeetingResult });
            if (!newMeetingResponse.success) {
                throw new Error(newMeetingResponse.error || 'Failed to create new meeting.');
            }
            meetingDataToLoad = {
                id: newMeetingResponse.meeting.id,
                meetingDate: chosenMeetingResult.meetingDate,
                meetingType: newMeetingResponse.meeting.meeting_type,
                quorumTotal: newMeetingResponse.meeting.quorum_total,
            };
        } else {
            meetingDataToLoad = {
                id: chosenMeetingResult.id,
                meetingDate: chosenMeetingResult.meeting_date,
                meetingType: chosenMeetingResult.meeting_type,
                quorumTotal: chosenMeetingResult.quorum_total
            };
        }

        await loadMeeting(spNumber, meetingDataToLoad);
    } catch (err) {
        console.error(`Failed during meeting setup for SP ${spNumber}:`, err);
        showToast(`Error setting up meeting: ${err.message}`, 'error');
        resetUiOnPlanChange();
    }
}

async function handlePlanChange(event) {
    const spNumber = event.target.value;
    resetUiOnPlanChange();
    sessionStorage.removeItem('activeMeeting');

    if (autoSyncIntervalId) clearInterval(autoSyncIntervalId);

    if (!spNumber) {
        currentStrataPlan = null;
        currentMeetingDate = null;
        currentMeetingId = null;
        return;
    }

    document.cookie = `selectedSP=${spNumber};max-age=2592000;path=/;SameSite=Lax`;
    await promptForMeeting(spNumber);
}

async function initializeApp() {
    if (isAppInitialized) return;
    isAppInitialized = true;

    loginSection.classList.add('hidden');
    mainApp.classList.remove('hidden');

    checkInTabBtn.addEventListener('click', (e) => openTab(e, 'check-in-tab'));
    strataPlanSelect.addEventListener('change', handlePlanChange);
    meetingDateBtn.addEventListener('click', () => {
        if (currentStrataPlan) {
            promptForMeeting(currentStrataPlan);
        }
    });
    emailPdfBtn.addEventListener('click', handleEmailReport);
    lotNumberInput.addEventListener('input', debounce((e) => {
        if (e.target.value.trim() && strataPlanCache) {
            renderOwnerCheckboxes(e.target.value.trim(), strataPlanCache);
        }
    }, 300));
    document.getElementById('attendance-form').addEventListener('submit', handleFormSubmit);
    document.getElementById('attendee-table-body').addEventListener('click', handleDelete);
    document.getElementById('sync-btn').addEventListener('click', syncSubmissions);
    
    document.getElementById('is-proxy').addEventListener('change', (e) => {
        const isChecked = e.target.checked;
        document.getElementById('proxy-holder-group').style.display = isChecked ? 'block' : 'none';
        document.getElementById('checkbox-container').style.display = isChecked ? 'none' : 'block';
        document.getElementById('owner-label').style.display = isChecked ? 'none' : 'block';
    });

    const user = JSON.parse(sessionStorage.getItem('attendanceUser'));
    if (user) {
        userDisplay.textContent = user.username;
        if (user.role === 'Admin') {
            adminPanel.classList.remove('hidden');
            setupAdminEventListeners();
        }
    }

    try {
        const data = await apiGet('/strata-plans');
        if (data.success) {
            localStorage.setItem('strataPlans', JSON.stringify(data.plans));
            renderStrataPlans(data.plans);

            const savedSP = document.cookie.split('; ').find(row => row.startsWith('selectedSP='))?.split('=')[1];
            if (savedSP && strataPlanSelect.querySelector(`option[value="${savedSP}"]`)) {
                strataPlanSelect.value = savedSP;
            }

            const cachedMeeting = JSON.parse(sessionStorage.getItem('activeMeeting'));
            if (cachedMeeting && cachedMeeting.spNumber === strataPlanSelect.value) {
                showToast('Resuming previous meeting session.', 'info');
                await loadMeeting(cachedMeeting.spNumber, cachedMeeting);
            } else if (strataPlanSelect.value) {
                await promptForMeeting(strataPlanSelect.value);
            }

            if (user && user.role !== 'Admin' && data.plans.length === 1) {
                strataPlanSelect.value = data.plans[0].sp_number;
                strataPlanSelect.disabled = true;
                if (!cachedMeeting) {
                    strataPlanSelect.dispatchEvent(new Event('change'));
                }
            }
        } else {
            throw new Error(data.error || 'Failed to load strata plans.');
        }
    } catch (err) {
        console.error('Failed to initialize strata plans:', err);
        showToast('Error: Could not load strata plans.', 'error');
    }

    syncSubmissions();
}

function setupAdminEventListeners() {
    const adminTabBtn = document.getElementById('admin-tab-btn');
    if (adminTabBtn) {
        adminTabBtn.addEventListener('click', (e) => {
            openTab(e, 'admin-tab');
            loadUsers();
        });
    }
    logoutBtn.addEventListener('click', handleLogout);
    changePasswordBtn.addEventListener('click', handleChangePassword);
    addUserBtn.addEventListener('click', handleAddUser);
    clearCacheBtn.addEventListener('click', handleClearCache);
    userListBody.addEventListener('change', handleUserActions);

    const collapsibleToggle = document.querySelector('.collapsible-toggle');
    if (collapsibleToggle) {
        collapsibleToggle.addEventListener('click', function() {
            this.classList.toggle('active');
            const content = this.nextElementSibling;
            if (content.style.maxHeight) {
                content.style.maxHeight = null;
            } else {
                content.style.maxHeight = content.scrollHeight + "px";
            }
        });
    }
}

function openTab(evt, tabName) {
    document.querySelectorAll('.tab-content').forEach(tab => tab.style.display = 'none');
    document.querySelectorAll('.tab-link').forEach(link => link.classList.remove('active'));
    document.getElementById(tabName).style.display = 'block';
    if (evt.currentTarget) {
      evt.currentTarget.classList.add('active');
    }
}

function handleUserActions(e) {
    if (!e.target.matches('.user-actions-select')) return;
    const select = e.target;
    const username = select.dataset.username;
    const action = select.value;
    if (!action) return;
    switch (action) {
        case 'change_sp': handleChangeSpAccess(username); break;
        case 'reset_password': handleResetPassword(username); break;
        case 'remove': handleRemoveUser(e); break;
    }
    select.value = "";
}

function handleClearCache() {
    showModal("Are you sure you want to clear all cached data? This includes unsynced submissions.", { confirmText: 'Yes, Clear' })
        .then(res => {
            if (res.confirmed) {
                clearStrataCache();
                sessionStorage.removeItem('activeMeeting');
                saveSubmissionQueue([]);
                document.cookie = 'selectedSP=; max-age=0; path=/;';
                location.reload();
            }
        });
}

document.addEventListener('DOMContentLoaded', () => {
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const loginResult = await handleLogin(e);
    if (loginResult && loginResult.success) {
        initializeApp();
    }
  });

  const token = document.cookie.split('; ').find(r => r.startsWith('authToken='))?.split('=')[1];
  if (token) {
      initializeApp();
  }
});

```

## public/auth.js
```javascript
import { apiGet, apiPost, showToast, showModal } from './utils.js';
import { API_BASE } from './config.js';

function getAuthToken() {
  return document.cookie
    .split('; ')
    .find(r => r.startsWith('authToken='))
    ?.split('=')[1];
}

function authHeaders(json = true) {
  const token = getAuthToken();
  return {
    ...(json && { 'Content-Type': 'application/json' }),
    ...(token && { Authorization: `Bearer ${token}` })
  };
}

export async function handleLogin(event) {
  if (event) event.preventDefault();
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  const loginStatus = document.getElementById('login-status');

  if (!username || !password) {
    loginStatus.textContent = 'Username and password are required.';
    loginStatus.style.color = 'red';
    return null;
  }

  loginStatus.textContent = 'Logging in…';

  try {
    const data = await apiPost('/login', { username, password });
    if (data.success && data.token) {
      document.cookie = `authToken=${data.token};max-age=604800;path=/;SameSite=Lax`;
      sessionStorage.setItem('attendanceUser', JSON.stringify(data.user));
      if (data.scriptVersion) {
        sessionStorage.setItem('scriptVersion', data.scriptVersion);
      }
      return data;
    } else {
      throw new Error(data.error || 'Invalid username or password.');
    }
  } catch (err) {
    loginStatus.textContent = `Login failed: ${err.message}`;
    loginStatus.style.color = 'red';
    return null;
  }
}

export function handleLogout() {
  sessionStorage.removeItem('attendanceUser');
  document.cookie = 'authToken=; max-age=0; path=/;';
  location.reload();
}

export async function handleImportCsv(file) {
    const importStatus = document.getElementById('import-status');
    if (!file) {
        importStatus.textContent = 'Please select a file first.';
        importStatus.style.color = 'red';
        return;
    }

    const reader = new FileReader();
    reader.onload = async (event) => {
        const csvData = event.target.result;
        importStatus.textContent = 'Importing... This may take a moment.';
        importStatus.style.color = 'black';

        try {
            const data = await apiPost('/import-data', { csvData });
            if (data.success) {
                importStatus.textContent = data.message;
                importStatus.style.color = 'green';
                showToast('Import complete! The page will now reload.', 'success', 4000);
                setTimeout(() => location.reload(), 4000);
            } else {
                throw new Error(data.error);
            }
        } catch (err) {
            importStatus.textContent = `Import failed: ${err.message}`;
            importStatus.style.color = 'red';
        }
    };
    reader.readAsText(file);
}

export async function loadUsers() {
  try {
    const data = await apiGet('/users');
    if (!data.success) throw new Error(data.error || 'Failed to load users.');

    const currentUser = JSON.parse(sessionStorage.getItem('attendanceUser'));
    const tbody = document.getElementById('user-list-body');
    tbody.innerHTML = '';

    data.users.forEach(user => {
      const isSelf = user.username === currentUser.username;
      const actions = `
        <select class="user-actions-select" data-username="${user.username}">
          <option value="">Select Action</option>
          <option value="change_sp">Change SP Access</option>
          <option value="reset_password">Reset Password</option>
          ${!isSelf ? '<option value="remove">Remove User</option>' : ''}
        </select>
      `;
      tbody.insertAdjacentHTML('beforeend', `
        <tr>
          <td>${user.username}</td>
          <td>${user.role}</td>
          <td>${user.spAccess || 'All'}</td>
          <td>${actions}</td>
        </tr>
      `);
    });
  } catch (err) {
    console.error('loadUsers error:', err);
    if (err.message.includes('Authentication failed')) handleLogout();
  }
}

export async function handleAddUser() {
  const uRes = await showModal("Enter new user's username:", { showInput: true, confirmText: 'Next' });
  if (!uRes.confirmed || !uRes.value) return;

  const pRes = await showModal("Enter new user's password:", { showInput: true, inputType: 'password', confirmText: 'Next' });
  if (!pRes.confirmed || !pRes.value) return;

  const rRes = await showModal("Enter role (Admin or User):", { showInput: true, confirmText: 'Next' });
  if (!rRes.confirmed || !rRes.value) return;

  const role = rRes.value.trim();
  if (!['Admin', 'User'].includes(role)) {
    showToast('Role must be "Admin" or "User".', 'error');
    return;
  }

  let spAccess = '';
  if (role === 'User') {
    const spRes = await showModal("Enter SP Access number:", { showInput: true, confirmText: 'Add User' });
    if (!spRes.confirmed || !spRes.value) {
      showToast('SP Access is required for User role.', 'error');
      return;
    }
    spAccess = spRes.value;
  }

  try {
    const data = await apiPost('/users', { username: uRes.value, password: pRes.value, role, spAccess });
    if (data.success) {
      showToast('User added successfully.', 'success');
      loadUsers();
    } else {
      throw new Error(data.error);
    }
  } catch (err) {
    showToast(`Failed to add user: ${err.message}`, 'error');
    if (err.message.includes('Authentication failed')) handleLogout();
  }
}

export async function handleRemoveUser(e) {
  if (!e.target.matches('.user-actions-select')) return;
  if (e.target.value !== 'remove') {
    e.target.value = '';
    return;
  }

  const username = e.target.dataset.username;
  const confirm = await showModal(`Remove user "${username}"?`, { confirmText: 'Yes, Remove' });
  if (!confirm.confirmed) return;

  try {
    const res = await fetch(`${API_BASE}/users/${username}`, {
      method: 'DELETE',
      headers: authHeaders(false)
    });
    const data = await res.json();

    if (data.success) {
      showToast('User removed successfully.', 'success');
      loadUsers();
    } else {
      throw new Error(data.error);
    }
  } catch (err) {
    showToast(`Failed to remove user: ${err.message}`, 'error');
    if (err.message.includes('Authentication failed')) handleLogout();
  } finally {
    e.target.value = '';
  }
}

export async function handleChangePassword() {
  const pRes = await showModal("Enter your new password:", {
    showInput: true, inputType: 'password', confirmText: 'Change Password'
  });
  if (!pRes.confirmed || !pRes.value) {
    showToast('Password cannot be blank.', 'error');
    return;
  }

  try {
    const user = JSON.parse(sessionStorage.getItem('attendanceUser'));
    const res = await fetch(`${API_BASE}/users/${user.username}/password`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ newPassword: pRes.value })
    });
    const data = await res.json();
    if (data.success) showToast('Password changed successfully.', 'success');
    else throw new Error(data.error);
  } catch (err) {
    showToast(`Failed to change password: ${err.message}`, 'error');
    if (err.message.includes('Authentication failed')) handleLogout();
  }
}

export async function handleChangeSpAccess(username) {
  const spRes = await showModal(`Enter new SP Access for ${username} (blank for All):`, {
    showInput: true, confirmText: 'Update'
  });
  if (!spRes.confirmed) return;

  try {
    const res = await fetch(`${API_BASE}/users/${username}/plan`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ plan_id: spRes.value || null })
    });
    const data = await res.json();
    if (data.success) {
      showToast('SP Access updated.', 'success');
      loadUsers();
    } else {
      throw new Error(data.error);
    }
  } catch (err) {
    showToast(`Failed to update SP Access: ${err.message}`, 'error');
    if (err.message.includes('Authentication failed')) handleLogout();
  }
}

export async function handleResetPassword(username) {
  const confirm = await showModal(`Reset password for ${username}?`, {
    confirmText: 'Yes, Reset'
  });
  if (!confirm.confirmed) return;

  try {
    const res = await fetch(`${API_BASE}/users/${username}/reset-password`, {
      method: 'POST',
      headers: authHeaders(false)
    });
    const data = await res.json();
    if (data.success) showToast('Password reset.', 'success');
    else throw new Error(data.error);
  } catch (err) {
    showToast(`Failed to reset password: ${err.message}`, 'error');
    if (err.message.includes('Authentication failed')) handleLogout();
  }
}
```

## public/config.js
```javascript
// config.js

/**
 * Base URL for all API requests.
 * On Vercel, this will point to your serverless functions.
 */
export const API_BASE = '/api';

 /**
  * Frontend application version.
  * Useful for cache busting or display.
  */
export const APP_VERSION = '3.0.0';

/**
 * How long to keep strata plan data in browser cache (6 hours).
 */
export const CACHE_DURATION_MS = 6 * 60 * 60 * 1000;

/**
 * Regular expression to validate email addresses.
 * Used in your “Email PDF Report” flow.
 */
export const EMAIL_REGEX =
  /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

```

## public/index.html
```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Attendance Form</title>
    <link rel="stylesheet" href="style.css">
    <link rel="icon" type="image/x-icon" href="favicon.ico">
</head>
<body>

    <div id="toast-container"></div>

    <div class="container">
        <!-- Login Section -->
        <div id="login-section">
            <h1>Login</h1>
            <form id="login-form">
                <div class="form-group">
                    <label for="username">Username</label>
                    <input type="text" id="username" required>
                </div>
                <div class="form-group">
                    <label for="password">Password</label>
                    <input type="password" id="password" required>
                </div>
                <button type="submit">Login</button>
                <p id="login-status"></p>
            </form>
        </div>

        <!-- Main App Section -->
        <div id="main-app" class="hidden">
            <div class="header-container">
                 <h1>
                    <span id="meeting-title">Attendance Form</span>
                    <!-- Make the meeting date a button for changing the meeting -->
                    <button id="meeting-date-btn" class="meeting-date-btn" style="display: none;"></button>
                </h1>
                <div id="quorum-display">Quorum: ...%</div>
            </div>

             <div class="tab-container">
                <button id="check-in-tab-btn" class="tab-link active">Check In</button>
                <button id="admin-tab-btn" class="tab-link">Admin Panel</button>
            </div>

            <div id="check-in-tab" class="tab-content" style="display: block;">
                <form id="attendance-form">
                    <div class="form-group">
                        <label for="strata-plan-select">Strata Plan</label>
                        <div class="strata-plan-container">
                            <select id="strata-plan-select" disabled>
                                <option value="">Loading plans...</option>
                            </select>
                        </div>
                    </div>
                    
                    <div class="form-group form-group-inline">
                        <div class="lot-number-wrapper">
                            <label for="lot-number">Lot Number</label>
                            <input type="text" id="lot-number" required disabled>
                        </div>
                        <div class="proxy-checkbox-wrapper">
                             <label class="checkbox-item"><input type="checkbox" id="is-proxy"> Voting by Proxy?</label>
                        </div>
                    </div>

                    <hr>
                    <div class="form-group">
                        <label id="owner-label">Owner/s</label>
                        <div id="checkbox-container">
                            <p>Select a Strata Plan to begin.</p>
                        </div>
                    </div>
                    <div class="form-group" id="company-rep-group" style="display: none;">
                        <label for="company-rep">Company Representative</label>
                        <input type="text" id="company-rep" placeholder="Enter representative's name (optional)">
                    </div>
                    <div class="form-group" id="proxy-holder-group" style="display: none;">
                        <label for="proxy-holder-lot">Proxy holder lot number/name</label>
                        <input type="text" id="proxy-holder-lot" placeholder="Enter lot number or name holding the proxy">
                    </div>
                    <div class="form-group">
                        <label class="checkbox-item" id="financial-label"><input type="checkbox" id="is-financial"> Is Financial?</label>
                    </div>
                    <button type="submit" id="submit-button">Submit</button>
                </form>

                <div class="attendee-section">
                    <div class="attendee-header">
                        <h2>Current Attendees <span id="person-count"></span></h2>
                        <div class="attendee-header">
                            <h2>Current Attendees <span id="person-count"></span></h2>
                            <div>
                                <button type="button" id="email-pdf-btn">Email PDF Report</button>
                                <button type="button" id="sync-btn" disabled>Sync</button>
                            </div>
                        </div>
                    </div>
                    <table class="attendee-table">
                        <thead>
                            <tr>
                                <th>Lot</th>
                                <th>Unit</th>
                                <th>Owner/Rep</th>
                                <th>Company</th>
                                <th>Delete</th>
                            </tr>
                        </thead>
                        <tbody id="attendee-table-body"></tbody>
                    </table>
                </div>
            </div>

            <div id="admin-tab" class="tab-content">
                 <div class="user-management-section">
                    <h2>User Management</h2>
                    <p>Logged in as: <b id="user-display"></b></p>
                    <button type="button" id="change-password-btn">Change My Password</button>
                    <div id="admin-panel" class="hidden">
                        <hr style="margin: 2rem 0;">
                        <h3>Admin Panel</h3>
                        <div class="collapsible-container">
                            <button type="button" class="collapsible-toggle">Import CSV Data</button>
                            <div class="collapsible-content">
                                <div id="csv-drop-zone" class="drop-zone">
                                    <p>Drag & drop a CSV file here, or click to select a file.</p>
                                    <input type="file" id="csv-file-input" accept=".csv" class="hidden">
                                </div>
                                <button type="button" id="import-csv-btn">Import Selected CSV</button>
                                <p id="import-status"></p>
                            </div>
                        </div>
                        <table class="attendee-table">
                            <thead>
                                <tr>
                                    <th>User</th>
                                    <th>Role</th>
                                    <th>SP Access</th>
                                    <th>Actions</th>
                                </tr>
                            </thead>
                            <tbody id="user-list-body"></tbody>
                        </table>
                        <button type="button" id="add-user-btn" style="background-color: #28a745; margin-top: 1rem;">Add New User</button>
                    </div>
                </div>
                <button type="button" id="clear-cache-btn">Clear Entire Cache</button>
                <button type="button" id="logout-btn">Logout</button>
            </div>
        </div>
    </div>

    <!-- Modals -->
    <div id="custom-modal" class="modal-overlay">
        <div class="modal-content">
            <p id="modal-text"></p>
            <input type="text" id="modal-input" class="modal-input" style="display: none;">
            <div class="modal-buttons">
                <button id="modal-cancel-btn" class="modal-cancel-btn">Cancel</button>
                <button id="modal-confirm-btn" class="modal-confirm-btn">Confirm</button>
            </div>
        </div>
    </div>
    
    <div id="meeting-modal" class="modal-overlay">
        <div class="modal-content">
            <div id="existing-meeting-section" class="hidden">
                <h3>Resume Existing Meeting</h3>
                <div class="form-group">
                    <label for="existing-meeting-select">Select a past meeting</label>
                    <select id="existing-meeting-select"></select>
                </div>
                <button type="button" id="resume-meeting-btn">Resume Selected Meeting</button>
                <hr style="margin: 1.5rem 0;">
                <p style="text-align: center;">Or</p>
            </div>

            <div id="new-meeting-section">
                <h3>New Meeting Setup</h3>
                <p>Please provide the meeting details below.</p>
                <form id="meeting-form">
                    <div class="form-group">
                        <label for="meeting-date-input">Meeting Date</label>
                        <input type="date" id="meeting-date-input" required>
                    </div>
                    <div class="form-group">
                        <label for="meeting-type-select">Meeting Type</label>
                        <select id="meeting-type-select" required>
                            <option value="">Select a type...</option>
                            <option value="AGM">AGM</option>
                            <option value="EGM">EGM</option>
                            <option value="SCM">SCM</option>
                            <option value="Other">Other</option>
                        </select>
                    </div>
                    <div class="form-group hidden" id="other-meeting-type-group">
                        <label for="other-meeting-type-input">Specify Meeting Type</label>
                        <input type="text" id="other-meeting-type-input">
                    </div>
                    <div class="form-group">
                        <label for="quorum-total-input" id="quorum-total-label">Quorum Total</label>
                        <input type="number" id="quorum-total-input" required>
                    </div>
                    <div class="modal-buttons">
                        <button type="button" id="meeting-cancel-btn" class="modal-cancel-btn">Cancel</button>
                        <button type="submit" id="meeting-confirm-btn" class="modal-confirm-btn">Start Meeting</button>
                    </div>
                </form>
            </div>
        </div>
    </div>
    
    <script type="module" src="config.js"></script>
    <script type="module" src="utils.js"></script>
    <script type="module" src="ui.js"></script>
    <script type="module" src="auth.js"></script>
    <script type="module" src="app.js"></script>
</body>
</html>

```

## public/style.css
```css
body { 
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; 
    line-height: 1.6; 
    margin: 2rem; 
    background-color: #f8f9fa; 
    color: #333; 
}

.container { 
    max-width: 600px; 
    margin: auto; 
    background: #fff; 
    padding: 2rem; 
    border-radius: 8px; 
    box-shadow: 0 2px 10px rgba(0,0,0,0.1); 
}

/* --- Collapsible Styles --- */
.collapsible-toggle {
    background-color: #6c757d;
    color: white;
    cursor: pointer;
    padding: 1rem;
    width: 100%;
    border: none;
    text-align: left;
    outline: none;
    font-size: 1rem;
    border-radius: 8px;
    margin-bottom: 1rem;
    position: relative;
}

.collapsible-toggle::after {
    content: '\25BC'; /* Down arrow */
    position: absolute;
    right: 1rem;
    transition: transform 0.2s;
}

.collapsible-toggle.active::after {
    transform: rotate(180deg); /* Up arrow */
}

.collapsible-content {
    padding: 0 1rem;
    max-height: 0;
    overflow: hidden;
    transition: max-height 0.3s ease-out;
    background-color: #f8f9fa;
    border-radius: 8px;
}

/* --- Drop Zone Styles --- */
.drop-zone {
    border: 2px dashed #ccc;
    border-radius: 8px;
    padding: 2rem;
    text-align: center;
    cursor: pointer;
    transition: background-color 0.2s, border-color 0.2s;
    margin-bottom: 1rem;
}

.drop-zone.drag-over {
    background-color: #e9ecef;
    border-color: #007bff;
}

.drop-zone p {
    margin: 0.5rem 0 1rem;
    color: #6c757d;
}

/* --- Header Layout Fix --- */
.header-container { 
    display: flex; 
    justify-content: space-between; 
    align-items: flex-start; /* Align items to the top */
    margin-bottom: 1rem; 
    flex-wrap: wrap; 
    gap: 1rem; 
}

h1, h2 { 
    color: #333; 
}

h1 { 
    font-size: 1.75rem; 
    margin: 0; 
    flex-grow: 1;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.5rem;
}

.meeting-date-btn {
    width: auto; /* Fit button to text content */
    padding: 0.5rem 1rem;
    font-size: 0.9rem;
    background-color: #007bff;
    border: none;
    color: white;
    cursor: pointer;
    border-radius: 4px;
    line-height: 1.2;
}

.meeting-date-btn:hover {
    background-color: #0056b3;
}

.hidden { 
    display: none; 
}

#quorum-display { 
    padding: 0.5rem 1rem; 
    border-radius: 4px; 
    font-weight: bold; 
    color: white; 
    text-align: center; 
    line-height: 1.2;
    flex-shrink: 0; /* Prevent the box from shrinking */
}

#quorum-display small { 
    font-weight: normal; 
    font-size: 0.8em; 
}

.form-group { 
    margin-bottom: 1rem; 
}

label { 
    display: block; 
    margin-bottom: 0.5rem; 
    font-weight: bold; 
}

input[type="text"], input[type="password"], select, input[type="number"], input[type="date"] { 
    width: 100%; 
    padding: 0.75rem; 
    border: 1px solid #ccc; 
    border-radius: 4px; 
    box-sizing: border-box; 
    font-size: 1rem; 
}

#checkbox-container {
    border: 1px solid #eee;
    padding: 1rem;
    border-radius: 4px;
    display: flex;
    flex-direction: column;
    justify-content: center;
}

.checkbox-item:last-child {
    margin-bottom: 0;
}

.checkbox-item { 
    display: block; 
    margin-bottom: 0.5rem; 
}

button { 
    background-color: #007bff; 
    color: white; 
    padding: 0.75rem 1.5rem; 
    border: none; 
    border-radius: 4px; 
    cursor: pointer; 
    font-size: 1rem; 
    width: 100%; 
    transition: background-color 0.2s; 
}

button:hover { 
    background-color: #0056b3; 
}

button:disabled { 
    background-color: #aaa; 
    cursor: not-allowed; 
}

#import-csv-btn { 
    background-color: #17a2b8; 
    margin-top: 1rem; 
}

#import-csv-btn:hover { 
    background-color: #138496; 
}

#sync-btn { 
    width: auto;
}

#clear-cache-btn, #logout-btn { 
    background-color: #dc3545; 
    margin-top: 0.5rem; 
}

#clear-cache-btn:hover, #logout-btn:hover { 
    background-color: #c82333; 
}

#status, #login-status, #import-status { 
    text-align: center; 
    margin-top: 1rem; 
    font-weight: bold; 
    min-height: 1.2em; 
}

.attendee-section { 
    margin-top: 2rem; 
    border-top: 1px solid #eee; 
    padding-top: 1.5rem; 
}

.attendee-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
}

.attendee-section h2 { 
    margin: 0;
}

.attendee-table { 
    width: 100%; 
    border-collapse: collapse; 
    margin-top: 1rem; 
}

.attendee-table th, .attendee-table td { 
    border: 1px solid #dee2e6; 
    padding: 8px; 
    text-align: left; 
    vertical-align: middle; 
}

.attendee-table th { 
    background-color: #f2f2f2; 
}

.delete-btn { 
    background: #dc3545; 
    color: white; 
    border: none; 
    padding: 5px 10px; 
    border-radius: 4px; 
    cursor: pointer;
    width: auto;
}

#company-rep-group, #proxy-holder-group { 
    display: none; 
}

/* Modal Styles */
.modal-overlay { 
    position: fixed; 
    top: 0; 
    left: 0; 
    width: 100%; 
    height: 100%; 
    background: rgba(0,0,0,0.6); 
    display: none; 
    justify-content: center; 
    align-items: center; 
    z-index: 1000; 
}

.modal-content { 
    background: white; 
    padding: 2rem; 
    border-radius: 8px; 
    width: 90%; 
    max-width: 500px; 
    box-shadow: 0 5px 15px rgba(0,0,0,0.3); 
}

.modal-content p { 
    margin-top: 0; 
}

.modal-input { 
    width: 100%; 
    padding: 0.5rem; 
    margin-top: 1rem; 
    border: 1px solid #ccc; 
    border-radius: 4px; 
}

.modal-buttons { 
    margin-top: 1.5rem; 
    text-align: right; 
}

.modal-buttons button { 
    width: auto; 
    margin-left: 0.5rem; 
    padding: 0.5rem 1rem; 
}

.modal-confirm-btn { 
    background-color: #28a745; 
}

.modal-cancel-btn { 
    background-color: #6c757d; 
}

/* Toaster Styles */
#toast-container {
    position: fixed;
    top: 20px;
    right: 20px;
    z-index: 2000;
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.toast {
    padding: 1rem 1.5rem;
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    color: white;
    font-size: 1rem;
    opacity: 0;
    transform: translateX(100%);
    transition: all 0.4s ease-in-out;
}

.toast.show {
    opacity: 1;
    transform: translateX(0);
}

.toast.success { background-color: #28a745; }
.toast.error { background-color: #dc3545; }
.toast.info { background-color: #17a2b8; }

.form-group-inline {
    display: flex;
    align-items: flex-end;
    gap: 1.5rem;
    flex-wrap: wrap;
}

.lot-number-wrapper {
    flex-grow: 1;
}

.proxy-checkbox-wrapper {
    padding-bottom: 0.75rem;
}

.proxy-checkbox-wrapper .checkbox-item {
    margin-bottom: 0;
}

/* Tab Styles */
.tab-container {
    overflow: hidden;
    border: 1px solid #ccc;
    background-color: #f1f1f1;
    border-radius: 8px 8px 0 0;
}

.tab-container button {
    background-color: inherit;
    float: left;
    border: none;
    outline: none;
    cursor: pointer;
    padding: 14px 16px;
    transition: 0.3s;
    color: #333;
    width: auto;
}

.tab-container button:hover {
    background-color: #ddd;
}

.tab-container button.active {
    background-color: #ccc;
}

.tab-content {
    display: none;
    padding: 20px 12px;
    border: 1px solid #ccc;
    border-top: none;
    border-radius: 0 0 8px 8px;
}

.strata-plan-container {
    display: flex;
    align-items: center;
    gap: 0.5rem;
}

/* Media query for mobile stacking */
@media (max-width: 600px) {
    .header-container {
        flex-direction: column;
        align-items: stretch; /* Make items full width */
    }

    h1 {
        align-items: center; /* Center title and button */
        text-align: center;
    }

    #quorum-display {
        width: 100%; /* Make quorum box full width on mobile */
        box-sizing: border-box;
    }
}
.attendee-header div {
    display: flex;
    gap: 0.5rem;
}

#email-pdf-btn {
    width: auto;
    background-color: #17a2b8;
}

#email-pdf-btn:hover {
    background-color: #138496;
}
```

## public/ui.js
```javascript
import { getSubmissionQueue } from './utils.js';

/**
 * Renders the owner checkboxes based on the lot number entered.
 */
export const renderOwnerCheckboxes = (lot, ownersCache) => {
    const checkboxContainer = document.getElementById('checkbox-container');
    const companyRepGroup = document.getElementById('company-rep-group');
    const ownerData = ownersCache[lot];

    companyRepGroup.style.display = 'none';
    checkboxContainer.innerHTML = '';

    if (!ownerData) {
        checkboxContainer.innerHTML = '<p>Lot not found in this strata plan.</p>';
        return;
    }

    const [mainContact, titleName] = ownerData;
    const companyKeywords = /\b(P\/L|PTY LTD|LIMITED|INVESTMENTS|MANAGEMENT|SUPERANNUATION FUND)\b/i;
    let namesToDisplay = new Set();

    const stripSalutation = (name) => {
        if (!name) return '';
        return name.replace(/^(Mr|Mrs|Ms|Miss|Dr)\.?\s+/i, '').trim();
    };

    const mainContactIsCompany = mainContact && companyKeywords.test(mainContact);
    const titleNameIsCompany = titleName && companyKeywords.test(titleName);
    let companyName = '';

    if (mainContactIsCompany) {
        companyName = (titleNameIsCompany && titleName.length > mainContact.length) ? titleName : mainContact;
    } else if (titleNameIsCompany) {
        companyName = titleName;
    }

    if (companyName) {
        checkboxContainer.innerHTML = `
            <p><b>Company Lot:</b> ${companyName}</p>
            <input type="hidden" id="company-name-hidden" value="${companyName}">
        `;
        companyRepGroup.style.display = 'block';
        return;
    }

    let primaryName = mainContact;
    const initialOnlyRegex = /^(?:(Mr|Mrs|Ms|Miss|Dr)\.?\s+)?([A-Z]\.?\s*)+$/i;
    if (mainContact && initialOnlyRegex.test(mainContact.trim()) && titleName) {
        primaryName = titleName;
    }

    if (primaryName) {
        primaryName.split(/\s*&\s*|\s+and\s+/i).forEach(name => {
            namesToDisplay.add(stripSalutation(name));
        });
    }

    if (namesToDisplay.size === 0 && titleName) {
        titleName.split(/\s*&\s*|\s+and\s+/i).forEach(name => {
            namesToDisplay.add(stripSalutation(name));
        });
    }

    let checkboxHTML = '';
    namesToDisplay.forEach(name => {
        if (name) {
            checkboxHTML += `<label class="checkbox-item"><input type="checkbox" name="owner" value="${name}"> ${name}</label>`;
        }
    });

    checkboxContainer.innerHTML = checkboxHTML || '<p>No owner names found for this lot.</p>';
};

/**
 * Main function to update the entire display.
 */
export const updateDisplay = (sp, currentSyncedAttendees, currentTotalLots, strataPlanCache) => {
    if (!sp) return;

    const queuedAttendees = getSubmissionQueue()
        .filter(s => s.sp === sp)
        .map(s => ({...s, status: 'queued'}));

    const allAttendees = [...currentSyncedAttendees, ...queuedAttendees];

    const attendedLots = new Set(allAttendees.map(attendee => String(attendee.lot)));

    renderAttendeeTable(allAttendees, strataPlanCache);
    updateQuorumDisplay(attendedLots.size, currentTotalLots);
    updateSyncButton();
};

/**
 * Resets the UI to its initial state.
 */
export const resetUiOnPlanChange = () => {
    document.getElementById('attendee-table-body').innerHTML = `<tr><td colspan="5" style="text-align:center;">Select a plan to see attendees.</td></tr>`;
    document.getElementById('person-count').textContent = `(0 people)`;
    document.getElementById('quorum-display').innerHTML = `Quorum: ...%`;
    document.getElementById('quorum-display').style.backgroundColor = '#6c757d';
    document.getElementById('checkbox-container').innerHTML = '<p>Select a Strata Plan to begin.</p>';
    document.getElementById('lot-number').value = '';
    document.getElementById('lot-number').disabled = true;
    document.getElementById('financial-label').lastChild.nodeValue = " Is Financial?";
    document.getElementById('meeting-title').textContent = 'Attendance Form';
    
    const meetingDateBtn = document.getElementById('meeting-date-btn');
    meetingDateBtn.textContent = '';
    meetingDateBtn.style.display = 'none';

    document.getElementById('company-rep-group').style.display = 'none';
};

/**
 * Populates the strata plan dropdown.
 */
export const renderStrataPlans = (plans) => {
    const strataPlanSelect = document.getElementById('strata-plan-select');
    if (!plans || plans.length === 0) {
        strataPlanSelect.innerHTML = '<option value="">No plans available</option>';
        strataPlanSelect.disabled = true;
        return;
    };

    strataPlanSelect.innerHTML = '<option value="">Select a plan...</option>';
    plans.sort((a, b) => a.sp_number - b.sp_number);
    plans.forEach(plan => {
        const option = document.createElement('option');
        option.value = plan.sp_number;
        option.textContent = `${plan.sp_number} - ${plan.suburb}`;
        strataPlanSelect.appendChild(option);
    });

    strataPlanSelect.disabled = false;
};

/**
 * Renders the table of attendees.
 */
export const renderAttendeeTable = (attendees, strataPlanCache) => {
    const attendeeTableBody = document.getElementById('attendee-table-body');
    const personCountSpan = document.getElementById('person-count');

    const syncedCount = attendees.filter(item => item.status !== 'queued').length;
    personCountSpan.textContent = `(${syncedCount} ${syncedCount === 1 ? 'person' : 'people'})`;
    attendeeTableBody.innerHTML = '';

    if (!attendees || attendees.length === 0) {
        attendeeTableBody.innerHTML = `<tr><td colspan="5" style="text-align:center;">No attendees yet.</td></tr>`;
        return;
    }

    attendees.sort((a, b) => a.lot - b.lot);

    attendees.forEach(item => {
        const lotData = strataPlanCache ? strataPlanCache[item.lot] : null;
        const unitNumber = lotData ? (lotData[2] || 'N/A') : 'N/A';
        const isQueued = item.status === 'queued';

        const isProxy = item.is_proxy;
        const isCompany = !isProxy && item.rep_name && item.rep_name !== 'N/A';
        
        let ownerRepName;
        let companyName = ''; // Default to empty
        let rowColor = '#d4e3c1'; // Default color for regular owner

        if (isProxy) {
            ownerRepName = item.rep_name; // Show "Proxy - Lot X" in the main name column
            rowColor = '#c1e1e3'; // Proxy color
        } else if (isCompany) {
            ownerRepName = item.owner_name; // Show company name
            companyName = item.rep_name; // Show representative's name in the company column
            rowColor = '#cbc1e3'; // Company color
        } else {
            ownerRepName = item.owner_name; // Regular owner name
        }

        if (isQueued) {
            rowColor = '#f5e0df'; // Queued color overrides others
        }

        const row = document.createElement('tr');
        row.style.backgroundColor = rowColor;

        const deleteButton = isQueued
            ? `<button class="delete-btn" data-type="queued" data-submission-id="${item.submissionId}">Delete</button>`
            : `<button class="delete-btn" data-type="synced" data-id="${item.id}" data-lot="${item.lot}">Delete</button>`;

        row.innerHTML = `
            <td>${item.lot}</td>
            <td>${unitNumber}</td>
            <td>${ownerRepName}</td>
            <td>${companyName}</td>
            <td>${deleteButton}</td>
        `;
        attendeeTableBody.appendChild(row);
    });
};

/**
 * Updates the quorum display.
 */
export const updateQuorumDisplay = (count = 0, total = 0) => {
    const quorumDisplay = document.getElementById('quorum-display');
    const percentage = total > 0 ? Math.floor((count / total) * 100) : 0;

    const quorumThreshold = Math.ceil(total * 0.25);
    const isQuorumMet = count >= quorumThreshold;

    quorumDisplay.innerHTML = `Financial Lots Quorum: ${percentage}%<br><small>(${count}/${total})</small>`;
    quorumDisplay.style.backgroundColor = isQuorumMet ? '#28a745' : '#dc3545';
};

/**
 * Updates the sync button's state.
 */
export const updateSyncButton = (isSyncing = false) => {
    const syncBtn = document.getElementById('sync-btn');
    if (!syncBtn) return;

    const queue = getSubmissionQueue();
    if (queue.length > 0) {
        syncBtn.disabled = isSyncing;
        syncBtn.textContent = isSyncing ? 'Syncing...' : `Sync ${queue.length} Item${queue.length > 1 ? 's' : ''}`;
    } else {
        syncBtn.disabled = true;
        syncBtn.textContent = 'Synced';
    }
};

```

## public/utils.js
```javascript
import { API_BASE } from './config.js';
import { handleLogout } from './auth.js';

/**
 * Helper to fetch JWT token from cookies.
 */
function getAuthToken() {
  return document.cookie
    .split('; ')
    .find(row => row.startsWith('authToken='))
    ?.split('=')[1];
}

/**
 * Unified fetch helper for API requests.
 */
async function apiRequest(path, { method = 'GET', body = null } = {}) {
  const token = getAuthToken();
  const headers = {
    ...(body && { 'Content-Type': 'application/json' }),
    ...(token && { Authorization: `Bearer ${token}` })
  };

  const config = {
      method,
      headers,
      ...(body && { body: JSON.stringify(body) })
  };

  const response = await fetch(`${API_BASE}${path}`, config);

  if (response.status === 204) {
      return { success: true };
  }

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || `Request failed with status ${response.status}`);
  }

  if (data.error && data.error.includes('Authentication failed')) {
    handleLogout();
  }

  return data;
}

/**
 * Helper for GET requests.
 */
export function apiGet(path) {
  return apiRequest(path, { method: 'GET' });
}

/**
 * Helper for POST requests.
 */
export function apiPost(path, body) {
  return apiRequest(path, { method: 'POST', body });
}

/**
 * Helper for DELETE requests.
 */
export function apiDelete(path) {
    return apiRequest(path, { method: 'DELETE' });
}


/**
 * Debounce utility to limit how often a function runs.
 */
export const debounce = (func, delay) => {
  let timeoutId;
  return (...args) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => func.apply(this, args), delay);
  };
};

/**
 * Display a generic modal dialog.
 */
export function showModal(
  text,
  {
    showInput = false,
    inputType = 'text',
    confirmText = 'Confirm',
    cancelText = 'Cancel',
    isHtml = false
  } = {}
) {
  const modal = document.getElementById('custom-modal');
  const modalText = document.getElementById('modal-text');
  const modalInput = document.getElementById('modal-input');
  const btnConfirm = document.getElementById('modal-confirm-btn');
  const btnCancel = document.getElementById('modal-cancel-btn');

  modalText[isHtml ? 'innerHTML' : 'textContent'] = text;
  modalInput.style.display = showInput ? 'block' : 'none';
  modalInput.type = inputType;
  modalInput.value = '';
  btnConfirm.textContent = confirmText;
  btnCancel.textContent = cancelText;
  modal.style.display = 'flex';

  return new Promise(resolve => {
    btnConfirm.onclick = () => {
      modal.style.display = 'none';
      resolve({ confirmed: true, value: modalInput.value });
    };
    btnCancel.onclick = () => {
      modal.style.display = 'none';
      resolve({ confirmed: false, value: null });
    };
    modalInput.onkeydown = e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        btnConfirm.click();
      }
    };
  });
}

/**
 * Display the specialized modal for setting up a new or existing meeting.
 */
export function showMeetingModal(existingMeetings = []) {
  const modal = document.getElementById('meeting-modal');
  const form = document.getElementById('meeting-form');
  const dateInput = document.getElementById('meeting-date-input');
  const typeSelect = document.getElementById('meeting-type-select');
  const otherGroup = document.getElementById('other-meeting-type-group');
  const otherInput = document.getElementById('other-meeting-type-input');
  const quorumLabel = document.getElementById('quorum-total-label');
  const quorumInput = document.getElementById('quorum-total-input');
  const btnCancel = document.getElementById('meeting-cancel-btn');

  const existingMeetingSection = document.getElementById('existing-meeting-section');
  const existingMeetingSelect = document.getElementById('existing-meeting-select');
  const resumeMeetingBtn = document.getElementById('resume-meeting-btn');

  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  const todayStr = `${year}-${month}-${day}`;

  form.reset();
  dateInput.value = todayStr;
  otherGroup.classList.add('hidden');
  quorumLabel.textContent = 'Quorum Total';

  if (existingMeetings.length > 0) {
      existingMeetingSection.classList.remove('hidden');
      existingMeetingSelect.innerHTML = '<option value="">Select a meeting to resume...</option>';
      existingMeetings.forEach((m, index) => {
          const option = document.createElement('option');
          option.value = index;
          const [year, month, day] = m.meeting_date.split('-');
          const formattedDate = `${day}-${month}-${year}`;
          option.textContent = `${formattedDate} - ${m.meeting_type}`;
          existingMeetingSelect.appendChild(option);
      });
  } else {
      existingMeetingSection.classList.add('hidden');
  }

  modal.style.display = 'flex';

  return new Promise(resolve => {
    typeSelect.onchange = () => {
        const type = typeSelect.value;
        otherGroup.classList.toggle('hidden', type !== 'Other');
        otherInput.required = type === 'Other';
        quorumLabel.textContent = type === 'SCM' ? 'Number of Committee Members' : 'Number of Financial Units';
    };

    form.onsubmit = (e) => {
        e.preventDefault();
        let meetingType = typeSelect.value;
        if (meetingType === 'Other') {
            meetingType = otherInput.value.trim();
        }

        if (!meetingType) {
            showToast('Please specify a meeting type.', 'error');
            return;
        }

        modal.style.display = 'none';
        resolve({
            isNew: true,
            meetingDate: dateInput.value,
            meetingType: meetingType,
            quorumTotal: parseInt(quorumInput.value, 10)
        });
    };

    resumeMeetingBtn.onclick = () => {
        const selectedIndex = existingMeetingSelect.value;
        if (selectedIndex === "") {
            showToast('Please select a meeting to resume.', 'error');
            return;
        }
        const selectedMeeting = existingMeetings[selectedIndex];
        modal.style.display = 'none';
        resolve({
            isNew: false,
            ...selectedMeeting
        });
    };

    btnCancel.onclick = () => {
        modal.style.display = 'none';
        resolve(null);
    };
  });
}

/**
 * Ensures there's a toast container in the DOM.
 */
function ensureToastContainer() {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  return container;
}

/**
 * Shows a toast notification.
 */
export function showToast(message, type = 'info', duration = 3000) {
  const container = ensureToastContainer();
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => toast.classList.add('show'), 10);
  setTimeout(() => {
    toast.classList.remove('show');
    toast.addEventListener('transitionend', () => toast.remove());
  }, duration);
}

/**
 * Submission queue helpers for offline support.
 */
export const getSubmissionQueue = () =>
  JSON.parse(localStorage.getItem('submissionQueue') || '[]');

export const saveSubmissionQueue = queue =>
  localStorage.setItem('submissionQueue', JSON.stringify(queue));

/**
 * Clears all strata plan related caches from localStorage.
 */
export const clearStrataCache = () => {
  Object.keys(localStorage).forEach(key => {
    if (key.startsWith('strata_') || key === 'strataPlans') {
      localStorage.removeItem(key);
    }
  });
};
```

## vercel.json
```json
{
  "version": 2,
  "builds": [
    {
      "src": "api/index.js",
      "use": "@vercel/node"
    },
    {
      "src": "public/**",
      "use": "@vercel/static"
    }
  ],
  "routes": [
    {
      "src": "/api/(.*)",
      "dest": "api/index.js"
    },
    {
      "src": "/(.*)",
      "dest": "public/$1"
    }
  ]
}

```
