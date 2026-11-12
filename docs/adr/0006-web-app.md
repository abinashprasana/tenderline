# ADR 0006: The web app

**Status:** accepted

## Context
The backend was built API-first with no frontend. Bid managers now need a screen they can work in all day: deciding the agent's proposals, moving opportunities through the pipeline and watching deadlines. There is also a public landing page that has to explain the product in a few seconds.

## Decision
**A Vite + React single-page app in `frontend/`, served by Caddy on the same origin as the API.**
- Same origin in every environment: Caddy serves the build and proxies `/v1`, `/healthz`, `/readyz` and `/docs` to the API (`frontend/caddy/tenderline.caddy`); Vite does the same in development. There is no CORS configuration, and the GitHub OAuth state cookie (path `/v1/auth/github`) keeps working.
- OAuth: GitHub redirects to the app route `/auth/callback`, which exchanges the code with `/v1/auth/github/callback` once. `GITHUB_REDIRECT_URI` points at that route.
- The token is held in memory and `sessionStorage` (closing the tab signs you out). It is renewed five minutes before it expires through `POST /v1/auth/refresh`, up to 12 hours after sign-in. The Content-Security-Policy allows only the app's own scripts (`script-src 'self'`), which is what protects the token from injected code. A cookie session would need CSRF protection on every write; it can be added later without changing the API's bearer model.
- The client is generated from `docs/openapi.json` (`openapi-typescript` + `openapi-fetch`); CI fails if the generated types or the action payload schemas (`tenderline action-schemas`) drift from the backend. Every create or execute request carries an `Idempotency-Key` that stays the same across retries of one submission; 429 waits for `Retry-After`; 401 returns to sign-in.
- Nothing is optimistic where the server decides: approvals show "running" until the action has executed, and a refused pipeline move slides the card back.
- Endpoints added for the app: `GET /v1/organisations`, `GET /v1/organisations/{id}/summary`, `GET /v1/cpv-codes`, `POST /v1/auth/refresh`, notice sorting, `allowed_transitions` and list counts on opportunities, and the notice title and agent assessment on proposals.

**CPV labels.** TED notices carry codes without names. The official CPV 2008 list (Regulation (EC) No 213/2008) is published by the Publications Office of the EU on TED (https://ted.europa.eu/en/simap/cpv, "XML" download). `data/cpv/cpv_2008_en.csv` holds its 9,454 codes with English labels, extracted with `tenderline cpv-load cpv_2008.xml --write-csv data/cpv/cpv_2008_en.csv`; `tenderline migrate` loads it when the table has no labels.

**Design system.** Dark first, with a separately tuned light theme ("Atlantic night": deep blue-green ink, one sea-glass accent used only for primary actions, focus and selection, status colours kept apart from the accent). Colours are OKLCH tokens in `src/styles.css`. Accessible primitives come from Radix; the type is Schibsted Grotesk with Geist Mono for numbers, self-hosted.
- Glass (backdrop blur) is used only on chrome: sidebar, top bar, palette, dialogs, toasts, the landing hero card. Dense content sits on solid panels so text keeps its contrast. Glass turns solid without `backdrop-filter`, under `prefers-reduced-transparency`, under `prefers-contrast: more`, and with the "Reduce transparency" switch.
- Motion has four durations (120, 200, 320, 560 ms) on an ease-out curve, springs only for dragging, and `MotionConfig reducedMotion="user"`. The landing page's WebGL aurora runs at up to 30 fps with a pixel ratio of at most 1.5, pauses when hidden or off screen, and draws one still frame under reduced motion.
- Route changes fade the content area with Motion. The router's View Transitions option was tried and dropped: in testing it left the router pending on first load.

## Verification
- Vitest: the fetch wrapper (token, 429 retry with the same key and body, 401, 204, network errors), error text, formatting of decimal strings, payload validation against the exported schemas, role gating, safe return paths.
- Playwright against the running stack: sign up, saved search, proposals arriving, approve, edit then approve, reject, a proposal someone else already decided (409), allowed and refused pipeline moves, reminders on the timeline, the audit trail, axe (WCAG 2.1 AA, no serious or critical findings) on every screen in both themes, reduced motion and reduced transparency.
- Budget on the production build (`e2e/performance.spec.ts`): LCP under 2.5 s, CLS under 0.1, initial JavaScript under 250 KB compressed. Measured locally: LCP 0.7 s, CLS 0, 236 KB.

## Consequences
One extra image (`tenderline-web`) and one more service in each compose file. The landing page's product screenshot is a real capture (`CAPTURE=1 npx playwright test capture`); it must be recaptured when the approvals screen changes.
