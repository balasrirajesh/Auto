require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const { Client, LocalAuth, RemoteAuth } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const qrcode = require('qrcode-terminal');
const xlsx = require('xlsx');
const fs = require('fs');
const path = require('path');

// Global safety handler for background Puppeteer, RemoteAuth, and EBUSY lockfile glitches
process.on('uncaughtException', (err) => {
    if (err && err.code === 'ENOENT' && err.path && err.path.includes('RemoteAuth.zip')) {
        console.warn('Notice: Handled background RemoteAuth zip sync event.');
        return;
    }
    if (err && (err.code === 'EBUSY' || (err.message && err.message.includes('EBUSY')))) {
        console.warn('Notice: Handled background session lockfile (EBUSY) event.');
        return;
    }
    if (err && (err.name === 'ProtocolError' || (err.message && (err.message.includes('Execution context was destroyed') || err.message.includes('Target closed'))))) {
        console.warn('Notice: Handled background Puppeteer page reload event.');
        return;
    }
    if (err && err.message && err.message.includes('The browser is already running')) {
        console.warn('Notice: Handled background Chrome lock event.');
        try {
            const lockDir = path.join(__dirname, '.wwebjs_auth');
            if (fs.existsSync(lockDir)) {
                fs.readdirSync(lockDir, { recursive: true }).forEach(file => {
                    if (file.includes('lock') || file.includes('Singleton')) {
                        try { fs.unlinkSync(path.join(lockDir, file)); } catch (e) {}
                    }
                });
            }
        } catch (e) {}
        return;
    }
    console.error('Uncaught Exception:', err);
});

const app = express();
const port = process.env.PORT || 3000;
const mongoURI = process.env.MONGODB_URI || 'mongodb+srv://narendrapurapubalasrirajesh_db_user:ziftMZYuDrN7qDDf@cluster0.txbp94i.mongodb.net/jobtracker?retryWrites=true&w=majority';
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

// Global status state for WhatsApp connection
let isWhatsAppConnected = false;

// Helper functions for deadline cleaning and expiration checking
function cleanDeadlineDate(raw) {
    if (!raw || raw === 'Not specified') return 'Not specified';
    let clean = raw.replace(/[*_~`]/g, '').trim();

    // Strip sentence continuations after comma, period, or trailing keywords
    clean = clean.replace(/,?\s*(?:after|which|we|late|post|shortlist|without|form|link).*/i, '');
    clean = clean.replace(/\..*/, '');

    // Try extracting standard date patterns if available
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
            // Set to end of day if time isn't explicitly specified
            if (!/\d{1,2}:\d{2}|\d{1,2}\s*(?:am|pm)/i.test(text)) {
                d.setHours(23, 59, 59, 999);
            }
            return d < now;
        }
    } catch (e) {}

    return false;
}

// Connect to MongoDB
if (mongoURI) {
    const connectDB = (retries = 5, delay = 3000) => {
        mongoose.connect(mongoURI, {
            serverSelectionTimeoutMS: 15000,
            socketTimeoutMS: 45000
        }).then(() => {
            console.log('✓ Connected to MongoDB Atlas');
        }).catch(err => {
            console.error(`MongoDB initial connection error (${err.message}). Retries left: ${retries}`);
            if (retries > 0) {
                setTimeout(() => connectDB(retries - 1, delay * 1.5), delay);
            } else {
                console.error('Fatal: Could not connect to MongoDB after multiple attempts.');
            }
        });
    };

    mongoose.connection.on('error', err => {
        console.error('MongoDB connection error:', err);
    });

    mongoose.connection.on('disconnected', () => {
        console.warn('MongoDB disconnected. Reconnecting...');
    });

    connectDB();

    // Use LocalAuth for local development (fast, zero zip errors) or RemoteAuth for cloud hosting (Render)
    const isCloudHost = process.env.RENDER || process.env.NODE_ENV === 'production';
        const store = isCloudHost ? new MongoStore({ mongoose: mongoose }) : null;

        const client = new Client({
            authStrategy: isCloudHost
                ? new RemoteAuth({ store: store, backupSyncIntervalMs: 300000 })
                : new LocalAuth(),
            puppeteer: {
                executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--disable-gpu'
                ]
            }
        });

        client.on('qr', (qr) => {
            qrcode.generate(qr, { small: true });
            console.log('QR Code generated. Scan it with WhatsApp.');
        });

        client.on('authenticated', () => {
            isWhatsAppConnected = true;
            console.log('✓ WhatsApp authenticated successfully! Saved session loaded.');
        });

        client.on('auth_failure', (msg) => {
            isWhatsAppConnected = false;
            console.error('WhatsApp authentication failed:', msg);
        });

        client.on('disconnected', (reason) => {
            isWhatsAppConnected = false;
            console.warn('WhatsApp client disconnected:', reason);
        });

        // ─────────────────────────────────────────────────────────────
        // Smart Parsing: extract labeled fields from WhatsApp job posts
        // Must be defined BEFORE the ready handler and message handlers
        // ─────────────────────────────────────────────────────────────
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

            // 1. Company
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

            // 2. Role
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

            // 3. Deadline
            const rawDeadline = extractField([
                /(?:apply\s*by|last\s*date|deadline|closes?\s*on|application\s*deadline)\s*[:\-–]?\s*(.+)/i,
                /(?:last\s*date\s*to\s*apply)\s*[:\-–]?\s*(.+)/i,
            ]) || 'Not specified';

            const deadline = cleanDeadlineDate(rawDeadline);

            // 4. Link
            const linkMatch = text.match(LINK_REGEX);
            const link = linkMatch ? linkMatch[0] : 'None';

            return {
                company: company ? company.substring(0, 120) : 'Unknown',
                role: role ? role.substring(0, 120) : 'Not specified',
                deadline: deadline ? deadline.substring(0, 100) : 'Not specified',
                link
            };
        }

        // Global cache for WhatsApp group names (ID -> Name)
        const groupCache = new Map();

        client.on('ready', async () => {
            isWhatsAppConnected = true;
            console.log('✓ WhatsApp client connected & ready.');
            console.log('Monitoring groups:', targetGroupList.join(', '));

            // ─────────────────────────────────────────────────────────────
            // Startup Scan: catch messages that arrived while server was offline
            // Wait 3 seconds to ensure WhatsApp Web internal store is ready
            // ─────────────────────────────────────────────────────────────
            setTimeout(async () => {
                try {
                    console.log('[Startup Scan] Fetching all chats...');
                    let allChats = [];
                    for (let retry = 1; retry <= 3; retry++) {
                        try {
                            allChats = await client.getChats();
                            break;
                        } catch (err) {
                            if (retry === 3) throw err;
                            await new Promise(r => setTimeout(r, 2000));
                        }
                    }
                    const isWildcard = targetGroupList.includes('*') || targetGroupList.includes('all');
                    const matchedGroups = [];

                    for (const chat of allChats) {
                        if (!chat || !chat.isGroup) continue;
                        const name = chat.name || chat.formattedTitle || '';
                        if (chat.id?._serialized && name) {
                            groupCache.set(chat.id._serialized, name);
                        }

                        const chatNameClean = name.trim().toLowerCase();
                        if (!chatNameClean) continue;

                        const isTarget = isWildcard || targetGroupList.some(t => t && t.length > 0 && chatNameClean.includes(t));
                        if (isTarget) matchedGroups.push(name);
                    }

                    console.log(`[Startup Scan] Matched ${matchedGroups.length} group(s):`, matchedGroups.join(', ') || 'NONE');

                    for (const chat of allChats) {
                        if (!chat || !chat.isGroup) continue;
                        const name = chat.name || chat.formattedTitle || '';
                        const chatNameClean = name.trim().toLowerCase();
                        if (!chatNameClean) continue;

                        const isTarget = isWildcard || targetGroupList.some(t => t && t.length > 0 && chatNameClean.includes(t));
                        if (!isTarget) continue;

                        let messages = [];
                        try {
                            messages = await chat.fetchMessages({ limit: 30 });
                            console.log(`[Startup Scan] "${name}" → ${messages.length} recent messages fetched`);
                        } catch (e) {
                            console.warn(`[Startup Scan] Failed to fetch messages from "${name}":`, e.message);
                            continue;
                        }

                        let savedCount = 0;
                        for (const msg of messages) {
                            if (!msg || msg.isStatus || ['notification', 'gp2', 'e2e_notification', 'protocol', 'ciphertext'].includes(msg.type)) continue;
                            const contentText = (msg.body || msg.caption || '').trim();
                            if (!contentText) continue;

                            const lowerBody = contentText.toLowerCase();
                            const hasKeyword = JOB_KEYWORDS.some(kw => lowerBody.includes(kw));
                            if (!hasKeyword) continue;

                            const already = await Job.findOne({ content: contentText });
                            if (already) continue;

                            const { company, role, deadline, link } = parseJobMessage(contentText);
                            const newJob = new Job({
                                content: contentText,
                                groupName: name || 'WhatsApp Group',
                                parsedCompany: company,
                                parsedRole: role,
                                parsedDeadline: deadline,
                                link: link
                            });
                            await newJob.save();
                            notifyClients();
                            savedCount++;
                            console.log(`[Startup Scan] ✓ Saved: "${company}" | Role: "${role}" | from "${name}"`);
                        }
                        if (savedCount === 0) console.log(`[Startup Scan] "${name}" → no new jobs found`);
                    }
                    console.log('[Startup Scan] Complete.');
                } catch (scanErr) {
                    console.error('[Startup Scan] ERROR:', scanErr.message);
                }
            }, 3000);
        });

        client.on('remote_session_saved', () => {
            console.log('WhatsApp session saved to MongoDB.');
        });

        // Set to store message IDs currently being processed to prevent duplicate processing
        const processingMsgIds = new Set();

        // Shared handler for all messages (incoming & outgoing)
        async function handleMessage(msg) {
            if (!msg || msg.isStatus || ['notification', 'gp2', 'e2e_notification', 'protocol', 'ciphertext'].includes(msg.type)) {
                return;
            }

            const msgId = msg.id?._serialized || msg.id?.id;
            if (msgId && processingMsgIds.has(msgId)) return;
            if (msgId) {
                processingMsgIds.add(msgId);
                setTimeout(() => processingMsgIds.delete(msgId), 30000); // clear after 30s
            }

            try {
                // Determine group ID (either msg.from or msg.to if ends with @g.us)
                const groupId = (msg.from && msg.from.endsWith('@g.us')) ? msg.from
                             : (msg.to && msg.to.endsWith('@g.us')) ? msg.to : null;

                let chat = null;
                if (groupId) {
                    try {
                        chat = await msg.getChat();
                        if (chat && chat.name) groupCache.set(groupId, chat.name);
                    } catch (e) {
                        try {
                            chat = await client.getChatById(groupId);
                            if (chat && chat.name) groupCache.set(groupId, chat.name);
                        } catch (err2) {}
                    }
                }

                // Resolve chat name from all possible sources
                let chatName = (chat && (chat.name || chat.formattedTitle || chat.groupMetadata?.subject || chat.subject))
                    || (groupId ? groupCache.get(groupId) : null)
                    || msg._data?.chat?.name
                    || msg._data?.chatName
                    || msg._data?.info?.subject
                    || '';

                // If still empty but is a group, attempt to fetch chat by ID directly
                if (!chatName && groupId) {
                    try {
                        const fetchedChat = await client.getChatById(groupId);
                        if (fetchedChat && fetchedChat.name) {
                            chatName = fetchedChat.name;
                            groupCache.set(groupId, chatName);
                        }
                    } catch (e) {}
                }

                const chatNameClean = chatName.trim().toLowerCase();
                const isGroupChat = Boolean(groupId) || (chat && chat.isGroup);
                const contentText = (msg.body || msg.caption || '').trim();

                const preview = contentText.length > 50 ? contentText.substring(0, 50) + '...' : contentText;
                console.log(`\n📩 [NEW MSG RECEIVED] Group: "${chatName || (isGroupChat ? 'Group' : 'Direct Chat')}" | ID: ${groupId || msg.from} | Content: "${preview}"`);

                if (!contentText && !msg.hasMedia) {
                    console.log(`   └─ ⏩ Skipped (empty content)`);
                    return;
                }

                const isWildcard = targetGroupList.includes('*') || targetGroupList.includes('all');
                // Ensure chatNameClean is non-empty before checking string inclusion
                const isExplicitTarget = Boolean(chatNameClean) && targetGroupList.some(target => target && target.length > 0 && chatNameClean.includes(target));

                const lowerBody = contentText.toLowerCase();
                const hasKeyword = JOB_KEYWORDS.some(kw => lowerBody.includes(kw));

                const shouldCapture = isExplicitTarget || isWildcard || (isGroupChat && hasKeyword);

                console.log(`   ├─ Group Match: ${isExplicitTarget} ("${chatName}") | Keyword Match: ${hasKeyword} | Capture: ${shouldCapture}`);

                if (!shouldCapture) {
                    console.log(`   └─ ⏩ Skipped (does not match target group or job keywords)`);
                    return;
                }

                const finalContent = contentText || '[Media Attachment]';

                const existingJob = await Job.findOne({ content: finalContent });
                if (existingJob) {
                    console.log(`   └─ ⏩ Skipped (already saved in database)`);
                    return;
                }

                const { company, role, deadline, link } = parseJobMessage(finalContent);
                const newJob = new Job({
                    content: finalContent,
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

        // Single event listener for all messages (prevents double execution)
        client.on('message_create', handleMessage);


        client.initialize();

        const cleanup = async () => {
            try {
                if (client) await client.destroy();
            } catch (e) {}
            process.exit(0);
        };
        process.once('SIGINT', cleanup);
        process.once('SIGTERM', cleanup);
} else {
    console.warn("MONGODB_URI not provided. Skipping MongoDB and WhatsApp client setup.");
}

// Express routes
app.use(express.urlencoded({ extended: true }));

app.get('/ping', (req, res) => {
    res.send('pong');
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

// Express routes and UI for review
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

                // Real-time live updates via Server-Sent Events
                const evtSource = new EventSource('/updates');
                evtSource.onmessage = function(e) {
                    if (e.data === 'new_job') {
                        window.location.reload();
                    }
                };
                evtSource.onerror = function() {
                    setTimeout(() => { evtSource.close(); }, 3000);
                };
            <\/script>
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

// SSE endpoint for real-time live updates
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

        // Exclude all expired jobs automatically from the Excel file
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

        // Set column widths for proper alignment
        ws['!cols'] = [
            { wch: 24 },   // WhatsApp Group
            { wch: 28 },   // Company
            { wch: 32 },   // Role
            { wch: 20 },   // Deadline
            { wch: 40 },   // Link
            { wch: 22 },   // Date Detected
            { wch: 80 }    // Original Content
        ];

        // Apply text wrap and alignment to all cells
        const range = xlsx.utils.decode_range(ws['!ref']);
        for (let R = range.s.r; R <= range.e.r; R++) {
            for (let C = range.s.c; C <= range.e.c; C++) {
                const cellRef = xlsx.utils.encode_cell({ r: R, c: C });
                if (!ws[cellRef]) ws[cellRef] = { t: 's', v: '' };
                if (!ws[cellRef].s) ws[cellRef].s = {};
                ws[cellRef].s.alignment = { wrapText: true, vertical: 'top' };
                // Bold header row
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

app.listen(port, () => {
    console.log(`Server listening on port ${port}`);

    // Self-ping every 10 minutes to prevent Render free-tier from sleeping
    const renderUrl = process.env.RENDER_URL;
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
        setInterval(selfPing, 10 * 60 * 1000); // Every 10 minutes
        console.log(`[Keep-Alive] Render sleep prevention active → pinging ${renderUrl}/ping every 10 min`);
    }
});
