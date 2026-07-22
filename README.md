# WhatsApp Job Tracker — Deployment Guide

This runs entirely on Render (free) + MongoDB Atlas (free). Nothing runs on your own device except when you scan the WhatsApp QR code once.

## Step 1 — Create a free MongoDB Atlas cluster
1. Go to mongodb.com/cloud/atlas and create a free account.
2. Create a free "M0" cluster (no credit card required for this tier).
3. Under **Database Access**, create a database user with a username/password.
4. Under **Network Access**, add `0.0.0.0/0` (allow access from anywhere) — needed since Render's IP isn't fixed on the free tier.
5. Click **Connect > Drivers**, copy the connection string. It looks like:
   `mongodb+srv://<username>:<password>@cluster0.xxxxx.mongodb.net/jobtracker`

## Step 2 — Put this code on GitHub
1. Create a new GitHub repository.
2. Upload `package.json`, `server.js`, and this `README.md` to it.

## Step 3 — Deploy to Render
1. Go to render.com, sign up (no card needed for the free tier).
2. Click **New > Web Service**, connect your GitHub repo.
3. Runtime: Node. Build command: `npm install`. Start command: `npm start`.
4. Under **Environment**, add these variables:
   - `MONGODB_URI` — the connection string from Step 1
   - `TARGET_GROUP_NAME` — the exact name of your WhatsApp group (must match exactly, including emojis if any)
5. Deploy.

## Step 4 — Scan the WhatsApp QR code
1. Once deployed, open the **Logs** tab on Render.
2. A QR code will print in the logs (as text art).
3. On your phone: WhatsApp > Settings > Linked Devices > Link a Device, and scan it.
4. Once connected, the logs will show "WhatsApp client connected." This session is now saved in MongoDB, so future Render restarts won't ask you to re-scan.

## Step 5 — Keep the server awake
Render's free tier sleeps after 15 minutes of inactivity, which would drop the WhatsApp connection.
1. Sign up free at cron-job.org (or UptimeRobot).
2. Create a job that sends a GET request to `https://your-render-url.onrender.com/ping` every 10–13 minutes.
3. This keeps the service active continuously.

## Step 6 — Using it day to day
- Visit your Render URL (e.g. `https://your-app.onrender.com`) any time to see pending detected postings.
- Click **Approve** or **Reject** on each one.
- Click **Download approved entries as Excel** to get your `.xlsx` file, updated with everything you've approved so far.

## Notes on the detection logic
The detector in `server.js` uses keyword matching (words like "hiring", "apply by", "internship") and regex patterns for dates and links — not an AI API call, so there's no per-message cost. This means it will occasionally miss oddly-phrased postings or misparse company/role names from messages that don't follow a "Company - Role" style first line. You can tune the `JOB_KEYWORDS`, `DEADLINE_REGEX`, and `COMPANY_ROLE_REGEX` patterns in `server.js` as you see what your group's messages actually look like.
