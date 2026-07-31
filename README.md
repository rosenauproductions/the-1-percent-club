# The 1% Club — Party Game

Browser-based party clone of **The 1% Club**: a **1080p TV display**, **host phone**, and **contestant phones**, synced over a local Node server.

## Quick start

```bash
cd "/Users/christopherrosenau/Desktop/Personal - Chris/Cursor Projects/The 1% club"
npm install
npm start
```

Or: `./start.sh`

On your party WiFi, use the **LAN IP** printed when the server starts (not `club.local` — that often hangs on macOS):

| Screen | Example |
|--------|---------|
| **Home** | http://192.168.0.128:3457/ |
| **TV** | http://192.168.0.128:3457/display/ |
| **Host** | http://192.168.0.128:3457/host/ |
| **Play** | http://192.168.0.128:3457/play/ |
| **QA** | http://192.168.0.128:3457/qa/ |

On the Mac running the server, `http://localhost:3457/` also works. Phones must use the LAN IP.

Press **F** on the TV page for fullscreen. Tap the TV once to unlock sound.

### QA feedback

Every screen has a gold **QA** button (bottom-right). Notes are saved to `data/feedback.jsonl` and listed on `/qa/`. Use that while playtesting.

## Deploy on Render (cloud)

Same pattern as Family Feud: a **Node web service** (HTTP + WebSockets) on Render’s free tier. Expect a **~30s cold start** after the service sleeps.

1. Put this project on GitHub (new repo), then push `main`.
2. Open [Render Dashboard](https://dashboard.render.com/) → **New** → **Blueprint**.
3. Connect this repo — Render reads `render.yaml`.
4. Click **Apply** and wait for the deploy.

| Screen | URL |
|--------|-----|
| **Home** | `https://the-1-percent-club.onrender.com/` |
| **TV** | `https://the-1-percent-club.onrender.com/display/` |
| **Host** | `https://the-1-percent-club.onrender.com/host/` |
| **Play** | `https://the-1-percent-club.onrender.com/play/` |

(`PORT` is set by Render. No extra env vars.)

**Cloud vs local:** same shareable URL for everyone; state resets on sleep/redeploy; a bit more latency than LAN. This is a **second** free service on the same Render account as Family Feud — not the same process.

## How a night runs

1. Open **display** on the TV and **host** on your phone.
2. Players open **play** (QR on the TV or the join code).
3. Host picks a question pack, closes join when ready, and starts the game.
4. Each question: host talks (TV holds) → host starts → question + timer music → lock answers → reveal → continue.
5. Special beats match the US show: passes before **50%**, cash-out before **30%**, $10k vs **1%** after **5%** (any number of remaining contestants can attempt 1%), solo $10k offer if one player remains early.

Player count is flexible: whoever joins during lobby (soft cap **100**). Each starts with a **$1,000** play-money stake; wrong answers / passes feed the jackpot.

## Sounds

Placeholder tones live in `public/sounds/`. Drop your own files with the same names:

| File | Cue |
|------|-----|
| `intro.mp3` | Game start + wait before **first** question only (once, 50% on TV) |
| `interlude.mp3` | Unused bed (kept for optional custom wiring) |
| `timer.mp3` | Host starts the question / answer window (plays through locks) |
| `lock.mp3` | Unused (kept for optional custom wiring) |
| `correct.mp3` | After clean-round TV sting |
| `thump.mp3` | `/play` only — sting before each non-last wrong blue light; audio test |
| `eliminating.mp3` | TV — clean round or **last** wrong (1–3×); also in `/play` audio test |
| `eliminate.mp3` | Each wrong player lit (after sting) |
| `youre-out.mp3` | Personal out sting (eliminated phone) |
| `pass.mp3` | Pass / cash-out moments |
| `jackpot.mp3` | Jackpot sting |
| `win.mp3` | Finale |

## Question packs

JSON files in `data/questions/`. Need **15** questions in order (90% → 1%):

```json
{
  "name": "My Pack",
  "questions": [
    {
      "percent": 25,
      "prompt": "This arrow is pointing up. Logically, which of these words could also go into the arrow?",
      "image": "arrow-words.png",
      "choices": ["KITTEN", "PUPPY", "CALF"],
      "accepted": ["puppy", "b"]
    }
  ]
}
```

### Question images (optional)

Put images in a folder named after the pack file:

```
data/questions/sample.json
public/images/questions/sample/q01.png
public/images/questions/sample/q14.jpg
```

Then set `"image": "q01.png"` on that question. The TV shows it **above** the prompt when space allows (between instructions and choices); if it can’t fit, the image moves to the **left**.

Optional `"choices": ["A text", "B text", …]` draws A/B/C tiles on the TV. Players can still type the word or letter.

- Relative names resolve to `/images/questions/<packName>/…`
- Or use a full path: `"image": "/images/questions/sample/q01.png"`
- Omit `image` / `choices` for plain text questions

Answers are graded with case-insensitive normalized matching. Host can force ✓/✗ on reveal.

## Architecture

Same pattern as Family Feud: Express + `ws`, pure reducers in `server/gameState.js`, vanilla clients under `public/`, HTTP actions + WebSocket state broadcast.

```
server/          # Express + game state
data/questions/  # Packs
public/display/  # TV
public/host/     # Host phone
public/play/     # Contestant phones
public/sounds/   # Swap-in audio
public/images/   # Temp art
```

## Temp assets

Graphics and sounds are placeholders — swap files in `public/images/` and `public/sounds/` anytime without code changes.
