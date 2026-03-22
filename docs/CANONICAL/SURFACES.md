# Surfaces

Updated: March 14, 2026

crewswarm has three main user-facing surfaces plus service controls.

## Dashboard

URL: `http://127.0.0.1:4319`

Use it for:
- service control
- providers and engine configuration
- shared chat with `crew-lead`
- project management
- agent configuration

Status:
- stable core surface

## Vibe

URL: `http://127.0.0.1:3333`

Use it for:
- Monaco editor
- file/project navigation
- project-aware chat
- direct agent chat
- direct CLI passthrough

Status:
- beta UX surface
- core flows work, but polish and consistency are still improving

## crewchat

App bundle: `/Applications/CrewChat.app`

Use it for:
- fast native macOS chat
- **Multimodal input**: Native image picker (camera/photos) and AVFoundation voice recording/transcription
- project-aware `crew-lead` chat and direct agent `@mentions`
- direct CLI passthrough
- **Two operating modes**:
  - **Quick Mode**: Chat conversationally with `crew-lead` for AI-routed support.
  - **Advanced Mode**: Bypasses the lead to allow direct conversational access to specialists like `crew-coder`, `crew-qa`, `crew-pm`.

Status & Build:
- beta native surface
- Run `./build-crewchat.sh` to compile the `CrewChat.app` bundle in under 2 minutes.

## SwiftBar

Use it for:
- stack health at a glance in the macOS Menu Bar
- start/stop/restart service shortcuts (without interacting with the Dashboard)
- opening dashboard, Vibe, and `crewchat`

Status & Mechanism:
- operational helper, not a primary product surface
- powered entirely by `contrib/swiftbar/openswitch.10s.sh`. (Make sure you configure it never to auto-restart the dashboard in a loop).

## Recommended Usage

- use Dashboard for setup and service management
- use Vibe for coding and project work
- use `crewchat` for lightweight native chat
- use SwiftBar for quick operational control
