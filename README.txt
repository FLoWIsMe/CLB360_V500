╔══════════════════════════════════════════════════════════════════════════════╗
║                        CLB360 V500 — Operations Dashboard                    ║
╚══════════════════════════════════════════════════════════════════════════════╝

This dashboard shows live network data for your three Peplink units (Unit 001,
002, 003). It pulls from the Unifi API for network stats and the Peplink
InControl2 API for GPS location. Reports can be exported as PDF or PNG and
emailed to clients.

Support: support@clb360.com  |  +1 508 425 0605

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 WHAT'S IN THIS FOLDER
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  index.html          The dashboard (all visuals live here)
  server.js           The backend server (fetches API data, serves the page)
  package.json        Lists the one software dependency (dotenv)
  .env.example        Template for your credentials — copy this to .env
  Dockerfile          Instructions for building the Docker container
  docker-compose.yml  Runs the app as a managed Docker service
  logo.png            CLB360 logo used in the dashboard
  previews/           Screenshot previews of each dashboard view

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 OPTION A — DEPLOY WITH DOCKER (RECOMMENDED FOR SERVERS)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Docker is the easiest way to run this on a server. It bundles everything the
app needs so you don't have to install Node.js, Chromium, or any other
software manually.

─── Step 1: Install Docker ───────────────────────────────────────────────────

  If Docker is not already installed on your server, go to:
    https://docs.docker.com/engine/install/

  For Ubuntu/Debian servers, the quick install is:
    curl -fsSL https://get.docker.com | sh

  Verify it worked:
    docker --version
    docker compose version

─── Step 2: Upload the project files to your server ─────────────────────────

  Copy this entire folder to your server. If you're using Ionos, you can use
  the File Manager in the control panel, or connect via SFTP with a tool like
  FileZilla (free download at filezilla-project.org).

  Put everything in a folder such as:
    /home/clb360/clb360-v500/

─── Step 3: Create your .env credentials file ───────────────────────────────

  On the server, navigate into the project folder and run:
    cp .env.example .env

  Then open .env in a text editor (e.g. nano .env) and fill in your values.
  The file looks like this:

    PORT=8080

    UNIFI_KEY_001=WOncXsXoJ9ivvnTfn7BifjyuoZ-OHqTH   ← already filled in
    UNIFI_KEY_002=_SbNK1htk4T21EFp-aCaJAKhA7zqKQqU   ← already filled in
    UNIFI_KEY_003=ZNGBD-tcy7l3jvdjWTTdwGg7v9rlymJP   ← already filled in

    PEPLINK_CLIENT_ID=        ← see "Adding Peplink GPS" section below
    PEPLINK_CLIENT_SECRET=    ← see "Adding Peplink GPS" section below
    PEPLINK_ORG_ID=           ← see "Adding Peplink GPS" section below
    PEPLINK_DEVICE_001=       ← serial number of Unit 001
    PEPLINK_DEVICE_002=       ← serial number of Unit 002
    PEPLINK_DEVICE_003=       ← serial number of Unit 003

  The Unifi keys are pre-filled and working. Leave them as-is unless the keys
  are rotated. The Peplink section can be left blank for now — the dashboard
  will use IP-based location as a fallback until GPS credentials are added.

─── Step 4: Build and start the app ─────────────────────────────────────────

  From inside the project folder, run:
    docker compose up -d

  The -d flag runs it in the background. The first time you run this it will
  take a few minutes to download and build everything. Subsequent starts are
  near-instant.

  Verify it's running:
    docker compose ps

  You should see a line showing clb360 with status "Up (healthy)".

─── Step 5: Open the dashboard ──────────────────────────────────────────────

  The app runs on port 8080. If your server's IP address is 123.45.67.89,
  open a browser and go to:
    http://123.45.67.89:8080

  If you have a domain pointed at the server (e.g. dashboard.clb360events.com),
  see the "Custom Domain / HTTPS" section below.

─── Useful Docker commands ───────────────────────────────────────────────────

  Start the app:          docker compose up -d
  Stop the app:           docker compose down
  Restart the app:        docker compose restart
  View live logs:         docker compose logs -f
  Rebuild after changes:  docker compose up -d --build

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 OPTION B — RUN DIRECTLY WITH NODE.JS (GOOD FOR LOCAL / QUICK TESTING)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Use this option if you just want to run it on your Mac or a server that
already has Node.js installed.

─── Step 1: Install Node.js ─────────────────────────────────────────────────

  Download and install Node.js 18 or newer from:
    https://nodejs.org  (click the "LTS" button)

─── Step 2: Set up credentials ──────────────────────────────────────────────

  In the project folder, make a copy of the example credentials file:
    cp .env.example .env

  Open .env and fill in any values you need (Unifi keys are pre-filled).

─── Step 3: Install dependencies ────────────────────────────────────────────

  In the project folder, run:
    npm install

  This installs the one required package (dotenv). It only needs to be done
  once.

─── Step 4: Start the server ────────────────────────────────────────────────

  npm start

  You'll see: "CLB360 V500 server running at http://localhost:8080"
  Open that address in your browser.

  To stop it: press Ctrl + C in the terminal.

─── Keeping it running on a server (PM2) ────────────────────────────────────

  If you're running directly on a server and want the app to stay running
  after you close the terminal, install PM2 (a process manager):
    npm install -g pm2
    pm2 start server.js --name clb360
    pm2 save
    pm2 startup   ← follow the instruction it prints to auto-start on reboot

  Useful PM2 commands:
    pm2 status          see if it's running
    pm2 logs clb360     see live output
    pm2 restart clb360  restart after a change

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 ADDING PEPLINK GPS (WHEN READY)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

The GPS integration is fully built. You just need to fill in five values in
your .env file. Here's how to find each one:

─── 1. PEPLINK_CLIENT_ID and PEPLINK_CLIENT_SECRET ──────────────────────────

  a. Log in to https://incontrol2.peplink.com
  b. Click your organization name in the top menu
  c. Go to Settings → API
  d. Click "Create Client Application"
  e. Give it a name (e.g. "CLB360 Dashboard")
  f. Copy the Client ID and Client Secret that appear — paste them into .env

─── 2. PEPLINK_ORG_ID ───────────────────────────────────────────────────────

  After logging in to InControl2, look at the URL in your browser. It will
  look something like:
    https://incontrol2.peplink.com/o/12345/dashboard

  The number after /o/ is your Org ID. Copy it into .env.

─── 3. PEPLINK_DEVICE_001 / 002 / 003 ───────────────────────────────────────

  a. In InControl2, go to Devices (left sidebar)
  b. Click on each Peplink unit
  c. The device serial number is shown in the device detail page
     (it looks like something like: 1846-B3E7-1234)
  d. Copy the serial number for each unit into the matching line in .env

─── Activate the new credentials ────────────────────────────────────────────

  After saving .env, restart the app:
    Docker:  docker compose restart
    Node:    npm start  (stop and start again)

  The location panel will update from "Location from IP geolocation" to
  "Live GPS — hardware data active" once the Peplink data is flowing.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 CUSTOM DOMAIN AND HTTPS (IONOS / ANY HOST)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

To serve the dashboard at a URL like https://dashboard.clb360events.com, you
need a reverse proxy in front of the app. Nginx is the most common choice.

─── Install Nginx ────────────────────────────────────────────────────────────

  sudo apt install nginx -y

─── Create a site config ────────────────────────────────────────────────────

  sudo nano /etc/nginx/sites-available/clb360

  Paste the following (replace YOUR_DOMAIN with your actual domain):

    server {
        listen 80;
        server_name YOUR_DOMAIN;

        location / {
            proxy_pass http://localhost:8080;
            proxy_http_version 1.1;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_read_timeout 60s;
        }
    }

  Save and exit (Ctrl+X, then Y, then Enter).

─── Enable the site and reload Nginx ────────────────────────────────────────

  sudo ln -s /etc/nginx/sites-available/clb360 /etc/nginx/sites-enabled/
  sudo nginx -t
  sudo systemctl reload nginx

─── Add a free SSL certificate (HTTPS) ──────────────────────────────────────

  sudo apt install certbot python3-certbot-nginx -y
  sudo certbot --nginx -d YOUR_DOMAIN

  Follow the prompts. Certbot will automatically update your Nginx config and
  renew the certificate before it expires.

─── Point your domain to the server ─────────────────────────────────────────

  In your Ionos DNS settings (or wherever your domain is managed), add an
  A record:
    Type:  A
    Name:  dashboard  (or @ for the root domain)
    Value: your server's IP address

  DNS changes can take up to 24 hours to propagate, though usually much faster.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 UPDATING THE APP
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

When you receive an updated version of the files:

  1. Upload the new files to your server (replacing the old ones)
     Do NOT overwrite your .env file — it holds your credentials
  2. Rebuild and restart:
       docker compose up -d --build    (if using Docker)
       pm2 restart clb360              (if using Node directly)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 TROUBLESHOOTING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Problem: Dashboard shows "Data Unavailable" or won't load data
  → Check your internet connection on the server. The server needs outbound
    access to api.ui.com and api.ic.peplink.com (ports 443).
  → Check the logs: docker compose logs -f  or  pm2 logs clb360
  → Confirm your .env file exists and is not empty.

Problem: Page loads but location shows a placeholder
  → GPS credentials haven't been added yet — see "Adding Peplink GPS" above.

Problem: Port 8080 is blocked / can't reach the dashboard
  → Your server firewall may be blocking port 8080. Open it:
      sudo ufw allow 8080
  → Or use a reverse proxy on port 80/443 as described in the Custom Domain
    section above.

Problem: PDF / PNG report export fails
  → Chromium must be installed. In Docker this is automatic. If running Node
    directly on a server, install it:
      sudo apt install chromium-browser -y

Problem: Docker says "port already in use"
  → Something else is using port 8080. Either stop that process, or change
    PORT=8081 in your .env and update docker-compose.yml to match.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 QUICK REFERENCE CARD
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Start (Docker):        docker compose up -d
  Stop (Docker):         docker compose down
  Restart (Docker):      docker compose restart
  View logs (Docker):    docker compose logs -f
  Rebuild (Docker):      docker compose up -d --build

  Start (Node):          npm start
  Keep alive (Node):     pm2 start server.js --name clb360

  Dashboard URL:         http://YOUR_SERVER_IP:8080
  Health check:          http://YOUR_SERVER_IP:8080/api/health

  Credentials file:      .env  (copy from .env.example, never commit to git)

  Support:               support@clb360.com  |  +1 508 425 0605
