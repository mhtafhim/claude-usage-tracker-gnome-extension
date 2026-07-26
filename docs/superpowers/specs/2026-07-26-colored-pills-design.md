# Colored Usage Pills — Design

> **Status: reverted.** Shipped in 636a45b, iterated through 33e398a, but the
> colored/pill styling didn't render visibly in the top bar for the user and
> was reverted back to plain text in favor of a working indicator. The
> underlying resilience fixes (async token reads, 429 countdown, stale-data
> preservation) were kept. Left here for history, not a description of the
> current UI.

## Motivation

Panel indicator currently shows plain text (`5h X% · Wk Y%`) with no visual severity cue. User wants an at-a-glance color signal for how close each limit is to being hit.

## Requirements

- Two independent pills in the top-bar indicator: one for the 5-hour session %, one for the weekly %.
- Each pill's background color reflects its own percentage, independently of the other.
- Color is a **continuous gradient**, not discrete bands. Anchor colors sit at fixed
  percentages and the pill blends between them, so the color drifts toward the next
  anchor as usage climbs:
  - 0%: green
  - 50%: purple
  - 70%: yellow
  - 90%: red
  - 100%: deep red
- Loading / no-token / error states keep plain text (no percentage to color, no pill).
- Dropdown menu items (`5-hour session: …`, `Weekly: …`) are unchanged — text only, no color.

## Design

### Color mapping

`COLOR_STOPS` holds the anchors above as RGB triples. `colorForPct(p)` clamps `p`
to 0–100, finds the bracketing pair of anchors, and interpolates between them.

Interpolation happens in **linear light** (each channel raised to 2.2, mixed, then
un-gamma'd) rather than straight sRGB, because a naive sRGB mix between two distant
hues sags toward grey. Green and purple are near-complementary, so the 20–40% region
is still relatively desaturated — that is inherent to blending those two hues, not a
bug in the ramp.

Foreground text color is derived, not fixed: `textColorFor(rgb)` computes perceived
brightness (`0.299R + 0.587G + 0.114B`) and returns black above 0.6, white otherwise,
so text stays readable on every blend.

### Panel indicator structure

Replace the single `this._label` with:

- `this._statusLabel` (`St.Label`) — plain text, shown for loading (`⏳`), no-token, and error states.
- `this._pillBox` (`St.BoxLayout`, horizontal) — shown on successful data, containing:
  - `this._sessionPill` (`St.Label`) — text `5h X%`, styled via `colorForPct(session)`.
  - `this._weeklyPill` (`St.Label`) — text `Wk Y%`, styled via `colorForPct(weekly)`.

Both `_statusLabel` and `_pillBox` are added as children of the indicator; visibility toggles between them (`.visible = true/false`) rather than swapping children in/out, to avoid re-parenting churn.

Pill style string (inline via `set_style()`):

```
background-color: <bg>; color: <fg>; border-radius: 8px; padding: 0 6px; margin: 0 2px; font-weight: bold;
```

### `_updateUI` changes

- On success: hide `_statusLabel`, show `_pillBox`. For each of session/weekly, if the value is available, set pill text and style; if unavailable (`N/A`), fall back to plain-text style (no colored background) so absence isn't mistaken for "0%, all green."
- On loading/no-token/error: hide `_pillBox`, show `_statusLabel` with existing messages (unchanged behavior).

### Resilience

Two bugs surfaced in the journal once the extension ran for real, both fixed alongside
the gradient:

- `message.get_status()` throws `429 is not a valid value for enumeration Status` —
  GJS marshals the return as a `Soup.Status` enum, and 429 is not a member. Read the
  `status_code` property instead, which returns a plain integer. Verified against a
  local server returning 429.
- Async callbacks (`load_contents_async`, `send_and_read_async`) can land after the
  indicator is destroyed, logging `has been already disposed`. `stop()` sets a
  `_destroyed` flag that both callbacks check before touching any actor.

A failed refresh no longer blanks the panel. Once `_haveData` is true the pills stay
put and the failure is reported in the dropdown, so a transient rate-limit or timeout
doesn't wipe numbers that are still roughly accurate.

## Out of scope

- No changes to dropdown menu item styling.
- No user-configurable thresholds or colors (hardcoded, matches current `REFRESH_SECONDS`-style simple constants pattern in the file).
