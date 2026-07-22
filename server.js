const express = require('express');
const mongoose = require('mongoose');
const { Client, RemoteAuth } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const qrcode = require('qrcode-terminal');
const xlsx = require('xlsx');

const app = express();
const port = process.env.PORT || 3000;
const mongoURI = process.env.MONGODB_URI;
const targetGroup = process.env.TARGET_GROUP_NAME;

// Mongoose schema for jobs
const jobSchema = new mongoose.Schema({
    content: String,
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
            if (!targetGroup) return;

            const chat = await msg.getChat();
            if (chat.isGroup && chat.name === targetGroup) {
                const lowerBody = msg.body.toLowerCase();
                const hasKeyword = JOB_KEYWORDS.some(kw => lowerBody.includes(kw));

                if (hasKeyword) {
                    // Parse details
                    const companyRoleMatch = msg.body.match(COMPANY_ROLE_REGEX);
                    const deadlineMatch = msg.body.match(DEADLINE_REGEX);
                    const linkMatch = msg.body.match(LINK_REGEX);

                    const newJob = new Job({
                        content: msg.body,
                        parsedCompany: companyRoleMatch ? companyRoleMatch[1].trim() : 'Unknown',
                        parsedRole: companyRoleMatch ? companyRoleMatch[2].trim() : 'Unknown',
                        parsedDeadline: deadlineMatch ? deadlineMatch[1].trim() : 'Unknown',
                        link: linkMatch ? linkMatch[0] : 'None'
                    });

                    await newJob.save();
                    console.log('New job posting detected and saved as pending.');
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
            <html>
            <head>
                <title>Job Tracker</title>
                <style>
                    body { font-family: sans-serif; padding: 20px; }
                    .job { border: 1px solid #ccc; padding: 15px; margin-bottom: 15px; border-radius: 5px; }
                    .content { white-space: pre-wrap; background: #f9f9f9; padding: 10px; }
                    .actions { margin-top: 10px; }
                    button { padding: 5px 10px; margin-right: 10px; cursor: pointer; }
                    .approve { background: #d4edda; border: 1px solid #c3e6cb; }
                    .reject { background: #f8d7da; border: 1px solid #f5c6cb; }
                </style>
            </head>
            <body>
                <h1>Pending Job Postings</h1>
                <p><a href="/download">Download approved entries as Excel</a></p>
        `;

        if (pendingJobs.length === 0) {
            html += `<p>No pending jobs to review.</p>`;
        } else {
            for (const job of pendingJobs) {
                html += `
                    <div class="job">
                        <p><strong>Company:</strong> ${escapeHTML(job.parsedCompany)}</p>
                        <p><strong>Role:</strong> ${escapeHTML(job.parsedRole)}</p>
                        <p><strong>Deadline:</strong> ${escapeHTML(job.parsedDeadline)}</p>
                        <p><strong>Link:</strong> <a href="${escapeHTML(job.link)}" target="_blank">${escapeHTML(job.link)}</a></p>
                        <div class="content">${escapeHTML(job.content)}</div>
                        <div class="actions">
                            <form method="POST" action="/approve/${job._id}" style="display:inline;">
                                <button type="submit" class="approve">Approve</button>
                            </form>
                            <form method="POST" action="/reject/${job._id}" style="display:inline;">
                                <button type="submit" class="reject">Reject</button>
                            </form>
                        </div>
                    </div>
                `;
            }
        }

        html += `
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
