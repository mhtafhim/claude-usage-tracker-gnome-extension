import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async');

// Candidate paths for Claude Code's OAuth credentials file.
const CRED_PATHS = [
    GLib.get_home_dir() + '/.claude/.credentials.json',
    GLib.get_home_dir() + '/.config/claude/credentials.json',
];

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const REFRESH_SECONDS = 60; // this endpoint rate-limits hard if polled too often

function pct(u) {
    // API has been seen returning either 0-100 or 0-1. Normalize to 0-100.
    if (u === null || u === undefined) return null;
    return u <= 1 ? Math.round(u * 100) : Math.round(u);
}

// Gradient anchors. A pill sitting exactly on an anchor gets that pure color;
// in between it blends toward the next one, so the color drifts continuously
// as usage climbs.
const COLOR_STOPS = [
    {at: 0, rgb: [39, 174, 96]},    // green
    {at: 50, rgb: [142, 68, 173]},  // purple
    {at: 70, rgb: [241, 196, 15]},  // yellow
    {at: 90, rgb: [231, 76, 60]},   // red
    {at: 100, rgb: [192, 57, 43]},  // deep red
];

const GAMMA = 2.2;

function textColorFor([r, g, b]) {
    // Perceived brightness, so text stays readable on any blend.
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.6 ? '#000000' : '#ffffff';
}

function colorForPct(p) {
    const c = Math.max(0, Math.min(100, p));
    let lo = COLOR_STOPS[0];
    let hi = COLOR_STOPS[COLOR_STOPS.length - 1];
    for (let i = 0; i < COLOR_STOPS.length - 1; i++) {
        if (c >= COLOR_STOPS[i].at && c <= COLOR_STOPS[i + 1].at) {
            lo = COLOR_STOPS[i];
            hi = COLOR_STOPS[i + 1];
            break;
        }
    }
    const span = hi.at - lo.at;
    const t = span === 0 ? 0 : (c - lo.at) / span;
    // Blend in linear light rather than straight sRGB: mid-ramp colors come out
    // brighter instead of sagging toward grey.
    const rgb = lo.rgb.map((v, i) => {
        const a = Math.pow(v / 255, GAMMA);
        const b = Math.pow(hi.rgb[i] / 255, GAMMA);
        return Math.round(255 * Math.pow(a + (b - a) * t, 1 / GAMMA));
    });
    return {bg: `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`, fg: textColorFor(rgb)};
}

const PILL_STYLE = 'border-radius: 8px; padding: 0 6px; margin: 0 2px; font-weight: bold;';

function formatResetTime(iso) {
    if (!iso) return '';
    try {
        const dt = GLib.DateTime.new_from_iso8601(iso, null);
        if (!dt) return '';
        const local = dt.to_local();
        const now = GLib.DateTime.new_now_local();
        const diffH = local.difference(now) / 3600000000;
        if (diffH < 24)
            return local.format('resets %-l:%M %p');
        return local.format('resets %a %-l:%M %p');
    } catch (e) {
        return '';
    }
}

const ClaudeUsageIndicator = GObject.registerClass(
class ClaudeUsageIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'Claude Usage', false);

        this._statusLabel = new St.Label({
            text: '⏳',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._sessionPill = new St.Label({y_align: Clutter.ActorAlign.CENTER});
        this._weeklyPill = new St.Label({y_align: Clutter.ActorAlign.CENTER});
        this._pillBox = new St.BoxLayout({visible: false});
        this._pillBox.add_child(this._sessionPill);
        this._pillBox.add_child(this._weeklyPill);

        this.add_child(this._statusLabel);
        this.add_child(this._pillBox);

        this._sessionItem = new PopupMenu.PopupMenuItem('5-hour session: —', {reactive: false});
        this._weeklyItem = new PopupMenu.PopupMenuItem('Weekly: —', {reactive: false});
        this.menu.addMenuItem(this._sessionItem);
        this.menu.addMenuItem(this._weeklyItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const refreshItem = new PopupMenu.PopupMenuItem('Refresh now');
        refreshItem.connect('activate', () => this._refresh());
        this.menu.addMenuItem(refreshItem);

        this._httpSession = new Soup.Session();
        this._timeoutId = null;
        this._destroyed = false;
        this._haveData = false;

        this._refresh();
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_SECONDS, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    async _getToken() {
        for (const path of CRED_PATHS) {
            try {
                const file = Gio.File.new_for_path(path);
                const [contents] = await file.load_contents_async(null);
                const text = new TextDecoder('utf-8').decode(contents);
                const json = JSON.parse(text);
                const oauth = json.claudeAiOauth || json;
                if (oauth && oauth.accessToken) return oauth.accessToken;
            } catch (e) {
                if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                    logError(e, `ClaudeUsage: could not read ${path}`);
            }
        }
        return null;
    }

    async _refresh() {
        const token = await this._getToken();
        if (this._destroyed) return;
        if (!token) {
            this._haveData = false;
            this._showStatus('Claude: no token');
            this._sessionItem.label.set_text('No credentials file found.');
            this._weeklyItem.label.set_text('Run "claude login" first.');
            return;
        }

        const message = Soup.Message.new('GET', USAGE_URL);
        message.request_headers.append('Authorization', `Bearer ${token}`);
        message.request_headers.append('anthropic-beta', 'oauth-2025-04-20');
        message.request_headers.append('User-Agent', 'claude-code/1.0.0');

        this._httpSession.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session, result) => {
            if (this._destroyed) return;
            try {
                const bytes = session.send_and_read_finish(result);
                // Read the property, not get_status(): GJS throws marshalling
                // codes missing from the Soup.Status enum, such as 429.
                const status = message.status_code;
                if (status !== 200) {
                    this._reportError(`Claude: err ${status}`, `Request failed (HTTP ${status}).`);
                    return;
                }
                const text = new TextDecoder('utf-8').decode(bytes.get_data());
                const data = JSON.parse(text);
                this._updateUI(data);
            } catch (e) {
                logError(e, 'ClaudeUsage: request failed');
                this._reportError('Claude: err', 'Request failed. Will retry.');
            }
        });
    }

    // A rate-limited or timed-out refresh shouldn't blank out numbers we
    // already have: leave the pills and dropdown showing the last known
    // values untouched, and only surface the failure when there's nothing
    // to fall back on yet.
    _reportError(panelText, menuText) {
        if (this._haveData) return;
        this._showStatus(panelText);
        this._sessionItem.label.set_text(menuText);
        this._weeklyItem.label.set_text('—');
    }

    _showStatus(text) {
        this._statusLabel.set_text(text);
        this._statusLabel.visible = true;
        this._pillBox.visible = false;
    }

    _setPill(label, prefix, pctValue) {
        if (pctValue === null) {
            label.set_text(`${prefix} N/A`);
            label.set_style(PILL_STYLE);
        } else {
            const {bg, fg} = colorForPct(pctValue);
            label.set_text(`${prefix} ${pctValue}%`);
            label.set_style(`background-color: ${bg}; color: ${fg}; ${PILL_STYLE}`);
        }
    }

    _updateUI(data) {
        const session = data.five_hour ? pct(data.five_hour.utilization) : null;
        const weekly = data.seven_day ? pct(data.seven_day.utilization) : null;

        if (session === null && weekly === null) {
            this._haveData = false;
            this._showStatus('Claude: N/A');
        } else {
            this._setPill(this._sessionPill, '5h', session);
            this._setPill(this._weeklyPill, 'Wk', weekly);
            this._statusLabel.visible = false;
            this._pillBox.visible = true;
            this._haveData = true;
        }

        if (session !== null) {
            const reset = formatResetTime(data.five_hour.resets_at);
            this._sessionItem.label.set_text(`5-hour session: ${session}% ${reset}`);
        } else {
            this._sessionItem.label.set_text('5-hour session: not available');
        }

        if (weekly !== null) {
            const reset = formatResetTime(data.seven_day.resets_at);
            this._weeklyItem.label.set_text(`Weekly: ${weekly}% ${reset}`);
        } else {
            this._weeklyItem.label.set_text('Weekly: not available');
        }
    }

    stop() {
        this._destroyed = true;
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
        this._httpSession.abort();
    }
});

export default class ClaudeUsageExtension extends Extension {
    enable() {
        this._indicator = new ClaudeUsageIndicator();
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator.stop();
        this._indicator.destroy();
        this._indicator = null;
    }
}
