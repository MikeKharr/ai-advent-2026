#!/usr/bin/env bash
# Первичная настройка свежего Ubuntu 24.04 на Vultr. Запускать от root ОДИН раз.
# Идемпотентен: повторный запуск ничего не ломает.
#
#   ssh root@<IP> 'bash -s' < deploy/bootstrap.sh
#
# Что делает: пользователь без root, жёсткий SSH, файрвол, fail2ban,
# автообновления безопасности, Docker, клон репозитория.

set -euo pipefail

APP_USER="${APP_USER:-advent}"
REPO="${REPO:-https://github.com/MikeKharr/ai-advent-2026.git}"
APP_DIR="/home/${APP_USER}/ai-advent-2026"

log() { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { echo "Запускать от root"; exit 1; }

log "Обновление пакетов"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get upgrade -y -qq

log "Пакеты: ufw, fail2ban, автообновления, git, ca-certificates"
apt-get install -y -qq ufw fail2ban unattended-upgrades git ca-certificates curl gnupg

log "Пользователь ${APP_USER}"
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "$APP_USER"
  usermod -aG sudo "$APP_USER"
fi
# Перенос authorized_keys от root — иначе после запрета root-логина вход потеряется.
install -d -m 700 -o "$APP_USER" -g "$APP_USER" "/home/${APP_USER}/.ssh"
if [ -f /root/.ssh/authorized_keys ]; then
  install -m 600 -o "$APP_USER" -g "$APP_USER" /root/.ssh/authorized_keys "/home/${APP_USER}/.ssh/authorized_keys"
fi
[ -s "/home/${APP_USER}/.ssh/authorized_keys" ] || {
  echo "ОСТАНОВ: у ${APP_USER} нет authorized_keys. Запрет root-логина отрезал бы доступ."
  echo "Добавьте публичный ключ в /root/.ssh/authorized_keys и запустите скрипт заново."
  exit 1
}

log "Жёсткий SSH: только ключи, без root"
cat > /etc/ssh/sshd_config.d/99-hardening.conf <<'EOF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
X11Forwarding no
MaxAuthTries 3
EOF
sshd -t && systemctl restart ssh

log "Файрвол: 22, 80, 443 и больше ничего"
ufw --force reset >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow 22/tcp >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable

log "fail2ban на SSH"
cat > /etc/fail2ban/jail.local <<'EOF'
[sshd]
enabled = true
maxretry = 5
bantime = 1h
findtime = 10m
EOF
systemctl enable --now fail2ban
systemctl restart fail2ban

log "Автообновления безопасности"
dpkg-reconfigure -f noninteractive unattended-upgrades

log "Docker"
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
usermod -aG docker "$APP_USER"
systemctl enable --now docker

log "Клон репозитория"
if [ ! -d "$APP_DIR/.git" ]; then
  sudo -u "$APP_USER" git clone --depth 50 "$REPO" "$APP_DIR"
else
  sudo -u "$APP_USER" git -C "$APP_DIR" pull --ff-only
fi

log "Файлы окружения"
sudo -u "$APP_USER" touch "${APP_DIR}/deploy/.env"
sudo -u "$APP_USER" chmod 600 "${APP_DIR}/deploy/.env"
grep -q '^DAY1_TAG=' "${APP_DIR}/deploy/.env" || echo 'DAY1_TAG=latest' | sudo -u "$APP_USER" tee -a "${APP_DIR}/deploy/.env" >/dev/null

cat <<EOF

────────────────────────────────────────────────────────
Готово. Осталось сделать вручную:

1. Секреты приложения (ключ Anthropic и лимиты):
     sudo -u ${APP_USER} nano ${APP_DIR}/deploy/day1.env
     sudo -u ${APP_USER} chmod 600 ${APP_DIR}/deploy/day1.env

2. A-запись challenge.zpq.ai → $(curl -s -4 ifconfig.me 2>/dev/null || echo '<IP этого сервера>')
   Дождаться, пока dig +short challenge.zpq.ai отдаёт этот адрес.
   Caddy выпустит сертификат сам, только когда DNS уже резолвится.

3. Первый запуск:
     cd ${APP_DIR}/deploy && docker compose up -d

4. Проверка:
     curl -I https://challenge.zpq.ai/day1/

Дальнейшие деплои идут через GitHub Actions при мерже в main.
────────────────────────────────────────────────────────
EOF
