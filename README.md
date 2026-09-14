# Business Insights Report

Upload any CSV and get an automatic business report: KPIs, trends, category
breakdowns, correlations, and rule-based findings — plus an optional
AI-written narrative. Column types and business roles (currency, quantity,
date, category, identifier) are detected automatically from the data, so
this works with sales data, HR records, operations logs, or anything else
shaped like a spreadsheet.

You can also compare two or more CSVs with the same columns as separate
time periods — useful when data arrives as monthly exports or point-in-time
snapshots rather than one continuously-growing file. See
[Comparing periods](#comparing-periods) below.

Everything runs client-side in the browser. The one exception is the
optional "Generate AI Insights" button, which calls a small server-side
function so your Anthropic API key is never exposed to visitors.

## Comparing periods

On the context screen, choose **Compare Periods** instead of **Single
File**. Upload 2+ CSVs with the exact same set of columns — each one
becomes a period. A period's label is auto-derived from a date column when
one exists (e.g. "Jan 2024"), or from the filename otherwise; you can
rename it before comparing.

Each file goes through the same blank-cell rejection as single-file mode,
individually. Files are also checked against each other: if a later
upload's columns don't match the first period's, it's rejected inline with
the specific column differences shown — no partial/mismatched comparison
is ever produced.

The comparison report has its own 4 tabs (Overview, Trends, Categories,
Findings) with period-over-period deltas. Deltas are shown as plain
directional arrows, not colored green/down-red — whether "up" is good or
bad depends on the metric (revenue vs. cancellations, say), and this tool
doesn't guess. Two sample files (`sample-compare-jan.csv` /
`sample-compare-feb.csv`) are on the upload screen for trying this without
your own data.

## Quick deploy (Vercel)

```
npm install -g vercel   # if you don't already have it
vercel
```

Follow the prompts, then in the Vercel dashboard go to **Project Settings →
Environment Variables** and add `ANTHROPIC_API_KEY` (see
[AI Insights setup](#ai-insights-setup) below). Redeploy after adding it.

Any static host (Netlify, GitHub Pages, S3 + CloudFront, Cloudflare Pages,
etc.) will serve the site itself just fine — `index.html`, `dist/`, and
`samples/` are plain static files. The `/api/ai-insights` function is
written for Vercel's zero-config Node.js runtime specifically; on another
host you'd need to adapt it to that platform's function format (or the
button will just show a friendly "unavailable" message instead of an error,
since the front end already handles that failure gracefully).

## Project structure

```
index.html              Entry point — references the built files in dist/
public/
  favicon.svg            Checked-in favicon asset
  robots.txt             Excludes server endpoints from crawlers
  sitemap.xml            Replace the placeholder hostname before deployment
  vendor/                Local Chart.js and Papa Parse browser bundles
src/
  app.js                Readable source — the whole app, one file
  styles.css             Readable source CSS
dist/
  app.min.js             Built/minified — what index.html actually loads
  styles.min.css          Built/minified
api/
  ai-insights.js          Vercel serverless function — the AI proxy
  health.js               Lightweight deployment health endpoint
samples/
  sample-retail-sales.csv       Small retail dataset — trends and categories
  sample-hr-headcount.csv       Small HR dataset — a different domain
  sample-with-blank-cells.csv   Deliberate blanks — try the data-quality gate
  sample-compare-jan.csv        January comparison fixture
  sample-compare-feb.csv        February comparison fixture
test/
  blackbox.test.js         Smoke checks for build output and secret placeholders
package.json, package-lock.json, vercel.json, .gitignore, .env.example
```

`src/` is what you edit. `dist/` is generated — never hand-edit it.

## Local development

```
npm install
npm run build      # builds dist/ from src/
npm run preview    # serves the folder at localhost — everything works except /api
```

To test the AI Insights feature locally, you need Vercel's dev server
instead, since it's the only thing that runs the `/api` function:

```
cp .env.example .env.local     # then fill in your real key
vercel dev
```

After editing `src/app.js` or `src/styles.css`, run `npm run build` again —
`index.html` loads the built files, not the source files directly.

## AI Insights setup

The button on the Findings tab sends a small aggregated summary (column
names, types, KPI values, top correlations — never your raw file) to
`/api/ai-insights`, which adds your API key server-side and forwards the
request to Anthropic. Without `ANTHROPIC_API_KEY` set, the button still
appears but shows a clear, non-broken message explaining it's not
configured — the rest of the report works normally either way.

For production traffic, also consider adding rate limiting (Vercel's
Firewall rules, or a service like Upstash) and origin checking in
`api/ai-insights.js` — this proxy validates and size-limits requests but
doesn't rate-limit them, so a public deployment could otherwise let anyone
run up your API bill.

## The data-quality gate

If any cell in any column is blank, the file is rejected before any
analysis runs — no partial preview. The rejection screen shows exactly
which columns, how many blank cells, what percentage of rows, and a full
scrollable log of every occurrence by row number, so you can go fix the
source file precisely rather than guessing. `sample-with-blank-cells.csv`
demonstrates this — it has 4 deliberate blanks across 3 columns.

## Tests

```
npm test
```

This runs `test/blackbox.test.js` against the actual built `dist/app.min.js`
— not the source — by simulating real browser events (filling the context
form, uploading files, clicking through tabs) against a minimal fake DOM.
It covers the full happy path, tab switching, clearing/reloading saved
data, and the blank-data rejection flow end to end.

## On code visibility

Worth being direct about: nothing here stops a visitor from opening
DevTools and reading this site's JavaScript. That isn't a limitation of
this project specifically — it's true of every website, because the
browser has to download and run the code to display the page at all.
Tricks like disabling right-click or detecting DevTools don't change that;
they're trivially bypassed and mostly just get in legitimate users' way, so
none of that is included here.

What actually matters is keeping real secrets server-side, which is why
the Anthropic API key lives only in `api/ai-insights.js`'s environment
variable and is never sent to the browser in any form. `dist/app.min.js`
is minified for performance (smaller download, faster parse) via
[Terser](https://terser.org/) — a side effect is that it's harder to
casually read than the source, but that's a byproduct of optimization, not
a security boundary. The `src/` files are the real, readable source, and
that's the honest state of things.
