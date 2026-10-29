# Security policy

## Supported versions

Only the latest code on `main` and the live site at
https://chanwoo777.github.io/quant-platform/ are supported. There are no releases or
older versions to patch.

## Reporting a vulnerability

Please report security problems privately, not in a public issue:

1. Open the repository's **Security** tab and choose **Report a vulnerability**
   (GitHub's private vulnerability reporting, enabled in the repository settings).
2. If that button isn't available, open an issue that only asks for a private contact,
   without any details of the problem.

Include what is affected (a page, file or script), how to reproduce it, and what an
attacker could do with it.

This is a personal, non-commercial project maintained in spare time. What to expect:

- an acknowledgement within 7 days;
- an assessment (confirmed or not, and how serious) within 14 days;
- a fix for confirmed problems as soon as practical, usually within 30 days, and credit in the
  changelog if you want it.

Please give the project a reasonable time to fix a problem before you publish it. There is no bug bounty.

## Scope

In scope:
- The website in `docs/` (`index.html`, `about.html`, `privacy.html`, `assets/*.js`).
  Examples: script injection through market data, news headlines or the URL, or the
  optional Finnhub key reaching any host other than finnhub.io.
- The Python export, publish and simulation scripts in `quant/web/`, and the GitHub
  Actions workflow in `.github/workflows/`.
- Secrets accidentally committed to the repository (CI runs gitleaks over the full history).
- Bypasses of the site's browser protections: the Content-Security-Policy, Subresource Integrity on
  the CDN libraries, the framing guard, URL and import validation, and CSV formula neutralisation.

Out of scope:
- Third-party services the site calls (GitHub Pages, jsDelivr, Binance, CNBC, Finnhub):
  report those to the service.
- The accuracy of market data or model outputs. That isn't a security issue; open a
  normal issue.
- Denial-of-service testing against GitHub Pages.

## How the project handles data

- The website has no server, accounts, cookies, analytics or payments, and never asks
  for a password or card details. Settings are kept in the visitor's browser
  (localStorage). The optional Finnhub API key is stored only there and sent only to
  finnhub.io. See [privacy.html](https://chanwoo777.github.io/quant-platform/privacy.html).
- No API keys or other secrets belong in this repository. Local settings live in `.env`,
  which git ignores; `.env.example` holds placeholders only.
- Python dependencies are pinned in `requirements-lock.txt` (used as constraints in CI), audited with
  `pip-audit` on every push, and watched by Dependabot (`.github/dependabot.yml`), as are the GitHub
  Actions, which are pinned to commit SHAs. The site has no npm dependencies: its two browser libraries
  are exact jsDelivr versions loaded with Subresource Integrity.
- Workflows have read-only permissions and use no secrets. The nightly export runs on the maintainer's
  machine and publishes only the built site (`data/site`) to the `gh-pages` branch: no logs, keys or raw
  API responses.
