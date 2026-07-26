# Colored Usage Pills — Design

## Motivation

Panel indicator currently shows plain text (`5h X% · Wk Y%`) with no visual severity cue. User wants an at-a-glance color signal for how close each limit is to being hit.

## Requirements

- Two independent pills in the top-bar indicator: one for the 5-hour session %, one for the weekly %.
- Each pill's background color reflects its own percentage, independently of the other.
- Color thresholds (inclusive upper bound):
  - 0–50%: green
  - 51–70%: purple
  - 71–90%: yellow
  - 91–100%: red
- Loading / no-token / error states keep plain text (no percentage to color, no pill).
- Dropdown menu items (`5-hour session: …`, `Weekly: …`) are unchanged — text only, no color.

## Design

### Color mapping

```js
function colorForPct(pct) {
    if (pct <= 50) return {bg: '#27ae60', fg: '#ffffff'}; // green
    if (pct <= 70) return {bg: '#8e44ad', fg: '#ffffff'}; // purple
    if (pct <= 90) return {bg: '#f1c40f', fg: '#000000'}; // yellow, dark text for contrast
    return {bg: '#e74c3c', fg: '#ffffff'};                // red
}
```

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

## Out of scope

- No changes to dropdown menu item styling.
- No user-configurable thresholds or colors (hardcoded, matches current `REFRESH_SECONDS`-style simple constants pattern in the file).
