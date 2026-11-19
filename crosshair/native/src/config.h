/*
 * Crosshair settings for the native service: the same defaults, limits, and validation as
 * crosshair/shared/config.js, which the C tables are generated from (scripts/gen_schema.py).
 */
#ifndef CROSSHAIR_CONFIG_H
#define CROSSHAIR_CONFIG_H

#include <stdbool.h>
#include <stddef.h>
#include <pbnjson.h>

typedef enum { F_BOOL, F_NUM, F_SHAPE, F_COLOR } field_type_t;

typedef struct {
    const char *name;
    field_type_t type;
    int def_b;          //[F_BOOL] Default
    double def_n;       //[F_NUM] Default
    double min;         //[F_NUM] Range and step, as in NUMBERS
    double max;
    double step;
    const char *def_s;  //[F_SHAPE, F_COLOR] Default
} field_t;

#include "config_schema.h"

typedef struct {
    bool b;
    double n;
    char s[16];         //Shape names and #rrggbb colors both fit
} value_t;

typedef struct {
    value_t v[FIELD_COUNT];
} config_t;

//Index of a field by name, or -1
int config_field(const char *name);

void config_defaults(config_t *c);

//Build a complete, valid config: `base` with any valid fields of the JSON object `patch`
//applied. Invalid fields are skipped, so they keep the value from `base` (like merge()).
void config_merge(config_t *out, const config_t *base, jvalue_ref patch);

bool config_equal(const config_t *a, const config_t *b);

//Write the config as JSON. `pretty` matches JSON.stringify(c, null, 2). `skip` names one
//field to leave out (NULL for none). Returns false if `buf` is too small.
bool config_json(const config_t *c, char *buf, size_t size, bool pretty, const char *skip);

//Shorthands for the fields the service reads
bool config_bool(const config_t *c, const char *name);
void config_set_bool(config_t *c, const char *name, bool value);

#endif
