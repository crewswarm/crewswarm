# 90-Second Demo

Updated: March 14, 2026

This is the fastest high-signal demo path.

## Goal

Show that crewswarm is:
- real
- local
- multi-surface
- useful

## Demo Script

### 0:00 - 0:10

Open Dashboard.

Say:
"crewswarm is a local-first multi-agent dev stack. It is not just one chat box. It runs a real orchestration backend, real services, and multiple operator surfaces."

Show:
- services healthy
- agents visible
- providers/engines visible

### 0:10 - 0:30

Open chat and send:
"Build a JWT auth API with tests."

Say:
"A requirement comes in through the dashboard. `crew-lead` routes it, specialists pick it up, and the stack shows you what is happening."

Show:
- `crew-lead` response
- agent activity
- service/runtime visibility

### 0:30 - 0:50

Switch to Vibe.

Say:
"Vibe is the coding surface. It gives you the project tree, Monaco editor, project-aware chat, and direct CLI or agent interaction in one place."

Show:
- file tree
- editor
- chat panel
- terminal/activity area

### 0:50 - 1:05

Open a changed/generated file and ask for an explanation.

Say:
"You can inspect what the system wrote, then ask follow-up questions against the actual project context."

Show:
- file content
- short ask/explain interaction

### 1:05 - 1:20

Show MCP/editor angle or `crewchat`.

Say:
"The same stack also works through MCP-enabled editors and a native macOS chat app, so this is not locked to one interface."

Show one of:
- MCP config mention in docs
- `crewchat`
- SwiftBar service controls

### 1:20 - 1:30

Close on the install story.

Say:
"You can install it with one file, run it locally, and own the full stack yourself."

Show:
- `install.sh --help`
- one-file install command in README

## Best Recording Order

1. Start services first
2. Prepare one clean project
3. Keep one short prompt ready
4. Keep Vibe already open in another tab/window
5. Avoid typing long commands live unless needed

## Recording Tips

- keep terminal font large
- use one project with readable files
- avoid dead time waiting for startup
- cut between surfaces if live timing drags
- prefer one successful end-to-end story over many partial features
