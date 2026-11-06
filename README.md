# Crimson

**▶ Play: <https://matveyev.github.io/crimson/>**

A tiny Crimsonland-style top-down survival shooter in plain JavaScript + Canvas.
No dependencies, no assets — everything is drawn with canvas primitives and
sounds are synthesized with WebAudio.

## Run

Open `index.html` directly in a browser, or serve the folder:

```bash
python3 -m http.server 8137
# then open http://127.0.0.1:8137
```

## Controls

| Input | Action |
|---|---|
| WASD / arrows | move |
| mouse | aim |
| hold left button | fire |
| P | pause |
| M | mute |
| R | restart (after death) |

## Gameplay

Survive an endless horde for as long as you can and rack up score.

- **Zombie** — slow shambler, dies in 2 hits (10 pts)
- **Spider** — fast and frail, dies in 1 hit (15 pts), appears after ~25 s
- **Brute** — slow tank, takes a full clip (50 pts), appears after ~70 s

It's tuned to be very easy: the player is much faster than everything, has
150 HP, regenerates 4 HP/s after 2.5 s without damage, and monsters that
touch you get knocked back. Spawn rate slowly ramps up over time.

## Files

- `index.html` — page + canvas
- `game.js` — all game code (entities, spawning, rendering, audio, HUD)
