# Security

## Reporting a vulnerability

Open a private security advisory on the repository, or contact the maintainer
directly if advisories are unavailable. Please do not file a public issue for
credential-handling problems.

## How the DeepSeek API key is handled

- Resolution order: saved profile → pi's `deepseek` credential
  (`<agent-dir>/auth.json` or `DEEPSEEK_API_KEY`) → interactive prompt.
- Keys saved by this package are encrypted with the OS key store:
  - Windows: DPAPI (`CurrentUser`), ciphertext bound to the Windows user and machine
  - macOS: Keychain (`security`)
  - Linux: Secret Service (`secret-tool`)
- Windows encryption/decryption runs in a short-lived PowerShell process. The secret is passed as
  base64 over stdin, so it never appears in argv, the process list, or shell history.
- `credentials.json` stores metadata only (backend, last four characters, timestamps).
- When no OS key store is available, the key is kept in memory for the session and a warning is
  shown. A `0600` plaintext file is written only when `allowPlaintextSecrets` is enabled.
- Decrypted keys are cached in memory for the session and cleared on exit.
- Error messages are built without key material; HTTP errors are surfaced with the API's message
  and an actionable hint.

## What leaves the machine

Only requests to `https://api.deepseek.com` (or the configured `baseUrl`): search queries, page
URLs and the API key in the `Authorization` header. There is no fallback provider, no reader proxy
and no telemetry. The extension performs no analytics and writes no logs.

## Trust

Like any pi extension, this code runs inside the pi process with your user permissions. Install it
from npm (`pi install npm:@thehuan/pi-deepseek-websearch`) or from a checkout you reviewed. Project-local
installs still require project trust.

## Supported versions

Security fixes are issued for the latest published minor version.
