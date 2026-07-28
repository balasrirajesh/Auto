// Polyfill Web Crypto API for Node 18 (required by MongoDB driver / Baileys)
if (!globalThis.crypto) { globalThis.crypto = require('crypto').webcrypto; }
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const xlsx = require('xlsx');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const {
    default: makeWASocket,
    DisconnectReason,
    fetchLatestWaWebVersion,
    useMultiFileAuthState,
    proto,
    initAuthCreds,
    BufferJSON
} = require('@whiskeysockets/baileys');

// Global process error safety
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err?.message || err);
});
process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection:', reason?.message || reason);
});

const app = express();
const port = process.env.PORT || 3000;
const mongoURI = process.env.MONGODB_URI;
const targetGroupsEnv = process.env.TARGET_GROUP_NAMES || process.env.TARGET_GROUP_NAME || 'cse2 GPP, GPP Stu Group 2027, IV CSE - (2023-27), 2027 Batch BTECH, CSE G - sitting, IgniteCoder - 2027 - ACOE, nithin, Job tracker';
const targetGroupList = targetGroupsEnv
    .split(',')
    .map(name => name.trim().toLowerCase())
    .filter(Boolean);

// Mongoose schema for jobs
const jobSchema = new mongoose.Schema({
    content: String,
    groupName: String,
    dateDetected: { type: Date, default: Date.now },
    status: { type: String, default: 'pending', enum: ['pending', 'approved', 'rejected'] },
    parsedCompany: String,
    parsedRole: String,
    parsedDeadline: String,
    link: String
});
const Job = mongoose.model('Job', jobSchema);

// Mongoose schema for Baileys Auth Store
const baileysAuthSchema = new mongoose.Schema({
    _id: String,
    data: String
}, { timestamps: true });
const BaileysAuth = mongoose.model('BaileysAuth', baileysAuthSchema);

// Global state variables
let isWhatsAppConnected = false;
let latestQRCode = null;   // stores raw QR string for /qr page
let sock = null;
const groupCache = new Map();
const processingMsgIds = new Set();

// Helper function: Baileys MongoDB Auth State
async function useMongoAuthState() {
    const writeData = async (id, value) => {
        try {
            if (value === null || value === undefined) {
                await BaileysAuth.findByIdAndDelete(id);
            } else {
                const dataStr = JSON.stringify(value, BufferJSON.replacer);
                await BaileysAuth.findByIdAndUpdate(id, { data: dataStr }, { upsert: true });
            }
        } catch (e) {
            console.error(`[Mongo Auth] Error writing ${id}:`, e.message);
        }
    };

    const readData = async (id) => {
        try {
            const doc = await BaileysAuth.findById(id);
            if (doc && doc.data) {
                return JSON.parse(doc.data, BufferJSON.reviver);
            }
        } catch (e) {
            console.error(`[Mongo Auth] Error reading ${id}:`, e.message);
        }
        return null;
    };

    const removeData = async (id) => {
        try {
            await BaileysAuth.findByIdAndDelete(id);
        } catch (e) {}
    };

    const creds = (await readData('creds')) || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await readData(`${type}-${id}`);
                            if (type === 'app-state-sync-key' && value) {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value);
                            }
                            data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            if (value) {
                                tasks.push(writeData(key, value));
                            } else {
                                tasks.push(removeData(key));
                            }
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => writeData('creds', creds)
    };
}

// Deadline cleaning & expiration helpers
function cleanDeadlineDate(raw) {
    if (!raw || raw === 'Not specified') return 'Not specified';
    let clean = raw.replace(/[*_~`]/g, '').trim();

    clean = clean.replace(/,?\s*(?:after|which|we|late|post|shortlist|without|form|link).*/i, '');
    clean = clean.replace(/\..*/, '');

    const dateMatch = clean.match(/(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\s*)?\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*(?:\s*,?\s*\d{2,4})?(?:\s*(?:at|by|before|,)?\s*\d{1,2}(?::\d{2})?\s*(?:am|pm|PM|AM)?)?/i)
        || clean.match(/\d{1,2}[./-]\d{1,2}[./-]\d{2,4}/)
        || clean.match(/\d{1,2}(?:st|nd|rd|th)?\s*(?:am|pm|AM|PM|noon|midnight)/i);

    if (dateMatch && dateMatch[0].trim().length >= 3) {
        return dateMatch[0].trim();
    }

    if (clean.length > 45) clean = clean.substring(0, 45).trim();
    return clean || 'Not specified';
}

function isDeadlineExpired(deadlineStr) {
    if (!deadlineStr || deadlineStr === 'Not specified') return false;

    try {
        const now = new Date();
        const currentYear = now.getFullYear();

        let text = deadlineStr.replace(/(\d+)(?:st|nd|rd|th)/gi, '$1').trim();
        let d = new Date(text);
        if (isNaN(d.getTime())) {
            d = new Date(`${text} ${currentYear}`);
        }

        if (!isNaN(d.getTime())) {
            if (!/\d{1,2}:\d{2}|\d{1,2}\s*(?:am|pm)/i.test(text)) {
                d.setHours(23, 59, 59, 999);
            }
            return d < now;
        }
    } catch (e) {}

    return false;
}

// Smart Job Parser
const JOB_KEYWORDS = ['hiring', 'apply', 'job', 'internship', 'role', 'full-time', 'fresher', 'opening', 'opportunity', 'careers', 'stipend', 'drive', 'off campus', 'off-campus', 'ctc', 'lpa', 'registration', 'http://', 'https://'];
const LINK_REGEX = /(https?:\/\/[^\s]+)/;

function parseJobMessage(text) {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

    function extractField(fieldPatterns) {
        for (const line of lines) {
            for (const pattern of fieldPatterns) {
                const match = line.match(pattern);
                if (match && match[1] && match[1].trim().length > 1) {
                    return match[1].trim().replace(/[*_~`]/g, '');
                }
            }
        }
        return null;
    }

    const company = extractField([
        /(?:company\s*name|company|organization|firm|employer)\s*[:\-–]\s*(.+)/i,
        /^(.+?)\s*(?:is\s+hiring|hiring\s+for|presents|campus\s+hiring)/i,
    ]) || (() => {
        const skip = /^(dear|hi|hello|hey|greetings|note|important|fyi|please)/i;
        const nonGreeting = lines.find(l => !skip.test(l) && l.length > 3);
        if (nonGreeting) {
            const inline = nonGreeting.match(/company\s*(?:name)?\s*[:\-–]\s*(.+)/i);
            if (inline) return inline[1].replace(/[*_~`]/g, '').trim();
            const parts = nonGreeting.split(/\s*[–\-]\s*/);
            return (parts[0] || nonGreeting).replace(/[*_~`]/g, '').substring(0, 60).trim();
        }
        return 'Unknown';
    })();

    const role = extractField([
        /(?:role|position|job\s*title|designation|profile|post)\s*[:\-–]\s*(.+)/i,
        /(?:hiring\s+for|looking\s+for|opening\s+for)\s*[:\-–]?\s*(.+)/i,
        /(?:internship|opportunity)\s*[:\-–]\s*(.+)/i,
    ]) || (() => {
        for (const line of lines) {
            const dashMatch = line.match(/^.+\s*[–\-]\s*(.+(?:intern|engineer|developer|analyst|manager|role|opportunity).+)$/i);
            if (dashMatch) return dashMatch[1].replace(/[*_~`]/g, '').trim();
        }
        return 'Not specified';
    })();

    const rawDeadline = extractField([
        /(?:apply\s*by|last\s*date|deadline|closes?\s*on|application\s*deadline)\s*[:\-–]?\s*(.+)/i,
        /(?:last\s*date\s*to\s*apply)\s*[:\-–]?\s*(.+)/i,
    ]) || 'Not specified';

    const deadline = cleanDeadlineDate(rawDeadline);

    const linkMatch = text.match(LINK_REGEX);
    const link = linkMatch ? linkMatch[0] : 'None';

    return {
        company: company ? company.substring(0, 120) : 'Unknown',
        role: role ? role.substring(0, 120) : 'Not specified',
        deadline: deadline ? deadline.substring(0, 100) : 'Not specified',
        link
    };
}

// Handle incoming messages from Baileys
async function handleMessage(msg) {
    if (!msg || !msg.message) return;

    const msgId = msg.key?.id;
    if (msgId && processingMsgIds.has(msgId)) return;
    if (msgId) {
        processingMsgIds.add(msgId);
        setTimeout(() => processingMsgIds.delete(msgId), 30000);
    }

    try {
        const remoteJid = msg.key?.remoteJid || '';
        const isGroupChat = remoteJid.endsWith('@g.us');

        const contentText = (
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            msg.message?.imageMessage?.caption ||
            msg.message?.videoMessage?.caption ||
            msg.message?.documentWithCaptionMessage?.message?.documentMessage?.caption ||
            ''
        ).trim();

        if (!contentText) return;

        // Resolve group name if group chat
        let chatName = '';
        if (isGroupChat) {
            if (groupCache.has(remoteJid)) {
                chatName = groupCache.get(remoteJid);
            } else if (sock) {
                try {
                    const metadata = await sock.groupMetadata(remoteJid);
                    chatName = metadata?.subject || '';
                    if (chatName) groupCache.set(remoteJid, chatName);
                } catch (err) {}
            }
        }

        const chatNameClean = chatName.trim().toLowerCase();
        const preview = contentText.length > 50 ? contentText.substring(0, 50) + '...' : contentText;
        console.log(`\n📩 [NEW MSG RECEIVED] Group: "${chatName || (isGroupChat ? 'Group' : 'Direct Chat')}" | JID: ${remoteJid} | Content: "${preview}"`);

        const isWildcard = targetGroupList.includes('*') || targetGroupList.includes('all');
        const isExplicitTarget = Boolean(chatNameClean) && targetGroupList.some(target => target && target.length > 0 && chatNameClean.includes(target));

        const lowerBody = contentText.toLowerCase();
        const hasKeyword = JOB_KEYWORDS.some(kw => lowerBody.includes(kw));

        const shouldCapture = isExplicitTarget || isWildcard || (isGroupChat && hasKeyword);
        console.log(`   ├─ Group Match: ${isExplicitTarget} ("${chatName}") | Keyword Match: ${hasKeyword} | Capture: ${shouldCapture}`);

        if (!shouldCapture) {
            console.log(`   └─ ⏩ Skipped (does not match target group or job keywords)`);
            return;
        }

        const existingJob = await Job.findOne({ content: contentText });
        if (existingJob) {
            console.log(`   └─ ⏩ Skipped (already saved in database)`);
            return;
        }

        const { company, role, deadline, link } = parseJobMessage(contentText);
        const newJob = new Job({
            content: contentText,
            groupName: chatName || 'WhatsApp Group',
            parsedCompany: company,
            parsedRole: role,
            parsedDeadline: deadline,
            link: link
        });

        await newJob.save();
        notifyClients();
        console.log(`   └─ ✅ [SAVED TO DATABASE] Company: "${company}" | Role: "${role}"`);
    } catch (error) {
        console.error('[MSG ERROR]', error.message);
    }
}

// Connect to Baileys WhatsApp Socket
async function connectToWhatsApp() {
    try {
        let state, saveCreds;

        if (mongoose.connection.readyState === 1) {
            console.log('📱 Initializing Baileys WhatsApp client with MongoDB Auth Store...');
            const auth = await useMongoAuthState();
            state = auth.state;
            saveCreds = auth.saveCreds;
        } else {
            console.log('📱 Initializing Baileys WhatsApp client with MultiFile Auth Store...');
            const auth = await useMultiFileAuthState(path.join(__dirname, 'baileys_auth'));
            state = auth.state;
            saveCreds = auth.saveCreds;
        }

        const { version } = await fetchLatestWaWebVersion().catch(() => ({ version: [2, 3000, 1015901307] }));

        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: ['Ubuntu', 'Chrome', '122.0.0.0'],
            syncFullHistory: false
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                latestQRCode = qr;  // store for /qr web page
                qrcode.generate(qr, { small: true });
                console.log('⚡ QR Code generated. Visit /qr on your deployed URL to scan it.');
            }

            if (connection === 'open') {
                isWhatsAppConnected = true;
                latestQRCode = null;  // clear QR once connected
                console.log('✓ WhatsApp authenticated & connected successfully via Baileys!');
                console.log('Monitoring groups:', targetGroupList.join(', '));
            } else if (connection === 'close') {
                isWhatsAppConnected = false;
                const statusCode = (lastDisconnect?.error instanceof Boom)
                    ? lastDisconnect.error.output?.statusCode
                    : lastDisconnect?.error?.statusCode;

                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                console.warn(`WhatsApp connection closed (Status: ${statusCode}). Reconnecting: ${shouldReconnect}`);

                if (shouldReconnect) {
                    setTimeout(connectToWhatsApp, 5000);
                } else {
                    latestQRCode = null;
                    console.error('WhatsApp logged out. Visit /qr on your deployed URL to scan a new QR code.');
                    // Re-init to show a fresh QR
                    setTimeout(connectToWhatsApp, 3000);
                }
            }
        });

        sock.ev.on('messages.upsert', async (m) => {
            if (m.type !== 'notify') return;
            for (const msg of m.messages) {
                await handleMessage(msg);
            }
        });
    } catch (err) {
        console.error('Error starting Baileys socket:', err.message);
        setTimeout(connectToWhatsApp, 10000);
    }
}

// Connect to MongoDB
if (mongoURI) {
    const connectDB = async (retries = 5, delay = 3000) => {
        mongoose.connect(mongoURI, {
            serverSelectionTimeoutMS: 15000,
            socketTimeoutMS: 45000
        }).then(() => {
            console.log('✓ Connected to MongoDB Atlas');
            connectToWhatsApp();
        }).catch(err => {
            console.error(`MongoDB initial connection error (${err.message}). Retries left: ${retries}`);
            if (retries > 0) {
                setTimeout(() => connectDB(retries - 1, delay * 1.5), delay);
            } else {
                console.error('Fatal: Could not connect to MongoDB after multiple attempts. Starting WhatsApp with local file auth...');
                connectToWhatsApp();
            }
        });
    };

    mongoose.connection.on('error', err => {
        console.error('MongoDB connection error:', err);
    });

    mongoose.connection.on('disconnected', () => {
        console.warn('MongoDB disconnected.');
    });

    connectDB();
} else {
    console.warn("MONGODB_URI not provided. Starting WhatsApp client with local file auth.");
    connectToWhatsApp();
}

// Express HTTP Server & UI Routes
app.use(express.urlencoded({ extended: true }));

app.get('/ping', (req, res) => {
    res.send('pong');
});

// QR Code page — visit this on your deployed URL to scan WhatsApp
app.get('/qr', async (req, res) => {
    if (isWhatsAppConnected) {
        return res.send(`
            <!DOCTYPE html><html><head><meta charset="UTF-8">
            <title>WhatsApp Status</title>
            <style>body{font-family:sans-serif;background:#0b0f19;color:#10b981;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;gap:1rem;}</style>
            </head><body>
            <h1>✅ WhatsApp is Connected!</h1>
            <p style="color:#94a3b8;">No QR code needed — already authenticated.</p>
            </body></html>
        `);
    }

    if (!latestQRCode) {
        return res.send(`
            <!DOCTYPE html><html><head><meta charset="UTF-8">
            <title>WhatsApp QR</title>
            <meta http-equiv="refresh" content="5">
            <style>body{font-family:sans-serif;background:#0b0f19;color:#f1f5f9;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;gap:1rem;}</style>
            </head><body>
            <h1>⏳ Waiting for QR Code...</h1>
            <p style="color:#94a3b8;">This page refreshes every 5 seconds. Please wait.</p>
            </body></html>
        `);
    }

    try {
        const qrImageData = await QRCode.toDataURL(latestQRCode, { width: 400, margin: 2 });
        res.send(`
            <!DOCTYPE html><html><head><meta charset="UTF-8">
            <title>Scan WhatsApp QR</title>
            <meta http-equiv="refresh" content="30">
            <style>
                body{font-family:sans-serif;background:#0b0f19;color:#f1f5f9;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;flex-direction:column;gap:1.5rem;padding:2rem;}
                h1{font-size:1.5rem;margin:0;}
                p{color:#94a3b8;text-align:center;max-width:400px;}
                img{border-radius:12px;box-shadow:0 0 40px rgba(16,185,129,0.3);border:4px solid #10b981;}
            </style>
            </head><body>
            <h1>📱 Scan to Connect WhatsApp</h1>
            <img src="${qrImageData}" alt="WhatsApp QR Code" width="400" height="400" />
            <p>Open WhatsApp → Linked Devices → Link a Device → Scan this QR.<br>
               <strong>This page auto-refreshes every 30 seconds with a new QR.</strong></p>
            </body></html>
        `);
    } catch (err) {
        res.status(500).send('Error generating QR image: ' + err.message);
    }
});

function escapeHTML(str) {
    if (typeof str !== 'string') return str;
    return str.replace(/[&<>'"]/g,
        tag => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            "'": '&#39;',
            '"': '&quot;'
        }[tag] || tag)
    );
}

app.get('/', async (req, res) => {
    try {
        if (!mongoURI) {
            return res.send('<p>Please set MONGODB_URI in your environment.</p>');
        }

        const pendingJobs = await Job.find({ status: 'pending' }).sort({ dateDetected: -1 });
        const approvedJobs = await Job.find({ status: 'approved' }).sort({ dateDetected: -1 });
        const activeApprovedJobs = approvedJobs.filter(job => !isDeadlineExpired(job.parsedDeadline));

        let html = `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>WhatsApp Job Tracker</title>
                <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
                <style>
                    :root {
                        --bg-color: #0b0f19;
                        --card-bg: rgba(22, 31, 48, 0.7);
                        --card-border: rgba(255, 255, 255, 0.08);
                        --text-main: #f1f5f9;
                        --text-muted: #94a3b8;
                        --accent-green: #10b981;
                        --accent-emerald: #059669;
                        --accent-red: #ef4444;
                        --accent-blue: #3b82f6;
                        --accent-purple: #8b5cf6;
                    }
                    * { margin: 0; padding: 0; box-sizing: border-box; }
                    body {
                        font-family: 'Inter', sans-serif;
                        background: var(--bg-color);
                        color: var(--text-main);
                        min-height: 100vh;
                        padding: 2.5rem 1.5rem;
                        background-image: radial-gradient(circle at 15% 15%, rgba(59, 130, 246, 0.08) 0%, transparent 40%),
                                          radial-gradient(circle at 85% 85%, rgba(16, 185, 129, 0.08) 0%, transparent 40%);
                    }
                    .container { max-width: 1100px; margin: 0 auto; }
                    .header {
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        flex-wrap: wrap;
                        gap: 1rem;
                        margin-bottom: 2rem;
                        padding-bottom: 1.5rem;
                        border-bottom: 1px solid var(--card-border);
                    }
                    h1 { font-size: 1.8rem; font-weight: 800; tracking: -0.5px; }
                    .status-badge {
                        display: inline-flex;
                        align-items: center;
                        gap: 0.5rem;
                        background: rgba(16, 185, 129, 0.12);
                        color: var(--accent-green);
                        border: 1px solid rgba(16, 185, 129, 0.3);
                        padding: 0.4rem 0.9rem;
                        border-radius: 20px;
                        font-size: 0.82rem;
                        font-weight: 600;
                    }
                    .status-dot {
                        width: 8px;
                        height: 8px;
                        background-color: var(--accent-green);
                        border-radius: 50%;
                        box-shadow: 0 0 10px var(--accent-green);
                        animation: pulse 2s infinite;
                    }
                    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
                    .download-btn {
                        display: inline-flex;
                        align-items: center;
                        gap: 0.5rem;
                        background: linear-gradient(135deg, #10b981, #059669);
                        color: white;
                        padding: 0.65rem 1.3rem;
                        border-radius: 8px;
                        text-decoration: none;
                        font-weight: 600;
                        font-size: 0.9rem;
                        box-shadow: 0 4px 14px rgba(16, 185, 129, 0.3);
                        transition: all 0.2s ease;
                    }
                    .download-btn:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(16, 185, 129, 0.4); }
                    .tab-bar {
                        display: flex;
                        gap: 0.8rem;
                        margin-bottom: 1.5rem;
                        border-bottom: 1px solid var(--card-border);
                        padding-bottom: 0.8rem;
                    }
                    .tab-btn {
                        background: transparent;
                        border: none;
                        color: var(--text-muted);
                        font-size: 1rem;
                        font-weight: 700;
                        padding: 0.5rem 1rem;
                        cursor: pointer;
                        border-radius: 8px;
                        transition: all 0.2s;
                    }
                    .tab-btn.active, .tab-btn:hover {
                        background: rgba(59, 130, 246, 0.15);
                        color: #60a5fa;
                    }
                    .section-block { display: none; }
                    .section-block.active { display: block; }

                    .excel-table-card {
                        background: var(--card-bg);
                        border: 1px solid var(--card-border);
                        border-radius: 14px;
                        padding: 1.5rem;
                        overflow-x: auto;
                    }
                    .excel-table {
                        width: 100%;
                        border-collapse: collapse;
                        font-size: 0.88rem;
                        text-align: left;
                    }
                    .excel-table th {
                        background: rgba(0, 0, 0, 0.4);
                        color: var(--text-muted);
                        padding: 0.8rem 1rem;
                        font-weight: 700;
                        text-transform: uppercase;
                        font-size: 0.75rem;
                        border-bottom: 1px solid var(--card-border);
                    }
                    .excel-table td {
                        padding: 1rem;
                        border-bottom: 1px solid rgba(255, 255, 255, 0.04);
                        vertical-align: top;
                    }
                    .excel-table tr:hover { background: rgba(255, 255, 255, 0.02); }

                    .empty-state {
                        text-align: center;
                        padding: 4rem 2rem;
                        background: var(--card-bg);
                        border: 1px dashed var(--card-border);
                        border-radius: 16px;
                        color: var(--text-muted);
                    }
                    .job-card {
                        background: var(--card-bg);
                        border: 1px solid var(--card-border);
                        border-radius: 14px;
                        padding: 1.5rem;
                        margin-bottom: 1.5rem;
                        backdrop-filter: blur(10px);
                        transition: border-color 0.2s;
                    }
                    .job-card:hover { border-color: rgba(255, 255, 255, 0.2); }
                    .card-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; margin-bottom: 1rem; }
                    .group-tag {
                        background: rgba(139, 92, 246, 0.15);
                        color: var(--accent-purple);
                        border: 1px solid rgba(139, 92, 246, 0.3);
                        padding: 0.25rem 0.75rem;
                        border-radius: 20px;
                        font-size: 0.78rem;
                        font-weight: 600;
                    }
                    .details-grid {
                        display: grid;
                        grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                        gap: 0.8rem;
                        margin-bottom: 1rem;
                    }
                    .detail-item { font-size: 0.9rem; }
                    .detail-label { color: var(--text-muted); font-size: 0.78rem; font-weight: 600; text-transform: uppercase; margin-bottom: 0.2rem; }
                    .detail-value { font-weight: 600; word-break: break-all; }
                    .link-value a { color: var(--accent-blue); text-decoration: none; }
                    .link-value a:hover { text-decoration: underline; }
                    .content-box {
                        white-space: pre-wrap;
                        background: rgba(0, 0, 0, 0.3);
                        border: 1px solid rgba(255, 255, 255, 0.05);
                        padding: 1rem;
                        border-radius: 8px;
                        font-size: 0.88rem;
                        line-height: 1.6;
                        color: #cbd5e1;
                        margin-bottom: 1.2rem;
                        max-height: 250px;
                        overflow-y: auto;
                    }
                    .actions { display: flex; gap: 0.8rem; }
                    .btn-action {
                        padding: 0.55rem 1.2rem;
                        border-radius: 8px;
                        font-weight: 600;
                        font-size: 0.85rem;
                        border: none;
                        cursor: pointer;
                        transition: transform 0.15s, opacity 0.15s;
                    }
                    .status-badge.disconnected {
                        background: rgba(239, 68, 68, 0.12);
                        color: #f87171;
                        border: 1px solid rgba(239, 68, 68, 0.3);
                    }
                    .status-dot.red {
                        background-color: #ef4444;
                        box-shadow: 0 0 10px #ef4444;
                    }
                    .btn-action:hover { transform: translateY(-1px); opacity: 0.9; }
                    .approve-btn { background: var(--accent-green); color: #022c22; }
                    .reject-btn { background: rgba(239, 68, 68, 0.15); color: var(--accent-red); border: 1px solid rgba(239, 68, 68, 0.3); }
                    .expired-badge {
                        background: rgba(239, 68, 68, 0.15);
                        color: #f87171;
                        border: 1px solid rgba(239, 68, 68, 0.3);
                        padding: 0.2rem 0.6rem;
                        border-radius: 12px;
                        font-size: 0.75rem;
                        font-weight: 700;
                        margin-left: 0.4rem;
                    }
                    .active-badge {
                        background: rgba(16, 185, 129, 0.15);
                        color: #34d399;
                        border: 1px solid rgba(16, 185, 129, 0.3);
                        padding: 0.2rem 0.6rem;
                        border-radius: 12px;
                        font-size: 0.75rem;
                        font-weight: 700;
                    }
                    .filter-bar {
                        display: flex;
                        gap: 0.6rem;
                        margin-bottom: 1.5rem;
                    }
                    .filter-btn {
                        background: var(--card-bg);
                        border: 1px solid var(--card-border);
                        color: var(--text-muted);
                        padding: 0.45rem 1rem;
                        border-radius: 8px;
                        font-size: 0.85rem;
                        font-weight: 600;
                        cursor: pointer;
                        transition: all 0.2s;
                    }
                    .filter-btn.active, .filter-btn:hover {
                        background: rgba(59, 130, 246, 0.2);
                        color: #60a5fa;
                        border-color: rgba(59, 130, 246, 0.4);
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="header">
                        <div>
                            <h1>WhatsApp Job Tracker</h1>
                            <div style="margin-top: 0.4rem;" class="status-badge ${isWhatsAppConnected ? 'connected' : 'disconnected'}">
                                <span class="status-dot ${isWhatsAppConnected ? '' : 'red'}"></span>
                                ${isWhatsAppConnected ? `🟢 WhatsApp Connected (${targetGroupList.length} Groups Live)` : '🔴 WhatsApp Disconnected / Initializing'}
                            </div>
                        </div>
                        <a href="/download" class="download-btn">📊 Download Excel (Active Only)</a>
                    </div>

                    <div class="tab-bar">
                        <button class="tab-btn active" onclick="switchTab('pending')">📥 Pending Review (${pendingJobs.length})</button>
                        <button class="tab-btn" onclick="switchTab('excel')">📊 Excel Table — Approved Jobs (${activeApprovedJobs.length})</button>
                    </div>

                    <!-- Pending Review Section -->
                    <div id="pending-section" class="section-block active">
                        <div class="filter-bar">
                            <button class="filter-btn active" onclick="filterJobs('all')">All Pending</button>
                            <button class="filter-btn" onclick="filterJobs('active')">⏰ Active Only</button>
                            <button class="filter-btn" onclick="filterJobs('expired')">🚨 Expired</button>
                        </div>
        `;

        if (pendingJobs.length === 0) {
            html += `
                <div class="empty-state">
                    <h3>No pending jobs to review</h3>
                    <p style="margin-top: 0.5rem; font-size: 0.9rem;">Listening in real-time. New detected postings will appear here automatically!</p>
                </div>
            `;
        } else {
            for (const job of pendingJobs) {
                const expired = isDeadlineExpired(job.parsedDeadline);
                html += `
                    <div class="job-card" data-expired="${expired}">
                        <div class="card-header">
                            <div>
                                <h2 style="font-size: 1.2rem; font-weight: 700;">${escapeHTML(job.parsedCompany !== 'Unknown' ? job.parsedCompany : 'Job Opportunity')}</h2>
                                <p style="color: var(--text-muted); font-size: 0.9rem; margin-top: 0.2rem;">${escapeHTML(job.parsedRole)}</p>
                            </div>
                            <span class="group-tag">${escapeHTML(job.groupName || 'WhatsApp Group')}</span>
                        </div>
                        <div class="details-grid">
                            <div class="detail-item">
                                <div class="detail-label">Deadline</div>
                                <div class="detail-value">
                                    ${escapeHTML(job.parsedDeadline)}
                                    ${expired ? '<span class="expired-badge">🚨 EXPIRED</span>' : (job.parsedDeadline !== 'Not specified' ? '<span class="active-badge">⏰ ACTIVE</span>' : '')}
                                </div>
                            </div>
                            <div class="detail-item">
                                <div class="detail-label">Application Link</div>
                                <div class="detail-value link-value">
                                    ${job.link !== 'None' ? `<a href="${escapeHTML(job.link)}" target="_blank">Open Link ↗</a>` : 'None'}
                                </div>
                            </div>
                        </div>
                        <div class="content-box">${escapeHTML(job.content)}</div>
                        <div class="actions">
                            <form method="POST" action="/approve/${job._id}" style="display:inline;">
                                <button type="submit" class="btn-action approve-btn">✓ Approve & Add</button>
                            </form>
                            <form method="POST" action="/reject/${job._id}" style="display:inline;">
                                <button type="submit" class="btn-action reject-btn">✕ Reject</button>
                            </form>
                            <form method="POST" action="/delete/${job._id}" style="display:inline;" onsubmit="return confirm('Are you sure you want to delete this job entry permanently?');">
                                <button type="submit" class="btn-action reject-btn" style="background: rgba(239, 68, 68, 0.25); color: #fca5a5;">🗑️ Delete</button>
                            </form>
                        </div>
                    </div>
                `;
            }
        }

        html += `
                    </div> <!-- End pending-section -->

                    <!-- Live Excel Table Section -->
                    <div id="excel-section" class="section-block">
                        <div class="excel-table-card">
                            ${activeApprovedJobs.length === 0 ? `
                                <div class="empty-state">
                                    <h3>No active approved jobs yet</h3>
                                    <p style="margin-top: 0.5rem; font-size: 0.9rem;">Approve pending jobs above to add them to your live Excel sheet!</p>
                                </div>
                            ` : `
                                <table class="excel-table">
                                    <thead>
                                        <tr>
                                            <th>WhatsApp Group</th>
                                            <th>Company</th>
                                            <th>Role</th>
                                            <th>Deadline</th>
                                            <th>Link</th>
                                            <th>Date Detected</th>
                                            <th>Actions</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        ${activeApprovedJobs.map(job => `
                                            <tr>
                                                <td><span class="group-tag">${escapeHTML(job.groupName || 'WhatsApp Group')}</span></td>
                                                <td><strong>${escapeHTML(job.parsedCompany)}</strong></td>
                                                <td>${escapeHTML(job.parsedRole)}</td>
                                                <td><span class="active-badge">${escapeHTML(job.parsedDeadline)}</span></td>
                                                <td class="link-value">${job.link !== 'None' ? `<a href="${escapeHTML(job.link)}" target="_blank">Open Link ↗</a>` : 'None'}</td>
                                                <td style="color: var(--text-muted); font-size: 0.8rem;">${job.dateDetected ? new Date(job.dateDetected).toLocaleString('en-IN') : ''}</td>
                                                <td>
                                                    <form method="POST" action="/delete/${job._id}" style="display:inline;" onsubmit="return confirm('Delete this job entry?');">
                                                        <button type="submit" class="btn-action reject-btn" style="padding: 0.35rem 0.75rem; font-size: 0.78rem;">🗑️ Delete</button>
                                                    </form>
                                                </td>
                                            </tr>
                                        `).join('')}
                                    </tbody>
                                </table>
                            `}
                        </div>
                    </div> <!-- End excel-section -->
                </div>
            </body>
            <script>
                function switchTab(tab) {
                    const buttons = document.querySelectorAll('.tab-btn');
                    buttons.forEach(btn => btn.classList.remove('active'));
                    event.target.classList.add('active');

                    document.getElementById('pending-section').classList.remove('active');
                    document.getElementById('excel-section').classList.remove('active');

                    if (tab === 'pending') {
                        document.getElementById('pending-section').classList.add('active');
                    } else {
                        document.getElementById('excel-section').classList.add('active');
                    }
                }

                function filterJobs(mode) {
                    const buttons = document.querySelectorAll('.filter-btn');
                    buttons.forEach(btn => btn.classList.remove('active'));
                    event.target.classList.add('active');

                    const cards = document.querySelectorAll('.job-card');
                    cards.forEach(card => {
                        const isExpired = card.getAttribute('data-expired') === 'true';
                        if (mode === 'all') {
                            card.style.display = 'block';
                        } else if (mode === 'active') {
                            card.style.display = isExpired ? 'none' : 'block';
                        } else if (mode === 'expired') {
                            card.style.display = isExpired ? 'block' : 'none';
                        }
                    });
                }

                const evtSource = new EventSource('/updates');
                evtSource.onmessage = function(e) {
                    if (e.data === 'new_job') {
                        window.location.reload();
                    }
                };
                evtSource.onerror = function() {
                    setTimeout(() => { evtSource.close(); }, 3000);
                };
            </script>
            </html>
        `;
        res.send(html);
    } catch (err) {
        console.error('Error in app.get(/):', err);
        res.status(500).send('Error fetching jobs: ' + err.message);
    }
});

app.post('/approve/:id', async (req, res) => {
    try {
        await Job.findByIdAndUpdate(req.params.id, { status: 'approved' });
        notifyClients();
        res.redirect('/');
    } catch (err) {
        res.status(500).send('Error approving job.');
    }
});

app.post('/reject/:id', async (req, res) => {
    try {
        await Job.findByIdAndUpdate(req.params.id, { status: 'rejected' });
        notifyClients();
        res.redirect('/');
    } catch (err) {
        res.status(500).send('Error rejecting job.');
    }
});

app.post('/delete/:id', async (req, res) => {
    try {
        await Job.findByIdAndDelete(req.params.id);
        notifyClients();
        res.redirect('/');
    } catch (err) {
        res.status(500).send('Error deleting job.');
    }
});

// SSE endpoint for live UI updates
const sseClients = [];
app.get('/updates', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    sseClients.push(res);
    req.on('close', () => {
        const idx = sseClients.indexOf(res);
        if (idx !== -1) sseClients.splice(idx, 1);
    });
});

function notifyClients() {
    sseClients.forEach(client => {
        try { client.write('data: new_job\n\n'); } catch (e) {}
    });
}

app.get('/download', async (req, res) => {
    try {
        const approvedJobs = await Job.find({ status: 'approved' }).sort({ dateDetected: -1 }).lean();
        const activeApprovedJobs = approvedJobs.filter(job => !isDeadlineExpired(job.parsedDeadline));

        if (activeApprovedJobs.length === 0) {
            return res.send('No active (non-expired) approved jobs to download.');
        }

        const data = activeApprovedJobs.map(job => ({
            'WhatsApp Group': job.groupName || 'Unknown',
            'Company': job.parsedCompany,
            'Role': job.parsedRole,
            'Deadline': job.parsedDeadline,
            'Link': job.link,
            'Date Detected': job.dateDetected ? new Date(job.dateDetected).toLocaleString('en-IN') : 'Unknown',
            'Original Content': job.content
        }));

        const ws = xlsx.utils.json_to_sheet(data);
        ws['!cols'] = [
            { wch: 24 },
            { wch: 28 },
            { wch: 32 },
            { wch: 20 },
            { wch: 40 },
            { wch: 22 },
            { wch: 80 }
        ];

        const range = xlsx.utils.decode_range(ws['!ref']);
        for (let R = range.s.r; R <= range.e.r; R++) {
            for (let C = range.s.c; C <= range.e.c; C++) {
                const cellRef = xlsx.utils.encode_cell({ r: R, c: C });
                if (!ws[cellRef]) ws[cellRef] = { t: 's', v: '' };
                if (!ws[cellRef].s) ws[cellRef].s = {};
                ws[cellRef].s.alignment = { wrapText: true, vertical: 'top' };
                if (R === 0) {
                    ws[cellRef].s.font = { bold: true };
                    ws[cellRef].s.fill = { fgColor: { rgb: '1a202c' } };
                }
            }
        }

        const wb = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(wb, ws, 'Approved Jobs');

        const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx', cellStyles: true });

        res.setHeader('Content-Disposition', 'attachment; filename="approved_jobs.xlsx"');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buffer);
    } catch (err) {
        res.status(500).send('Error downloading excel file.');
    }
});

// Start Express HTTP Server immediately
app.listen(port, '0.0.0.0', () => {
    console.log(`Server listening on port ${port}`);

    // Self-ping keep-alive for Render
    const renderUrl = process.env.RENDER_EXTERNAL_URL || process.env.RENDER_URL;
    if (renderUrl) {
        const https = require('https');
        const http = require('http');
        const selfPing = () => {
            const lib = renderUrl.startsWith('https') ? https : http;
            lib.get(`${renderUrl}/ping`, (res) => {
                console.log(`[Keep-Alive] Self-ping sent to ${renderUrl}/ping — status: ${res.statusCode}`);
            }).on('error', (err) => {
                console.warn('[Keep-Alive] Self-ping failed:', err.message);
            });
        };
        setInterval(selfPing, 5 * 60 * 1000);
        console.log(`[Keep-Alive] Render sleep prevention active → pinging ${renderUrl}/ping every 5 min`);
    }
});
