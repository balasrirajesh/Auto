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
const nodemailer = require('nodemailer');
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

// ─── Email Notification Config ─────────────────────────────────────────────
const GMAIL_USER = (process.env.GMAIL_USER || '').trim();
const GMAIL_APP_PASSWORD = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
const ALERT_EMAIL = (process.env.ALERT_EMAIL || 'bsrajeshn@gmail.com').trim();

let emailTransporter = null;
if (GMAIL_USER && GMAIL_APP_PASSWORD) {
    emailTransporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD }
    });
    console.log(`✉️  Email alerts enabled → ${ALERT_EMAIL}`);
} else {
    console.warn('⚠️  Email alerts disabled. Set GMAIL_USER and GMAIL_APP_PASSWORD in environment variables.');
}

async function sendJobAlert(job) {
    if (!emailTransporter) return;
    try {
        const deadlineBadge = job.parsedDeadline && job.parsedDeadline !== 'Not specified'
            ? `<span style="background:#10b981;color:#022c22;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:700;">${job.parsedDeadline}</span>`
            : `<span style="background:#334155;color:#94a3b8;padding:3px 10px;border-radius:20px;font-size:12px;">Not specified</span>`;

        const jobLinks = (job.links && job.links.length > 0) ? job.links : (job.link && job.link !== 'None' ? [job.link] : []);
        const linkBtn = jobLinks.length > 0
            ? jobLinks.map((l, i) => `<a href="${l}" style="display:inline-block;margin-top:8px;margin-right:8px;background:linear-gradient(135deg,#3b82f6,#6366f1);color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:700;font-size:13px;">🔗 ${jobLinks.length > 1 ? `Link ${i + 1}` : 'Apply Now'}</a>`).join('')
            : '';

        await emailTransporter.sendMail({
            from: `"Job Tracker Bot 🤖" <${GMAIL_USER}>`,
            to: ALERT_EMAIL,
            subject: `🚨 New Job Alert: ${job.parsedCompany} — ${job.parsedRole}`,
            html: `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:'Inter',Arial,sans-serif;background:#0b0f19;">
  <div style="max-width:580px;margin:0 auto;background:#0b0f19;">
    <!-- Header -->
    <div style="background:linear-gradient(135deg,#1e3a5f,#0f2847);padding:32px 32px 24px;border-bottom:1px solid rgba(59,130,246,0.2);">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;">
        <span style="font-size:28px;">💼</span>
        <span style="color:#60a5fa;font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">WhatsApp Job Tracker</span>
      </div>
      <h1 style="color:#f1f5f9;font-size:22px;font-weight:800;margin:0;line-height:1.3;">New Job Opportunity Detected!</h1>
      <p style="color:#64748b;font-size:13px;margin:6px 0 0;">Captured from WhatsApp · Pending your approval</p>
    </div>

    <!-- Job Details Card -->
    <div style="padding:28px 32px;">
      <div style="background:rgba(30,42,68,0.8);border:1px solid rgba(255,255,255,0.08);border-radius:14px;padding:24px;margin-bottom:20px;">

        <div style="margin-bottom:18px;">
          <p style="color:#64748b;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin:0 0 6px;">Company</p>
          <p style="color:#f1f5f9;font-size:20px;font-weight:800;margin:0;">${escapeHTML(job.parsedCompany || 'Unknown')}</p>
        </div>

        <div style="margin-bottom:18px;">
          <p style="color:#64748b;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin:0 0 6px;">Role / Position</p>
          <p style="color:#93c5fd;font-size:16px;font-weight:600;margin:0;">${escapeHTML(job.parsedRole || 'Not specified')}</p>
        </div>

        <div style="display:flex;gap:20px;flex-wrap:wrap;margin-bottom:18px;">
          <div style="flex:1;min-width:140px;">
            <p style="color:#64748b;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin:0 0 6px;">Deadline</p>
            ${deadlineBadge}
          </div>
          <div style="flex:1;min-width:140px;">
            <p style="color:#64748b;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin:0 0 6px;">Source Group</p>
            <span style="background:rgba(139,92,246,0.2);color:#a78bfa;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:600;">${escapeHTML(job.groupName || 'WhatsApp Group')}</span>
          </div>
        </div>

        ${linkBtn}
      </div>

      <!-- Message Preview -->
      <div style="background:#0f172a;border:1px solid rgba(255,255,255,0.05);border-radius:10px;padding:16px;margin-bottom:20px;">
        <p style="color:#64748b;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin:0 0 10px;">Original Message</p>
        <p style="color:#94a3b8;font-size:13px;line-height:1.7;margin:0;white-space:pre-wrap;max-height:200px;overflow:hidden;">${escapeHTML((job.content || '').substring(0, 500))}${(job.content || '').length > 500 ? '...' : ''}</p>
      </div>

      <!-- Action Buttons -->
      <div style="text-align:center;padding:8px 0;">
        <p style="color:#64748b;font-size:13px;margin:0 0 14px;">Open your dashboard to approve or reject this job:</p>
        <a href="${process.env.RENDER_EXTERNAL_URL || 'http://localhost:' + port}" style="display:inline-block;background:linear-gradient(135deg,#10b981,#059669);color:#022c22;padding:12px 28px;border-radius:10px;text-decoration:none;font-weight:800;font-size:15px;margin-right:10px;">✅ Open Dashboard</a>
      </div>
    </div>

    <!-- Footer -->
    <div style="padding:20px 32px;border-top:1px solid rgba(255,255,255,0.05);text-align:center;">
      <p style="color:#334155;font-size:12px;margin:0;">WhatsApp Job Tracker Bot · Auto-generated alert</p>
      <p style="color:#334155;font-size:11px;margin:4px 0 0;">Detected at ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST</p>
    </div>
  </div>
</body>
</html>`
        });
        console.log(`   ✉️  Email alert sent to ${ALERT_EMAIL}`);
    } catch (err) {
        console.error('   ❌ Email alert failed:', err.message);
    }
}

// Mongoose schema for jobs
const jobSchema = new mongoose.Schema({
    content: String,
    groupName: String,
    dateDetected: { type: Date, default: Date.now },
    status: { type: String, default: 'pending', enum: ['pending', 'approved', 'rejected'] },
    parsedCompany: String,
    parsedRole: String,
    parsedDeadline: String,
    link: String,
    links: [String]
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
let latestQRCode = null;
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

// Smart Job Parser & Intent Validator
const JOB_KEYWORDS = [
    'hiring', 'internship', 'intern', 'job', 'role', 'full-time', 'fulltime', 'part-time',
    'fresher', 'freshers', 'drive', 'campus drive', 'off campus', 'off-campus', 'placement',
    'stipend', 'ctc', 'lpa', 'careers', 'walk-in', 'walkin', 'opening', 'openings',
    'registration link', 'apply link', 'job description', 'opportunity', 'salary', 'package'
];

const JOB_DOMAINS = [
    'forms.gle', 'docs.google.com/forms', 'unstop.com', 'linkedin.com/jobs', 'naukri.com',
    'hirist.com', 'lever.co', 'greenhouse.io', 'myworkdayjobs.com', 'foundit.in', 'indeed.com',
    'careers.', 'jobs.', '/careers', '/apply', '/job/'
];

const EXCLUDE_DOC_EXTENSIONS = /\.(pdf|txt|docx?|pptx?|xlsx?|zip|rar|png|jpe?g)$/i;
const EXCLUDE_ACADEMIC_KEYWORDS = [
    'syllabus', 'syallabus', 'curriculum', 'timetable', 'time table', 'hallticket', 'hall ticket',
    'mid-1', 'mid-2', 'mid 1', 'mid 2', 'semester exam', 'lab manual', 'assignment', 'question paper',
    'marksheet', 'attendance'
];

const LINK_REGEX = /(https?:\/\/[^\s]+)/;
const GLOBAL_LINK_REGEX = /(https?:\/\/[^\s<>"'\)]+)/g;

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

    const rawLinks = text.match(GLOBAL_LINK_REGEX) || [];
    const links = Array.from(new Set(rawLinks.map(l => l.replace(/[.,;)]+$/, '').trim()))).filter(l => l.length > 8);
    const link = links.length > 0 ? links[0] : 'None';

    return {
        company: company ? company.substring(0, 120) : 'Unknown',
        role: role ? role.substring(0, 120) : 'Not specified',
        deadline: deadline ? deadline.substring(0, 100) : 'Not specified',
        link,
        links: links.length > 0 ? links : (link !== 'None' ? [link] : [])
    };
}

function isJobOfferMessage(text) {
    if (!text || typeof text !== 'string') return false;
    const trimmed = text.trim();
    if (trimmed.length < 15) return false;

    // Check if it's purely a document filename without job text (e.g. "exp2pe.txt" or "Syllabus.pdf")
    const lines = trimmed.split('\n').map(l => l.trim()).filter(Boolean);
    const isSingleDocFilename = lines.length <= 2 && EXCLUDE_DOC_EXTENSIONS.test(trimmed) && !JOB_KEYWORDS.some(kw => trimmed.toLowerCase().includes(kw));
    if (isSingleDocFilename) return false;

    const lower = trimmed.toLowerCase();

    // Reject academic files/notes unless accompanied by strong placement/job keywords
    const hasAcademicExclusion = EXCLUDE_ACADEMIC_KEYWORDS.some(kw => lower.includes(kw));
    const hasStrongJobKeyword = ['hiring', 'internship', 'campus drive', 'off-campus', 'off campus', 'placement drive', 'job role', 'stipend', 'ctc', 'lpa', 'fresher', 'apply here', 'apply link', 'registration link'].some(kw => lower.includes(kw));
    
    if (hasAcademicExclusion && !hasStrongJobKeyword) {
        return false;
    }

    // Check if message has Company Name + Deadline + Link(s)
    const { company, deadline, links } = parseJobMessage(text);
    const hasCompany = company && company !== 'Unknown';
    const hasDeadline = deadline && deadline !== 'Not specified';
    const hasLinks = links && links.length > 0;

    // Condition A: Company Name + Deadline + Link(s)
    if (hasCompany && hasDeadline && hasLinks) {
        return true;
    }

    // Condition B: Check for explicit job application domain (forms.gle, unstop, etc.)
    const hasJobDomain = JOB_DOMAINS.some(domain => lower.includes(domain));
    if (hasJobDomain) return true;

    // Condition C: General job keywords
    const hasKeyword = JOB_KEYWORDS.some(kw => lower.includes(kw));
    return hasKeyword;
}

function normalizeText(str) {
    if (!str) return '';
    return str.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function isDuplicateJob(contentText, link, company, role, links = []) {
    // 1. Exact match on raw content
    const exactMatch = await Job.findOne({ content: contentText });
    if (exactMatch) return true;

    // 2. Exact match on any of the application URLs (across single or multiple groups)
    const allLinks = (links && links.length > 0) ? links : (link && link !== 'None' ? [link] : []);
    for (const l of allLinks) {
        if (l && l.startsWith('http')) {
            const linkMatch = await Job.findOne({ $or: [{ link: l }, { links: l }] });
            if (linkMatch) return true;
        }
    }

    // 3. Company & Role duplicate match (if company & role are validly parsed)
    if (company && company !== 'Unknown' && company.length > 2 && role && role !== 'Not specified' && role.length > 2) {
        const compRoleMatch = await Job.findOne({
            parsedCompany: { $regex: new RegExp('^' + escapeRegExp(company) + '$', 'i') },
            parsedRole: { $regex: new RegExp('^' + escapeRegExp(role) + '$', 'i') }
        });
        if (compRoleMatch) return true;
    }

    // 4. Core text similarity match (skip common greetings header)
    const normContent = normalizeText(contentText);
    if (normContent.length > 30) {
        const coreText = normContent.length > 120 ? normContent.substring(30, 130) : normContent;
        const recentJobs = await Job.find({}).sort({ dateDetected: -1 }).limit(100);
        for (const job of recentJobs) {
            const normExisting = normalizeText(job.content);
            if (normExisting === normContent) return true;
            if (coreText.length > 40 && normExisting.includes(coreText)) {
                return true;
            }
        }
    }

    return false;
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
        const isExplicitTarget = isWildcard || (Boolean(chatNameClean) && targetGroupList.some(target => target && target.length > 0 && chatNameClean.includes(target)));

        if (!isExplicitTarget) {
            console.log(`   └─ ⏩ Skipped (group "${chatName}" not in monitored target list)`);
            return;
        }

        const isJobMsg = isJobOfferMessage(contentText);
        console.log(`   ├─ Target Group Match: ${isExplicitTarget} ("${chatName}") | Valid Job Intent: ${isJobMsg}`);

        if (!isJobMsg) {
            console.log(`   └─ ⏩ Skipped (message is not a job/internship/drive announcement)`);
            return;
        }

        const { company, role, deadline, link, links } = parseJobMessage(contentText);

        const duplicate = await isDuplicateJob(contentText, link, company, role, links);
        if (duplicate) {
            console.log(`   └─ ⏩ Skipped (duplicate job already captured in single or across multiple groups)`);
            return;
        }

        const newJob = new Job({
            content: contentText,
            groupName: chatName || 'WhatsApp Group',
            parsedCompany: company,
            parsedRole: role,
            parsedDeadline: deadline,
            link: link,
            links: links && links.length > 0 ? links : (link !== 'None' ? [link] : [])
        });

        await newJob.save();
        notifyClients();
        console.log(`   └─ ✅ [SAVED TO DATABASE] Company: "${company}" | Role: "${role}" | Links: ${links.length}`);

        // Send email alert
        sendJobAlert(newJob).catch(() => {});
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
                latestQRCode = qr;
                qrcode.generate(qr, { small: true });
                console.log('⚡ QR Code generated. Visit /qr on your deployed URL to scan it.');
            }

            if (connection === 'open') {
                isWhatsAppConnected = true;
                latestQRCode = null;
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

// QR Code page
app.get('/qr', async (req, res) => {
    if (isWhatsAppConnected) {
        return res.send(`
            <!DOCTYPE html><html><head><meta charset="UTF-8">
            <title>WhatsApp Status</title>
            <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap" rel="stylesheet">
            <style>body{font-family:'Inter',sans-serif;background:#0b0f19;color:#10b981;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;gap:1rem;}</style>
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
            <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap" rel="stylesheet">
            <style>body{font-family:'Inter',sans-serif;background:#0b0f19;color:#f1f5f9;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;gap:1rem;}</style>
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
            <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap" rel="stylesheet">
            <style>
                body{font-family:'Inter',sans-serif;background:#0b0f19;color:#f1f5f9;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;flex-direction:column;gap:1.5rem;padding:2rem;}
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

// ─── Main Dashboard ───────────────────────────────────────────────────────────
app.get('/', async (req, res) => {
    try {
        if (!mongoURI) {
            return res.send('<p>Please set MONGODB_URI in your environment.</p>');
        }

        const pendingJobs = await Job.find({ status: 'pending' }).sort({ dateDetected: -1 });
        const approvedJobs = await Job.find({ status: 'approved' }).sort({ dateDetected: -1 });
        const rejectedCount = await Job.countDocuments({ status: 'rejected' });
        const activeApprovedJobs = approvedJobs.filter(job => !isDeadlineExpired(job.parsedDeadline));
        const todayStart = new Date(); todayStart.setHours(0,0,0,0);
        const todayCount = await Job.countDocuments({ dateDetected: { $gte: todayStart } });

        const connectedBadge = isWhatsAppConnected
            ? `<div class="status-pill connected"><span class="dot"></span>WhatsApp Live · ${targetGroupList.length} Groups</div>`
            : `<div class="status-pill disconnected"><span class="dot red"></span>WhatsApp Disconnected</div>`;

        const emailStatus = emailTransporter
            ? `<div class="status-pill email-on"><span style="font-size:13px;">✉️</span> Email Alerts ON</div>`
            : `<div class="status-pill email-off"><span style="font-size:13px;">✉️</span> Email Alerts OFF</div>`;

        let pendingHTML = '';
        if (pendingJobs.length === 0) {
            pendingHTML = `
                <div class="empty-state">
                    <div class="empty-icon">📭</div>
                    <h3>All caught up!</h3>
                    <p>No pending jobs to review. New detections will appear here automatically.</p>
                </div>`;
        } else {
            for (const job of pendingJobs) {
                const expired = isDeadlineExpired(job.parsedDeadline);
                const initials = (job.parsedCompany || 'J').replace(/[^a-zA-Z]/g, '').substring(0, 2).toUpperCase() || 'JB';
                const hue = (initials.charCodeAt(0) * 47 + (initials.charCodeAt(1) || 0) * 23) % 360;
                const jobLinks = (job.links && job.links.length > 0) ? job.links : (job.link && job.link !== 'None' ? [job.link] : []);
                const linksHTML = jobLinks.length > 0
                    ? jobLinks.map((l, idx) => `<a href="${escapeHTML(l)}" target="_blank" class="apply-link" style="margin-right:8px;">${jobLinks.length > 1 ? `Link ${idx + 1} ↗` : 'Open Link ↗'}</a>`).join('')
                    : '<span class="text-muted">None</span>';

                pendingHTML += `
                <div class="job-card" data-expired="${expired}">
                    <div class="card-top">
                        <div class="company-avatar" style="background:linear-gradient(135deg,hsl(${hue},70%,40%),hsl(${(hue+40)%360},80%,55%));">${initials}</div>
                        <div class="card-info">
                            <h2 class="company-name">${escapeHTML(job.parsedCompany !== 'Unknown' ? job.parsedCompany : 'Job Opportunity')}</h2>
                            <p class="role-name">${escapeHTML(job.parsedRole)}</p>
                        </div>
                        <div class="card-badges">
                            <span class="group-tag">${escapeHTML(job.groupName || 'WhatsApp')}</span>
                            ${expired
                                ? '<span class="badge-expired">🚨 Expired</span>'
                                : (job.parsedDeadline !== 'Not specified' ? '<span class="badge-active">⏰ Active</span>' : '')}
                        </div>
                    </div>
                    <div class="card-meta">
                        <div class="meta-item">
                            <span class="meta-label">📅 Deadline</span>
                            <span class="meta-value">${escapeHTML(job.parsedDeadline)}</span>
                        </div>
                        <div class="meta-item">
                            <span class="meta-label">🔗 Links (${jobLinks.length})</span>
                            <span class="meta-value">${linksHTML}</span>
                        </div>
                        <div class="meta-item">
                            <span class="meta-label">🕒 Detected</span>
                            <span class="meta-value">${job.dateDetected ? new Date(job.dateDetected).toLocaleString('en-IN') : ''}</span>
                        </div>
                    </div>
                    <div class="desc-box">
                        <div class="desc-header">
                            <span>📜 Full WhatsApp Announcement & Description</span>
                            <button type="button" class="expand-btn" onclick="toggleExpand(this)">Expand / Collapse ↕</button>
                        </div>
                        <div class="desc-content">${escapeHTML(job.content)}</div>
                    </div>
                    <div class="card-actions">
                        <form method="POST" action="/approve/${job._id}" style="display:inline;">
                            <button type="submit" class="btn btn-approve">✓ Approve & Add to Tracker</button>
                        </form>
                        <form method="POST" action="/reject/${job._id}" style="display:inline;">
                            <button type="submit" class="btn btn-reject">✕ Reject Job</button>
                        </form>
                        <form method="POST" action="/delete/${job._id}" style="display:inline;" onsubmit="return confirm('Delete this job entry permanently?');">
                            <button type="submit" class="btn btn-delete">🗑️ Delete</button>
                        </form>
                    </div>
                </div>`;
            }
        }

        let tableHTML = '';
        if (activeApprovedJobs.length === 0) {
            tableHTML = `
                <div class="empty-state">
                    <div class="empty-icon">📊</div>
                    <h3>No approved jobs yet</h3>
                    <p>Approve pending jobs to build your live tracker table.</p>
                </div>`;
        } else {
            tableHTML = `
            <div class="table-wrap">
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>#</th>
                            <th>Company</th>
                            <th>Role</th>
                            <th>Deadline</th>
                            <th>Group</th>
                            <th>Links</th>
                            <th>Detected</th>
                            <th>Action</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${activeApprovedJobs.map((job, i) => {
                            const jobLinks = (job.links && job.links.length > 0) ? job.links : (job.link && job.link !== 'None' ? [job.link] : []);
                            const tableLinksHTML = jobLinks.length > 0
                                ? jobLinks.map((l, idx) => `<a href="${escapeHTML(l)}" target="_blank" class="apply-link" style="margin-right:6px;">${jobLinks.length > 1 ? `Link ${idx + 1} ↗` : 'Apply ↗'}</a>`).join('')
                                : '<span class="text-muted">—</span>';
                            return `
                        <tr>
                            <td class="text-muted">${i + 1}</td>
                            <td><strong class="company-cell">${escapeHTML(job.parsedCompany)}</strong></td>
                            <td>${escapeHTML(job.parsedRole)}</td>
                            <td><span class="badge-active">${escapeHTML(job.parsedDeadline)}</span></td>
                            <td><span class="group-tag">${escapeHTML(job.groupName || 'WhatsApp')}</span></td>
                            <td>${tableLinksHTML}</td>
                            <td class="text-muted small-text">${job.dateDetected ? new Date(job.dateDetected).toLocaleString('en-IN') : ''}</td>
                            <td>
                                <form method="POST" action="/delete/${job._id}" style="display:inline;" onsubmit="return confirm('Delete this job?');">
                                    <button type="submit" class="btn btn-delete btn-sm">🗑️</button>
                                </form>
                            </td>
                        </tr>`;
                        }).join('')}
                    </tbody>
                </table>
            </div>`;
        }

        const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WhatsApp Job Tracker — Dashboard</title>
    <meta name="description" content="Auto-detect and manage job opportunities from WhatsApp groups with approval workflow.">
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
    <style>
        /* ── Design Tokens ── */
        :root {
            --bg: #070b14;
            --bg2: #0d1220;
            --surface: rgba(16, 24, 40, 0.85);
            --surface2: rgba(22, 32, 54, 0.9);
            --border: rgba(255,255,255,0.07);
            --border-hover: rgba(255,255,255,0.16);
            --text: #e8edf5;
            --muted: #64748b;
            --muted2: #94a3b8;
            --green: #10b981;
            --green-dim: rgba(16,185,129,0.12);
            --green-glow: rgba(16,185,129,0.25);
            --blue: #3b82f6;
            --blue-dim: rgba(59,130,246,0.12);
            --purple: #8b5cf6;
            --purple-dim: rgba(139,92,246,0.12);
            --red: #ef4444;
            --red-dim: rgba(239,68,68,0.12);
            --amber: #f59e0b;
            --radius: 14px;
            --radius-sm: 8px;
            --sidebar-w: 240px;
            --header-h: 64px;
        }
        *, *::before, *::after { margin:0; padding:0; box-sizing:border-box; }

        body {
            font-family: 'Inter', sans-serif;
            background: var(--bg);
            color: var(--text);
            min-height: 100vh;
            display: flex;
            overflow-x: hidden;
        }

        /* ── Background Orbs ── */
        body::before, body::after {
            content: '';
            position: fixed;
            border-radius: 50%;
            pointer-events: none;
            z-index: 0;
        }
        body::before {
            width: 600px; height: 600px;
            background: radial-gradient(circle, rgba(59,130,246,0.06) 0%, transparent 70%);
            top: -150px; left: -100px;
        }
        body::after {
            width: 500px; height: 500px;
            background: radial-gradient(circle, rgba(16,185,129,0.05) 0%, transparent 70%);
            bottom: -100px; right: -100px;
        }

        /* ── Sidebar ── */
        .sidebar {
            width: var(--sidebar-w);
            min-height: 100vh;
            background: var(--surface);
            border-right: 1px solid var(--border);
            display: flex;
            flex-direction: column;
            position: fixed;
            top: 0; left: 0; bottom: 0;
            z-index: 100;
            backdrop-filter: blur(20px);
            -webkit-backdrop-filter: blur(20px);
        }
        .sidebar-brand {
            padding: 24px 20px 20px;
            border-bottom: 1px solid var(--border);
        }
        .brand-icon { font-size: 28px; margin-bottom: 6px; display: block; }
        .brand-name {
            font-size: 0.95rem; font-weight: 800;
            background: linear-gradient(135deg, #10b981, #3b82f6);
            -webkit-background-clip: text; -webkit-text-fill-color: transparent;
            background-clip: text;
        }
        .brand-sub { font-size: 0.72rem; color: var(--muted); margin-top: 2px; }

        .sidebar-nav { flex: 1; padding: 16px 12px; display: flex; flex-direction: column; gap: 4px; }
        .nav-item {
            display: flex; align-items: center; gap: 12px;
            padding: 10px 14px; border-radius: var(--radius-sm);
            color: var(--muted2); font-size: 0.88rem; font-weight: 600;
            cursor: pointer; border: none; background: transparent;
            width: 100%; text-align: left; transition: all 0.2s;
            text-decoration: none;
        }
        .nav-item:hover { background: var(--blue-dim); color: #93c5fd; }
        .nav-item.active { background: var(--blue-dim); color: #60a5fa; border: 1px solid rgba(59,130,246,0.2); }
        .nav-icon { font-size: 18px; flex-shrink: 0; }
        .nav-badge {
            margin-left: auto; background: var(--blue);
            color: white; font-size: 0.7rem; font-weight: 700;
            padding: 2px 7px; border-radius: 10px; min-width: 22px; text-align: center;
        }
        .nav-badge.green { background: var(--green); }

        .sidebar-footer {
            padding: 16px 12px;
            border-top: 1px solid var(--border);
            display: flex; flex-direction: column; gap: 8px;
        }

        /* ── Main Content ── */
        .main {
            margin-left: var(--sidebar-w);
            flex: 1;
            display: flex;
            flex-direction: column;
            min-height: 100vh;
            position: relative;
            z-index: 1;
        }

        /* ── Top Bar ── */
        .topbar {
            height: var(--header-h);
            background: rgba(7,11,20,0.9);
            backdrop-filter: blur(20px);
            border-bottom: 1px solid var(--border);
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 0 28px;
            position: sticky; top: 0; z-index: 50;
        }
        .topbar-title {
            font-size: 1rem; font-weight: 700; color: var(--text);
        }
        .topbar-right { display: flex; align-items: center; gap: 10px; }

        /* ── Status Pills ── */
        .status-pill {
            display: inline-flex; align-items: center; gap: 7px;
            padding: 5px 12px; border-radius: 20px;
            font-size: 0.78rem; font-weight: 700;
        }
        .status-pill.connected {
            background: var(--green-dim); color: #34d399;
            border: 1px solid rgba(16,185,129,0.25);
        }
        .status-pill.disconnected {
            background: var(--red-dim); color: #f87171;
            border: 1px solid rgba(239,68,68,0.25);
        }
        .status-pill.email-on {
            background: var(--blue-dim); color: #93c5fd;
            border: 1px solid rgba(59,130,246,0.2);
        }
        .status-pill.email-off {
            background: rgba(100,116,139,0.12); color: var(--muted2);
            border: 1px solid rgba(100,116,139,0.2);
        }
        .dot {
            width: 7px; height: 7px; border-radius: 50%;
            background: #34d399; box-shadow: 0 0 8px #34d399;
            animation: blink 2s infinite;
        }
        .dot.red { background: #f87171; box-shadow: 0 0 8px #f87171; }
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0.3} }

        /* ── Content Area ── */
        .content { padding: 28px; flex: 1; }

        /* ── Stats Row ── */
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 16px;
            margin-bottom: 28px;
        }
        .stat-card {
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: var(--radius);
            padding: 20px 22px;
            backdrop-filter: blur(10px);
            position: relative;
            overflow: hidden;
            transition: transform 0.2s, border-color 0.2s;
        }
        .stat-card:hover { transform: translateY(-2px); border-color: var(--border-hover); }
        .stat-card::before {
            content: '';
            position: absolute;
            top: 0; left: 0; right: 0;
            height: 2px;
        }
        .stat-card.s-pending::before { background: linear-gradient(90deg, var(--blue), var(--purple)); }
        .stat-card.s-approved::before { background: linear-gradient(90deg, var(--green), #06d6a0); }
        .stat-card.s-rejected::before { background: linear-gradient(90deg, var(--red), #f97316); }
        .stat-card.s-today::before { background: linear-gradient(90deg, var(--amber), #f97316); }

        .stat-icon { font-size: 26px; margin-bottom: 10px; display: block; }
        .stat-value { font-size: 2rem; font-weight: 900; line-height: 1; margin-bottom: 4px; }
        .stat-card.s-pending .stat-value { color: #93c5fd; }
        .stat-card.s-approved .stat-value { color: #34d399; }
        .stat-card.s-rejected .stat-value { color: #fca5a5; }
        .stat-card.s-today .stat-value { color: #fcd34d; }
        .stat-label { font-size: 0.78rem; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.8px; }

        /* ── Tab Bar ── */
        .tab-bar {
            display: flex; gap: 4px;
            background: var(--surface);
            border: 1px solid var(--border);
            padding: 4px; border-radius: 12px;
            margin-bottom: 24px;
            width: fit-content;
        }
        .tab-btn {
            padding: 8px 18px;
            border-radius: 9px; border: none;
            font-weight: 700; font-size: 0.88rem;
            cursor: pointer; transition: all 0.2s;
            background: transparent; color: var(--muted2);
        }
        .tab-btn.active { background: var(--blue); color: #fff; box-shadow: 0 2px 12px rgba(59,130,246,0.4); }
        .tab-btn:not(.active):hover { background: var(--blue-dim); color: #93c5fd; }

        /* ── Filter Bar ── */
        .filter-bar { display: flex; gap: 8px; margin-bottom: 20px; align-items: center; }
        .filter-btn {
            padding: 6px 14px; border-radius: 20px;
            border: 1px solid var(--border);
            background: var(--surface); color: var(--muted2);
            font-size: 0.82rem; font-weight: 600; cursor: pointer; transition: all 0.2s;
        }
        .filter-btn.active, .filter-btn:hover {
            background: var(--blue-dim); color: #93c5fd; border-color: rgba(59,130,246,0.3);
        }
        .filter-label { font-size: 0.82rem; color: var(--muted); font-weight: 600; margin-right: 4px; }

        /* ── Section Blocks ── */
        .section-block { display: none; animation: fadeIn 0.3s ease; }
        .section-block.active { display: block; }
        @keyframes fadeIn { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }

        /* ── Job Cards ── */
        .job-card {
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: var(--radius);
            padding: 22px;
            margin-bottom: 16px;
            backdrop-filter: blur(10px);
            transition: all 0.25s;
            position: relative;
        }
        .job-card:hover {
            border-color: rgba(59,130,246,0.25);
            box-shadow: 0 8px 32px rgba(0,0,0,0.3), 0 0 0 1px rgba(59,130,246,0.08);
            transform: translateY(-1px);
        }
        .card-top { display: flex; align-items: center; gap: 16px; margin-bottom: 16px; flex-wrap: wrap; }
        .company-avatar {
            width: 48px; height: 48px; border-radius: 12px;
            display: flex; align-items: center; justify-content: center;
            font-weight: 900; font-size: 1rem; color: #fff;
            flex-shrink: 0; letter-spacing: 1px;
        }
        .card-info { flex: 1; min-width: 0; }
        .company-name { font-size: 1.1rem; font-weight: 800; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .role-name { font-size: 0.88rem; color: var(--muted2); margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .card-badges { display: flex; gap: 6px; flex-wrap: wrap; margin-left: auto; }

        .group-tag {
            background: var(--purple-dim);
            color: #c4b5fd; border: 1px solid rgba(139,92,246,0.25);
            padding: 3px 10px; border-radius: 20px;
            font-size: 0.75rem; font-weight: 700;
        }
        .badge-expired {
            background: var(--red-dim); color: #fca5a5;
            border: 1px solid rgba(239,68,68,0.25);
            padding: 3px 10px; border-radius: 20px;
            font-size: 0.75rem; font-weight: 700;
        }
        .badge-active {
            background: var(--green-dim); color: #34d399;
            border: 1px solid rgba(16,185,129,0.25);
            padding: 3px 10px; border-radius: 20px;
            font-size: 0.75rem; font-weight: 700;
        }

        .card-meta {
            display: flex; gap: 20px; flex-wrap: wrap;
            margin-bottom: 14px; padding: 12px 14px;
            background: rgba(0,0,0,0.25); border-radius: 10px;
            border: 1px solid rgba(255,255,255,0.04);
        }
        .meta-item { display: flex; flex-direction: column; gap: 3px; }
        .meta-label { font-size: 0.72rem; color: var(--muted); font-weight: 700; text-transform: uppercase; letter-spacing: 0.6px; }
        .meta-value { font-size: 0.88rem; font-weight: 600; }

        .apply-link { color: #60a5fa; text-decoration: none; font-weight: 700; }
        .apply-link:hover { color: #93c5fd; text-decoration: underline; }
        .text-muted { color: var(--muted); }

        .desc-box {
            background: rgba(13, 19, 34, 0.8);
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 10px;
            margin-bottom: 18px;
            overflow: hidden;
        }
        .desc-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 10px 14px;
            background: rgba(0,0,0,0.35);
            border-bottom: 1px solid rgba(255,255,255,0.06);
            font-size: 0.76rem;
            font-weight: 700;
            color: #94a3b8;
            text-transform: uppercase;
            letter-spacing: 0.6px;
        }
        .expand-btn {
            background: rgba(59,130,246,0.12);
            border: 1px solid rgba(59,130,246,0.25);
            color: #60a5fa;
            padding: 3px 10px;
            border-radius: 6px;
            font-size: 0.75rem;
            font-weight: 700;
            cursor: pointer;
            transition: all 0.2s;
        }
        .expand-btn:hover { background: rgba(59,130,246,0.25); color: #93c5fd; }
        .desc-content {
            white-space: pre-wrap;
            padding: 14px 16px;
            font-size: 0.88rem;
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
            line-height: 1.65;
            color: #cbd5e1;
            max-height: 260px;
            overflow-y: auto;
            transition: max-height 0.3s ease;
        }
        .desc-content.expanded {
            max-height: none !important;
        }
        .desc-content::-webkit-scrollbar { width: 4px; }
        .desc-content::-webkit-scrollbar-track { background: transparent; }
        .desc-content::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 2px; }

        .card-actions { display: flex; gap: 8px; flex-wrap: wrap; }

        /* ── Buttons ── */
        .btn {
            padding: 8px 18px; border-radius: var(--radius-sm);
            font-weight: 700; font-size: 0.85rem;
            border: none; cursor: pointer; transition: all 0.18s;
            letter-spacing: 0.2px;
        }
        .btn:hover { transform: translateY(-1px); }
        .btn-approve {
            background: linear-gradient(135deg, #10b981, #059669);
            color: #022c22;
            box-shadow: 0 3px 12px rgba(16,185,129,0.35);
        }
        .btn-approve:hover { box-shadow: 0 5px 20px rgba(16,185,129,0.5); }
        .btn-reject {
            background: var(--red-dim); color: #f87171;
            border: 1px solid rgba(239,68,68,0.25);
        }
        .btn-reject:hover { background: rgba(239,68,68,0.2); }
        .btn-delete {
            background: rgba(239,68,68,0.08); color: #fca5a5;
            border: 1px solid rgba(239,68,68,0.15);
        }
        .btn-delete:hover { background: rgba(239,68,68,0.18); }
        .btn-sm { padding: 5px 10px; font-size: 0.8rem; }

        .dl-btn {
            display: inline-flex; align-items: center; gap: 8px;
            background: linear-gradient(135deg, #10b981, #059669);
            color: #022c22; padding: 8px 18px; border-radius: var(--radius-sm);
            text-decoration: none; font-weight: 700; font-size: 0.88rem;
            box-shadow: 0 3px 14px rgba(16,185,129,0.3); transition: all 0.2s;
        }
        .dl-btn:hover { transform: translateY(-2px); box-shadow: 0 6px 22px rgba(16,185,129,0.45); }

        /* ── Empty State ── */
        .empty-state {
            text-align: center; padding: 60px 24px;
            background: var(--surface); border: 1px dashed var(--border);
            border-radius: var(--radius); color: var(--muted);
        }
        .empty-icon { font-size: 48px; margin-bottom: 16px; display: block; }
        .empty-state h3 { font-size: 1.2rem; font-weight: 700; color: var(--muted2); margin-bottom: 8px; }
        .empty-state p { font-size: 0.9rem; }

        /* ── Data Table ── */
        .table-wrap {
            background: var(--surface); border: 1px solid var(--border);
            border-radius: var(--radius); overflow: hidden; overflow-x: auto;
        }
        .data-table {
            width: 100%; border-collapse: collapse;
            font-size: 0.87rem; min-width: 700px;
        }
        .data-table thead { position: sticky; top: 0; z-index: 10; }
        .data-table th {
            background: rgba(0,0,0,0.5);
            color: var(--muted); padding: 13px 14px;
            font-weight: 700; font-size: 0.72rem;
            text-transform: uppercase; letter-spacing: 0.8px;
            border-bottom: 1px solid var(--border); text-align: left;
        }
        .data-table td {
            padding: 13px 14px;
            border-bottom: 1px solid rgba(255,255,255,0.03);
            vertical-align: middle;
        }
        .data-table tbody tr { transition: background 0.15s; }
        .data-table tbody tr:hover { background: rgba(255,255,255,0.02); }
        .data-table tbody tr:last-child td { border-bottom: none; }
        .company-cell { font-weight: 700; }
        .small-text { font-size: 0.78rem; }

        /* ── Toast Notifications ── */
        #toast-container {
            position: fixed; bottom: 24px; right: 24px;
            display: flex; flex-direction: column-reverse; gap: 10px;
            z-index: 9999; pointer-events: none;
        }
        .toast {
            background: rgba(16,24,40,0.97);
            border: 1px solid rgba(16,185,129,0.4);
            color: var(--text); padding: 14px 18px;
            border-radius: 12px; font-size: 0.88rem; font-weight: 600;
            box-shadow: 0 8px 32px rgba(0,0,0,0.5), 0 0 0 1px rgba(16,185,129,0.15);
            animation: slideInToast 0.4s ease;
            min-width: 260px; max-width: 340px;
            backdrop-filter: blur(20px); pointer-events: all;
        }
        @keyframes slideInToast {
            from { opacity:0; transform: translateX(60px); }
            to { opacity:1; transform: translateX(0); }
        }
        .toast-title { color: #34d399; font-weight: 800; margin-bottom: 2px; }

        /* ── Scrollbar ── */
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 3px; }
        ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.2); }

        /* ── Responsive ── */
        @media (max-width: 900px) {
            .sidebar { width: 60px; }
            .brand-name, .brand-sub, .nav-item span:not(.nav-icon), .nav-badge { display: none; }
            .main { margin-left: 60px; }
            .stats-grid { grid-template-columns: repeat(2, 1fr); }
        }
        @media (max-width: 600px) {
            .stats-grid { grid-template-columns: 1fr 1fr; }
            .content { padding: 16px; }
        }
    </style>
</head>
<body>

<!-- ── Sidebar ── -->
<aside class="sidebar">
    <div class="sidebar-brand">
        <span class="brand-icon">💼</span>
        <div class="brand-name">Job Tracker</div>
        <div class="brand-sub">WhatsApp Automation</div>
    </div>
    <nav class="sidebar-nav">
        <button class="nav-item active" id="nav-pending" onclick="switchTab('pending', this)">
            <span class="nav-icon">📥</span>
            <span>Pending</span>
            <span class="nav-badge">${pendingJobs.length}</span>
        </button>
        <button class="nav-item" id="nav-excel" onclick="switchTab('excel', this)">
            <span class="nav-icon">📊</span>
            <span>Approved Jobs</span>
            <span class="nav-badge green">${activeApprovedJobs.length}</span>
        </button>
        <a href="/qr" class="nav-item" target="_blank">
            <span class="nav-icon">📱</span>
            <span>WhatsApp QR</span>
        </a>
        <a href="/download" class="nav-item">
            <span class="nav-icon">⬇️</span>
            <span>Download Excel</span>
        </a>
    </nav>
    <div class="sidebar-footer">
        ${connectedBadge}
        ${emailStatus}
    </div>
</aside>

<!-- ── Main ── -->
<main class="main">
    <header class="topbar">
        <span class="topbar-title">WhatsApp Job Tracker</span>
        <div class="topbar-right">
            <form method="POST" action="/clean-false-positives" style="display:inline;" onsubmit="return confirm('Purge all non-job / document entries from pending list?');">
                <button type="submit" class="btn btn-reject btn-sm" style="margin-right:8px;">🧹 Purge Non-Jobs</button>
            </form>
            <form method="POST" action="/clean-duplicates" style="display:inline;" onsubmit="return confirm('Purge duplicate job entries from pending list?');">
                <button type="submit" class="btn btn-reject btn-sm" style="margin-right:10px;">👯 Purge Duplicates</button>
            </form>
            <a href="/download" class="dl-btn">📊 Download Excel</a>
        </div>
    </header>

    <div class="content">
        <!-- Stats -->
        <div class="stats-grid">
            <div class="stat-card s-pending">
                <span class="stat-icon">📥</span>
                <div class="stat-value">${pendingJobs.length}</div>
                <div class="stat-label">Pending Review</div>
            </div>
            <div class="stat-card s-approved">
                <span class="stat-icon">✅</span>
                <div class="stat-value">${activeApprovedJobs.length}</div>
                <div class="stat-label">Active Approved</div>
            </div>
            <div class="stat-card s-rejected">
                <span class="stat-icon">❌</span>
                <div class="stat-value">${rejectedCount}</div>
                <div class="stat-label">Rejected</div>
            </div>
            <div class="stat-card s-today">
                <span class="stat-icon">📅</span>
                <div class="stat-value">${todayCount}</div>
                <div class="stat-label">Captured Today</div>
            </div>
        </div>

        <!-- Tabs -->
        <div class="tab-bar">
            <button class="tab-btn active" id="tab-pending" onclick="switchTab('pending', document.getElementById('nav-pending'))">
                📥 Pending (${pendingJobs.length})
            </button>
            <button class="tab-btn" id="tab-excel" onclick="switchTab('excel', document.getElementById('nav-excel'))">
                📊 Approved Table (${activeApprovedJobs.length})
            </button>
        </div>

        <!-- Pending Section -->
        <div id="pending-section" class="section-block active">
            <div class="filter-bar">
                <span class="filter-label">Filter:</span>
                <button class="filter-btn active" onclick="filterJobs('all', this)">All</button>
                <button class="filter-btn" onclick="filterJobs('active', this)">⏰ Active</button>
                <button class="filter-btn" onclick="filterJobs('expired', this)">🚨 Expired</button>
            </div>
            ${pendingHTML}
        </div>

        <!-- Approved Table Section -->
        <div id="excel-section" class="section-block">
            ${tableHTML}
        </div>
    </div>
</main>

<!-- Toast Container -->
<div id="toast-container"></div>

<script>
    // Toggle expand/collapse for full description
    function toggleExpand(btn) {
        const descContent = btn.parentElement.nextElementSibling;
        const isExpanded = descContent.classList.toggle('expanded');
        btn.textContent = isExpanded ? 'Collapse ⬆️' : 'Expand / Collapse ↕';
    }

    // Tab switching
    function switchTab(tab, navItem) {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.section-block').forEach(s => s.classList.remove('active'));

        if (tab === 'pending') {
            document.getElementById('tab-pending').classList.add('active');
            document.getElementById('pending-section').classList.add('active');
            document.getElementById('nav-pending').classList.add('active');
        } else {
            document.getElementById('tab-excel').classList.add('active');
            document.getElementById('excel-section').classList.add('active');
            document.getElementById('nav-excel').classList.add('active');
        }
    }

    // Filter jobs
    function filterJobs(mode, btn) {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        if (btn) btn.classList.add('active');
        document.querySelectorAll('.job-card').forEach(card => {
            const isExpired = card.getAttribute('data-expired') === 'true';
            if (mode === 'all') card.style.display = '';
            else if (mode === 'active') card.style.display = isExpired ? 'none' : '';
            else if (mode === 'expired') card.style.display = isExpired ? '' : 'none';
        });
    }

    // SSE Live Updates with Toast
    function showToast(title, message) {
        const container = document.getElementById('toast-container');
        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.innerHTML = \`<div class="toast-title">\${title}</div><div>\${message}</div>\`;
        container.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transition = 'opacity 0.4s';
            setTimeout(() => toast.remove(), 400);
        }, 5000);
    }

    const evtSource = new EventSource('/updates');
    evtSource.onmessage = function(e) {
        if (e.data === 'new_job') {
            showToast('🚨 New Job Detected!', 'A new opportunity was captured from WhatsApp. Refreshing...');
            setTimeout(() => window.location.reload(), 2500);
        }
    };
    evtSource.onerror = function() {
        setTimeout(() => evtSource.close(), 3000);
    };

    // Animate stat values on load
    document.querySelectorAll('.stat-value').forEach(el => {
        const target = parseInt(el.textContent, 10);
        if (isNaN(target) || target === 0) return;
        let current = 0;
        const step = Math.max(1, Math.ceil(target / 20));
        const timer = setInterval(() => {
            current = Math.min(current + step, target);
            el.textContent = current;
            if (current >= target) clearInterval(timer);
        }, 40);
    });
</script>
</html>`;

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

app.post('/clean-false-positives', async (req, res) => {
    try {
        const pendingJobs = await Job.find({ status: 'pending' });
        let deletedCount = 0;
        for (const job of pendingJobs) {
            if (!isJobOfferMessage(job.content)) {
                await Job.findByIdAndDelete(job._id);
                deletedCount++;
            }
        }
        notifyClients();
        console.log(`🧹 Purged ${deletedCount} non-job / document entries from pending.`);
        res.redirect('/');
    } catch (err) {
        res.status(500).send('Error purging false positives: ' + err.message);
    }
});

app.post('/clean-duplicates', async (req, res) => {
    try {
        const pendingJobs = await Job.find({ status: 'pending' }).sort({ dateDetected: 1 });
        const seenLinks = new Set();
        const seenNorms = [];
        const seenCompRoles = new Set();
        let deletedCount = 0;

        for (const job of pendingJobs) {
            let isDup = false;

            // Check Links
            const jobLinks = (job.links && job.links.length > 0) ? job.links : (job.link && job.link !== 'None' ? [job.link] : []);
            for (const l of jobLinks) {
                if (l && l.startsWith('http')) {
                    if (seenLinks.has(l)) {
                        isDup = true;
                        break;
                    }
                }
            }

            // Check Company & Role
            if (!isDup && job.parsedCompany && job.parsedCompany !== 'Unknown' && job.parsedRole && job.parsedRole !== 'Not specified') {
                const key = `${job.parsedCompany.trim().toLowerCase()}|${job.parsedRole.trim().toLowerCase()}`;
                if (seenCompRoles.has(key)) {
                    isDup = true;
                }
            }

            // Check Normalized Content
            if (!isDup && job.content) {
                const norm = normalizeText(job.content);
                if (norm.length > 30) {
                    for (const existingNorm of seenNorms) {
                        if (existingNorm === norm) {
                            isDup = true;
                            break;
                        }
                        const core1 = norm.length > 120 ? norm.substring(30, 130) : norm;
                        if (core1.length > 40 && existingNorm.includes(core1)) {
                            isDup = true;
                            break;
                        }
                    }
                }
            }

            if (isDup) {
                await Job.findByIdAndDelete(job._id);
                deletedCount++;
            } else {
                jobLinks.forEach(l => { if (l && l.startsWith('http')) seenLinks.add(l); });
                if (job.parsedCompany && job.parsedCompany !== 'Unknown' && job.parsedRole && job.parsedRole !== 'Not specified') {
                    seenCompRoles.add(`${job.parsedCompany.trim().toLowerCase()}|${job.parsedRole.trim().toLowerCase()}`);
                }
                if (job.content) seenNorms.push(normalizeText(job.content));
            }
        }

        notifyClients();
        console.log(`👯 Purged ${deletedCount} duplicate pending jobs.`);
        res.redirect('/');
    } catch (err) {
        res.status(500).send('Error purging duplicates: ' + err.message);
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

        const data = activeApprovedJobs.map(job => {
            const jobLinks = (job.links && job.links.length > 0) ? job.links.join('\n') : (job.link || 'None');
            return {
                'WhatsApp Group': job.groupName || 'Unknown',
                'Company': job.parsedCompany,
                'Role': job.parsedRole,
                'Deadline': job.parsedDeadline,
                'Links': jobLinks,
                'Date Detected': job.dateDetected ? new Date(job.dateDetected).toLocaleString('en-IN') : 'Unknown',
                'Original Content': job.content
            };
        });

        const ws = xlsx.utils.json_to_sheet(data);
        ws['!cols'] = [
            { wch: 24 }, { wch: 28 }, { wch: 32 },
            { wch: 20 }, { wch: 40 }, { wch: 22 }, { wch: 80 }
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
