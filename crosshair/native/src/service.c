/*
 * org.abbie.crosshair.service: owns the crosshair settings and keeps the dot on screen.
 * It replaced the JS service in 0.5.0 (git tag js-service-final has the last JS version)
 * with the same methods, replies, files, and rules.
 *
 * Runs as root (Homebrew Channel's elevate-service). Event driven: a glib main loop with
 * four subscriptions (power state, the running-app list, the foreground app, and the
 * picture settings for HDR), and nothing running between events.
 *
 * Methods (luna://org.abbie.crosshair.service/<method>):
 *   getConfig {subscribe}   current settings, whether the picture is HDR, and whether
 *                           the service runs as root; with subscribe, a reply after
 *                           every change
 *   setConfig {config}      apply a partial settings object; invalid fields are skipped
 *                           and keep their current value
 *   resetConfig             defaults for the look, keeping on/off, auto-start, and the
 *                           triple-press and hide-outside-inputs settings as they are
 *   show / hide / toggle    turn the crosshair on or off
 *   button                  the remote button (Input Hook calls this): one press toggles;
 *                           with tripleOpensSettings, three quick presses open the panel
 *   status                  settings plus whether the dot app is loaded, and the power state
 *   start                   no-op; the boot hook calls it to start the service
 *
 * Power-on rule: after the TV boots or wakes from standby, the crosshair is on if
 * auto-start is on, and off otherwise. The dim "Screen Off" state isn't a power-on.
 *
 * With hideOutsideInputs, the dot app is also closed while Home or an app is in front, and
 * comes back on an input (HDMI, live TV, AV). The on/off setting itself doesn't change.
 *
 * Crash recovery: the process the hub starts supervises the service in a child process and
 * restarts it a second after it dies abnormally, up to 5 times a minute (see supervise()).
 */
#include <ctype.h>
#include <errno.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#include <glib.h>
#include <glib-unix.h>
#include <luna-service2/lunaservice.h>
#include <pbnjson.h>

#include "config.h"

#define SERVICE_ID "org.abbie.crosshair.service"
#define DOT_APP_ID "org.abbie.crosshair.dot"
#define SETTINGS_APP_ID "org.abbie.crosshair"
#define OWN_PREFIX "org.abbie.crosshair"
#define CONFIG_DIR "/home/root/.config/org.abbie.crosshair"
#define CONFIG_FILE CONFIG_DIR "/config.json"
#define LOG_FILE "/tmp/org.abbie.crosshair.log"
//The /tmp folder is RAM (tmpfs) and emptied every boot, so a missing marker means this is
//the first start since boot, rather than a restart (reinstall, crash) that should keep the
//current on/off. The marker holds that on/off, so turning the crosshair on or off never
//writes to the TV's storage.
#define BOOT_MARKER "/tmp/org.abbie.crosshair.booted"
#define LOG_MAX_BYTES (64 * 1024)   //Two files at most (log and .1), both in RAM

//Settings changes arrive in bursts while the panel is open. Save once things go quiet, or
//right away when the panel closes (its subscription ends) or the TV powers down.
#define SAVE_DELAY_MS 10000
#define WAKE_DELAY_MS 1500          //Let the compositor settle after the screen comes on
//Failsafe: budget for relaunching a dot app that died by itself, so a crashing app can't
//loop forever. Launches you cause (on/off, coming back to an input, waking) don't count.
#define LAUNCH_WINDOW_MS 60000
#define LAUNCH_BUDGET 5
//Presses count as one gesture while each comes within PRESS_GAP_MS of the one before.
//A press normally reaches the service about 30 ms after lginput2 sees it, so this is generous.
#define PRESS_GAP_MS 600
#define RESUBSCRIBE_S 5
//Crash recovery: restart the service after RESTART_DELAY_S, at most RESTART_BUDGET times
//in RESTART_WINDOW_S. EXIT_NO_RESTART means a restart can't help (setup failed).
#define RESTART_DELAY_S 1
#define RESTART_WINDOW_S 60
#define RESTART_BUDGET 5
#define EXIT_NO_RESTART 3

#define JSON_MAX 4096

static LSHandle *sh;
static GMainLoop *loop;
static config_t config;
static char saved_text[JSON_MAX];   //What config.json holds now, to skip writes that change nothing
static bool config_dir_ready;
static guint save_timer;
//The tvpower states in which apps keep running. "Screen Off" is the dim semi-sleep: the
//compositor hides the dot itself and shows it again on wake, so it counts as up.
static char power_state[32] = "Active";
static int dot_running = -1;        //-1 = no reply yet. 1 = loaded. 0 = not running.
static char foreground_app[256];    //The app in front, from the foreground subscription
static bool on_input = true;        //An input is in front (assumed until the first reply)
static bool hdr;                    //The TV is showing an HDR picture (picks hdrBrightness)
static char dynamic_range[64];
static gint64 launch_times[LAUNCH_BUDGET];
static int launch_count;
static bool launch_pending;
//Root comes from Homebrew Channel's elevate-service. Without it the service can't keep
//settings in /home/root, so the settings panel warns.
static bool elevated;
static int press_count;
static guint press_timer;

static FILE *log_fp;
static long log_size = -1;

//---------------------------------------------------------------------------------------
//Logging. Keep a short file in /tmp (cleared every boot), trimmed when it grows.

static void log_line(const char *level, const char *fmt, ...) G_GNUC_PRINTF(2, 3);

static void log_line(const char *level, const char *fmt, ...)
{
    char stamp[40];
    struct timespec ts;
    struct tm tm;
    clock_gettime(CLOCK_REALTIME, &ts);
    gmtime_r(&ts.tv_sec, &tm);
    size_t len = strftime(stamp, sizeof(stamp), "%Y-%m-%dT%H:%M:%S", &tm);
    snprintf(stamp + len, sizeof(stamp) - len, ".%03ldZ", ts.tv_nsec / 1000000);

    //Grab the size once, then count what we append
    if (log_size < 0) {
        struct stat st;
        log_size = (stat(LOG_FILE, &st) == 0) ? (long)st.st_size : 0;
    }
    if (log_size > LOG_MAX_BYTES) {
        if (log_fp) { fclose(log_fp); log_fp = NULL; }
        rename(LOG_FILE, LOG_FILE ".1");
        log_size = 0;
    }
    if (!log_fp) {
        log_fp = fopen(LOG_FILE, "a");
        if (!log_fp) return;    //Logging must NEVER take the service down
        setvbuf(log_fp, NULL, _IOLBF, 0);
    }
    int n = fprintf(log_fp, "%s %s ", stamp, level);
    va_list ap;
    va_start(ap, fmt);
    n += vfprintf(log_fp, fmt, ap);
    va_end(ap);
    n += fprintf(log_fp, "\n");
    if (n > 0) log_size += n;
}

//---------------------------------------------------------------------------------------
//Small JSON helpers.

static jvalue_ref parse_json(const char *text)
{
    if (!text) return jinvalid();
    return jdom_create(j_str_to_buffer(text, strlen(text)), jschema_all(), NULL);
}

static jvalue_ref get(jvalue_ref obj, const char *key)
{
    jvalue_ref v;
    if (!jis_valid(obj) || !jis_object(obj)) return NULL;
    if (!jobject_get_exists(obj, j_str_to_buffer(key, strlen(key)), &v)) return NULL;
    return v;
}

//Copy a string field into `out`; false if it's missing or not a string
static bool get_string(jvalue_ref obj, const char *key, char *out, size_t size)
{
    jvalue_ref v = get(obj, key);
    if (!v || !jis_string(v)) return false;
    raw_buffer r = jstring_get_fast(v);
    size_t n = r.m_len < size - 1 ? r.m_len : size - 1;
    memcpy(out, r.m_str, n);
    out[n] = '\0';
    return true;
}

static bool get_bool(jvalue_ref obj, const char *key, bool fallback)
{
    jvalue_ref v = get(obj, key);
    bool b;
    if (v && jis_boolean(v) && jboolean_get(v, &b) == CONV_OK) return b;
    return fallback;
}

//Quote a string for JSON, for text that comes from other services
static void json_quote(const char *s, char *out, size_t size)
{
    size_t o = 0;
    if (size < 3) { if (size) out[0] = '\0'; return; }
    out[o++] = '"';
    for (; *s && o + 7 < size; s++) {
        unsigned char ch = (unsigned char)*s;
        if (ch == '"' || ch == '\\') { out[o++] = '\\'; out[o++] = (char)ch; }
        else if (ch < 0x20) o += (size_t)snprintf(out + o, size - o, "\\u%04x", ch);
        else out[o++] = (char)ch;
    }
    out[o++] = '"';
    out[o] = '\0';
}

static void reply(LSMessage *msg, const char *payload)
{
    LSError err;
    LSErrorInit(&err);
    if (!LSMessageReply(sh, msg, payload, &err)) {
        log_line("ERROR", "reply failed: %s", err.message ? err.message : "unknown");
        LSErrorFree(&err);
    }
}

//Send a one-reply call. `cb` may be NULL when the reply doesn't matter.
static void call_once(const char *uri, const char *payload, LSFilterFunc cb, void *ctx)
{
    LSError err;
    LSErrorInit(&err);
    if (!LSCallOneReply(sh, uri, payload, cb, ctx, NULL, &err)) {
        log_line("ERROR", "call %s failed: %s", uri, err.message ? err.message : "unknown");
        LSErrorFree(&err);
    }
}

//---------------------------------------------------------------------------------------
//Settings storage.

static bool up_state(const char *state)
{
    return strcmp(state, "Active") == 0 || strcmp(state, "Screen Off") == 0;
}

//Build the text config.json should hold. On/off isn't in it: the power-on rule sets it
//after every boot, and a restart in between reads it from the boot marker in RAM.
static void stored_text(const config_t *c, char *buf, size_t size)
{
    if (!config_json(c, buf, size, true, "visible")) buf[0] = '\0';
}

static char *read_file(const char *path)
{
    gchar *text = NULL;
    if (!g_file_get_contents(path, &text, NULL, NULL)) return NULL;
    return text;
}

static void load_config(void)
{
    config_t defaults;
    config_defaults(&defaults);
    config = defaults;

    char *text = read_file(CONFIG_FILE);
    if (text) {
        jvalue_ref parsed = parse_json(text);
        if (jis_valid(parsed) && jis_object(parsed)) config_merge(&config, &defaults, parsed);
        j_release(&parsed);
        g_free(text);
        config_dir_ready = true;
    }
    stored_text(&config, saved_text, sizeof(saved_text));

    //On a restart since boot, on/off comes from the marker. Versions before 0.4.2 left the
    //marker empty and kept on/off in config.json, so that value stays as the fallback.
    text = read_file(BOOT_MARKER);
    if (text) {
        jvalue_ref state = parse_json(text);
        if (jis_valid(state) && jis_object(state)) {
            config_t next;
            config_merge(&next, &config, state);
            config_set_bool(&config, "visible", config_bool(&next, "visible"));
        }
        j_release(&state);
        g_free(text);
    }
}

static void save_now(void)
{
    if (save_timer) { g_source_remove(save_timer); save_timer = 0; }
    char text[JSON_MAX];
    stored_text(&config, text, sizeof(text));
    if (!text[0] || strcmp(text, saved_text) == 0) return;    //Changed and changed back, so nothing to write

    if (!config_dir_ready) {
        if (g_mkdir_with_parents(CONFIG_DIR, 0755) != 0) {
            log_line("ERROR", "save failed: can't create %s: %s", CONFIG_DIR, strerror(errno));
            return;
        }
        config_dir_ready = true;
    }
    //Atomic, so never a half-written file
    GError *gerr = NULL;
    if (!g_file_set_contents(CONFIG_FILE, text, -1, &gerr)) {
        log_line("ERROR", "save failed: %s", gerr ? gerr->message : "unknown");
        if (gerr) g_error_free(gerr);
        return;
    }
    snprintf(saved_text, sizeof(saved_text), "%s", text);
}

static gboolean save_timer_cb(gpointer data)
{
    (void)data;
    save_timer = 0;
    save_now();
    return G_SOURCE_REMOVE;
}

//Keep on/off in the boot marker (RAM), so a service restart picks it back up
static void write_visible_state(void)
{
    FILE *f = fopen(BOOT_MARKER, "w");
    if (!f) return;     //Worst case, a restart falls back to config.json
    fprintf(f, "{\"visible\":%s}", config_bool(&config, "visible") ? "true" : "false");
    fclose(f);
}

//---------------------------------------------------------------------------------------
//The dot app runs only while the crosshair is on.
//
//Off closes it completely: a loaded floating window, even an empty one, stops the Home
//menu from opening. Relaunching a previously loaded web app takes about 0.4 s.

static void broadcast(void);
static void close_dot(bool force);

//Check if the dot should be on screen right now
static bool wanted(void)
{
    return config_bool(&config, "visible") && (on_input || !config_bool(&config, "hideOutsideInputs"));
}

static bool launch_reply_cb(LSHandle *h, LSMessage *msg, void *ctx)
{
    (void)h; (void)ctx;
    launch_pending = false;
    jvalue_ref r = parse_json(LSMessageGetPayload(msg));
    if (!get_bool(r, "returnValue", false)) {
        char text[256] = "unknown";
        get_string(r, "errorText", text, sizeof(text));
        log_line("ERROR", "launch failed: %s", text);
    } else if (!wanted()) {
        close_dot(true);    //Turned off or hidden again while it was launching
    }
    j_release(&r);
    return true;
}

static void ensure_dot(const char *reason, bool force, bool budgeted)
{
    if (!wanted()) return;
    if (!up_state(power_state) || launch_pending) return;
    if (dot_running == 1 && !force) return;

    if (budgeted) {
        gint64 now = g_get_monotonic_time() / 1000;
        int kept = 0;
        for (int i = 0; i < launch_count; i++) {
            if (now - launch_times[i] < LAUNCH_WINDOW_MS) launch_times[kept++] = launch_times[i];
        }
        launch_count = kept;
        if (launch_count >= LAUNCH_BUDGET) {
            log_line("WARN", "relaunch budget spent, not launching (%s)", reason);
            return;
        }
        launch_times[launch_count++] = now;
    }
    launch_pending = true;
    log_line("INFO", "launching dot app (%s)", reason);
    call_once("luna://com.webos.applicationManager/launch",
              "{\"id\":\"" DOT_APP_ID "\",\"noSplash\":true,\"spinner\":false}",
              launch_reply_cb, NULL);
}

static void close_dot(bool force)
{
    if (dot_running == 0 && !launch_pending && !force) return;
    log_line("INFO", "closing dot app");
    call_once("luna://com.webos.applicationManager/closeByAppId",
              "{\"id\":\"" DOT_APP_ID "\"}", NULL, NULL);
}

static void update_dot(const char *reason)
{
    if (wanted()) ensure_dot(reason, false, false);
    else close_dot(false);
}

static void apply_config(const config_t *next)
{
    bool changed = !config_equal(next, &config);
    bool visibility_changed = config_bool(next, "visible") != config_bool(&config, "visible");
    bool hide_changed = config_bool(next, "hideOutsideInputs") != config_bool(&config, "hideOutsideInputs");
    config = *next;
    if (!changed) return;
    if (visibility_changed) write_visible_state();

    //Only a stored setting needs a save; a change that was undone cancels the pending one
    char text[JSON_MAX];
    stored_text(&config, text, sizeof(text));
    if (save_timer) { g_source_remove(save_timer); save_timer = 0; }
    if (strcmp(text, saved_text) != 0) save_timer = g_timeout_add(SAVE_DELAY_MS, save_timer_cb, NULL);

    broadcast();
    if (visibility_changed) log_line("INFO", "crosshair %s", config_bool(&config, "visible") ? "on" : "off");
    if (visibility_changed || hide_changed) {
        update_dot(visibility_changed ? "turned on" : "hide setting changed");
    }
}

static void set_visible(bool visible)
{
    config_t next = config;
    config_set_bool(&next, "visible", visible);
    apply_config(&next);
}

static void apply_power_on_rule(const char *reason)
{
    bool auto_start = config_bool(&config, "autoStart");
    log_line("INFO", "%s: auto-start %s", reason, auto_start ? "on" : "off");
    set_visible(auto_start);
}

//Build the getConfig reply: settings, HDR, root, and whether this is a subscription
static void config_reply(char *buf, size_t size, bool subscribed, bool with_return)
{
    char c[JSON_MAX];
    if (!config_json(&config, c, sizeof(c), false, NULL)) snprintf(c, sizeof(c), "{}");
    snprintf(buf, size, "{\"config\":%s,\"hdr\":%s,\"elevated\":%s,\"subscribed\":%s%s}",
             c, hdr ? "true" : "false", elevated ? "true" : "false",
             subscribed ? "true" : "false", with_return ? ",\"returnValue\":true" : "");
}

static void broadcast(void)
{
    char payload[JSON_MAX + 256];
    config_reply(payload, sizeof(payload), true, true);
    LSError err;
    LSErrorInit(&err);
    if (!LSSubscriptionReply(sh, "getConfig", payload, &err)) {
        log_line("ERROR", "broadcast failed: %s", err.message ? err.message : "unknown");
        LSErrorFree(&err);
    }
}

//---------------------------------------------------------------------------------------
//Subscriptions to the system. Each one holds a call open; when the other end goes away
//(the hub sends an error), drop it and subscribe again a little later.

typedef struct watch watch_t;
typedef void (*watch_fn)(jvalue_ref payload);

struct watch {
    const char *name;
    const char *uri;
    const char *payload;
    watch_fn on_reply;
    LSMessageToken token;
};

static void watch_start(watch_t *w);

static gboolean watch_retry_cb(gpointer data)
{
    watch_start((watch_t *)data);
    return G_SOURCE_REMOVE;
}

static bool watch_reply_cb(LSHandle *h, LSMessage *msg, void *ctx)
{
    (void)h;
    watch_t *w = (watch_t *)ctx;
    if (LSMessageIsHubErrorMessage(msg)) {
        log_line("WARN", "%s subscription dropped, retrying", w->name);
        LSError err;
        LSErrorInit(&err);
        if (w->token && !LSCallCancel(sh, w->token, &err)) LSErrorFree(&err);
        w->token = 0;
        g_timeout_add_seconds(RESUBSCRIBE_S, watch_retry_cb, w);
        return true;
    }
    jvalue_ref r = parse_json(LSMessageGetPayload(msg));
    if (jis_valid(r)) w->on_reply(r);
    j_release(&r);
    return true;
}

static void watch_start(watch_t *w)
{
    LSError err;
    LSErrorInit(&err);
    if (!LSCall(sh, w->uri, w->payload, watch_reply_cb, w, &w->token, &err)) {
        log_line("WARN", "%s subscription failed (%s), retrying", w->name,
                 err.message ? err.message : "unknown");
        LSErrorFree(&err);
        w->token = 0;
        g_timeout_add_seconds(RESUBSCRIBE_S, watch_retry_cb, w);
    }
}

//HDR detection. The picture settings carry the current dynamic range as a "dimension"
//(seen: "hdrALLM" for HDR10 game content with ALLM), and push a reply when it changes.
static void on_picture(jvalue_ref r)
{
    char range[64];
    if (!get_string(get(r, "dimension"), "dynamicRange", range, sizeof(range))) return;
    char low[64];
    size_t i;
    for (i = 0; range[i] && i < sizeof(low) - 1; i++) low[i] = (char)tolower((unsigned char)range[i]);
    low[i] = '\0';
    bool is_hdr = (strstr(low, "hdr") || strstr(low, "hlg") || strstr(low, "dolby") || strstr(low, "dv"))
        && strncmp(low, "sdr", 3) != 0;
    if (strcmp(range, dynamic_range) != 0) log_line("INFO", "dynamic range %s", range);
    snprintf(dynamic_range, sizeof(dynamic_range), "%s", range);
    if (is_hdr != hdr) {
        hdr = is_hdr;
        broadcast();
    }
}

static void on_running(jvalue_ref r)
{
    jvalue_ref list = get(r, "running");
    if (!list || !jis_array(list)) return;
    int running = 0;
    for (ssize_t i = 0; i < jarray_size(list); i++) {
        char id[128];
        if (get_string(jarray_get(list, i), "id", id, sizeof(id)) && strcmp(id, DOT_APP_ID) == 0) {
            running = 1;
            break;
        }
    }
    if (running != dot_running) {
        dot_running = running;
        if (!running) ensure_dot("dot app not running", false, true);
        else if (!wanted()) close_dot(true);
    }
}

//Match foreground apps that are a TV input (com.webos.app.hdmiN, livetv, externalinput.*).
//Anything else in front (Home, an app) hides the dot.
static bool is_input_app(const char *id)
{
    const char *p = "com.webos.app.";
    if (strncmp(id, p, strlen(p)) != 0) return false;
    id += strlen(p);
    if (strncmp(id, "hdmi", 4) == 0) return isdigit((unsigned char)id[4]) != 0;
    return strncmp(id, "livetv", 6) == 0 || strncmp(id, "externalinput.", 14) == 0;
}

//Watch the foreground app to hide the dot outside inputs. The list has the main app first,
//then anything layered over it (quick settings, our own panel and dot). Only the main app
//decides, so the picture menus over HDMI keep the crosshair.
static void on_foreground(jvalue_ref r)
{
    jvalue_ref list = get(r, "foregroundAppInfo");
    if (!list || !jis_array(list)) return;
    char main_app[256] = "";
    for (ssize_t i = 0; i < jarray_size(list); i++) {
        char id[256];
        if (get_string(jarray_get(list, i), "appId", id, sizeof(id)) && id[0]
            && strncmp(id, OWN_PREFIX, strlen(OWN_PREFIX)) != 0) {
            snprintf(main_app, sizeof(main_app), "%s", id);
            break;
        }
    }
    if (!main_app[0] || strcmp(main_app, foreground_app) == 0) return;
    snprintf(foreground_app, sizeof(foreground_app), "%s", main_app);
    bool input = is_input_app(foreground_app);
    if (input == on_input) return;
    on_input = input;
    if (config_bool(&config, "visible") && config_bool(&config, "hideOutsideInputs")) {
        log_line("INFO", "%s%s", on_input ? "showing on " : "hiding for ", foreground_app);
    }
    char reason[300];
    snprintf(reason, sizeof(reason), "back on %s", foreground_app);
    update_dot(reason);
}

static gboolean wake_cb(gpointer data)
{
    char *reason = (char *)data;
    ensure_dot(reason, true, false);
    g_free(reason);
    return G_SOURCE_REMOVE;
}

static void on_power(jvalue_ref r)
{
    char state[32];
    if (!get_string(r, "state", state, sizeof(state)) || !state[0]) return;
    if (strcmp(state, power_state) == 0) return;
    char previous[32];
    snprintf(previous, sizeof(previous), "%s", power_state);
    snprintf(power_state, sizeof(power_state), "%s", state);
    log_line("INFO", "power state %s -> %s", previous, state);
    //Write any pending settings before a power-down can cut them off
    if (!up_state(state)) save_now();
    if (strcmp(state, "Active") != 0) return;
    //Semi-sleep restores the window by itself and needs nothing.
    if (up_state(previous)) return;
    //A real power-on: apply the auto-start rule. Standby also clears floating windows
    //even if the app stayed loaded, so relaunch unconditionally: on a loaded app that
    //just remaps its window.
    char reason[64];
    snprintf(reason, sizeof(reason), "wake from %s", previous);
    apply_power_on_rule(reason);
    g_timeout_add(WAKE_DELAY_MS, wake_cb, g_strdup(reason));
}

static watch_t watches[] = {
    { "power", "luna://com.webos.service.tvpower/power/getPowerState",
      "{\"subscribe\":true}", on_power, 0 },
    { "running-app", "luna://com.webos.applicationManager/running",
      "{\"subscribe\":true}", on_running, 0 },
    { "foreground", "luna://com.webos.applicationManager/getForegroundAppInfo",
      "{\"subscribe\":true,\"extraInfo\":true}", on_foreground, 0 },
    { "picture settings", "luna://com.webos.settingsservice/getSystemSettings",
      "{\"category\":\"picture\",\"keys\":[\"pictureMode\"],\"subscribe\":true}", on_picture, 0 },
};

//---------------------------------------------------------------------------------------
//Luna methods.

static bool m_get_config(LSHandle *h, LSMessage *msg, void *ctx)
{
    (void)h; (void)ctx;
    bool subscribed = false;
    if (LSMessageIsSubscription(msg)) {
        LSError err;
        LSErrorInit(&err);
        if (LSSubscriptionAdd(sh, "getConfig", msg, &err)) subscribed = true;
        else LSErrorFree(&err);
    }
    char payload[JSON_MAX + 256];
    config_reply(payload, sizeof(payload), subscribed, true);
    reply(msg, payload);
    return true;
}

//The settings panel (or the dot app) closed, so the burst of changes is over
static bool subscription_cancel_cb(LSHandle *h, LSMessage *msg, void *ctx)
{
    (void)h; (void)msg; (void)ctx;
    if (save_timer) save_now();
    return true;
}

static void reply_config(LSMessage *msg)
{
    char c[JSON_MAX], payload[JSON_MAX + 64];
    if (!config_json(&config, c, sizeof(c), false, NULL)) snprintf(c, sizeof(c), "{}");
    snprintf(payload, sizeof(payload), "{\"config\":%s,\"returnValue\":true}", c);
    reply(msg, payload);
}

static bool m_set_config(LSHandle *h, LSMessage *msg, void *ctx)
{
    (void)h; (void)ctx;
    jvalue_ref r = parse_json(LSMessageGetPayload(msg));
    jvalue_ref patch = get(r, "config");
    if (!patch || !jis_object(patch)) {
        reply(msg, "{\"returnValue\":false,\"errorText\":\"config object required\"}");
        j_release(&r);
        return true;
    }
    config_t next;
    config_merge(&next, &config, patch);
    j_release(&r);
    apply_config(&next);
    reply_config(msg);
    return true;
}

static bool m_reset_config(LSHandle *h, LSMessage *msg, void *ctx)
{
    (void)h; (void)ctx;
    static const char *keep[] = { "visible", "autoStart", "tripleOpensSettings", "hideOutsideInputs" };
    config_t next;
    config_defaults(&next);
    for (size_t i = 0; i < G_N_ELEMENTS(keep); i++) {
        config_set_bool(&next, keep[i], config_bool(&config, keep[i]));
    }
    apply_config(&next);
    reply_config(msg);
    return true;
}

static void reply_visible(LSMessage *msg)
{
    reply(msg, config_bool(&config, "visible") ? "{\"visible\":true,\"returnValue\":true}"
                                               : "{\"visible\":false,\"returnValue\":true}");
}

static bool m_show(LSHandle *h, LSMessage *msg, void *ctx)
{
    (void)h; (void)ctx;
    set_visible(true);
    reply_visible(msg);
    return true;
}

static bool m_hide(LSHandle *h, LSMessage *msg, void *ctx)
{
    (void)h; (void)ctx;
    set_visible(false);
    reply_visible(msg);
    return true;
}

static bool m_toggle(LSHandle *h, LSMessage *msg, void *ctx)
{
    (void)h; (void)ctx;
    set_visible(!config_bool(&config, "visible"));
    reply_visible(msg);
    return true;
}

static bool settings_launch_cb(LSHandle *h, LSMessage *msg, void *ctx)
{
    (void)h; (void)ctx;
    jvalue_ref r = parse_json(LSMessageGetPayload(msg));
    if (!get_bool(r, "returnValue", false)) {
        char text[256] = "unknown";
        get_string(r, "errorText", text, sizeof(text));
        log_line("ERROR", "settings launch failed: %s", text);
    }
    j_release(&r);
    return true;
}

static gboolean press_timer_cb(gpointer data)
{
    (void)data;
    if (press_count == 2) set_visible(!config_bool(&config, "visible"));
    press_count = 0;
    press_timer = 0;
    return G_SOURCE_REMOVE;
}

//Handle the remote button. The first press toggles right away, so a single press feels
//instant. A second quick press is held back: on its own it toggles back once the gesture
//ends, so two presses leave things as they were. A third quick press undoes the first
//toggle and opens the settings panel instead.
static bool m_button(LSHandle *h, LSMessage *msg, void *ctx)
{
    (void)h; (void)ctx;
    reply(msg, "{\"returnValue\":true}");
    if (!config_bool(&config, "tripleOpensSettings")) {
        set_visible(!config_bool(&config, "visible"));
        return true;
    }
    press_count++;
    log_line("INFO", "button press %d", press_count);
    if (press_timer) { g_source_remove(press_timer); press_timer = 0; }
    if (press_count == 1) {
        set_visible(!config_bool(&config, "visible"));
    } else if (press_count == 3) {
        press_count = 0;
        log_line("INFO", "triple press: opening settings");
        set_visible(!config_bool(&config, "visible"));
        call_once("luna://com.webos.applicationManager/launch",
                  "{\"id\":\"" SETTINGS_APP_ID "\"}", settings_launch_cb, NULL);
        return true;
    }
    press_timer = g_timeout_add(PRESS_GAP_MS, press_timer_cb, NULL);
    return true;
}

static bool m_status(LSHandle *h, LSMessage *msg, void *ctx)
{
    (void)h; (void)ctx;
    char c[JSON_MAX], fg[600], range[160], power[80];
    char payload[JSON_MAX + 1024];
    if (!config_json(&config, c, sizeof(c), false, NULL)) snprintf(c, sizeof(c), "{}");
    json_quote(foreground_app, fg, sizeof(fg));
    json_quote(dynamic_range, range, sizeof(range));
    json_quote(power_state, power, sizeof(power));
    snprintf(payload, sizeof(payload),
             "{\"config\":%s,\"dotLoaded\":%s,\"powerState\":%s,\"hdr\":%s,\"dynamicRange\":%s,"
             "\"elevated\":%s,\"foregroundApp\":%s,\"onInput\":%s,\"engine\":\"native\","
             "\"returnValue\":true}",
             c, dot_running == 1 ? "true" : "false", power, hdr ? "true" : "false", range,
             elevated ? "true" : "false", fg, on_input ? "true" : "false");
    reply(msg, payload);
    return true;
}

static bool m_start(LSHandle *h, LSMessage *msg, void *ctx)
{
    (void)h; (void)ctx;
    ensure_dot("start", false, false);
    reply(msg, "{\"started\":true,\"returnValue\":true}");
    return true;
}

static LSMethod methods[] = {
    { "getConfig", m_get_config, LUNA_METHOD_FLAGS_NONE },
    { "setConfig", m_set_config, LUNA_METHOD_FLAGS_NONE },
    { "resetConfig", m_reset_config, LUNA_METHOD_FLAGS_NONE },
    { "show", m_show, LUNA_METHOD_FLAGS_NONE },
    { "hide", m_hide, LUNA_METHOD_FLAGS_NONE },
    { "toggle", m_toggle, LUNA_METHOD_FLAGS_NONE },
    { "button", m_button, LUNA_METHOD_FLAGS_NONE },
    { "status", m_status, LUNA_METHOD_FLAGS_NONE },
    { "start", m_start, LUNA_METHOD_FLAGS_NONE },
    { NULL, NULL, LUNA_METHOD_FLAGS_NONE },
};

//---------------------------------------------------------------------------------------

//Save pending settings and stop cleanly when told to (deploy, shutdown)
static gboolean on_term(gpointer data)
{
    (void)data;
    log_line("INFO", "stopping");
    save_now();
    g_main_loop_quit(loop);
    return G_SOURCE_REMOVE;
}

static bool fail(const char *what, LSError *err)
{
    log_line("ERROR", "%s: %s", what, err->message ? err->message : "unknown");
    LSErrorFree(err);
    return false;
}

static int service_main(void)
{
    LSError err;
    LSErrorInit(&err);
    elevated = getuid() == 0;
    load_config();

    loop = g_main_loop_new(NULL, FALSE);
    //A failed setup won't fix itself on a retry (most often another copy already owns the
    //bus name), so these exit with EXIT_NO_RESTART and the supervisor stops too.
    if (!LSRegister(SERVICE_ID, &sh, &err)) return fail("register", &err), EXIT_NO_RESTART;
    if (!LSRegisterCategory(sh, "/", methods, NULL, NULL, &err)) {
        return fail("register methods", &err), EXIT_NO_RESTART;
    }
    if (!LSSubscriptionSetCancelFunction(sh, subscription_cancel_cb, NULL, &err)) fail("cancel hook", &err);
    if (!LSGmainAttach(sh, loop, &err)) return fail("attach main loop", &err), EXIT_NO_RESTART;
    g_unix_signal_add(SIGTERM, on_term, NULL);
    g_unix_signal_add(SIGINT, on_term, NULL);

    log_line("INFO", "service started (native)%s", elevated ? "" : " WITHOUT ROOT (not elevated)");
    if (access(BOOT_MARKER, F_OK) != 0) {
        //Write the marker first, so it exists even when the rule leaves on/off as it was.
        //Worst case (can't write it), the rule runs again on the next start.
        write_visible_state();
        apply_power_on_rule("boot");
    }
    for (size_t i = 0; i < G_N_ELEMENTS(watches); i++) watch_start(&watches[i]);

    g_main_loop_run(loop);

    if (!LSUnregister(sh, &err)) LSErrorFree(&err);
    g_main_loop_unref(loop);
    if (log_fp) fclose(log_fp);
    return 0;
}

//---------------------------------------------------------------------------------------
//Crash recovery. The process the hub starts is a small supervisor that runs the service
//in a child and starts it again if it dies abnormally (crash, abort, or kill), so the
//crosshair keeps following power, Home, and the button without waiting for the next call
//to wake the hub. The child holds all the state and the bus connection; the supervisor
//only waits.

static volatile sig_atomic_t stop_requested;
static volatile pid_t child_pid;

//Pass a stop on to the service, and don't restart it afterwards
static void supervisor_signal(int sig)
{
    stop_requested = 1;
    if (child_pid > 0) kill(child_pid, sig);
}

static int supervise(void)
{
    struct sigaction sa;
    memset(&sa, 0, sizeof(sa));
    sa.sa_handler = supervisor_signal;
    sigemptyset(&sa.sa_mask);
    sigaction(SIGTERM, &sa, NULL);
    sigaction(SIGINT, &sa, NULL);

    gint64 starts[RESTART_BUDGET];
    int count = 0;
    for (;;) {
        //Failsafe: a service that keeps crashing (say, right at startup) gives up instead
        //of looping forever. The next call to it starts a fresh supervisor.
        gint64 now = g_get_monotonic_time() / G_USEC_PER_SEC;
        int kept = 0;
        for (int i = 0; i < count; i++) {
            if (now - starts[i] < RESTART_WINDOW_S) starts[kept++] = starts[i];
        }
        count = kept;
        if (count >= RESTART_BUDGET) {
            log_line("ERROR", "service died %d times in %d s, giving up", RESTART_BUDGET, RESTART_WINDOW_S);
            return 1;
        }
        starts[count++] = now;

        pid_t pid = fork();
        if (pid < 0) {
            log_line("ERROR", "can't start the service: %s", strerror(errno));
            return 1;
        }
        if (pid == 0) {
            signal(SIGTERM, SIG_DFL);
            signal(SIGINT, SIG_DFL);
            _exit(service_main());
        }
        child_pid = pid;

        int status;
        while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {}
        child_pid = 0;
        log_size = -1;      //The service wrote to the log meanwhile, so measure it again
        if (stop_requested) return 0;
        if (WIFEXITED(status)) {
            int code = WEXITSTATUS(status);
            if (code == 0 || code == EXIT_NO_RESTART) return code;
            log_line("WARN", "service exited with code %d, restarting", code);
        } else if (WIFSIGNALED(status)) {
            log_line("WARN", "service crashed (signal %d), restarting", WTERMSIG(status));
        }
        //Let the hub notice the old connection is gone before the new one registers
        sleep(RESTART_DELAY_S);
        if (stop_requested) return 0;
    }
}

int main(void)
{
    return supervise();
}
