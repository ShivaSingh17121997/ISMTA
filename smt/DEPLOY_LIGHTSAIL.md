# Moving SMT to AWS Lightsail (Mumbai) — step by step

**Result:** the backend and frontend run all day on a server with a fixed IP, behind HTTPS, at `https://app.yourdomain.com`. Zerodha always sees the same IP.

**Time:** about 2–3 hours the first time. **Cost:** check current prices on the Lightsail pricing page.

| Item | Approximate cost |
|---|---|
| 2 GB instance | about $12/month |
| 4 GB instance | about $24/month |
| Static IP | free while attached to an instance |
| Automatic snapshots | a few dollars a month |
| Domain | about ₹700–1,000 a year |

Ready-made files are in `smt/deploy/`: `smt-be.service`, `smt-fe.service`, `Caddyfile`, `backup.sh`, `update.sh`.

> **The one rule that matters: never run the laptop backend and the server backend at the same time while connected to Zerodha.** Two engines would both trade your account. Stop the laptop first and keep it stopped.

---

## Part 0 — Before you start

You need:

- An AWS account (aws.amazon.com), with a card added.
- A domain name from any registrar (GoDaddy, Namecheap, Hostinger, Cloudflare). You will use two subdomains: `api.yourdomain.com` and `app.yourdomain.com`.
- Access to the Kite developer console (developers.kite.trade).
- Your current `BE/.env` file.
  - It holds `JWT_SECRET` and **`BROKER_CREDENTIALS_KEY`**, which you must copy exactly.
  - Your Kite API secret and your two-factor (TOTP) secret are stored encrypted with that key. A new key makes them unreadable.
- About 30 minutes outside market hours for the switch-over (Part 7). Evening or weekend is best.

---

## Part 1 — Create the server

1. Open lightsail.aws.amazon.com → **Create instance**.
2. **Region: Mumbai (ap-south-1).** This keeps the server a few milliseconds from Zerodha and NSE.
3. **Platform:** Linux/Unix. **Blueprint:** OS Only → **Ubuntu 24.04 LTS**.
4. **SSH key:** keep the default key and download it (a `.pem` file). Save it as `C:\Users\Microsoft\.ssh\lightsail-mumbai.pem`.
5. **Plan: 2 GB RAM / 2 vCPU** is enough; it will need a swap file (Part 3). Choose **4 GB** if you want headroom for the Market Weather, Global Markets and Foreign Stocks refreshes.
6. **Name:** `smt-prod` → **Create instance**.

## Part 2 — Fixed IP, firewall, domain

1. **Static IP:** Lightsail → **Networking** → **Create static IP** → Mumbai → attach to `smt-prod`. Write the IP down; call it `SERVER_IP`.
2. **Firewall:** open the instance → **Networking** tab → IPv4 firewall. Keep only:
   - SSH (22)
   - HTTP (80), needed for the HTTPS certificate
   - HTTPS (443)

   Do **not** open 4000, 3002 or 27017.
3. **Domain:** at your registrar's DNS settings, add two **A records**:
   - `api` → `SERVER_IP`
   - `app` → `SERVER_IP`

   They usually work within minutes. Check from your laptop with `nslookup api.yourdomain.com`.
4. **Kite developer console** → your app:
   - **Add `SERVER_IP` as the second static IP** and keep your home IP (122.176.71.56) for now. Kite allows two IPs and one change a week, so adding the second one now avoids a week stuck without trading.
   - **Change the Redirect URL** to `https://api.yourdomain.com/api/broker/zerodha/callback`. Do this during the switch-over (Part 7), because it breaks the laptop login.

## Part 3 — Prepare the server

Connect from Git Bash or PowerShell on your laptop:

```bash
ssh -i ~/.ssh/lightsail-mumbai.pem ubuntu@SERVER_IP
```

The browser "Connect using SSH" button in Lightsail also works.

Then run, on the server:

```bash
# Updates
sudo apt update && sudo apt -y upgrade
sudo apt -y install build-essential git curl unzip

# Swap file (essential on 2 GB, or the frontend build can run out of memory)
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Automatic security updates
sudo apt -y install unattended-upgrades && sudo dpkg-reconfigure -plow unattended-upgrades

# Node.js 22 (the version you use locally)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt -y install nodejs
node -v    # should print v22.x
```

Leave the server clock on UTC. The app converts to IST internally for market hours.

## Part 4 — MongoDB on the server

```bash
curl -fsSL https://www.mongodb.org/static/pgp/server-8.0.asc | sudo gpg -o /usr/share/keyrings/mongodb-server-8.0.gpg --dearmor
echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] https://repo.mongodb.org/apt/ubuntu noble/mongodb-org/8.0 multiverse" | sudo tee /etc/apt/sources.list.d/mongodb-org-8.0.list
sudo apt update && sudo apt -y install mongodb-org
sudo systemctl enable --now mongod
```

Create a password-protected user for the app. Pick your own strong password in place of `CHANGE_ME_LONG_PASSWORD`:

```bash
mongosh --quiet --eval '
  db.getSiblingDB("admin").createUser({ user: "admin", pwd: "CHANGE_ME_ADMIN_PASSWORD", roles: ["root"] });
  db.getSiblingDB("smt_trading").createUser({ user: "smt", pwd: "CHANGE_ME_LONG_PASSWORD", roles: [{ role: "readWrite", db: "smt_trading" }, { role: "readWrite", db: "smt_trading_test" }] });
'
```

Then turn authentication on:

```bash
sudo sed -i 's/^#security:/security:\n  authorization: enabled/' /etc/mongod.conf
grep -A1 '^security' /etc/mongod.conf    # should show: authorization: enabled
sudo systemctl restart mongod
```

MongoDB listens only on 127.0.0.1 by default, so it cannot be reached from the internet. Keep it that way.

## Part 5 — Copy the code to the server

On the **laptop**, in Git Bash:

```bash
cd ~/Desktop
tar --exclude=node_modules --exclude=.next --exclude=dist \
    -czf smt.tgz smt/BE smt/FE/ismta smt/deploy
scp -i ~/.ssh/lightsail-mumbai.pem smt.tgz ubuntu@SERVER_IP:~
```

This includes `BE/.cache` (about 300 MB of downloaded price history), so the server does not have to refetch it.

On the **server**:

```bash
cd ~ && tar -xzf smt.tgz && ls smt    # BE  FE  deploy
```

## Part 6 — Configure and build

### Backend `.env`

Edit `~/smt/BE/.env` (`nano ~/smt/BE/.env`). Keep all your existing lines, and make sure these are set:

```ini
NODE_ENV=production
HOST=127.0.0.1
PORT=4000
MONGO_URI=mongodb://smt:CHANGE_ME_LONG_PASSWORD@127.0.0.1:27017/smt_trading?authSource=smt_trading
PUBLIC_API_URL=https://api.yourdomain.com
FRONTEND_URL=https://app.yourdomain.com
CORS_ORIGIN=https://app.yourdomain.com
BROKER_STATIC_IP=SERVER_IP
# Keep these EXACTLY as on the laptop:
JWT_SECRET=...same...
BROKER_CREDENTIALS_KEY=...same...
# Once your own account exists, close sign-up:
ALLOW_REGISTRATION=false
# Strongly recommended now the server is remote (alerts reach your phone):
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

Then lock the file and build:

```bash
chmod 600 ~/smt/BE/.env
cd ~/smt/BE && npm ci && npm run build
```

### Frontend

The API address is fixed into the frontend when it is built, so set it first:

```bash
cd ~/smt/FE/ismta
cat > .env.production.local <<'EOF'
NEXT_PUBLIC_API_URL=https://api.yourdomain.com
NEXT_PUBLIC_WS_URL=wss://api.yourdomain.com/ws
EOF
npm ci && npm run build
```

### Services and HTTPS

```bash
sudo cp ~/smt/deploy/smt-be.service ~/smt/deploy/smt-fe.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable smt-be smt-fe          # start on boot (do NOT start yet: see Part 7)

# Caddy (HTTPS reverse proxy with automatic certificates)
sudo apt -y install debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt -y install caddy
sed 's/yourdomain.com/YOURREALDOMAIN.com/g' ~/smt/deploy/Caddyfile | sudo tee /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

## Part 7 — Switch over (outside market hours)

1. **On the laptop, stop the backend** (Ctrl+C in its terminal). Don't start it again after this.
2. **Copy the database.**
   - On the laptop, install "MongoDB Command Line Database Tools" for Windows from mongodb.com (it provides `mongodump`).
   - Then, in Git Bash:

     ```bash
     mongodump --db smt_trading --archive=smt-db.gz --gzip
     scp -i ~/.ssh/lightsail-mumbai.pem smt-db.gz ubuntu@SERVER_IP:~
     ```

   - On the server:

     ```bash
     mongorestore --uri="mongodb://smt:CHANGE_ME_LONG_PASSWORD@127.0.0.1:27017/smt_trading?authSource=smt_trading" \
                  --archive=smt-db.gz --gzip --nsInclude='smt_trading.*'
     ```

3. **Start the apps on the server:** `sudo systemctl start smt-be smt-fe`
4. **Watch the backend start:**

   ```bash
   journalctl -u smt-be -f
   ```

   You should see `Fill audit: every engine fill is booked` and no `static-ip` halt. Ctrl+C stops watching; it does not stop the app.
5. **In the Kite console**, set the Redirect URL to `https://api.yourdomain.com/api/broker/zerodha/callback`.
6. **Open `https://app.yourdomain.com`**, log in, go to **Settings** and **Connect Zerodha** (the normal daily login). It should come back connected.

## Part 8 — Check it works

| Check | How | Expected |
|---|---|---|
| API reachable over HTTPS | `curl https://api.yourdomain.com/api/auth/config` | JSON, not an error |
| Site loads with a padlock | open `https://app.yourdomain.com` | your login page |
| Live updates | top bar after login | not stuck on "Reconnecting…" (that would mean the WebSocket is blocked) |
| Static IP | **System** page | no `static-ip` halt; public IP = `SERVER_IP` |
| Zerodha | Settings → broker card | connected, funds read |
| Data pages | Market Weather, Global Markets, Foreign Stocks | first build appears within a few minutes of boot |
| Orders | one tiny manual round trip in market hours | fills, shows in Orders and the Kite app |

Once all of this passes, you can remove your home IP from the Kite console (one change a week).

## Part 9 — Security (do all of these)

- **Change the demo account password**, and enrol **TOTP** (two-factor) in Settings. Live trading already refuses to switch on without them.
- `ALLOW_REGISTRATION=false` once your account exists, then restart: `sudo systemctl restart smt-be`.
- Never open ports 4000, 3002 or 27017 in the Lightsail firewall. Everything goes through Caddy on 443.
- Keep the `.pem` key private. Lightsail allows SSH by key only; leave it that way.
- `.env` stays `chmod 600`, and never goes into a chat, email or git.

## Part 10 — Backups

- **Lightsail automatic snapshots:** instance → **Snapshots** → enable automatic daily snapshots. This lets you restore the whole server in minutes.
- **Database backup every night:**

  ```bash
  echo 'MONGO_URI="mongodb://smt:CHANGE_ME_LONG_PASSWORD@127.0.0.1:27017/smt_trading?authSource=smt_trading"' > ~/.smt-backup.env
  chmod 600 ~/.smt-backup.env && chmod +x ~/smt/deploy/backup.sh
  (crontab -l 2>/dev/null; echo '30 21 * * * /home/ubuntu/smt/deploy/backup.sh') | crontab -
  ```

  This runs at 03:00 IST and keeps 14 days in `~/backups`.

## Part 11 — Everyday use and updates

- **Every morning:** open the site → Settings → **Connect Zerodha**. Kite logs everyone out at 06:00, so this cannot be automated.
- **Logs:**
  - `journalctl -u smt-be -f` (live)
  - `journalctl -u smt-be --since "1 hour ago"`
- **Restart:** `sudo systemctl restart smt-be` (after 15:30 IST).
- **Deploy a new version** (after market close):
  1. On the laptop, package the code without the server's settings and cache:

     ```bash
     cd ~/Desktop
     tar --exclude=node_modules --exclude=.next --exclude=dist --exclude=.cache --exclude='.env*' \
         -czf smt-new.tgz smt/BE smt/FE/ismta smt/deploy
     scp -i ~/.ssh/lightsail-mumbai.pem smt-new.tgz ubuntu@SERVER_IP:~
     ```

  2. On the server: `bash ~/smt/deploy/update.sh`. It stops the apps, rebuilds and restarts them.

## If something goes wrong

| Symptom | Likely cause | Fix |
|---|---|---|
| Site does not load, or certificate error | DNS not pointing at `SERVER_IP` yet, or port 80/443 closed | `nslookup app.yourdomain.com`; check the Lightsail firewall; `sudo journalctl -u caddy` |
| "CORS: blocked origin" in backend logs | `CORS_ORIGIN` does not exactly match the site address | set `CORS_ORIGIN=https://app.yourdomain.com` (no trailing slash), then restart |
| Top bar always "Reconnecting…" | `NEXT_PUBLIC_WS_URL` wrong at build time | fix `.env.production.local`, run `npm run build`, then `sudo systemctl restart smt-fe` |
| Zerodha login returns to the laptop or errors | Kite Redirect URL not updated | Part 7, step 5 |
| "No IPs configured" / IP rejected by Kite | `SERVER_IP` not added in the Kite console, or `BROKER_STATIC_IP` mismatch | Part 2, step 4; System page shows the IP the server really uses |
| "two-factor secret cannot be read" / broker keys unreadable | `BROKER_CREDENTIALS_KEY` differs from the laptop's | copy the exact value from the laptop `.env`, then restart |
| Backend restarting in a loop | see the error in `journalctl -u smt-be -n 100` | usually `MONGO_URI` (password, or `authSource`) |
| Frontend build killed | out of memory on 2 GB | check the swap file exists (`free -h`), or use the 4 GB plan |
