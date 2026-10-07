# Running Axle on your own server

This folder turns one Linux server into a complete Axle installation. It needs no supabase.co and no Netlify:

| On the server | What it does |
|---|---|
| **Axle web server** (Caddy) | serves the app at your address, with HTTPS |
| **Supabase**, self-hosted (the official Docker setup, release `self-hosted/v0.8.2`) | Postgres 17 database, logins, file storage (shop logo, attachments), the invite/remove-user functions, and Studio (the database dashboard) |
| **axle.sh** | one script for installing, migrations, backups, restores, moving data from supabase.co, and updates |

Everything runs in Docker containers. The database, uploaded files and certificates are stored in folders on the server (`/opt/axle/supabase/volumes/...`) and survive restarts and updates.

Outside connections are needed only for these:
- installing and updating (downloading Docker images and the Supabase setup);
- sending email (your SMTP provider);
- the first use of the invite/remove-user functions after a restart (they download one library);
- Let's Encrypt certificates, if you use `AXLE_TLS=auto`.

---

## 1. What you need

- **A Linux server.** Ubuntu 24.04 or 22.04 LTS, or Debian 12, 64-bit.
  - It can be a physical machine in the office, a VM, or a VPS (e.g. Biznet Gio, IDCloudHost, DigitalOcean Singapore).
  - Windows Server isn't supported directly. Run an Ubuntu VM on it instead (Hyper-V works).
- **Size.** At least 2 CPUs, **4 GB RAM** (8 GB is more comfortable) and 40 GB of SSD disk.
- **Internet access** during installation.
- **An address people will type.** One of:
  - **A domain name**, e.g. `axle.yourcompany.co.id`. Create a DNS "A record" that points the name at the server's public IP address, and open ports 80 and 443 to the internet. This gives a real padlock certificate automatically.
  - **An office-network name or IP address**, e.g. `192.168.1.20`. The server makes its own certificate. Each device must install it once (section 10).
- **An email account that can send by SMTP**, for staff invites and "forgot password". For example, your company mail, Google Workspace (with an app password), Zoho or Brevo.
- **SSH access to the server** with a user that can use `sudo`.

Nothing else may use ports 80 and 443 on the server. Don't install a separate web server such as Apache, nginx or IIS on it.

## 2. Put Axle on the server

The app folder must end up at `/opt/axle/app` (other places work too; the database lives next to it).

**From the zip I send you:**
1. Copy it to the server. From Windows you can use WinSCP, or PowerShell:
   `scp axle-....zip you@server:/tmp/`
2. Unzip it on the server:
```bash
sudo apt-get install -y unzip
sudo mkdir -p /opt/axle/app
sudo unzip -o /tmp/axle-....zip -d /opt/axle/app
```

**Or from GitHub** (the repository is private, so the server needs a deploy key or token):
```bash
sudo git clone --branch axle-v2 https://github.com/<you>/<repo>.git /opt/axle/app
```

## 3. Fill in the settings

```bash
cd /opt/axle/app/deploy/self-host
sudo cp axle.conf.example axle.conf
sudo nano axle.conf
```
The file explains each line. The important ones are:
- `AXLE_DOMAIN`: your address.
- `AXLE_TLS`: use `auto` for a domain name, or `internal` for an office IP.
- `AXLE_ACME_EMAIL`: needed for `auto`.
- The `SMTP_...` lines.

Press Ctrl+O, Enter to save, then Ctrl+X to exit. `axle.conf` holds your email password, so keep it to administrators (`sudo chmod 600 axle.conf`).

## 4. Install

```bash
sudo bash axle.sh install
```
This takes 10–20 minutes the first time, and it is safe to run again if it stops part-way. It:
1. installs Docker, if it isn't installed yet;
2. downloads the official Supabase setup and creates new secret keys for this server only;
3. writes your address and email settings;
4. builds the Axle app for your address and starts everything;
5. applies all Axle database migrations, 100 to the latest;
6. offers to create the first **Owner** login.

When it finishes, open your address in a browser and sign in.

> **No email set up?** You can still sign in as the Owner. Invites and password-reset emails start working when you add the SMTP settings to `axle.conf` and run `sudo bash axle.sh update`.

## 5. First check

1. Sign in as the Owner.
2. Go to **Settings → Shop** and upload the logo. This checks that file storage works.
3. Go to **Settings → Users** and invite yourself at a second email address. This checks email and the invite function. Open the email, set a password and sign in.
4. Create a test job and print it.

## 6. Moving data from supabase.co

This copies **everything**: companies, vehicles, jobs, invoices, payments, stock, purchase orders, settings, logins (people keep their passwords) and uploaded files. The supabase.co project is only read; nothing there changes.

```bash
sudo bash axle.sh import-cloud
```
It asks for three things from the project's Supabase dashboard:
- **Database URI.** Click **Connect**, choose **Session pooler**, and copy the URI. Replace `[YOUR-PASSWORD]` with the database password.
  - If the password contains `@ # / ? % :` or spaces, write those characters in URI form: `@`→`%40`, `#`→`%23`, `/`→`%2F`, `?`→`%3F`, `%`→`%25`, `:`→`%3A`, space→`%20`. Or reset the password to letters and numbers only.
  - Use the *Session pooler* address, because the "direct" address often doesn't work from a server.
  - If you've lost the password, reset it under **Project Settings → Database**.
- **Project URL**, e.g. `https://wuwabhwvnzhlcctxwpda.supabase.co`.
- **Service key.** Go to **Project Settings → API Keys** and take the `service_role` key (or a secret key). It is used only to copy the uploaded files.

Before copying, it checks that both databases have the same table layout. Axle's staging project matches today. The live (v1) database doesn't match until the v2 cut-over migration is done, so it will refuse that one and change nothing.

Then it saves a copy of what it downloaded in the backups folder. Next it asks you to type `REPLACE`, and saves a safety backup of this server's current data. Finally it loads the data.

**Switching over for real:**
1. Agree on a quiet time and ask everyone to stop using the old site.
2. Run `import-cloud`.
3. Sign in and spot-check a few jobs, invoices and stock levels.
4. Tell everyone the new address.
5. Keep the old project untouched for a few weeks as a fallback.

## 7. Backups — your job now

supabase.co used to keep backups for you. On your own server you must. A backup is **one file** holding all app data, logins and uploaded files.

```bash
sudo bash axle.sh backup                 # make one now
sudo bash axle.sh enable-nightly-backup  # every night at 02:30, keeping the newest 14
```
Backups go to `/opt/axle/backups/` (change this with `AXLE_BACKUP_DIR`, and the number kept with `AXLE_BACKUP_KEEP`).

The last 5 safety copies made before each update or restore are kept separately.

**Copy them off the server as well.** A backup on the same disk doesn't help if the disk dies. Some ways to do it:
- WinSCP or `scp` to another computer, weekly;
- an external USB disk;
- `rclone` to Google Drive or S3.

The files contain customer data and password hashes, so store them privately.

**Restoring** replaces all data with the backup. It asks first and saves the current data before it starts:
```bash
sudo bash axle.sh restore /opt/axle/backups/axle-backup-20261007-023000.tar.gz
```
If loading fails, everything is rolled back and the data stays as it was.

A restore only works into an Axle on the same version (same migrations). If you rebuild a server from scratch, install the same Axle version first, then restore.

Try a restore on a spare machine or VM once, so you know it works before you need it.

## 8. Updating Axle

When I send a new version:
```bash
sudo unzip -o /tmp/axle-new.zip -d /opt/axle/app      # or: cd /opt/axle/app && sudo git pull
cd /opt/axle/app/deploy/self-host
sudo bash axle.sh update
```
`update` does four things in order:
1. makes a safety backup;
2. rewrites the settings from `axle.conf`, so this is also how you change email settings or the address;
3. rebuilds the app;
4. applies only the new migrations.

Users may see a short interruption of about a minute.

**Updating Supabase itself** is optional, perhaps every few months. Back up first, then follow Supabase's guide in `/opt/axle/supabase`:
```bash
sudo bash axle.sh backup
cd /opt/axle/supabase && sudo sh update.sh --dry-run && sudo sh update.sh && sudo sh run.sh pull && sudo sh run.sh recreate
```

## 9. Studio (the database dashboard)

Studio is the same dashboard you know from supabase.com: table editor, SQL editor and the list of logins.

For safety it only listens on the server itself. To open it from your computer, use an SSH tunnel:
```bash
sudo bash axle.sh studio        # shows the username and password
```
On your computer (PowerShell on Windows works):
```bash
ssh -L 8000:127.0.0.1:8000 you@your-server
```
Then browse to **http://localhost:8000**. Studio stays available while the ssh window is open.

## 10. Office network certificates (`AXLE_TLS=internal`)

The server signs its own certificate. Browsers warn until each device trusts it, which you do once per device.

1. Get the certificate file from the server:
```bash
sudo docker cp axle-web:/data/caddy/pki/authorities/local/root.crt /tmp/axle-root.crt
```
   Copy `/tmp/axle-root.crt` to your computer (WinSCP), or put it on a shared folder.
2. Install it on each device:
   - **Windows:** double-click the file → Install Certificate → Local Machine → "Place all certificates in the following store" → **Trusted Root Certification Authorities** → Finish. Restart the browser.
   - **Android:** Settings → Security → Encryption & credentials → Install a certificate → **CA certificate** → pick the file.
   - **iPhone/iPad:** send the file by email or AirDrop and open it to install the profile. Then go to Settings → General → About → **Certificate Trust Settings** and switch it on.

The certificate is kept in a Docker volume (`supabase_axle-caddy-data`) and stays the same across updates.

## 11. Everyday commands

Run all of these from `/opt/axle/app/deploy/self-host` (`cd` there first).

| Command | What it does |
|---|---|
| `sudo bash axle.sh status` | is everything running? address, latest backup |
| `sudo bash axle.sh logs` / `logs auth` / `logs web` | live logs, all or one part (Ctrl+C to stop) |
| `sudo bash axle.sh stop` / `start` | stop or start everything (data is kept) |
| `sudo bash axle.sh backup` | backup now |
| `sudo bash axle.sh restore <file>` | put a backup back |
| `sudo bash axle.sh create-owner` | add another Owner login (e.g. if the only Owner is locked out) |
| `sudo bash axle.sh migrate` | apply new migrations only (update does this) |
| `sudo bash axle.sh studio` | Studio login details |

Everything also starts by itself when the server reboots.

## 12. Security checklist

- Allow only SSH, HTTP and HTTPS through the server's firewall:
```bash
sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw allow 443/udp && sudo ufw enable
```
  Note that Docker-published ports bypass ufw. The kit only publishes 80 and 443 publicly; the database, the pooler and Studio listen on the server itself (127.0.0.1).
- The server's secret keys are in `/opt/axle/supabase/.env`. Only root can read the file. Don't share it, and keep a copy somewhere safe: without it, a backup can still be restored into a new install, but the old keys can't be recovered.
- Keep the system updated: `sudo apt update && sudo apt upgrade`, monthly.
- Use `AXLE_TLS=off` only on a closed test network: with it, passwords cross the network unencrypted.
- Login tokens are signed with this server's own keys. The app's public key in the browser is valid for 5 years from install. `update` won't change it.

## 13. When something goes wrong

| Problem | What to check |
|---|---|
| `install` stops with "Some services didn't start" | `sudo bash axle.sh status` shows which one; `sudo bash axle.sh logs <name>` shows why. Most often the server has too little RAM (4 GB minimum) or disk. |
| Browser says the site can't be reached | Is the server on? Does `status` show `web` running? On a VPS, are ports 80 and 443 open in the provider's firewall? |
| Certificate error with `AXLE_TLS=auto` | The DNS A record must point at this server, and ports 80 and 443 must be reachable from the internet. Check `sudo bash axle.sh logs web`. |
| Invites / reset emails don't arrive | Check the spam folder, then check the SMTP settings in `axle.conf` and run `sudo bash axle.sh update`. `sudo bash axle.sh logs auth` shows the mail server's reply. Gmail needs an *app password*. |
| A migration failed | Nothing from that migration was kept, so the database is as it was. Send me the message. |
| Forgot the Owner password | Use "Forgot password" on the sign-in page (needs email), or `sudo bash axle.sh create-owner` to make a new Owner who can then reset the other. |
| Disk getting full | `df -h`. Old backups are pruned automatically; old Docker images can be removed with `sudo docker image prune`. |

---

### For the technically curious

- `axle.sh install` runs Supabase's own `setup.sh` at release `self-hosted/v0.8.2` into `/opt/axle/supabase`. It then adds `docker-compose.axle.yml`, which:
  - adds the `web` service;
  - limits the gateway and pooler to 127.0.0.1;
  - is listed in `COMPOSE_FILE` in `.env`, so plain `docker compose` commands in that folder include it.
- Migrations run as the `postgres` role, as in the supabase.co SQL editor, each in its own transaction. They are recorded in `axle_deploy.migrations` together with a checksum. pg_cron is switched on first, so the 06:00 reminders job gets scheduled.
- A backup holds:
  - `data.sql`, a `pg_dump --data-only` of `public.*` plus `auth.users` and `auth.identities`;
  - the uploaded files, fetched through the Storage API;
  - a fingerprint of the table layout.

  A restore empties the app and login tables and loads everything with triggers off (`session_replication_role = replica`), in one transaction, so it is all or nothing. It then re-uploads the files.
- The app is built inside Docker (`node:20-alpine`, `npm run build`), with `VITE_SUPABASE_URL` set to your address and this server's anon key. It is served by `caddy:2.10-alpine`. The same paths as supabase.co (`/auth/v1`, `/rest/v1`, `/storage/v1`, `/functions/v1`…) are forwarded to the Supabase gateway, so the app code is unchanged.
