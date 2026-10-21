# SOCKS5 Relay with Web Panel on Runflare

This guide sets up a lightweight Docker SOCKS5 relay on Runflare with a password-protected web control panel. Use it as a private, authenticated proxy for any SOCKS5-capable client. The relay only forwards connections that your client sends to it.

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

1. Download [`relay-control.zip`](https://github.com/ThisIsDara/Runflare-Proxy/releases/latest/download/relay-control.zip).
2. Drag and drop, or upload the ZIP file into the deployment area.
3. Make sure the `Dockerfile` is at the **root** of the ZIP, not inside an extra folder.
4. Start the deployment.
<img width="1571" height="403" alt="image" src="https://github.com/user-attachments/assets/40523bf6-8a8e-4812-8559-21e93d7209cf" />

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
- **`PROXY_USER`** — the SOCKS5 username, for example `relay`.
- **`PROXY_PASS`** — the SOCKS5 password, 8–128 characters. Set it explicitly so it does **not** change when the container restarts.
- **`PUBLIC_SOCKS_ENDPOINT`** — Add a placeholder value for now, we will Add this at step 6.

<img width="1566" height="480" alt="image" src="https://github.com/user-attachments/assets/b1fc6648-0cba-4103-8323-530c560f9500" />


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

---

## 5. Create a Panel URL (Domain)

Runflare's ClusterIP row only maps `http:80 → 3000` inside the project. It does **not** create a public URL by itself, so you attach a domain to that row to open the panel.

1. Go to **Project → Services** (or the service details page).
2. In the **Domain (دامنه)** column, click **Create Temporary Domain (ایجاد دامنه موقت)**.
3. The URL appears in that column, for example:
   `docker-xxxx-<project>.runflare.cloud`
4. Open that URL. It routes to the panel on port `3000`.

> A temporary domain is valid for **1 hour** and can be created **3 times per 24 hours**. It is meant for setup and testing. The relay itself keeps running after the URL expires; create a new temporary domain when you need the panel.

<img width="1568" height="663" alt="temp-domain" src="https://github.com/user-attachments/assets/fa4a02e7-d7e5-4791-91c6-a9ac7328ee66" />


### For a permanent URL, go to **Project → Domain Settings (تنظیم دامنه)**, add a domain you own, set its DNS record, then attach it to this service and choose the **`http:80 → 3000`** network.

<img width="1558" height="403" alt="domain1" src="https://github.com/user-attachments/assets/b611af75-d280-4197-8b5d-3926a78eeadd" />

### Copy the TXT Record
<img width="1546" height="618" alt="domain2" src="https://github.com/user-attachments/assets/43ed0046-d3cf-4c2d-88f0-aef5dc64cffa" />


### If you use CDNs like Cloudflare to manage your Domain, add the TXT Record to your Domain.

<img width="1609" height="261" alt="domain3" src="https://github.com/user-attachments/assets/e6db4a29-8631-4733-afc2-c279be0f8936" />
### Copy the IP from Runflare Domain Records
<img width="1545" height="655" alt="A record ip" src="https://github.com/user-attachments/assets/0b9858c1-6f1b-414a-9fa0-a7e093ce149b" />

### Add the IP in Cloudflare as *A* Record with the names *@* and *www*

<img width="1630" height="339" alt="DNS records" src="https://github.com/user-attachments/assets/bd546fc2-3d9e-4fad-82b2-2866729f2c12" />


> *DNS propagation:* Runflare manages DNS queries itself. After creating or attaching the domain, the panel may not open immediately. Wait **5–30 minutes** for the DNS record to propagate before assuming the deployment is broken.





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
<img width="1565" height="413" alt="network" src="https://github.com/user-attachments/assets/0d9c5474-e4d0-4ab6-b205-381c4475835e" />


9. Put that `host:port` into **`PUBLIC_SOCKS_ENDPOINT`** and save/restart. The panel's **v2rayN share link** will then be generated with the proxy credentials embedded.


<img width="660" height="496" alt="replace" src="https://github.com/user-attachments/assets/fc9cfa26-3c3a-40b5-a5ad-5092d8316b5c" />


> Use the **5-digit remote port**, not `8000`. Do not use the panel domain for SOCKS. The panel domain is for the web UI only; the SOCKS proxy is the NodePort.




---

## 7. Open the Panel and Copy the Share Link

1. Open the panel URL from step 5.
2. Sign in with **`ADMIN_PASSWORD`**.
3. Confirm that the panel says **Relay is live**.
4. Under **Access**, click **Reveal current password** if you need the raw credentials for manual client setup.
5. The **v2rayN share link** box shows `socks://...@host:port#runflare` when `PUBLIC_SOCKS_ENDPOINT` is set. Click **Copy**; paste it into v2rayN with `Ctrl+V`.

---

## 8. Connect Through the Proxy

### Option A: v2rayN (GUI)

The panel's **v2rayN share link** already contains the host, port, username, and password. Import it directly:

1. Open the panel and click **Copy** next to the **v2rayN share link**.
2. In v2rayN, choose **Servers → Import Share Links from Clipboard** (`Ctrl+V`).
3. Select the imported `runflare` server in the server list.
4. Click **Enable Tun** (run v2rayN as Administrator if prompted).
5. Open **Routing Setting** and add rules for the traffic you want to send through the relay. Set the outbound to the imported `runflare` server, and add a final catch-all `direct` rule for everything else.

> The share link is a password. Anyone who has it can use the relay. If you prefer manual entry, use **Servers → Add [SOCKS]** and fill in the host, 5-digit port, username, and password from the panel.

> v2rayN's TUN mode captures all system traffic. Configure the routing rules so only the traffic you want uses the relay.

---

### Confirm it is working

Open the panel and check:

- **Active connections** shows the destination hosts your client is opening.
- **Traffic → Downloaded** climbs while data moves through the relay.
- A request succeeds when the relay is live and fails when it is paused.

---

## 🛑 Stopping & Starting Your Service (Cost Saving)

To avoid charges while you are not using the relay, stop the Runflare service.

### When you finish using the relay

- Go to your **Runflare Dashboard**.
- Open **Projects** and select your project.
- Click the **Stop** button (⏻). The service stops billing while paused.

### When you need it again

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
- **Traffic is not going through the relay.** Confirm the client is using the NodePort `host:port`, the relay is live, and the app or system proxy is actually pointed at it. In v2rayN, check that the active routing rule selects the imported server. If you use TUN mode, run v2rayN as Administrator and check **Active connections** in the panel.
- **The Route test shows 502 or HTTP 403.** Cloudflare is rejecting the container's test download. This is not the SOCKS proxy failing. Try `https://speed.hetzner.de/100MB.bin` in the Route test, or ignore it.
- **The password contains URL characters.** Use curl's `--proxy-user "USER:PASS"` instead of putting the password inside the proxy URL. Quote the value in your shell.
- **The NodePort changed after a redeploy.** Update `PUBLIC_SOCKS_ENDPOINT` and the client config with the new `host:port`.

---

## Limits & Notes

- **No caching.** Every byte crosses the container twice: client → container, then container → destination. A 100 GB transfer moves roughly 200 GB through Runflare. Check Runflare's bandwidth quotas and pricing before large transfers.
- **TCP only.** The relay implements SOCKS5 `CONNECT`, which forwards TCP. UDP-based traffic, including some voice, streaming, and QUIC flows, is not supported and may fail while routed.
- **In-memory state.** Panel changes, counters, and active sessions reset when the container restarts.
- **Security.** The SOCKS port is public but requires a username and password. Use a strong password. The panel is protected by `ADMIN_PASSWORD`; use HTTPS for the domain when possible. A temporary domain may be HTTP-only, so avoid entering the admin password on an untrusted network.
- **Acceptable use.** A public general-purpose proxy may violate the host's terms. Check Runflare's policy before committing to large transfers.

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
