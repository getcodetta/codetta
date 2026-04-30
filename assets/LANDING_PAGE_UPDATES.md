# Landing page (codetta.dev) updates to apply

These changes belong in the **separate** `getcodetta/codetta.dev` repo, not
this one. Apply them via the GitHub web editor or pull the repo locally.

## 1. Add the OG image asset

Convert `assets/og-image.svg` (in this repo) to a 1200×630 PNG:

```bash
# If you have ImageMagick installed
magick assets/og-image.svg -resize 1200x630 og-image.png

# Or use https://cloudconvert.com/svg-to-png
# Or a one-off script:  npx svg2png-cli og-image.svg --width 1200 --height 630
```

Upload the resulting `og-image.png` to the `getcodetta/codetta.dev` repo at
`/og-image.png` (root of the repo).

## 2. Add OG / Twitter / favicon meta tags to `index.html`

In the `<head>` section of the landing repo's `index.html`, replace the
existing `og:*` and `twitter:*` lines with this block:

```html
<!-- Open Graph (Facebook, LinkedIn, Slack, Discord, etc.) -->
<meta property="og:title" content="Codetta — A lightweight code editor with first-class AI" />
<meta property="og:description" content="Bring your own model — Anthropic, OpenAI, Ollama, or Claude Code. Free, open source, ~30 MB native." />
<meta property="og:url" content="https://codetta.dev" />
<meta property="og:type" content="website" />
<meta property="og:image" content="https://codetta.dev/og-image.png" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:image:alt" content="Codetta — the lightweight code editor with first-class AI" />

<!-- Twitter / X large card -->
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="Codetta" />
<meta name="twitter:description" content="A lightweight desktop code editor with first-class AI. BYOK — Anthropic, OpenAI, Ollama, or Claude Code." />
<meta name="twitter:image" content="https://codetta.dev/og-image.png" />

<!-- Favicon (matches landing brand) -->
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='18' fill='%230f1115'/%3E%3Ctext x='50' y='72' font-size='62' text-anchor='middle' fill='%236ea8ff' font-family='system-ui, -apple-system, sans-serif' font-weight='600'%3E%E2%8C%98%3C/text%3E%3C/svg%3E" />
```

## 3. Verify

After committing + pushing to the landing repo, GitHub Pages redeploys
in ~1 minute. Then test the preview cards:

- **Twitter / X**: https://cards-dev.twitter.com/validator
- **Facebook / LinkedIn / Slack**: https://www.opengraph.xyz/url/https%3A%2F%2Fcodetta.dev
- **Generic**: https://www.opengraphcheck.com/result.php?url=https%3A%2F%2Fcodetta.dev

If any cache the old preview, use Twitter's "Card validator" or Facebook's
"Sharing Debugger" to force a re-scrape.
