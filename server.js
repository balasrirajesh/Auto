require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const { Client, RemoteAuth } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const qrcode = require('qrcode-terminal');
const xlsx = require('xlsx');

const app = express();
const port = process.env.PORT || 3000;
const mongoURI = process.env.MONGODB_URI;
const targetGroupsEnv = process.env.TARGET_GROUP_NAMES || process.env.TARGET_GROUP_NAME || '';
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

// Connect to MongoDB
if (mongoURI) {
    mongoose.connect(mongoURI).then(() => {
        console.log('Connected to MongoDB');

        mongoose.connection.on('error', err => {
            console.error('MongoDB connection error:', err);
        });

        mongoose.connection.on('disconnected', () => {
            console.warn('MongoDB disconnected. Reconnecting...');
        });

        // Set up wwebjs-mongo Store
        const store = new MongoStore({ mongoose: mongoose });

        const client = new Client({
            authStrategy: new RemoteAuth({
                store: store,
                backupSyncIntervalMs: 300000
            }),
            puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'] }
        });

        client.on('qr', (qr) => {
            qrcode.generate(qr, { small: true });
            console.log('QR Code generated. Scan it with WhatsApp.');
        });

        client.on('ready', () => {
            console.log('WhatsApp client connected.');
            console.log('Monitoring groups:', targetGroupList.join(', '));
        });

        client.on('remote_session_saved', () => {
            console.log('WhatsApp session saved to MongoDB.');
        });

        // Job detection logic
        const JOB_KEYWORDS = ['hiring', 'apply by', 'internship', 'role', 'full-time', 'fresher', 'opening', 'opportunity'];
        const DEADLINE_REGEX = /(?:apply by|deadline|last date)\s*:?\s*([\w\d\s,]+)/i;
        const COMPANY_ROLE_REGEX = /^([^-]+)\s*-\s*(.+)$/m; // Simple regex for "Company - Role" on first line
        const LINK_REGEX = /(https?:\/\/[^\s]+)/;

        client.on('message', async msg => {
            if (targetGroupList.length === 0) return;

            const chat = await msg.getChat();
            if (chat.isGroup) {
                const chatNameLower = chat.name.toLowerCase();
                const isMatchedGroup = targetGroupList.some(target => chatNameLower.includes(target));

                if (isMatchedGroup) {
                    const lowerBody = msg.body.toLowerCase();
                    const hasKeyword = JOB_KEYWORDS.some(kw => lowerBody.includes(kw));

                    if (hasKeyword) {
                        try {
                            // Prevent duplicates: check if exact message content is already stored
                            const existingJob = await Job.findOne({ content: msg.body });

                            if (!existingJob) {
                                // Parse details
                                const companyRoleMatch = msg.body.match(COMPANY_ROLE_REGEX);
                                const deadlineMatch = msg.body.match(DEADLINE_REGEX);
                                const linkMatch = msg.body.match(LINK_REGEX);

                                const newJob = new Job({
                                    content: msg.body,
                                    groupName: chat.name,
                                    parsedCompany: companyRoleMatch ? companyRoleMatch[1].trim() : 'Unknown',
                                    parsedRole: companyRoleMatch ? companyRoleMatch[2].trim() : 'Unknown',
                                    parsedDeadline: deadlineMatch ? deadlineMatch[1].trim() : 'Unknown',
                                    link: linkMatch ? linkMatch[0] : 'None'
                                });

                                await newJob.save();
                                console.log(`New job posting detected in "${chat.name}" and saved as pending.`);
                            } else {
                                console.log('Duplicate job posting detected. Skipping.');
                            }
                        } catch (error) {
                            console.error('Error processing message:', error);
                        }
                    }
                }
            }
        });

        client.initialize();
    }).catch(err => {
        console.error('MongoDB connection error:', err);
    });
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

        let html = `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <meta http-equiv="refresh" content="30">
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
                    .container { max-width: 1000px; margin: 0 auto; }
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
                    .btn-action:hover { transform: translateY(-1px); opacity: 0.9; }
                    .approve-btn { background: var(--accent-green); color: #022c22; }
                    .reject-btn { background: rgba(239, 68, 68, 0.15); color: var(--accent-red); border: 1px solid rgba(239, 68, 68, 0.3); }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="header">
                        <div>
                            <h1>WhatsApp Job Tracker</h1>
                            <div style="margin-top: 0.4rem;" class="status-badge">
                                <span class="status-dot"></span> 6 Groups Monitored & Live
                            </div>
                        </div>
                        <a href="/download" class="download-btn">📊 Download Excel</a>
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
                html += `
                    <div class="job-card">
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
                                <div class="detail-value">${escapeHTML(job.parsedDeadline)}</div>
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
                        </div>
                    </div>
                `;
            }
        }

        html += `
                </div>
            </body>
            </html>
        `;
        res.send(html);
    } catch (err) {
        res.status(500).send('Error fetching jobs.');
    }
});

app.post('/approve/:id', async (req, res) => {
    try {
        await Job.findByIdAndUpdate(req.params.id, { status: 'approved' });
        res.redirect('/');
    } catch (err) {
        res.status(500).send('Error approving job.');
    }
});

app.post('/reject/:id', async (req, res) => {
    try {
        await Job.findByIdAndUpdate(req.params.id, { status: 'rejected' });
        res.redirect('/');
    } catch (err) {
        res.status(500).send('Error rejecting job.');
    }
});

app.get('/download', async (req, res) => {
    try {
        const approvedJobs = await Job.find({ status: 'approved' }).sort({ dateDetected: -1 }).lean();

        if (approvedJobs.length === 0) {
            return res.send('No approved jobs to download.');
        }

        const data = approvedJobs.map(job => ({
            'WhatsApp Group': job.groupName || 'Unknown',
            Company: job.parsedCompany,
            Role: job.parsedRole,
            Deadline: job.parsedDeadline,
            Link: job.link,
            'Date Detected': job.dateDetected.toISOString(),
            'Original Content': job.content
        }));

        const ws = xlsx.utils.json_to_sheet(data);
        const wb = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(wb, ws, "Approved Jobs");

        const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

        res.setHeader('Content-Disposition', 'attachment; filename="approved_jobs.xlsx"');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buffer);
    } catch (err) {
        res.status(500).send('Error downloading excel file.');
    }
});

app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
});
