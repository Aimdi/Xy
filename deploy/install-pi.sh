#!/usr/bin/env bash
# Install Xy Threads API as a systemd service on Raspberry Pi.
# Run as your normal user (not root), from anywhere:
#
#   curl -fsSL https://raw.githubusercontent.com/Aimdi/Xy/main/deploy/install-pi.sh | bash
#   # or, after cloning:
#   bash deploy/install-pi.sh
set -euo pipefail

REPO_URL="${XY_REPO_URL:-https://github.com/Aimdi/Xy.git}"
INSTALL_DIR="${XY_INSTALL_DIR:-$HOME/Xy}"
SERVICE_USER="${USER}"
NODE_MAJOR="${XY_NODE_MAJOR:-22}"

echo "==> Xy Raspberry Pi installer"
echo "    user:  ${SERVICE_USER}"
echo "    dir:   ${INSTALL_DIR}"

need_cmd() {
  command -v "$1" >/dev/null 2>&1
}

if ! need_cmd git; then
  echo "==> Installing git"
  sudo apt-get update
  sudo apt-get install -y git
fi

if ! need_cmd curl; then
  echo "==> Installing curl"
  sudo apt-get update
  sudo apt-get install -y curl
fi

if ! need_cmd node || ! need_cmd npm; then
  echo "==> Installing Node.js ${NODE_MAJOR}.x"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
  sudo apt-get install -y nodejs
fi

echo "==> Node $(node -v) / npm $(npm -v)"

if [[ -d "${INSTALL_DIR}/.git" ]]; then
  echo "==> Updating existing clone at ${INSTALL_DIR}"
  git -C "${INSTALL_DIR}" pull --ff-only || true
else
  echo "==> Cloning into ${INSTALL_DIR}"
  git clone "${REPO_URL}" "${INSTALL_DIR}"
fi

cd "${INSTALL_DIR}"
echo "==> npm install"
npm install

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "==> Created .env from .env.example (edit if you need login)"
fi

# Resolve npm absolute path for systemd
NPM_BIN="$(command -v npm)"
NODE_BIN="$(command -v node)"
echo "==> npm at ${NPM_BIN}"
echo "==> node at ${NODE_BIN}"

SERVICE_NAME="xy-threads@${SERVICE_USER}.service"
UNIT_SRC="${INSTALL_DIR}/deploy/xy-threads@.service"
UNIT_DST="/etc/systemd/system/xy-threads@.service"

echo "==> Installing systemd unit"
# Rewrite ExecStart to the absolute npm path found on this Pi
TMP_UNIT="$(mktemp)"
sed "s|/usr/bin/npm|${NPM_BIN}|g" "${UNIT_SRC}" > "${TMP_UNIT}"
sudo cp "${TMP_UNIT}" "${UNIT_DST}"
rm -f "${TMP_UNIT}"

sudo systemctl daemon-reload
sudo systemctl enable --now "${SERVICE_NAME}"

echo
echo "==> Done. Service status:"
systemctl --no-pager --full status "${SERVICE_NAME}" || true

echo
echo "Useful commands:"
echo "  sudo systemctl status ${SERVICE_NAME}"
echo "  sudo systemctl restart ${SERVICE_NAME}"
echo "  sudo journalctl -u ${SERVICE_NAME} -f"
echo "  curl http://127.0.0.1:8787/health"
echo "  curl http://127.0.0.1:8787/profile/zuck"
echo
echo "Installed at: ${INSTALL_DIR}"
