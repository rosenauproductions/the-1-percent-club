# Question pack images

One folder per pack file (same name, no `.json`):

```
public/images/questions/sample/   ← for data/questions/sample.json
  q01.png
  q05.jpg
```

In the pack JSON:

```json
{
  "percent": 50,
  "prompt": "What is missing from this diagram?",
  "image": "q05.jpg",
  "accepted": ["triangle", "a triangle"]
}
```

Shown on the TV above the question text. Leave `image` out for text-only questions.
