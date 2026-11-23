/*
 * com.abbiedoobie.crosshair.service: keeps the settings and loads or closes the app (dot and
 * settings panel, one floating web app) to match. Runs as root through Homebrew Channel's
 * elevate-service. Event driven: four subscriptions (power, running apps, foreground app, and
 * picture settings for HDR), nothing running between events.
 *
 * Methods (luna://com.abbiedoobie.crosshair.service/<method>):
 *   getConfig {subscribe}   settings, show (dot should be on screen), hdr, and elevated. With
 *                           panel: true, the subscription keeps the app loaded until cancelled
 *   setConfig {config}      apply a partial settings object (invalid fields are skipped)
 *   resetConfig             look settings back to defaults (on/off and the switches are kept)
 *   show / hide / toggle    turn the crosshair on or off
 *   button                  remote button, from Input Hook. One press toggles, three quick
 *                           presses open the panel (if tripleOpensSettings)
 *   status                  settings plus app, panel, power, and input state
 *   start                   no-op, so the boot hook can start the service
 *   restart                 save and exit, so the next call starts it fresh (as root, once elevated)
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
#include <syslog.h>
#include <luna-service2/lunaservice.h>
#include <pbnjson.h>

#include "config.h"

#define SERVICE_ID "com.abbiedoobie.crosshair.service"
#define APP_ID "com.abbiedoobie.crosshair"
#define OWN_PREFIX "com.abbiedoobie.crosshair"
#define CONFIG_DIR "/home/root/.config/com.abbiedoobie.crosshair"
#define CONFIG_FILE CONFIG_DIR "/config.json"
#define LOG_IDENT "com.abbiedoobie.crosshair"
//The /tmp folder is RAM and emptied every boot, so no marker means first start since boot
//(not a reinstall or crash restart). It also holds on/off, so toggling never writes to storage.
#define BOOT_MARKER "/tmp/com.abbiedoobie.crosshair.booted"

//Boot hook, run as root by Homebrew Channel (run-parts, so no dots in the name). Removes
//itself if Crosshair is uninstalled, re-elevates the service (an update drops root), and
//starts it. Backgrounded so it doesn't hold up the other hooks.
#define BOOT_HOOK "/var/lib/webosbrew/init.d/95-abbiedoobie-crosshair"
#define BOOT_HOOK_TEXT \
    "#!/bin/sh\n" \
    "#Crosshair boot hook, written by its service (" SERVICE_ID ")\n" \
    "SERVICE=" SERVICE_ID "\n" \
    "[ -d /media/developer/apps/usr/palm/services/$SERVICE ] || { rm -f \"$0\"; exit 0; }\n" \
    "(\n" \
    "    /media/developer/apps/usr/palm/services/org.webosbrew.hbchannel.service/elevate-service $SERVICE\n" \
    "    luna-send -n 1 luna://$SERVICE/start '{}'\n" \
    ") >/dev/null 2>&1 &\n" \
    "exit 0\n"

//Save once a burst of panel changes goes quiet (or right away on panel close or power-down)
#define SAVE_DELAY_MS 10000
#define WAKE_DELAY_MS 1500          //Let the compositor settle after the screen comes on
#define PANEL_GRACE_MS 10000        //Keep an app launched for its panel this long for the panel to open
//Failsafe: cap relaunches of an app that died by itself, so a crashing app can't loop forever
//(launches from on/off, inputs, and waking don't count)
#define LAUNCH_WINDOW_MS 60000
#define LAUNCH_BUDGET 5
//Max gap between presses of one gesture. A press lands ~30 ms after lginput2 sees it, so this is generous.
#define PRESS_GAP_MS 600
#define RESUBSCRIBE_S 5
//Crash recovery: restart after RESTART_DELAY_S, at most RESTART_BUDGET times in RESTART_WINDOW_S.
//EXIT_NO_RESTART = setup failed, so a restart can't help.
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
static char power_state[32] = "Active";
static int app_running = -1;        //-1 = no reply yet. 1 = loaded. 0 = not running.
static bool panel_open;             //The panel holds a getConfig subscription with panel: true
static guint grace_timer;           //Running while a panel is expected (expect_panel)
static char foreground_app[256];    //The app in front, from the foreground subscription
static bool on_input = true;        //An input is in front (assumed until the first reply)
static bool hdr;                    //The TV is showing an HDR picture (picks hdrBrightness)
static char dynamic_range[64];
static gint64 launch_times[LAUNCH_BUDGET];
static int launch_count;
static bool launch_pending;
static bool elevated;               //Running as root (without it, settings in /home/root aren't kept)
static int press_count;
static guint press_timer;

//---------------------------------------------------------------------------------------
//Logging, through syslog, which the TV keeps in /var/log/legacy-log (RAM). PmLog would be the
//webOS way, but the TV drops homebrew PmLog lines unless dev log recording is on.
//Start, stop, warnings, and errors always log; everything else only with Verbose logging on.
//Each line starts with an ID for grepping.

static void log_msg(int priority, const char *msgid, const char *fmt, ...) G_GNUC_PRINTF(3, 4);

static void log_msg(int priority, const char *msgid, const char *fmt, ...)
{
    static bool opened;
    if (!opened) {
        openlog(LOG_IDENT, LOG_PID, LOG_USER);
        opened = true;
    }
    char text[512];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(text, sizeof(text), fmt, ap);
    va_end(ap);
    syslog(priority, "%s %s", msgid, text);
}

#define log_error(id, ...) log_msg(LOG_ERR, id, __VA_ARGS__)
#define log_warn(id, ...) log_msg(LOG_WARNING, id, __VA_ARGS__)
#define log_info(id, ...) log_msg(LOG_INFO, id, __VA_ARGS__)
#define log_verbose(id, ...) \
    do { if (config_bool(&config, "verboseLogging")) log_msg(LOG_INFO, id, __VA_ARGS__); } while (0)

//---------------------------------------------------------------------------------------
//Small JSON helpers

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
        log_error("REPLY_FAILED", "reply failed: %s", err.message ? err.message : "unknown");
        LSErrorFree(&err);
    }
}

//Send a one-reply call. `cb` may be NULL when the reply doesn't matter.
static void call_once(const char *uri, const char *payload, LSFilterFunc cb, void *ctx)
{
    LSError err;
    LSErrorInit(&err);
    if (!LSCallOneReply(sh, uri, payload, cb, ctx, NULL, &err)) {
        log_error("CALL_FAILED", "call %s failed: %s", uri, err.message ? err.message : "unknown");
        LSErrorFree(&err);
    }
}

//---------------------------------------------------------------------------------------
//Settings storage

//Check if apps keep running in this power state. "Screen Off" is the dim semi-sleep: the
//compositor hides the dot itself and brings it back on wake.
static bool up_state(const char *state)
{
    return strcmp(state, "Active") == 0 || strcmp(state, "Screen Off") == 0;
}

//Build the text config.json should hold. On/off is left out: the power-on rule sets it every
//boot, and the boot marker covers restarts.
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

    //On a restart since boot, on/off comes from the marker
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
            log_error("SAVE_FAILED", "save failed: can't create %s: %s", CONFIG_DIR, strerror(errno));
            return;
        }
        config_dir_ready = true;
    }
    //Atomic, so never a half-written file
    GError *gerr = NULL;
    if (!g_file_set_contents(CONFIG_FILE, text, -1, &gerr)) {
        log_error("SAVE_FAILED", "save failed: %s", gerr ? gerr->message : "unknown");
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
    if (!f) return;     //Worst case, a restart comes back with it off
    fprintf(f, "{\"visible\":%s}", config_bool(&config, "visible") ? "true" : "false");
    fclose(f);
}

//---------------------------------------------------------------------------------------
//App lifetime. The app runs only while the dot should show or the panel is open, since a
//loaded floating window (even an empty one) blocks the Home menu. Relaunching takes ~0.4 s.

static void broadcast(void);
static void close_app(bool force);

//Check if the dot should be on screen right now
static bool dot_wanted(void)
{
    return config_bool(&config, "visible") && (on_input || !config_bool(&config, "hideOutsideInputs"));
}

//Check if the app should be loaded right now
static bool app_wanted(void)
{
    return panel_open || grace_timer || dot_wanted();
}

static bool launch_reply_cb(LSHandle *h, LSMessage *msg, void *ctx)
{
    (void)h; (void)ctx;
    launch_pending = false;
    jvalue_ref r = parse_json(LSMessageGetPayload(msg));
    if (!get_bool(r, "returnValue", false)) {
        char text[256] = "unknown";
        get_string(r, "errorText", text, sizeof(text));
        log_error("LAUNCH_FAILED", "launch failed: %s", text);
    } else if (!app_wanted()) {
        close_app(true);    //Turned off or hidden again while it was launching
    }
    j_release(&r);
    return true;
}

//Launch the app for the dot. The dot parameter tells the page not to open its panel.
static void ensure_app(const char *reason, bool force, bool budgeted)
{
    if (!app_wanted()) return;
    if (!up_state(power_state) || launch_pending) return;
    if (app_running == 1 && !force) return;

    if (budgeted) {
        gint64 now = g_get_monotonic_time() / 1000;
        int kept = 0;
        for (int i = 0; i < launch_count; i++) {
            if (now - launch_times[i] < LAUNCH_WINDOW_MS) launch_times[kept++] = launch_times[i];
        }
        launch_count = kept;
        if (launch_count >= LAUNCH_BUDGET) {
            log_warn("RELAUNCH_BUDGET", "relaunch budget spent, not launching (%s)", reason);
            return;
        }
        launch_times[launch_count++] = now;
    }
    launch_pending = true;
    log_verbose("APP_LAUNCH", "launching app (%s)", reason);
    call_once("luna://com.webos.applicationManager/launch",
              "{\"id\":\"" APP_ID "\",\"params\":{\"dot\":true},\"noSplash\":true,\"spinner\":false}",
              launch_reply_cb, NULL);
}

static void close_app(bool force)
{
    if (app_running == 0 && !launch_pending && !force) return;
    log_verbose("APP_CLOSE", "closing app");
    call_once("luna://com.webos.applicationManager/closeByAppId",
              "{\"id\":\"" APP_ID "\"}", NULL, NULL);
}

static void update_app(const char *reason)
{
    if (app_wanted()) ensure_app(reason, false, false);
    else close_app(false);
}

static void apply_config(const config_t *next)
{
    bool changed = !config_equal(next, &config);
    bool visibility_changed = config_bool(next, "visible") != config_bool(&config, "visible");
    bool hide_changed = config_bool(next, "hideOutsideInputs") != config_bool(&config, "hideOutsideInputs");
    bool verbose_changed = config_bool(next, "verboseLogging") != config_bool(&config, "verboseLogging");
    config = *next;
    if (!changed) return;
    if (verbose_changed) log_info("VERBOSE_LOGGING", "verbose logging %s", config_bool(&config, "verboseLogging") ? "on" : "off");
    if (visibility_changed) write_visible_state();

    //Only a stored setting needs a save; a change that was undone cancels the pending one
    char text[JSON_MAX];
    stored_text(&config, text, sizeof(text));
    if (save_timer) { g_source_remove(save_timer); save_timer = 0; }
    if (strcmp(text, saved_text) != 0) save_timer = g_timeout_add(SAVE_DELAY_MS, save_timer_cb, NULL);

    broadcast();
    if (visibility_changed) log_verbose("CROSSHAIR", "crosshair %s", config_bool(&config, "visible") ? "on" : "off");
    if (visibility_changed || hide_changed) {
        update_app(!visibility_changed ? "hide setting changed"
                   : config_bool(&config, "visible") ? "turned on" : "turned off");
    }
}

static void set_visible(bool visible)
{
    config_t next = config;
    config_set_bool(&next, "visible", visible);
    apply_config(&next);
}

//Power-on rule: after a boot or a wake from standby, on/off follows auto-start
static void apply_power_on_rule(const char *reason)
{
    bool auto_start = config_bool(&config, "autoStart");
    log_verbose("POWER_ON_RULE", "%s: auto-start %s", reason, auto_start ? "on" : "off");
    set_visible(auto_start);
}

//Build the getConfig reply
static void config_reply(char *buf, size_t size, bool subscribed, bool with_return)
{
    char c[JSON_MAX];
    if (!config_json(&config, c, sizeof(c), false, NULL)) snprintf(c, sizeof(c), "{}");
    snprintf(buf, size, "{\"config\":%s,\"show\":%s,\"hdr\":%s,\"elevated\":%s,\"subscribed\":%s%s}",
             c, dot_wanted() ? "true" : "false", hdr ? "true" : "false",
             elevated ? "true" : "false", subscribed ? "true" : "false",
             with_return ? ",\"returnValue\":true" : "");
}

static void broadcast(void)
{
    char payload[JSON_MAX + 256];
    config_reply(payload, sizeof(payload), true, true);
    static const char *keys[] = { "getConfig", "panel" };
    for (size_t i = 0; i < G_N_ELEMENTS(keys); i++) {
        LSError err;
        LSErrorInit(&err);
        if (!LSSubscriptionReply(sh, keys[i], payload, &err)) {
            log_error("BROADCAST_FAILED", "broadcast failed: %s", err.message ? err.message : "unknown");
            LSErrorFree(&err);
        }
    }
}

//---------------------------------------------------------------------------------------
//System subscriptions. When the other end goes away (the hub sends an error), drop it and
//subscribe again a little later.

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
        log_warn("SUBSCRIPTION", "%s subscription dropped, retrying", w->name);
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
        log_warn("SUBSCRIPTION", "%s subscription failed (%s), retrying", w->name,
                 err.message ? err.message : "unknown");
        LSErrorFree(&err);
        w->token = 0;
        g_timeout_add_seconds(RESUBSCRIBE_S, watch_retry_cb, w);
    }
}

//Detect HDR from the picture settings' dynamic range "dimension" (seen: "hdrALLM" for HDR10
//games with ALLM)
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
    if (strcmp(range, dynamic_range) != 0) log_verbose("DYNAMIC_RANGE", "dynamic range %s", range);
    snprintf(dynamic_range, sizeof(dynamic_range), "%s", range);
    if (is_hdr != hdr) {
        hdr = is_hdr;
        broadcast();
    }
}

static gboolean grace_cb(gpointer data)
{
    (void)data;
    grace_timer = 0;
    if (app_running == 1 && !app_wanted()) {
        log_verbose("PANEL_TIMEOUT", "app started but its panel never opened");
        close_app(true);
    }
    return G_SOURCE_REMOVE;
}

//Keep the app while its panel opens, so a close meant for the dot (the crosshair turned
//off, or a launch reply arriving late) doesn't take the panel with it
static void expect_panel(void)
{
    if (panel_open) return;
    if (grace_timer) g_source_remove(grace_timer);
    grace_timer = g_timeout_add(PANEL_GRACE_MS, grace_cb, NULL);
}

static void on_running(jvalue_ref r)
{
    jvalue_ref list = get(r, "running");
    if (!list || !jis_array(list)) return;
    int running = 0;
    for (ssize_t i = 0; i < jarray_size(list); i++) {
        char id[128];
        if (get_string(jarray_get(list, i), "id", id, sizeof(id)) && strcmp(id, APP_ID) == 0) {
            running = 1;
            break;
        }
    }
    if (running != app_running) {
        app_running = running;
        if (!running) ensure_app("app not running", false, true);
        //Started by something other than the service (the app list): it's for the panel
        else if (!app_wanted()) expect_panel();
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

//Hide the dot outside inputs. The list has the main app first, then anything layered over it
//(quick settings, our own app). Only the main app decides, so menus over HDMI keep the crosshair.
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
        log_verbose("FOREGROUND", "%s%s", on_input ? "showing on " : "hiding for ", foreground_app);
        broadcast();
    }
    char reason[300];
    snprintf(reason, sizeof(reason), "back on %s", foreground_app);
    update_app(reason);
}

static gboolean wake_cb(gpointer data)
{
    char *reason = (char *)data;
    ensure_app(reason, true, false);
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
    log_verbose("POWER_STATE", "power state %s -> %s", previous, state);
    //Write any pending settings before a power-down can cut them off
    if (!up_state(state)) save_now();
    if (strcmp(state, "Active") != 0) return;
    //Semi-sleep restores the window by itself
    if (up_state(previous)) return;
    //Real power-on: apply auto-start. Standby drops floating windows even with the app still
    //loaded, so relaunch regardless (a loaded app just remaps its window).
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
//Luna methods

//Count the panel's subscriptions to see if it's open, and load or close the app to match
static void update_panel(void)
{
    bool open = LSSubscriptionGetHandleSubscribersCount(sh, "panel") > 0;
    if (open == panel_open) return;
    panel_open = open;
    log_verbose("PANEL", "panel %s", open ? "opened" : "closed");
    if (open && grace_timer) { g_source_remove(grace_timer); grace_timer = 0; }
    update_app(open ? "panel opened" : "panel closed");
}

static bool m_get_config(LSHandle *h, LSMessage *msg, void *ctx)
{
    (void)h; (void)ctx;
    bool subscribed = false;
    bool panel = false;
    if (LSMessageIsSubscription(msg)) {
        jvalue_ref r = parse_json(LSMessageGetPayload(msg));
        panel = get_bool(r, "panel", false);
        j_release(&r);
        LSError err;
        LSErrorInit(&err);
        if (LSSubscriptionAdd(sh, panel ? "panel" : "getConfig", msg, &err)) subscribed = true;
        else LSErrorFree(&err);
    }
    char payload[JSON_MAX + 256];
    config_reply(payload, sizeof(payload), subscribed, true);
    reply(msg, payload);
    if (panel) update_panel();
    return true;
}

static gboolean panel_check_cb(gpointer data)
{
    (void)data;
    update_panel();
    return G_SOURCE_REMOVE;
}

//Save now when a subscriber leaves (if it was the panel, the burst of changes is over). The
//panel count is checked on idle, once the hub has dropped the subscription.
static bool subscription_cancel_cb(LSHandle *h, LSMessage *msg, void *ctx)
{
    (void)h; (void)msg; (void)ctx;
    if (save_timer) save_now();
    g_idle_add(panel_check_cb, NULL);
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
    static const char *keep[] = { "visible", "autoStart", "tripleOpensSettings", "hideOutsideInputs",
                                  "verboseLogging" };
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
        log_error("LAUNCH_FAILED", "settings launch failed: %s", text);
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

//Handle the remote button. Press 1 toggles right away so it feels instant. Press 2 is held
//back and toggles back once the gesture ends (two presses = no change). Press 3 undoes the
//first toggle and opens the panel instead.
static bool m_button(LSHandle *h, LSMessage *msg, void *ctx)
{
    (void)h; (void)ctx;
    reply(msg, "{\"returnValue\":true}");
    if (!config_bool(&config, "tripleOpensSettings")) {
        set_visible(!config_bool(&config, "visible"));
        return true;
    }
    press_count++;
    log_verbose("BUTTON", "button press %d", press_count);
    if (press_timer) { g_source_remove(press_timer); press_timer = 0; }
    if (press_count == 1) {
        set_visible(!config_bool(&config, "visible"));
    } else if (press_count == 3) {
        press_count = 0;
        log_verbose("BUTTON", "triple press: opening settings");
        expect_panel();
        set_visible(!config_bool(&config, "visible"));
        call_once("luna://com.webos.applicationManager/launch",
                  "{\"id\":\"" APP_ID "\",\"params\":{\"panel\":true}}", settings_launch_cb, NULL);
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
             "{\"config\":%s,\"appLoaded\":%s,\"panelOpen\":%s,\"show\":%s,\"powerState\":%s,\"hdr\":%s,\"dynamicRange\":%s,"
             "\"elevated\":%s,\"foregroundApp\":%s,\"onInput\":%s,"
             "\"returnValue\":true}",
             c, app_running == 1 ? "true" : "false", panel_open ? "true" : "false",
             dot_wanted() ? "true" : "false", power, hdr ? "true" : "false", range,
             elevated ? "true" : "false", fg, on_input ? "true" : "false");
    reply(msg, payload);
    return true;
}

//Exit cleanly after the reply goes out. The supervisor leaves a clean exit alone, so the hub
//starts a fresh service on the next call.
static gboolean restart_cb(gpointer data)
{
    (void)data;
    log_info("RESTART_REQUEST", "restarting on request");
    save_now();
    g_main_loop_quit(loop);
    return G_SOURCE_REMOVE;
}

static bool m_restart(LSHandle *h, LSMessage *msg, void *ctx)
{
    (void)h; (void)ctx;
    reply(msg, "{\"returnValue\":true}");
    g_timeout_add(200, restart_cb, NULL);
    return true;
}

static bool m_start(LSHandle *h, LSMessage *msg, void *ctx)
{
    (void)h; (void)ctx;
    ensure_app("start", false, false);
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
    { "restart", m_restart, LUNA_METHOD_FLAGS_NONE },
    { NULL, NULL, LUNA_METHOD_FLAGS_NONE },
};

//---------------------------------------------------------------------------------------

//Save pending settings and stop cleanly when told to (deploy, shutdown)
static gboolean on_term(gpointer data)
{
    (void)data;
    log_info("STOPPING", "stopping");
    save_now();
    g_main_loop_quit(loop);
    return G_SOURCE_REMOVE;
}

//Write the boot hook if it's missing or out of date
static void install_boot_hook(void)
{
    char *current = read_file(BOOT_HOOK);
    bool same = current && strcmp(current, BOOT_HOOK_TEXT) == 0;
    g_free(current);
    if (same) return;
    GError *gerr = NULL;
    if (g_mkdir_with_parents("/var/lib/webosbrew/init.d", 0755) != 0
        || !g_file_set_contents(BOOT_HOOK, BOOT_HOOK_TEXT, -1, &gerr) || chmod(BOOT_HOOK, 0755) != 0) {
        log_error("BOOT_HOOK", "can't write %s: %s", BOOT_HOOK, gerr ? gerr->message : strerror(errno));
        if (gerr) g_error_free(gerr);
        return;
    }
    log_info("BOOT_HOOK", "installed %s", BOOT_HOOK);
}

static bool fail(const char *what, LSError *err)
{
    log_error("SETUP_FAILED", "%s: %s", what, err->message ? err->message : "unknown");
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
    //A failed setup won't fix itself on a retry (usually another copy owns the bus name), so
    //exit with EXIT_NO_RESTART to stop the supervisor too
    if (!LSRegister(SERVICE_ID, &sh, &err)) return fail("register", &err), EXIT_NO_RESTART;
    if (!LSRegisterCategory(sh, "/", methods, NULL, NULL, &err)) {
        return fail("register methods", &err), EXIT_NO_RESTART;
    }
    if (!LSSubscriptionSetCancelFunction(sh, subscription_cancel_cb, NULL, &err)) fail("cancel hook", &err);
    if (!LSGmainAttach(sh, loop, &err)) return fail("attach main loop", &err), EXIT_NO_RESTART;
    g_unix_signal_add(SIGTERM, on_term, NULL);
    g_unix_signal_add(SIGINT, on_term, NULL);

    log_info("STARTED", "service started");
    if (elevated) install_boot_hook();
    else log_warn("NOT_ROOT", "running without root (not elevated): settings may not be kept");
    if (access(BOOT_MARKER, F_OK) != 0) {
        //Write the marker first, since the rule only writes it when on/off changes. If it
        //can't be written, the rule just runs again next start.
        write_visible_state();
        apply_power_on_rule("boot");
    }
    for (size_t i = 0; i < G_N_ELEMENTS(watches); i++) watch_start(&watches[i]);

    g_main_loop_run(loop);

    if (!LSUnregister(sh, &err)) LSErrorFree(&err);
    g_main_loop_unref(loop);
    return 0;
}

//---------------------------------------------------------------------------------------
//Crash recovery. The process the hub starts is a small supervisor that runs the service in a
//child and restarts it if it dies abnormally (crash, abort, or kill), so power, Home, and the
//button keep working without waiting for the next call to wake the hub.

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
    sigset_t stop_signals, old_mask;
    sigemptyset(&stop_signals);
    sigaddset(&stop_signals, SIGTERM);
    sigaddset(&stop_signals, SIGINT);

    gint64 starts[RESTART_BUDGET];
    int count = 0;
    for (;;) {
        //Failsafe: give up on a service that keeps crashing (say, at startup). The next call
        //starts a fresh supervisor.
        gint64 now = g_get_monotonic_time() / G_USEC_PER_SEC;
        int kept = 0;
        for (int i = 0; i < count; i++) {
            if (now - starts[i] < RESTART_WINDOW_S) starts[kept++] = starts[i];
        }
        count = kept;
        if (count >= RESTART_BUDGET) {
            log_error("GAVE_UP", "service died %d times in %d s, giving up", RESTART_BUDGET, RESTART_WINDOW_S);
            return 1;
        }
        starts[count++] = now;

        //Hold stops until child_pid is set and the child has its own handlers, so a stop
        //can't slip in between and get lost (the supervisor would then wait forever)
        sigprocmask(SIG_BLOCK, &stop_signals, &old_mask);
        if (stop_requested) {
            sigprocmask(SIG_SETMASK, &old_mask, NULL);
            return 0;
        }
        pid_t pid = fork();
        if (pid == 0) {
            signal(SIGTERM, SIG_DFL);
            signal(SIGINT, SIG_DFL);
            sigprocmask(SIG_SETMASK, &old_mask, NULL);
            _exit(service_main());
        }
        if (pid > 0) child_pid = pid;
        sigprocmask(SIG_SETMASK, &old_mask, NULL);      //A held stop is handled here
        if (pid < 0) {
            log_error("FORK_FAILED", "can't start the service: %s", strerror(errno));
            return 1;
        }

        int status;
        while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {}
        child_pid = 0;
        if (stop_requested) return 0;
        if (WIFEXITED(status)) {
            int code = WEXITSTATUS(status);
            if (code == 0 || code == EXIT_NO_RESTART) return code;
            log_warn("RESTARTING", "service exited with code %d, restarting", code);
        } else if (WIFSIGNALED(status)) {
            log_warn("RESTARTING", "service crashed (signal %d), restarting", WTERMSIG(status));
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
