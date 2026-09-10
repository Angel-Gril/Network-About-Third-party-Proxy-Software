#!/bin/sh
set -eu

# This command initializes a new service. Existing identities are never rotated
# implicitly by rerunning installation or by recovering a partial setup.
for existing in \
  /etc/private-subscription/service.env \
  /etc/private-subscription/flybird.json \
  /etc/private-subscription/leapvpn.json \
  /etc/private-subscription/leapvpn-account.json \
  /var/lib/private-subscription/read-tokens/flybird \
  /var/lib/private-subscription/read-tokens/leapvpn \
  /var/lib/private-subscription/state/leapvpn/session.json \
  /etc/nginx/private-subscription.htpasswd
do
  if test -e "$existing" || test -L "$existing"; then
    printf 'Initialization stopped: an existing subscription service file is present. Use the upgrade/backup procedure.\n' >&2
    exit 1
  fi
done

umask 0077
read_token="$(openssl rand -hex 32)"
leap_token="$(openssl rand -hex 32)"
admin_password="$(openssl rand -base64 24 | tr -d '=+/\n' | cut -c1-24)"

install -d -o root -g subsvc -m 0750 /etc/private-subscription
install -d -o subsvc -g subsvc -m 0750 /var/lib/private-subscription
install -d -o subsvc -g subsvc -m 0700 /var/lib/private-subscription/cache
install -d -o subsvc -g subsvc -m 0700 /var/lib/private-subscription/read-tokens
install -d -o subsvc -g subsvc -m 0700 /var/lib/private-subscription/state/leapvpn
{
  printf 'PUBLIC_DOMAIN=sub.example.com\n'
  printf 'LISTEN_HOST=127.0.0.1\n'
  printf 'LISTEN_PORT=3100\n'
  printf 'SUBSCRIPTION_CACHE_DIR=/var/lib/private-subscription/cache\n'
  printf 'SUBSCRIPTION_READ_TOKEN_FILE=/var/lib/private-subscription/read-tokens/flybird\n'
  printf 'LEAPVPN_READ_TOKEN_FILE=/var/lib/private-subscription/read-tokens/leapvpn\n'
  printf 'LEAPVPN_SESSION_FILE=/etc/private-subscription/leapvpn.json\n'
  printf 'LEAPVPN_CREDENTIAL_FILE=/etc/private-subscription/leapvpn-account.json\n'
  printf 'LEAPVPN_AUTH_STATE_FILE=/var/lib/private-subscription/state/leapvpn/session.json\n'
  printf 'LEAPVPN_PYTHON=/opt/private-subscription/providers/leapvpn/venv/bin/python\n'
  printf 'LEAPVPN_EXPORT_SCRIPT=/opt/private-subscription/providers/leapvpn/refresh_leapvpn.py\n'
  printf 'LEAPVPN_MIN_PROXIES=1\n'
  printf 'FLYBIRD_CREDENTIAL_FILE=/etc/private-subscription/flybird.json\n'
  printf 'FLYBIRD_WORKER_MODULE=/opt/private-subscription/providers/flybird/worker.js\n'
  printf 'FLYBIRD_MIN_PROXIES=1\n'
} > /etc/private-subscription/service.env
chown root:subsvc /etc/private-subscription/service.env
chmod 0640 /etc/private-subscription/service.env
printf '%s\n' "$read_token" | install -o subsvc -g subsvc -m 0600 /dev/stdin /var/lib/private-subscription/read-tokens/flybird
printf '%s\n' "$leap_token" | install -o subsvc -g subsvc -m 0600 /dev/stdin /var/lib/private-subscription/read-tokens/leapvpn

printf '%s\n' "$admin_password" | htpasswd -iBc /etc/nginx/private-subscription.htpasswd admin >/dev/null
chown root:www-data /etc/nginx/private-subscription.htpasswd
chmod 0640 /etc/nginx/private-subscription.htpasswd

printf '{"adminUser":"admin","adminPassword":"%s","readToken":"%s","leapvpnReadToken":"%s"}\n' "$admin_password" "$read_token" "$leap_token"
