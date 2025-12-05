# opkg login – Device Authorization Flow (RFC 8628)

## Goals
- Add `opkg login [--profile <name>]` using OAuth 2.0 Device Authorization Grant.
- Store bearer tokens per profile; keep API-key auth backward compatible.

## Command behavior
- Syntax: `opkg login [--profile <name>]`
- Profile: optional; defaults to `default`.
- Flow:
  1) Start device authorization → get `device_code`, `user_code`, `verification_uri`, `verification_uri_complete`, `expires_in`, `interval`.
  2) Print code/URL; attempt to open browser to `verification_uri_complete`.
  3) Poll token endpoint until success/denied/expired/timeout.
  4) On success, persist access/refresh tokens to the selected profile.
  5) On failure, show actionable error and exit non-zero.

## HTTP interactions (backend contract)
- POST `/auth/device/authorize` (no auth):
  - Body: `{ clientId: 'opkg-cli', scope?: 'openid', deviceName?: 'opkg-cli' }`
  - Response: `{ device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval }`
- POST `/auth/device/token` (no auth):
  - Body: `{ deviceCode }`
  - Success: `{ access_token, refresh_token, token_type: 'bearer', expires_in }`
  - Error codes (HTTP 400): `authorization_pending`, `slow_down`, `expired_token`, `access_denied`
- POST `/auth/refresh` (no auth) for refresh flow:
  - Body: `{ refreshToken }`
  - Success: `{ accessToken, refreshToken }`

## CLI storage & auth selection
- Extend `ProfileCredentials` to include `access_token`, `refresh_token`, `expires_at`, `token_type`.
- Credentials persisted in the existing profile credentials INI; preserve existing `api_key`.
- Header selection:
  - Prefer non-expired access token → `Authorization: Bearer <token>`.
  - If expired and refresh token present → call `/auth/refresh`, persist new pair.
  - Fallback: `X-API-Key` if present.
  - If none: instruct user to run `opkg login` or configure API key.

## UX requirements
- Print user code and verification URL.
- Open browser best-effort; if it fails, user can manually visit the URL.
- Poll respecting `interval`; on `slow_down` add +5s each time.
- Time out when `expires_in` elapses; show “code expired, rerun opkg login.”
- Errors:
  - `access_denied`: “Access denied. Please restart opkg login.”
  - `expired_token`: “Code expired. Please rerun opkg login.”

## Persistence details
- `expires_at` derived from `Date.now() + expires_in*1000` or JWT `exp`.
- When refreshing, keep existing `api_key` intact in the profile record.

## Edge cases & fallbacks
- If profile missing: create credentials entry when saving tokens.
- If refresh fails: drop to API key if present; otherwise require login.
- Platform-specific browser open: `open` (mac), `start` (win), `xdg-open` (linux); ignore failures.

## Telemetry/logging (minimal)
- Debug log start/stop of poll, slow_down adjustments, refresh attempts.
- Do not log tokens.

## Non-goals (future)
- Device-name flag, headless/no-browser flag.
- Multi-factor UX in CLI.

