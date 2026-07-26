# Claude Usage Tracker (GNOME Extension)

A tiny GNOME Shell extension that shows your Claude Pro/Max **5-hour** and **weekly** usage limits right in the top bar.

## Why I built this

I kept switching over to `/usage` in Claude Code or digging into settings just to check how much of my usage limit was left. Doing that back and forth, over and over, got irritating fast. So I built this extension to put the numbers right in my GNOME top bar — no more manual checking.

## What it does

- Shows a live `5h X%  ·  Wk Y%` indicator in the panel, each as a color-coded pill (green/purple/yellow/red by % used — see [spec](docs/superpowers/specs/2026-07-26-colored-pills-design.md) for thresholds).
- Click it to see a dropdown with exact reset times for both the 5-hour session and weekly limit.
- Refreshes automatically every 60 seconds (configurable in `extension.js`).
- Manual "Refresh now" option in the dropdown.

## How it works

It reads the OAuth access token that the [Claude Code](https://github.com/anthropics/claude-code) CLI already stores locally after you run `claude login` (`~/.claude/.credentials.json` or `~/.config/claude/credentials.json`), and uses it to call Anthropic's usage endpoint (`https://api.anthropic.com/api/oauth/usage`). No separate login, no credentials stored by the extension itself — it just reuses the session you already have.

## Requirements

- GNOME Shell 45+ (tested on 50)
- Claude Code CLI installed and logged in (`claude login`)

## Installation

```bash
git clone https://github.com/mhtafhim/claude-usage-tracker-gnome-extension.git
cd claude-usage-tracker-gnome-extension
mkdir -p ~/.local/share/gnome-shell/extensions/claude-usage@mhtafhim
cp -r claude-usage@mhtafhim/* ~/.local/share/gnome-shell/extensions/claude-usage@mhtafhim/
```

Restart GNOME Shell:
- **X11**: `Alt+F2`, type `r`, press Enter.
- **Wayland**: log out and log back in.

Then enable it:

```bash
gnome-extensions enable claude-usage@mhtafhim
```

## Configuration

Refresh interval is set via `REFRESH_SECONDS` near the top of `extension.js`. Anthropic's usage endpoint rate-limits aggressively if polled too often — 180s (3 min) is a safe middle ground.

If the API returns a 429, the panel shows a red `Wait Xs` pill counting down the server's `Retry-After` value and retries automatically the moment it hits zero, instead of silently failing on the next scheduled poll.

## Troubleshooting

- **"Claude: no token"** — no credentials file found at `~/.claude/.credentials.json` or `~/.config/claude/credentials.json`. Run `claude login`.
- **"Claude: err 401"** — token expired or invalid. Re-run `claude login`.
- **Indicator missing after enabling** — check logs: `journalctl -f -o cat /usr/bin/gnome-shell` while reloading the shell.

## Uninstall

```bash
gnome-extensions disable claude-usage@mhtafhim
rm -rf ~/.local/share/gnome-shell/extensions/claude-usage@mhtafhim
```

## Privacy

Your OAuth token never leaves your machine except in the `Authorization` header sent directly to `api.anthropic.com`. Nothing is logged, cached, or sent anywhere else.

## License

MIT
