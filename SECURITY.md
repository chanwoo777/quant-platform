# Security policy

## Supported versions

Only the latest code on `main` and the live site at
https://chanwoo777.github.io/quant-platform/ are supported. There are no releases or
older versions to patch.

## Reporting a vulnerability

Please report security problems privately, not in a public issue:

1. Open the repository's **Security** tab and choose **Report a vulnerability**
   (GitHub's private vulnerability reporting).
2. If that button isn't available, open an issue that only asks for a private contact,
   without any details of the problem.

Include what is affected (a page, file or script), how to reproduce it, and what an
attacker could do with it.

This is a personal, non-commercial project maintained in spare time. Reports are
acknowledged within 7 days where possible, and confirmed problems are fixed as soon as
practical. There is no bug bounty.

## Scope

In scope:
- The website in `docs/` (`index.html`, `about.html`, `privacy.html`, `assets/*.js`).
  Examples: script injection through market data, news headlines or the URL, or the
  optional Finnhub key reaching any host other than finnhub.io.
- The Python export, publish and simulation scripts in `quant/web/`, and the GitHub
  Actions workflow in `.github/workflows/`.
- Secrets accidentally committed to the repository.

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
- Dependencies are watched by Dependabot (`.github/dependabot.yml`), and the tests run on
  every push and pull request (`.github/workflows/tests.yml`).
