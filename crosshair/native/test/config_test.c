/*
 * Parity test for config.c, run on the TV: reads one JSON line per case,
 * {"base": {...} or null, "patch": {...}}, and prints the merged config as compact JSON.
 * scripts/native_parity.py compares the output with merge() in config.js.
 */
#include <stdio.h>
#include <string.h>

#include "config.h"

int main(void)
{
    static char line[16384];
    char out[4096];
    while (fgets(line, sizeof(line), stdin)) {
        jvalue_ref c = jdom_create(j_str_to_buffer(line, strlen(line)), jschema_all(), NULL);
        jvalue_ref base_json = NULL, patch = NULL;
        jobject_get_exists(c, J_CSTR_TO_BUF("base"), &base_json);
        jobject_get_exists(c, J_CSTR_TO_BUF("patch"), &patch);

        config_t base, merged;
        config_merge(&base, NULL, (base_json && jis_object(base_json)) ? base_json : NULL);
        config_merge(&merged, &base, patch);
        if (!config_json(&merged, out, sizeof(out), false, NULL)) strcpy(out, "OVERFLOW");
        puts(out);
        j_release(&c);
    }
    return 0;
}
