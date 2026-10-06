#!/usr/bin/env bash
# Creates the permanent Android signing key. Run this ONCE, on your own computer (needs Java's keytool).
# The key must never be committed to the repository and must never be lost: without it the
# installed app can no longer be updated, only uninstalled and reinstalled.
set -euo pipefail

OUT="${1:-goldvar-release.jks}"
ALIAS="goldvar"

[ -e "$OUT" ] && { echo "$OUT already exists. Refusing to overwrite it."; exit 1; }
read -r -s -p "Choose a password for the key (min 8 chars, write it down): " PASS; echo
[ "${#PASS}" -ge 8 ] || { echo "Password too short."; exit 1; }

keytool -genkeypair -v -keystore "$OUT" -alias "$ALIAS" -keyalg RSA -keysize 4096 \
  -validity 36500 -storepass "$PASS" -keypass "$PASS" \
  -dname "CN=Gold Var Sensor Hub, O=Nexus Tech, C=GH"

B64="$OUT.base64.txt"
base64 -w0 "$OUT" 2>/dev/null > "$B64" || base64 "$OUT" | tr -d '\n' > "$B64"

cat <<MSG

Done. Now:
 1. BACK UP $OUT and the password somewhere safe and private (password manager + offline copy).
 2. In GitHub: Settings -> Secrets and variables -> Actions -> New repository secret. Add three:
      ANDROID_KEYSTORE_BASE64   = the entire contents of $B64
      ANDROID_KEYSTORE_PASSWORD = the password you just typed
      ANDROID_KEY_ALIAS         = $ALIAS
 3. Delete $B64 afterwards (keep the .jks backup). Never commit either file.
MSG
