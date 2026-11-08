# Pomodoro

A calm, full-screen Pomodoro timer meant to run on a second monitor while you study — with Spotify playlists for focus and break time.

**Live:** https://linoking09.github.io/pomodoro-premium/

## Features

- Modes (focus/break/long break): **Classic** 25/5/15, **Deep Work** 50/10/30, **Flow State** 90/20/40, plus a **Custom** mode with your own times
- Long break after every N sessions (default 4), shown as dots under the phase label
- Two themes: **Midnight** (dark blue, default) and **Pomodoro** (red); the colors shift subtly during breaks
- Spotify: one playlist for focus, one for breaks, each with **Shuffle** or **Continue where I left off**. Any playlist or album works: search, paste a share link, or use what is currently playing. Music fades out/in between phases (on devices that allow volume control). Playback runs on any device of your account (e.g. your phone on a Bluetooth speaker)
- Chime + optional desktop notification when a phase ends, auto-start options
- Controls fade out while the timer runs, screen wake lock, fullscreen
- “What are you working on?” line and a daily session counter
- Keyboard: `Space` start/pause · `R` reset · `S` skip · `1`–`4` modes · `T` theme · `F` fullscreen

## Spotify setup (one time)

Spotify playback control requires **Spotify Premium**.

1. Open the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) → **Create app**.
2. Redirect URI: `https://linoking09.github.io/pomodoro-premium/` (exactly as shown in the app's settings). Select **Web API**.
3. Copy the **Client ID** into the app's settings → **Connect Spotify**.

Everything (token, settings, playlist positions) is stored in your browser's localStorage only — there is no backend.

## Deployment

Pushes are deployed by `.github/workflows/deploy.yml`. In the repository go to
**Settings → Pages → Build and deployment → Source: GitHub Actions** once.

Tip for testing: `?speed=60` makes the timer run 60× faster.
