#!/bin/zsh
set -euo pipefail

IDENTITY_NAME="${SNACK_RECORD_SIGNING_IDENTITY_NAME:-Snack Record Local Code Signing}"
SIGNING_DIR="${SNACK_RECORD_SIGNING_DIR:-$HOME/Library/Application Support/Snack Record/Signing}"
KEYCHAIN_PATH="$SIGNING_DIR/snack-record.keychain-db"
PASSWORD_FILE="$SIGNING_DIR/keychain-password"

find_identity() {
  local lines match
  lines="$(security find-identity -v -p codesigning 2>/dev/null || true)"
  match="$(print -r -- "$lines" | /usr/bin/grep -F "\"$IDENTITY_NAME\"" || true)"
  if [[ -n "$match" ]]; then
    print -r -- "$match" | /usr/bin/awk 'NR == 1 { print $2 }'
  fi
}

add_keychain_to_search_list() {
  local listed
  local -a keychains
  listed="$(security list-keychains -d user | /usr/bin/sed -e 's/^[[:space:]]*"//' -e 's/"[[:space:]]*$//')"
  if print -r -- "$listed" | /usr/bin/grep -Fx "$KEYCHAIN_PATH" >/dev/null; then
    return
  fi
  keychains=("${(@f)listed}")
  security list-keychains -d user -s "${keychains[@]}" "$KEYCHAIN_PATH"
}

unlock_managed_keychain_if_present() {
  if [[ ! -f "$KEYCHAIN_PATH" ]]; then
    return
  fi
  if [[ ! -f "$PASSWORD_FILE" ]]; then
    print -u2 "Snack Record signing keychain exists but its password file is missing: $PASSWORD_FILE"
    exit 1
  fi
  local password
  password="$(<"$PASSWORD_FILE")"
  security unlock-keychain -p "$password" "$KEYCHAIN_PATH"
  add_keychain_to_search_list
}

unlock_managed_keychain_if_present

identity="$(find_identity)"
if [[ -n "$identity" ]]; then
  print -r -- "$identity"
  exit 0
fi

OPENSSL_BIN="/usr/bin/openssl"
if [[ ! -x "$OPENSSL_BIN" ]]; then
  OPENSSL_BIN="$(command -v openssl || true)"
fi
[[ -n "$OPENSSL_BIN" ]] || {
  print -u2 "OpenSSL is required to create the local Snack Record signing identity."
  exit 1
}

print -u2 "Creating a stable local code-signing identity for Snack Record..."
umask 077
mkdir -p "$SIGNING_DIR"
chmod 700 "$SIGNING_DIR"

if [[ ! -f "$KEYCHAIN_PATH" ]]; then
  password="$($OPENSSL_BIN rand -hex 24)"
  print -rn -- "$password" > "$PASSWORD_FILE"
  chmod 600 "$PASSWORD_FILE"
  security create-keychain -p "$password" "$KEYCHAIN_PATH"
else
  password="$(<"$PASSWORD_FILE")"
fi

security set-keychain-settings -lut 21600 "$KEYCHAIN_PATH"
security unlock-keychain -p "$password" "$KEYCHAIN_PATH"
add_keychain_to_search_list

temporary_directory="$(mktemp -d -t snack-record-signing)"
trap 'rm -rf "$temporary_directory"' EXIT
certificate="$temporary_directory/snack-record.cer"
private_key="$temporary_directory/snack-record.key"
archive="$temporary_directory/snack-record.p12"
archive_password="$($OPENSSL_BIN rand -hex 24)"

$OPENSSL_BIN req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
  -subj "/CN=$IDENTITY_NAME/O=Snack Record Local" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,digitalSignature,keyCertSign" \
  -addext "extendedKeyUsage=codeSigning" \
  -keyout "$private_key" \
  -out "$certificate" >/dev/null 2>&1

$OPENSSL_BIN pkcs12 -export \
  -name "$IDENTITY_NAME" \
  -inkey "$private_key" \
  -in "$certificate" \
  -out "$archive" \
  -passout "pass:$archive_password" >/dev/null 2>&1

security import "$archive" \
  -k "$KEYCHAIN_PATH" \
  -P "$archive_password" \
  -T /usr/bin/codesign \
  -T /usr/bin/security >/dev/null
security set-key-partition-list \
  -S apple-tool:,apple:,codesign: \
  -s -k "$password" "$KEYCHAIN_PATH" >/dev/null
security add-trusted-cert \
  -r trustRoot \
  -p codeSign \
  -k "$KEYCHAIN_PATH" "$certificate"

identity="$(find_identity)"
if [[ -z "$identity" ]]; then
  print -u2 "Unable to create a valid Snack Record signing identity."
  exit 1
fi

print -r -- "$identity"
