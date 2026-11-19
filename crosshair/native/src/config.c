/*
 * Settings validation, ported from merge() and clampNumber() in crosshair/shared/config.js.
 * Keep the two in step: same skips, same clamping, same snapping to the step.
 */
#include "config.h"

#include <ctype.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int config_field(const char *name)
{
    for (int i = 0; i < FIELD_COUNT; i++) {
        if (strcmp(FIELDS[i].name, name) == 0) return i;
    }
    return -1;
}

void config_defaults(config_t *c)
{
    memset(c, 0, sizeof(*c));
    for (int i = 0; i < FIELD_COUNT; i++) {
        const field_t *f = &FIELDS[i];
        if (f->type == F_BOOL) c->v[i].b = f->def_b;
        else if (f->type == F_NUM) c->v[i].n = f->def_n;
        else snprintf(c->v[i].s, sizeof(c->v[i].s), "%s", f->def_s);
    }
}

//Math.round: halves go up, toward +infinity (C's round() goes away from zero)
static double js_round(double x)
{
    return floor(x + 0.5);
}

//Number(string): trimmed, empty is NaN, and the whole string must be the number
static double js_number_from_string(const char *s, size_t len)
{
    char buf[64];
    while (len && isspace((unsigned char)*s)) { s++; len--; }
    while (len && isspace((unsigned char)s[len - 1])) len--;
    if (len == 0 || len >= sizeof(buf)) return NAN;
    memcpy(buf, s, len);
    buf[len] = '\0';
    char *end;
    double n = strtod(buf, &end);
    return (*end == '\0') ? n : NAN;
}

//Clamp a number to its range and snap it to the step. Anything that isn't a number (or a
//numeric string) kicks back `fallback`, the current value.
static double clamp_number(const field_t *f, jvalue_ref value, double fallback)
{
    double n = NAN;
    if (jis_number(value)) {
        jnumber_get_f64(value, &n);
    } else if (jis_string(value)) {
        raw_buffer r = jstring_get_fast(value);
        n = js_number_from_string(r.m_str, r.m_len);
    }
    if (!isfinite(n)) return fallback;
    n = fmin(f->max, fmax(f->min, n));
    //Snap to the step so repeated adjustments never drift (0.1 + 0.05 + ...)
    n = f->min + js_round((n - f->min) / f->step) * f->step;
    n = js_round(n * 1000) / 1000;
    return n == 0 ? 0 : n;      //No "-0" in the JSON
}

static bool is_color(raw_buffer r)
{
    if (r.m_len != 7 || r.m_str[0] != '#') return false;
    for (int i = 1; i < 7; i++) {
        if (!isxdigit((unsigned char)r.m_str[i])) return false;
    }
    return true;
}

void config_merge(config_t *out, const config_t *base, jvalue_ref patch)
{
    if (base) *out = *base;
    else config_defaults(out);
    if (!patch || !jis_object(patch)) return;

    for (int i = 0; i < FIELD_COUNT; i++) {
        const field_t *f = &FIELDS[i];
        jvalue_ref v;
        if (!jobject_get_exists(patch, j_str_to_buffer(f->name, strlen(f->name)), &v)) continue;

        if (f->type == F_BOOL) {
            bool b;
            if (jis_boolean(v) && jboolean_get(v, &b) == CONV_OK) out->v[i].b = b;
        } else if (f->type == F_SHAPE) {
            if (!jis_string(v)) continue;
            raw_buffer r = jstring_get_fast(v);
            for (int k = 0; k < SHAPE_COUNT; k++) {
                if (strlen(SHAPES[k]) == r.m_len && memcmp(SHAPES[k], r.m_str, r.m_len) == 0) {
                    snprintf(out->v[i].s, sizeof(out->v[i].s), "%s", SHAPES[k]);
                    break;
                }
            }
        } else if (f->type == F_COLOR) {
            if (!jis_string(v)) continue;
            raw_buffer r = jstring_get_fast(v);
            if (!is_color(r)) continue;
            for (int k = 0; k < 7; k++) out->v[i].s[k] = (char)tolower((unsigned char)r.m_str[k]);
            out->v[i].s[7] = '\0';
        } else {
            out->v[i].n = clamp_number(f, v, out->v[i].n);
        }
    }
}

bool config_equal(const config_t *a, const config_t *b)
{
    for (int i = 0; i < FIELD_COUNT; i++) {
        const field_t *f = &FIELDS[i];
        if (f->type == F_BOOL && a->v[i].b != b->v[i].b) return false;
        if (f->type == F_NUM && a->v[i].n != b->v[i].n) return false;
        if ((f->type == F_SHAPE || f->type == F_COLOR) && strcmp(a->v[i].s, b->v[i].s) != 0) return false;
    }
    return true;
}

bool config_json(const config_t *c, char *buf, size_t size, bool pretty, const char *skip)
{
    size_t used = 0;
    bool first = true;
    int n = snprintf(buf, size, "{");
    if (n < 0 || (size_t)n >= size) return false;
    used = (size_t)n;

    for (int i = 0; i < FIELD_COUNT; i++) {
        const field_t *f = &FIELDS[i];
        if (skip && strcmp(skip, f->name) == 0) continue;
        const char *sep = first ? "" : ",";
        const char *indent = pretty ? "\n  " : "";
        const char *colon = pretty ? ": " : ":";
        if (f->type == F_BOOL) {
            n = snprintf(buf + used, size - used, "%s%s\"%s\"%s%s", sep, indent, f->name, colon,
                         c->v[i].b ? "true" : "false");
        } else if (f->type == F_NUM) {
            //%.15g writes 0.7 as 0.7 and 8 as 8, the way JSON.stringify does for these values
            n = snprintf(buf + used, size - used, "%s%s\"%s\"%s%.15g", sep, indent, f->name, colon,
                         c->v[i].n);
        } else {
            n = snprintf(buf + used, size - used, "%s%s\"%s\"%s\"%s\"", sep, indent, f->name, colon,
                         c->v[i].s);
        }
        if (n < 0 || (size_t)n >= size - used) return false;
        used += (size_t)n;
        first = false;
    }
    n = snprintf(buf + used, size - used, pretty ? "\n}" : "}");
    return n >= 0 && (size_t)n < size - used;
}

bool config_bool(const config_t *c, const char *name)
{
    int i = config_field(name);
    return i >= 0 && c->v[i].b;
}

void config_set_bool(config_t *c, const char *name, bool value)
{
    int i = config_field(name);
    if (i >= 0) c->v[i].b = value;
}
