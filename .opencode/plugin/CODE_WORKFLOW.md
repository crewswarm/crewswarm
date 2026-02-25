# Code Production Workflow

## The Problem
Agents were just chatting and producing status reports instead of actual code.

## The Solution
New `code_*` tools enforce structured output schemas:
- `code_execute` - Runs `opencode run` with strict JSON output requirements
- `code_validate` - Verifies files were actually written
- `code_status` - Tracks task execution state

## How to Make Agents Write Code

### 1. Orchestrator assigns work via code_execute

```json
{
  "tool": "code_execute",
  "args": {
    "taskId": "task-001",
    "instruction": "Create a TypeScript function that validates email addresses using regex. Write it to src/utils/validation.ts",
    "files": ["src/utils/validation.ts"],
    "tests": ["npm test -- validation"],
    "agent": "coder"
  }
}
```

### 2. Agent MUST return this JSON schema

```json
{
  "files_changed": [
    {
      "path": "src/utils/validation.ts",
      "action": "created",
      "lines_added": 15,
      "lines_removed": 0
    }
  ],
  "tests_run": [
    {
      "name": "validation",
      "passed": true,
      "output": "3 tests passed"
    }
  ],
  "result": "success",
  "summary": "Created email validation function with regex",
  "errors": []
}
```

### 3. Orchestrator validates the work

```json
{
  "tool": "code_validate",
  "args": {
    "taskId": "task-001",
    "expectedFiles": ["src/utils/validation.ts"],
    "requireTests": true
  }
}
```

### 4. If validation fails, reassign to fixer

```json
{
  "tool": "opencrew_rt_issue",
  "args": {
    "to": "fixer",
    "taskId": "task-001",
    "issue": "Validation failed: file not found on disk",
    "severity": "high"
  }
}
```

## Critical Rules

1. **NO CHAT OUTPUT** - Agents must use `write`/`edit` tools, not return text
2. **MUST RETURN JSON** - Response must match CodeTaskResult schema exactly
3. **FILES MUST EXIST** - Validation checks both the report AND filesystem
4. **EMPTY files_changed = FAILURE** - If no files reported, task is marked failed

## Testing the System

```bash
# Start the realtime server
openswitchctl start

# Test code execution
opencode agent orchestrator "Execute task TEST-001: create a hello world function"

# Check status
opencode agent orchestrator "Check code task status for TEST-001"

# Validate results
opencode agent orchestrator "Validate task TEST-001 expects file src/hello.ts"
```

## Agent Roles

- **orchestrator**: Delegates via `code_execute`, validates via `code_validate`
- **coder**: Receives coding tasks, writes files, returns structured JSON
- **fixer**: Fixes failed validations, patches issues
- **qa**: Validates output quality (not file existence - that's code_validate)

## Common Failures

1. **Agent returns chat text** → `code_execute` returns error: "No valid JSON output found"
2. **File reported but doesn't exist** → `code_validate` returns error
3. **Tests required but not run** → `code_validate` returns partial/failed
4. **Timeout** → Default 5min, can extend with `timeout` arg (max 10min)
