# SOCKS5 Relay with Web Panel and 443 Tunnel on Runflare

This guide sets up a lightweight Docker SOCKS5 relay on Runflare with a password-protected web control panel. It also includes an optional **VLESS-over-WebSocket tunnel on port 443** for networks that throttle the SOCKS5 NodePort. Use it as a private, authenticated proxy for any SOCKS5-capable client or v2rayN. The relay only forwards connections that your client sends to it.

> **Quick start:** [Download `relay-control.zip`](https://github.com/ThisIsDara/Runflare-Proxy/releases/latest/download/relay-control.zip) and follow the steps below.

The container has two listeners:

| Container port | What it is | How it is exposed |
| --- | --- | --- |
| `3000` | Web control panel | Runflare **ClusterIP** `http:80 → 3000`, opened through a domain |
| `3000` + `/ws` | Optional VLESS 443 tunnel | The same panel domain over **HTTPS**, using a WebSocket upgrade |
| `8000` | SOCKS5 proxy | Runflare **NodePort** `80 → 8000` |

> **Important:** `3000` is the panel and the 443 tunnel. `8000` is the direct SOCKS5 proxy. Do not swap them. The 443 tunnel does not add a new port; it reuses the panel's HTTPS domain and the `/ws` path.

> **TLS requirement:** the 443 tunnel uses the panel domain's certificate. If the domain serves a self-signed or internal certificate, the panel may still open after a browser warning, but v2rayN will reject the tunnel. See [Enable HTTPS for the 443 Tunnel](#enable-https-for-the-443-tunnel).

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
   `https://github.com/ThisIsDara/Runflare-Proxy.git`
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
- **`VLESS_UUID`** *(Optional)* — A fixed UUID for the 443 tunnel. If omitted, the server derives one from `ADMIN_PASSWORD`. Set it explicitly if you rotate the admin password or want the tunnel link to stay the same across password changes.
- **`PUBLIC_VLESS_ENDPOINT`** *(Optional)* — The public `host:port` used in the 443 tunnel link. Use `https://host:443` to force TLS, or `ws://host:80` for an HTTP-only test. Leave it empty to use the panel's own domain and scheme.

<img width="1566" height="480" alt="image" src="https://github.com/user-attachments/assets/b1fc6648-0cba-4103-8323-530c560f9500" />


Optional settings:

| Variable | Default | Notes |
| --- | --- | --- |
| `MAX_CONNECTIONS` | `64` | Concurrent SOCKS5 and VLESS connections, 1–512. |
| `PROXY_ENABLED` | `true` | Start with the relay active or paused. |
| `SPEEDTEST_URL` | Cloudflare 100 MB | Default Route test URL. Change it if the test returns 403. |
| `ADMIN_PORT` | `3000` | Must match the service's Expose Port. |
| `PROXY_PORT` | `8000` | Must match the NodePort target. |
| `VLESS_UUID` | derived from ADMIN_PASSWORD | Fixed UUID for the 443 tunnel. |
| `PUBLIC_VLESS_ENDPOINT` | panel domain | Public `host:port` for the 443 tunnel link. |
| `TRUST_PROXY` | `true` | Keep this for Runflare so login rate limiting sees the real client IP. |

Save the variables. Runflare restarts the container automatically when they change.

> The 443 tunnel is active automatically. It only becomes useful when the panel is opened over **HTTPS**; the panel will generate a `ws://` link (not 443) when the domain is HTTP-only.

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

> **For the 443 tunnel, use a permanent HTTPS domain.** The tunnel runs through the panel's domain, so it stops when a temporary domain expires. The SOCKS5 NodePort keeps working without the panel. If the panel opens over plain HTTP, the tunnel link will be `ws://` and will not use 443; attach a domain with TLS before relying on it. The domain's HTTP ingress must also forward WebSocket upgrades for `/ws`; most HTTP ingresses do, but test the tunnel after deployment.

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

### Enable HTTPS for the 443 Tunnel

The 443 tunnel uses the panel domain's certificate. If the domain serves a self-signed or internal certificate, the panel may still load after a browser warning, but v2rayN rejects the tunnel and the real-delay test shows `-1`. The panel also keeps generating a `ws://` link while it is opened over HTTP.

Open **SSL**, select the domain, and choose one of Runflare's three modes:

| Mode | Result | Use it? |
| --- | --- | --- |
| **HTTP** | No TLS. The panel is plain HTTP and the tunnel link is `ws://`. | No, not for the 443 tunnel. |
| **Runflare free certificate** | Runflare manages the certificate. | Try it first. Some domains receive an internal `cert-manager.local` certificate that clients reject. |
| **HTTPS user certificate** | You upload a certificate and its private key. | Use this when the free certificate is not trusted. |

#### Option A: Runflare free certificate

1. Open **SSL**, select the domain.
2. Enable **Runflare free certificate** and turn off the other two options.
3. Click **Save** and wait a few minutes.
4. Open `https://your-domain` in a private window. A valid padlock means the certificate is trusted.
5. Reload the panel over HTTPS. The 443 card should show `:443` with `security=tls`.

If the browser still warns, or the certificate details show `CN=cert-manager.local` or `CN=TRAEFIK DEFAULT CERT`, the free certificate is not usable for this domain. Use Option B.

#### Option B: Upload a Let's Encrypt certificate (Recommended)

Some CAs, including **ZeroSSL**, refuse `.ir` domains because of US sanctions. **Let's Encrypt** issues certificates for ordinary `.ir` domains, so use it when the panel domain ends in `.ir`.

You need a certificate whose SAN covers the panel domain, its private key, and the intermediate chain. The certificate must cover the exact hostname used in the 443 link; if you use the apex domain, do not switch to `www` unless the certificate includes it. Any ACME client can produce them. For example, with `acme.sh` and Cloudflare DNS:

```bash
export CF_Token="your-cloudflare-api-token"
acme.sh --issue --server letsencrypt --dns dns_cf -d panel.example.com --keylength 2048
```

For other DNS providers, use the matching `--dns` hook and credentials. The client prints a TXT record. Add it at your DNS provider:

- **Type:** `TXT`
- **Name:** `_acme-challenge` (the provider appends the zone)
- **Value:** the value printed by the client

Finish the validation, then remove the TXT record (it is only needed during issuance). Collect:

| File | `acme.sh` name | What it is |
| --- | --- | --- |
| `private.key` | `<domain>.key` | The private key |
| `certificate.crt` | `<domain>.cer` | The leaf certificate |
| `ca_bundle.crt` | `ca.cer` | The intermediate chain (recommended) |

Upload them in Runflare:

1. **SSL → select the domain → HTTPS user certificate**.
2. Paste the private key, certificate, and bundle into the matching boxes.
3. Turn off **Runflare free certificate**; only the user certificate should be active.
4. Click **Save** and wait 1–2 minutes.
5. Open `https://your-domain` and check the certificate details. It should be issued to your domain by Let's Encrypt (or your CA), not `TRAEFIK DEFAULT CERT`.

> **Renewal:** Let's Encrypt certificates are valid for 90 days. Renew about 30 days before expiry and upload the new files. The TXT value changes on every renewal. Let's Encrypt allows 50 certificates per domain per 7 days, so normal renewals are well within the limit.

> **Runflare caveat:** A custom certificate can work and then revert to `CN=TRAEFIK DEFAULT CERT` after the ingress restarts. If the tunnel stops working, open the SSL page, confirm only the user certificate is selected, paste the files again, and save. If it keeps reverting, open a Runflare ticket. The SOCKS5 NodePort is not affected.

> **Checking the certificate:** click the padlock in the browser and open the certificate details. The subject should be your panel domain, and the issuer should be a public CA such as Let's Encrypt. `TRAEFIK DEFAULT CERT` or `cert-manager.local` means the domain is not using a trusted certificate.

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


> Use the **5-digit remote port**, not `8000`, for SOCKS5. The panel domain is for the web UI and the optional 443 tunnel; it is not a SOCKS5 endpoint. The 443 tunnel does not use this NodePort.




---

## 7. Open the Panel and Copy a Share Link

1. Open the panel over **HTTPS**: `https://your-domain` (not `http://`, and not the NodePort). The padlock must be valid; if it is not, see [Enable HTTPS for the 443 Tunnel](#enable-https-for-the-443-tunnel).
2. Sign in with **`ADMIN_PASSWORD`**.
3. Confirm that the panel says **Relay is live**.
4. Under **Access**, click **Reveal current password** if you need the raw credentials for manual client setup.
5. The **v2rayN share link** box shows `socks://...@host:port#runflare` when `PUBLIC_SOCKS_ENDPOINT` is set. Click **Copy** for the direct SOCKS5 path.
6. The **v2rayN 443 tunnel** box shows a `vless://...@host:443...` link when the panel is open over HTTPS. Click **Copy** if your ISP throttles the SOCKS5 NodePort.

> The 443 tunnel is **VLESS over WebSocket/TLS**, not SOCKS5. Import its link as a separate server in v2rayN. It uses the panel domain and the `/ws` path. If the card says `ws://`, the panel is being opened over HTTP; use `https://` and a permanent domain. If the link shows `:443` but v2rayN returns `-1` on the real-delay test, the domain's certificate is not trusted — see [Enable HTTPS for the 443 Tunnel](#enable-https-for-the-443-tunnel).

---

## 8. Connect Through the Proxy

### Option A: v2rayN (GUI)

The panel can generate two different links. Use the one that matches your network:

| Link | Protocol | Endpoint | When to use it |
| --- | --- | --- | --- |
| **v2rayN share link** | SOCKS5 | NodePort `host:5-digit-port` | Direct path; simplest setup |
| **v2rayN 443 tunnel** | VLESS + WebSocket + TLS | Panel domain on port `443` | When the SOCKS5 NodePort is throttled |

Import the link directly:

1. Open the panel and click **Copy** next to the link you want.
2. In v2rayN, choose **Servers → Import Share Links from Clipboard** (`Ctrl+V`).
3. Select the imported server in the list: `runflare` for SOCKS5, or `runflare-443` for the tunnel.
4. Click **Enable Tun** (run v2rayN as Administrator if prompted).
5. Open **Routing Setting** and add rules for the traffic you want to send through the relay. Set the outbound to the imported server, and add a final catch-all `direct` rule for everything else.

> The share link is a password. Anyone who has it can use the relay. If you prefer manual entry for the direct path, use **Servers → Add [SOCKS]** and fill in the host, 5-digit port, username, and password from the panel. Do not add the 443 tunnel as SOCKS5; it must be imported as VLESS.

> v2rayN's TUN mode captures all system traffic. Configure the routing rules so only the traffic you want uses the relay.

> If the 443 tunnel connects but pages do not load, turn off **Mux** for the `runflare-443` server. This relay handles one TCP stream per WebSocket; VLESS multiplexing is not implemented.

> **Sing-box users:** [`client/sing-box.vless.example.json`](client/sing-box.vless.example.json) contains the same 443 tunnel as a VLESS/WebSocket/TLS outbound. Replace `PANEL_DOMAIN` and `VLESS_UUID` with the values from the panel.

---

### How the 443 tunnel works

The panel domain's HTTPS ingress forwards WebSocket upgrades to the container on port `3000`. The container speaks VLESS over WebSocket and relays TCP. Because the client connects to the domain on port `443` with TLS, the traffic uses the same port as normal HTTPS instead of the random NodePort. The ingress terminates TLS, so the certificate must be valid for the panel domain; a self-signed certificate breaks the tunnel even if the panel itself loads after a warning. The SOCKS5 listener on `8000` remains unchanged.

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
- **The temporary domain expired.** Create another one from the **Domain** column (3 per 24 hours). The SOCKS relay keeps working without the panel. The 443 tunnel stops with the domain; use a permanent HTTPS domain for it.
- **The domain returns 503 "Application Starting", or the SOCKS port closes immediately.** The container is stopped or still booting. Start the service in Runflare and wait; the 503 page reloads itself. If it stays down, check the service logs.
- **`curl` says the user was rejected.** The username or password is wrong. Use **Reveal current password** in the panel. Changes apply to new connections.
- **`curl` cannot connect.** Confirm the NodePort is `Port 80 → Target 8000`, the service is running, and you are using the **Remote Access** `host:5-digit-port`, not port `8000`.
- **The 443 tunnel link starts with `ws://`.** The tunnel needs HTTPS. Open the panel over `https://` with a permanent domain; a temporary Runflare domain may not provide TLS. If the site is HTTPS but the link is still `ws://`, the ingress is not sending `X-Forwarded-Proto: https`; set `PUBLIC_VLESS_ENDPOINT=https://your-domain:443` and redeploy.
- **The 443 tunnel link contains an internal hostname, `localhost`, or the wrong port.** The ingress rewrote the `Host` header. Set `PUBLIC_VLESS_ENDPOINT=https://your-domain:443` explicitly and redeploy; the panel will use that value for the tunnel link.
- **The 443 tunnel link does not connect.** Confirm the domain opens the panel over HTTPS, the ClusterIP target is `3000`, and the domain/ingress forwards WebSocket upgrades for `/ws`. The tunnel is VLESS, not SOCKS5; import the `vless://` link, not the `socks://` link. If the ingress cannot upgrade WebSocket, the tunnel cannot work on that service. If the panel opens over HTTPS but v2rayN shows `-1`, check the certificate first.
- **The browser says the panel is "Not secure", or v2rayN shows `-1` on the real-delay test.** The ingress is serving a certificate that clients do not trust. Open the certificate details; if the subject is `TRAEFIK DEFAULT CERT` or the issuer is `cert-manager.local`, the domain is not using a public certificate. Follow [Enable HTTPS for the 443 Tunnel](#enable-https-for-the-443-tunnel).
- **The 443 tunnel worked for a few minutes and then stopped.** The ingress restarted and reverted to its default certificate. Re-save the user certificate in Runflare SSL, then reload the panel. If it keeps happening, contact Runflare support; the SOCKS5 NodePort keeps working.
- **The panel works intermittently, or v2rayN sometimes shows `-1`.** If the domain has more than one A record, the ingress replicas can disagree about the certificate or the domain route. Test each IP:
  ```bash
  curl -I --resolve your-domain:443:INGRESS_IP https://your-domain
  ```
  A healthy IP returns the panel (usually `303` to `/login`) without a certificate error. If one IP returns `404`, a certificate error, or `TRAEFIK DEFAULT CERT`, remove that A record or ask Runflare to fix the ingress.
- **ZeroSSL refuses the domain.** ZeroSSL blocks `.ir` and some other sanctioned ccTLDs. Use Let's Encrypt instead; it issues for ordinary `.ir` domains.
- **The certificate expired.** Let's Encrypt certificates last 90 days. Renew about 30 days before expiry and upload the new files. The `_acme-challenge` TXT value changes on every renewal.
- **The 443 tunnel is also slow.** If the direct SOCKS5 NodePort is throttled but the 443 tunnel is slow too, the limit is likely the Runflare ingress/plan or the upstream route, not the ISP's high-port shaping. Compare it with the Route test and contact Runflare support or upgrade.
- **The 443 tunnel link changed after changing `ADMIN_PASSWORD`.** Set a fixed `VLESS_UUID` environment variable and redeploy. The link is derived from the admin password when `VLESS_UUID` is empty.
- **Traffic is not going through the relay.** Confirm the client is using the NodePort `host:port` or the imported 443 tunnel, the relay is live, and the app or system proxy is actually pointed at it. In v2rayN, check that the active routing rule selects the imported server. If you use TUN mode, run v2rayN as Administrator and check **Active connections** in the panel.
- **The Route test shows 502 or HTTP 403.** Cloudflare is rejecting the container's test download. This is not the proxy failing. Try `https://speed.hetzner.de/100MB.bin` in the Route test, or ignore it.
- **The password contains URL characters.** Use curl's `--proxy-user "USER:PASS"` instead of putting the password inside the proxy URL. Quote the value in your shell.
- **The NodePort changed after a redeploy.** Update `PUBLIC_SOCKS_ENDPOINT` and the client config with the new `host:port`. The 443 tunnel does not depend on the NodePort; it depends on the panel domain.

---

## Limits & Notes

- **No caching.** Every byte crosses the container twice: client → container, then container → destination. A 100 GB transfer moves roughly 200 GB through Runflare. Check Runflare's bandwidth quotas and pricing before large transfers.
- **TCP only.** Both the SOCKS5 path and the 443 tunnel forward TCP. UDP-based traffic, including some voice, streaming, and QUIC flows, is not supported and may fail while routed.
- **The 443 tunnel depends on the panel domain and its certificate.** It uses the domain's HTTPS certificate and WebSocket support. A self-signed or internal certificate (`TRAEFIK DEFAULT CERT`, `cert-manager.local`) breaks the tunnel even if the panel loads after a warning. A temporary domain expires after 1 hour; use a permanent domain for the tunnel. The SOCKS5 NodePort does not depend on the panel domain.
- **Certificates expire.** Let's Encrypt certificates last 90 days. Renew about 30 days before expiry and upload the new files. Runflare can revert a custom certificate after an ingress restart; re-save it if the tunnel stops.
- **In-memory state.** Panel changes, counters, and active sessions reset when the container restarts.
- **Security.** The SOCKS port is public but requires a username and password. The 443 tunnel is public but requires the VLESS UUID; treat the `vless://` link like a password. Use a strong `ADMIN_PASSWORD` and a fixed `VLESS_UUID`. The panel is protected by `ADMIN_PASSWORD`; use HTTPS for the domain. A temporary domain may be HTTP-only, so avoid entering the admin password on an untrusted network.
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

Open <http://127.0.0.1:3000>. The panel will show a local `ws://127.0.0.1:3000/ws` tunnel link; for a real 443 test, put the app behind an HTTPS domain or a local TLS terminator. To build the image:

```powershell
docker build -t relay-control .
docker run --rm -p 3000:3000 -p 8000:8000 `
  -e ADMIN_PASSWORD=testpass123 `
  -e PROXY_USER=relay `
  -e PROXY_PASS=testpass123 `
  relay-control
```

The Dockerfile uses `node:22-alpine` and does not run `npm install`.
