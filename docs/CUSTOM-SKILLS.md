# How to Write a Custom Skill

Skills extend what agents can do. There are two types: **API skills** (call external services) and **knowledge skills** (inject context into agent prompts).

## API Skills (JSON)

API skills call HTTP endpoints. Create a `.json` file in `~/.crewswarm/skills/`:

```json
{
  "description": "Translate text using DeepL API",
  "url": "https://api-free.deepl.com/v2/translate",
  "method": "POST",
  "auth": {
    "type": "header",
    "header": "Authorization",
    "token": "DeepL-Auth-Key YOUR_KEY"
  },
  "defaultParams": {
    "target_lang": "EN"
  },
  "paramNotes": "Required: text (string to translate). Optional: target_lang (default EN), source_lang.",
  "requiresApproval": false,
  "timeout": 15000
}
```

Save as `~/.crewswarm/skills/deepl-translate.json`. The filename (minus `.json`) becomes the skill name.

### API Skill Fields

| Field | Required | Description |
|-------|----------|-------------|
| `description` | Yes | What the skill does — shown to agents |
| `url` | Yes | HTTP endpoint. Use `{param}` for URL params |
| `method` | Yes | `GET`, `POST`, `PUT`, `DELETE` |
| `auth` | No | `{ type: "bearer", keyFrom: "providers.deepl.apiKey" }` or `{ type: "header", header: "X-Key", token: "..." }` |
| `defaultParams` | No | Default values merged with agent-provided params |
| `paramNotes` | No | Help text for agents about what params to pass |
| `requiresApproval` | No | If `true`, user must approve before execution |
| `timeout` | No | Request timeout in ms (default 15000) |
| `aliases` | No | Alternative names agents can use to invoke this skill |

### Auth Options

```json
// Bearer token from provider config
{ "type": "bearer", "keyFrom": "providers.deepl.apiKey" }

// Static header
{ "type": "header", "header": "X-API-Key", "token": "your-key-here" }

// No auth
// omit the auth field entirely
```

## Knowledge Skills (SKILL.md)

Knowledge skills inject context into agent prompts. They teach agents *when and how* to do something without calling an external API.

Create a folder in `~/.crewswarm/skills/` with a `SKILL.md` file:

```
~/.crewswarm/skills/code-review/SKILL.md
```

Example `SKILL.md`:

```markdown
# Code Review Skill

## When to use this skill
Use when the user asks to review code, audit a PR, or check code quality.

## How to review
1. Read the files or diff
2. Check for: security issues, performance problems, readability, test coverage
3. Rate severity: critical / warning / suggestion
4. Provide specific line references and fix suggestions

## Output format
- Start with a summary (pass/fail/needs-work)
- List issues grouped by severity
- End with specific action items
```

The skill name is the folder name (`code-review`). Agents see it listed via `@@SKILL code-review` and the content gets injected into their context.

## Managing Skills

### Dashboard
Go to the **Skills** tab to view, create, edit, and test skills.

### API
```bash
# List all skills
curl http://127.0.0.1:5010/api/skills -H "Authorization: Bearer $TOKEN"

# Execute a skill
curl -X POST http://127.0.0.1:5010/api/skills/execute \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"skill":"deepl-translate","params":{"text":"Hello world","target_lang":"DE"}}'
```

### Agent Usage
Agents invoke skills automatically when relevant, or explicitly via:
```
@@SKILL deepl-translate {"text": "Hello world", "target_lang": "DE"}
```

## Built-in Skills

CrewSwarm ships with several built-in skills including `code-search` (ripgrep-based codebase search) and `read-log` (tail service logs). View the full list in the Skills tab or via `/api/skills`.

## Tips

- Keep API skills focused — one endpoint per skill
- Use `paramNotes` generously — agents read them to know what to pass
- Set `requiresApproval: true` for skills that cost money or have side effects (e.g. trading, posting)
- Knowledge skills are free — use them to encode institutional knowledge agents should always have
