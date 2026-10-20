# Steam SOCKS5 Relay with Web Panel on Runflare (Steam-only, no full VPN)

This guide sets up a lightweight Docker SOCKS5 relay on Runflare with a password-protected web control panel. It sends only Steam's download traffic through the container, so you can use a better network path without routing your whole PC through a VPN. Everything else stays direct.

> **Quick start:** [Download `relay-control.zip`](https://github.com/ThisIsDara/Runflare-Proxy/releases/latest/download/relay-control.zip) and follow the steps below.

The container has two listeners:

| Container port | What it is | How it is exposed |
| --- | --- | --- |
| `3000` | Web control panel | Runflare **ClusterIP** `http:80 → 3000`, opened through a domain |
| `8000` | SOCKS5 proxy | Runflare **NodePort** `80 → 8000` |

> **Important:** `3000` is the panel. `8000` is the proxy. Do not swap them.

---

## 1. Create a Runflare Project

First, set up the project that will hold the relay service.

1. **Login or Register** at [portal.runflare.com](https://portal.runflare.com/).
2. Click **Create Project (ایجاد پروژه)**.
3. Select any domain name you prefer. You can attach a real domain later; a temporary domain is enough to start.
4. **Select a Datacenter:** **Pishgaman IRAN (پیشگامان ایران)** is recommended for the best route from inside the country. Other locations work; test the route.
5. **Select Resources:** The minimum is fine. This relay is limited by bandwidth, not CPU.
6. Click to create the project.

---

## 2. Create the Docker Service

1. Go to **Services (سرویس ها)** in your project and click **Create (+ ایجاد)**.
2. Enter a **Service Name** of your choice.
3. In **Structure**, select **Docker**.
4. **Expose Port:** choose **`3000`**. This is the web panel.
   - Do **not** choose `8000` here. `8000` is the SOCKS port and will be exposed later as a NodePort.
5. **Select Resources:** The minimum is enough to start.
6. Click to create the service.

<img width="1319" height="779" alt="image" src="https://github.com/user-attachments/assets/55bdfe8b-5287-421b-acad-ad3e1a2b554e" />


---

## 3. Deploy the Source Code

Deploy this project to the service. You can use either method.

### Option A: ZIP Upload (Recommended)

1. Download [`relay-control.zip`](https://github.com/ThisIsDara/Runflare-Proxy/releases/latest/download/relay-control.zip), or download the repository as a ZIP.
2. Drag and drop, or upload the ZIP file into the deployment area.
3. Make sure the `Dockerfile` is at the **root** of the ZIP, not inside an extra folder.
4. Start the deployment.

### Option B: Direct GitHub Link

1. Push this project to a GitHub repository.
2. In Runflare, select **Git**.
3. Choose **Classic GitHub (گیت هاب کلاسیک)**.
4. Enter your repository URL, for example:
   `https://github.com/YOUR_USERNAME/YOUR_REPO.git`
5. Set the **Branch** to `main`.
6. Leave the Token field completely blank.
7. Select the last commit from the bottom of the page.
8. Start the deployment.

---

## 4. Environment Variables Configuration

Open the **Environment Variables (متغیرهای محیطی)** section in the service settings. Add these variables:

- **`ADMIN_PASSWORD`** *(Required)* — the password for the web panel. Use at least 8 characters; 16+ is better.
- **`PROXY_USER`** — the SOCKS5 username, for example `steam`.
- **`PROXY_PASS`** — the SOCKS5 password, 8–128 characters. Set it explicitly so it does **not** change when the container restarts.
- **`PUBLIC_SOCKS_ENDPOINT`** — the NodePort address, for example `remote-pishgaman.runflare.com:30769`. Add this after step 6. Use `host:port` only, without `socks5://`.

Optional settings:

| Variable | Default | Notes |
| --- | --- | --- |
| `MAX_CONNECTIONS` | `64` | Concurrent SOCKS connections, 1–512. |
| `PROXY_ENABLED` | `true` | Start with the relay active or paused. |
| `SPEEDTEST_URL` | Cloudflare 100 MB | Default Route test URL. Change it if the test returns 403. |
| `ADMIN_PORT` | `3000` | Must match the service's Expose Port. |
| `PROXY_PORT` | `8000` | Must match the NodePort target. |
| `TRUST_PROXY` | `true` | Keep this for Runflare so login rate limiting sees the real client IP. |

Save the variables. Runflare restarts the container automatically when they change.

> Changes made in the panel are kept in memory. They reset to these environment values when the container restarts.

![Environment variables](screenshots/environment_variables.png)

---

## 5. Create a Panel URL (Domain)

Runflare's ClusterIP row only maps `http:80 → 3000` inside the project. It does **not** create a public URL by itself, so you attach a domain to that row to open the panel.

1. Go to **Project → Services** (or the service details page).
2. In the **Domain (دامنه)** column, click **Create Temporary Domain (ایجاد دامنه موقت)**.
3. The URL appears in that column, for example:
   `docker-xxxx-<project>.runflare.cloud`
4. Open that URL. It routes to the panel on port `3000`.

For a permanent URL, go to **Project → Domain Settings (تنظیم دامنه)**, add a domain you own, set its DNS record, then attach it to this service and choose the **`http:80 → 3000`** network.

> A temporary domain is valid for **1 hour** and can be created **3 times per 24 hours**. It is meant for setup and testing. The relay itself keeps running after the URL expires; create a new temporary domain when you need the panel.

![Create a temporary domain](screenshots/domain.png)

---

## 6. Network Configuration (Crucial Step)

Runflare's default ClusterIP mapping is for the web panel. SOCKS5 is raw TCP, so it needs a **NodePort**. This is the address your client will use.

1. Open **Networks (شبکه ها)** in the service.
2. Leave the default **ClusterIP** `http:80 → 3000` alone. That is the panel.
3. Click **Add Network (افزودن شبکه)**.
4. Set the **Type (نوع)** to **`NodePort`**.
5. Set the **Port** to **`80`**.
6. Set the **Target Port (تارگت پورت)** to **`8000`**.
7. Click **Add / Save**.
8. Copy the value under **Remote Access (دسترسی از راه دور)**, for example:
   `remote-pishgaman.runflare.com:30769`
9. Put that `host:port` into **`PUBLIC_SOCKS_ENDPOINT`** and save/restart. The panel's **Copy** button will then work.

> Use the **5-digit remote port**, not `8000`. Do not use the panel domain for SOCKS. The panel domain is for the web UI only; the SOCKS proxy is the NodePort.

![NodePort configuration](screenshots/networks.png)

---

## 7. Open the Panel and Copy Credentials

1. Open the panel URL from step 5.
2. Sign in with **`ADMIN_PASSWORD`**.
3. Confirm that the panel says **Relay is live**.
4. Under **Access**, click **Reveal current password**. Copy the username and password.
5. The **Endpoint** box shows `socks5h://host:port` if `PUBLIC_SOCKS_ENDPOINT` is set. If it is not set, use the NodePort address manually.

Quick test from PowerShell:

```powershell
curl.exe --proxy 'socks5h://USER:PASS@HOST:PORT' https://api.ipify.org
```

If the password contains characters like `@`, `:`, or `/`, use:

```powershell
curl.exe --proxy 'socks5h://HOST:PORT' --proxy-user USER --proxy-password 'PASS' https://api.ipify.org
```

The reply should be the container's public IP. `socks5h` makes the proxy resolve the hostname, which avoids DNS leaks.

![Relay Control panel](screenshots/panel_dashboard.png)

---

## 8. Connect Steam

Steam has no SOCKS setting of its own, so use a TUN client. Pick one of the options below.

### Option A: sing-box (included config, recommended)

1. Download sing-box for Windows from the [official releases](https://github.com/SagerNet/sing-box/releases). The included config is validated against [sing-box 1.14.3 for Windows amd64](https://github.com/SagerNet/sing-box/releases/download/v1.14.3/sing-box-1.14.3-windows-amd64.zip).
2. Extract it. Put `sing-box.exe` in `client\sing-box\`, or note the full path to the executable.
3. Copy the example config:

   ```powershell
   Copy-Item client\sing-box.example.json client\sing-box.json
   ```

4. Edit `client\sing-box.json`:
   - `server`: the NodePort host, for example `remote-pishgaman.runflare.com`
   - `server_port`: the 5-digit port as a number, for example `30769`
   - `username`: the panel username
   - `password`: the panel password
5. Run it from an **Administrator** PowerShell:

   ```powershell
   cd C:\Users\Trick\Desktop\Docker-VPN
   .\client\sing-box\sing-box.exe run -c .\client\sing-box.json
   ```

6. Fully exit Steam if it is running, then start it again.
7. Start a game download and watch the panel's **Active connections** and **Traffic**.

The config routes only `steam.exe` and `steamwebhelper.exe` through the relay. DNS and everything else stay direct.

![sing-box setup](screenshots/sing-box.png)

### Option B: v2rayN (GUI)

If you already use v2rayN, add the relay as a SOCKS server:

1. Open v2rayN.
2. Go to **Servers → Add [SOCKS]**.
3. Fill in:
   - **Address:** the NodePort host
   - **Port:** the 5-digit remote port
   - **Username:** the panel username
   - **Password:** the panel password
   - **Remarks:** `Steam Relay`
4. Save the server and select it in the server list.
5. Click **Enable Tun** (run v2rayN as Administrator if prompted).
6. Open **Routing Setting** and create a rule set for Steam:
   - Under **Pre-defined Rule Set List**, click **Add** and name it `Steam only`.
   - Under **Rule Settings**, add Rule 1: **Process (Linux/Windows)** = `steam.exe,steamwebhelper.exe`, **Outbound Tag** = `proxy`.
   - Add Rule 2: **Port** = `0-65535`, **Outbound Tag** = `direct` (final catch-all).
   - Set `Steam only` as the active routing rule.
7. Start Steam **after** TUN mode is active.

> v2rayN expects `socks://` or `socks5://` links, not `socks5h://`. Importing the panel's `socks5h://` link directly will fail; enter the host and port manually, or change the scheme to `socks5://` and fill in the username/password after importing.

> v2rayN's TUN mode captures all system traffic. The routing rules decide what is proxied. Without the Steam-only rule and a final direct rule, everything can go through the relay.

![v2rayN setup](screenshots/v2rayn.png)

### Confirm it is working

Open the panel and check:

- **Active connections** shows connections to Steam CDN hosts.
- **Traffic → Downloaded** climbs while the game downloads.
- Steam's download speed changes when you switch the relay on or off.

If Steam still downloads directly, see the troubleshooting section below.

![Steam download](screenshots/steam_download.png)

---

## 🛑 Stopping & Starting Your Service (Cost Saving)

To avoid charges while you are not downloading, stop the Runflare service.

### When you finish downloading

- Go to your **Runflare Dashboard**.
- Open **Projects** and select your project.
- Click the **Stop** button (⏻). The service stops billing while paused.

### When you are ready to download again

- Return to the same project.
- Click the **Start** button (▷).
- Wait a few seconds for the container to boot.
- If the NodePort address changed, update `PUBLIC_SOCKS_ENDPOINT` and your client config.

---

## Troubleshooting

- **There is no panel URL, or Remote Access is empty.** ClusterIP is internal only. Create a temporary domain from the service list's **Domain** column, or attach your own domain in **Project → Domain Settings**. Make sure the domain points to `http:80 → 3000`, not the NodePort.
- **The panel keeps returning to the sign-in page.** The domain is attached to the wrong network or the cookie is stale. Use the domain URL, not the NodePort, and confirm the ClusterIP target is `3000`.
- **The temporary domain expired.** Create another one from the **Domain** column (3 per 24 hours). The SOCKS relay keeps working without the panel.
- **`curl` says the user was rejected.** The username or password is wrong. Use **Reveal current password** in the panel. Changes apply to new connections.
- **`curl` cannot connect.** Confirm the NodePort is `Port 80 → Target 8000`, the service is running, and you are using the **Remote Access** `host:5-digit-port`, not port `8000`.
- **Steam still downloads directly.** Run the client as Administrator, start Steam **after** the TUN client, and confirm the process names are `steam.exe` / `steamwebhelper.exe`. Check **Active connections** in the panel.
- **The Route test shows 502 or HTTP 403.** Cloudflare is rejecting the container's test download. This is not the SOCKS proxy failing. Try `https://speed.hetzner.de/100MB.bin` in the Route test, or ignore it.
- **The password contains URL characters.** Use curl's `--proxy-user USER --proxy-password PASS` instead of putting the password inside the proxy URL.
- **The NodePort changed after a redeploy.** Update `PUBLIC_SOCKS_ENDPOINT` and the client config with the new `host:port`.

---

## Limits & Notes

- **No caching.** Every byte crosses the container twice: Steam → container, then container → you. A 100 GB game moves roughly 200 GB through Runflare. Check Runflare's bandwidth quotas and pricing before a large download.
- **TCP only.** The relay implements SOCKS5 `CONNECT`, which covers Steam downloads. Steam voice and other UDP features may fail while routed.
- **In-memory state.** Panel changes, counters, and active sessions reset when the container restarts.
- **Security.** The SOCKS port is public but requires a username and password. Use a strong password. The panel is protected by `ADMIN_PASSWORD`; use HTTPS for the domain when possible. A temporary domain may be HTTP-only, so avoid entering the admin password on an untrusted network.
- **Acceptable use.** A general-purpose proxy or game-download relay may violate the host's terms. Check Runflare's policy before committing to large downloads.

---

## Local Development (Optional)

No Docker is required; the app uses only Node's standard library.

```powershell
$env:ADMIN_PORT="3000"
$env:PROXY_PORT="8000"
$env:ADMIN_PASSWORD="testpass123"
$env:PROXY_USER="relay"
$env:PROXY_PASS="testpass123"
node server.js
```

Open <http://127.0.0.1:3000>. To build the image:

```powershell
docker build -t relay-control .
docker run --rm -p 3000:3000 -p 8000:8000 `
  -e ADMIN_PASSWORD=testpass123 `
  -e PROXY_USER=relay `
  -e PROXY_PASS=testpass123 `
  relay-control
```

The Dockerfile uses `node:22-alpine` and does not run `npm install`.
