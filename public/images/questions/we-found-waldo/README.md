# We Found Waldo images

Question / solution board pairs, named by percent:

```
90a.png   # question graphic (TV while answering)
90b.png   # solution graphic (TV on “Show right answer”)
…
1a.png / 1b.png
```

Expected files for each percent (90, 80, 70, 60, 50, 45, 40, 35, 30, 25, 20, 15, 10, 5, 1):
- `{n}a.png` — question board
- `{n}b.png` — solution

All 30 boards are present in this folder.

Pack JSON: `data/questions/we-found-waldo.json`  
`settings.hidePrompt: true` → TV shows the image only (host still sees the full prompt text).
