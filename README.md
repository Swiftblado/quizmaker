# QuizMaker

Put in a list of vocabulary and drill it. Type the translation from memory, or
pick it from the tiles. One point per word you get right.

**<https://swiftblado.github.io/quizmaker>**

It runs entirely in your browser. No account, no upload, no server — your word
lists are saved in your own browser and go nowhere else. It installs to a phone
home screen and works offline.

## The website

`index.html` is the whole app: one self-contained file with no `<!doctype>`,
`<head>` or `<body>` of its own, because it is also published as a Claude
artifact and that is the shape the artifact host wants.

`build.js` wraps that file into a standalone site in `docs/` — adding the
document scaffolding, the metadata, a generated icon set and social card, a
web manifest and a service worker. GitHub Pages serves `docs/` on the main
branch, so a push is a deploy.

```bash
npm run build      # index.html  ->  docs/
npm run preview    # serve docs/ at http://localhost:8787
```

Edit `index.html`, never `docs/` — everything in there is generated and gets
wiped on the next build.

To move the site to a custom domain, set the `DOMAIN` constant at the top of
`build.js` and rebuild. That one line repoints the canonical URL, the `og:`
tags and the sitemap, and writes the `CNAME` file GitHub Pages reads to claim
the domain; point the domain's DNS at `swiftblado.github.io` and it is done.

## The photo reader (optional, local only)

`server.js` is a separate, older path: it serves the app and exposes `POST
/read`, which sends a photographed vocabulary sheet to the Claude API so the
word pairs can be read off it. That needs your own API key and so it only runs
locally — it is not part of the public website.

```bash
npm install
cp .env.example .env      # then put your real key in it
npm start                 # http://localhost:3000
```
