# Butler

Use Postman to send POST requests to `/apply`.

Headers:
- `Content-Type: application/json`
- `X-Butler-Token: <secret>`

Body example:
```json
{
  "branch": "ai/run-1755142905",
  "baseBranch": "main",
  "prTitle": "chore: add hello file",
  "edits": [
    { "op": "write", "path": "src/hello.txt", "mode": "create", "content": "hi from butler\n" }
  ]
}
```
