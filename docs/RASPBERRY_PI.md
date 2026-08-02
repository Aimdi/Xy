# Run Xy on a Raspberry Pi

Xy can run as a tiny local HTTP server that starts on boot via systemd.

## One-time install

SSH into your Pi, then:

```bash
curl -fsSL https://raw.githubusercontent.com/Aimdi/Xy/main/deploy/install-pi.sh | bash
```

Or if you already cloned it:

```bash
cd ~/Xy
bash deploy/install-pi.sh
```

This will:

1. Install Node.js (if needed) + curl/git
2. Clone/update `~/Xy`
3. `npm install`
4. Enable `xy-threads@<your-user>.service` on boot
5. Start the server on `http://127.0.0.1:8787`

## Use it

On the Pi:

```bash
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/profile/zuck
curl http://127.0.0.1:8787/user-id/zuck
curl http://127.0.0.1:8787/post-id/CuZsgfWLyiI
```

## Service commands

```bash
sudo systemctl status xy-threads@$USER
sudo systemctl restart xy-threads@$USER
sudo systemctl stop xy-threads@$USER
sudo journalctl -u xy-threads@$USER -f
```

## Config

Edit `~/Xy/.env` if needed:

```env
XY_HOST=127.0.0.1
XY_PORT=8787
XY_VERBOSE=0

# Optional authenticated endpoints later:
# THREADS_USERNAME=
# THREADS_PASSWORD=
# THREADS_DEVICE_ID=android-yourdeviceid
```

Then restart:

```bash
sudo systemctl restart xy-threads@$USER
```

### Expose on your LAN (optional)

By default it only listens on localhost (safer).

To reach it from your phone/laptop on the same Wi‑Fi:

1. Set in `~/Xy/.env`:

```env
XY_HOST=0.0.0.0
XY_PORT=8787
```

2. Restart the service
3. Call `http://<pi-ip>:8787/profile/zuck`

Find the Pi IP:

```bash
hostname -I
```

> Only do this on a trusted home network. There is no auth on this tiny server.

## Manual run (without systemd)

```bash
cd ~/Xy
npm run server
```

## Troubleshooting: `Failed to fetch web profile`

### 1. Pull the latest fix

```bash
cd ~/Xy
git pull
npm install
sudo systemctl restart xy-threads@$USER
curl http://127.0.0.1:8787/profile/zuck
```

### 2. Check curl has HTTP/2

Meta returns **empty HTTP 429** when the request is HTTP/1.1:

```bash
curl -V | grep -i HTTP2
# should mention HTTP2 / nghttp2

# This should fail (proves the issue):
curl --http1.1 -s -o /dev/null -w '%{http_code}\n' \
  -H 'x-ig-app-id: 238260118697367' \
  'https://www.threads.net/api/v1/users/web_profile_info/?username=zuck'
# → 429

# This should work:
curl --http2 -s \
  -H 'x-ig-app-id: 238260118697367' \
  'https://www.threads.net/api/v1/users/web_profile_info/?username=zuck' | head -c 80
```

If HTTP/2 is missing:

```bash
sudo apt-get update
sudo apt-get install -y curl
```

### 3. Inspect server diagnostics

```bash
curl http://127.0.0.1:8787/debug/ping
sudo journalctl -u xy-threads@$USER -n 50 --no-pager
```

## Uninstall

```bash
sudo systemctl disable --now xy-threads@$USER
sudo rm /etc/systemd/system/xy-threads@.service
sudo systemctl daemon-reload
# optional: rm -rf ~/Xy
```
