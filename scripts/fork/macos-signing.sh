#!/usr/bin/env bash
set -euo pipefail
configured=0
for name in CSC_LINK CSC_KEY_PASSWORD APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER; do
  if [[ -n "${!name:-}" ]]; then configured=$((configured + 1)); fi
done
if [[ "$configured" = 0 ]]; then
  echo 'signed=false' >> "$GITHUB_OUTPUT"
  echo 'macOS artifacts are unsigned; the CLI will receive an ad hoc signature.' >&2
  exit 0
fi
if [[ "$configured" != 5 ]]; then
  echo 'Configure all five macOS signing and notarization secrets, or leave all five unset.' >&2
  exit 1
fi
keychain="$RUNNER_TEMP/t3-signing.keychain-db"
password="$(openssl rand -hex 32)"
printf '::add-mask::%s\n' "$password"
printf '%s' "$CSC_LINK" | base64 -D > "$RUNNER_TEMP/t3-signing.p12"
security create-keychain -p "$password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$password" "$keychain"
security import "$RUNNER_TEMP/t3-signing.p12" -k "$keychain" -P "$CSC_KEY_PASSWORD" -T /usr/bin/codesign
security set-key-partition-list -S apple-tool:,apple: -s -k "$password" "$keychain" >/dev/null
security list-keychains -d user -s "$keychain" "$HOME/Library/Keychains/login.keychain-db"
identity="$(security find-identity -v -p codesigning "$keychain" | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -n 1)"
[[ -n "$identity" ]] || { echo 'No Developer ID Application identity in the certificate.' >&2; exit 1; }
printf '%s' "$APPLE_API_KEY" > "$RUNNER_TEMP/t3-notarization.p8"
chmod 600 "$RUNNER_TEMP/t3-notarization.p8"
{
  echo "APPLE_API_KEY=$RUNNER_TEMP/t3-notarization.p8"
  echo "CSC_KEYCHAIN=$keychain"
  echo "T3CODE_CLI_MAC_SIGN_IDENTITY=$identity"
} >> "$GITHUB_ENV"
if [[ -n "${MACOS_PROVISIONING_PROFILE:-}" ]]; then
  [[ -n "${APPLE_TEAM_ID:-}" && -n "${CLERK_PASSKEY_RP_DOMAINS:-}" ]] || { echo 'Provisioning requires the fork Apple team and passkey domains.' >&2; exit 1; }
  printf '%s' "$MACOS_PROVISIONING_PROFILE" | base64 -D > "$RUNNER_TEMP/t3.provisionprofile"
  {
    echo "T3CODE_MACOS_PROVISIONING_PROFILE=$RUNNER_TEMP/t3.provisionprofile"
    echo "T3CODE_APPLE_TEAM_ID=$APPLE_TEAM_ID"
    echo "T3CODE_CLERK_PASSKEY_RP_DOMAINS=$CLERK_PASSKEY_RP_DOMAINS"
  } >> "$GITHUB_ENV"
fi
echo 'signed=true' >> "$GITHUB_OUTPUT"
