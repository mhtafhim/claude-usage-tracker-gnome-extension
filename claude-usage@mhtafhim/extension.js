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
const REFRESH_SECONDS = 180; // this endpoint rate-limits hard if polled too often

function pct(u) {
    // API has been seen returning either 0-100 or 0-1. Normalize to 0-100.
    if (u === null || u === undefined) return null;
    return u <= 1 ? Math.round(u * 100) : Math.round(u);
}

// Anthropic has been seen sending "retry-after: 0" on this endpoint, which
// isn't a real wait time - treat missing/zero/garbage the same way and fall
// back to a floor so we don't immediately hammer it again.
// https://github.com/anthropics/claude-code/issues/30930
const RATE_LIMIT_FLOOR_SECONDS = 60;

function parseRetryAfter(message) {
    const raw = message.response_headers.get_one('Retry-After');
    const seconds = raw ? parseInt(raw, 10) : NaN;
    if (!Number.isFinite(seconds) || seconds <= 0) return RATE_LIMIT_FLOOR_SECONDS;
    return seconds;
}

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

        this._label = new St.Label({
            text: '⏳',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._label);

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
        this._countdownId = null;
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
        this._clearCountdown();
        const token = await this._getToken();
        if (this._destroyed) return;
        if (!token) {
            this._haveData = false;
            this._label.set_text('Claude: no token');
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
                if (status === 429) {
                    this._startCountdown(parseRetryAfter(message));
                    return;
                }
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
    // already have: leave the panel and dropdown showing the last known
    // values untouched, and only surface the failure when there's nothing
    // to fall back on yet.
    _reportError(panelText, menuText) {
        if (this._haveData) return;
        this._label.set_text(panelText);
        this._sessionItem.label.set_text(menuText);
        this._weeklyItem.label.set_text('—');
    }

    // Rate-limited: count down the server-given Retry-After on the panel
    // instead of polling again right away, then retry the moment it elapses.
    _startCountdown(seconds) {
        let remaining = seconds;
        this._label.set_text(`Wait ${remaining}s`);
        this._countdownId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            if (this._destroyed) {
                this._countdownId = null;
                return GLib.SOURCE_REMOVE;
            }
            remaining -= 1;
            if (remaining <= 0) {
                this._countdownId = null;
                this._refresh();
                return GLib.SOURCE_REMOVE;
            }
            this._label.set_text(`Wait ${remaining}s`);
            return GLib.SOURCE_CONTINUE;
        });
    }

    _clearCountdown() {
        if (this._countdownId) {
            GLib.source_remove(this._countdownId);
            this._countdownId = null;
        }
    }

    _updateUI(data) {
        const session = data.five_hour ? pct(data.five_hour.utilization) : null;
        const weekly = data.seven_day ? pct(data.seven_day.utilization) : null;

        const parts = [];
        if (session !== null) parts.push(`5h ${session}%`);
        if (weekly !== null) parts.push(`Wk ${weekly}%`);
        this._label.set_text(parts.length ? parts.join('  ·  ') : 'Claude: N/A');
        this._haveData = parts.length > 0;

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
        this._clearCountdown();
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
