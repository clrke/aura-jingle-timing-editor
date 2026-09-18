# Aura Primera Jingle — Timing Editor

A small React app for adjusting the line-by-line lyric timings of the Aura Primera Villa
jingle. Drag lyric blocks on the waveform to move them, drag the edges to resize, or type
exact start/end seconds per line. Loop a selected line while it plays to audition a tweak
live. When you're happy, hit **Export timings** — it copies the updated JSON to your
clipboard so you can paste it back.

Live: https://clrke.github.io/aura-jingle-timing-editor/

## Develop

```
npm install
npm run dev
```

## Build & deploy to GitHub Pages

```
npm run build
npm run deploy
```
