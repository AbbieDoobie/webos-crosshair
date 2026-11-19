#!/bin/sh
#Run on the TV (ssh -tt, so luna-send prints): one-screen health check for the crosshair
#and LG Input Hook. Read-only.

echo "== crosshair service"
luna-send -n 1 luna://com.abbiedoobie.crosshair.service/status '{}' | node -e '
let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
  try { const r=JSON.parse(s); const c=r.config||{};
    console.log("  on:", c.visible, " auto-start:", c.autoStart, " app loaded:", r.appLoaded, " panel open:", r.panelOpen);
    console.log("  power:", r.powerState, " HDR:", r.hdr, "(" + r.dynamicRange + ")");
    console.log("  shape:", c.shape, " color:", c.color, " size:", c.size);
    console.log("  root:", r.elevated, " in front:", r.foregroundApp, " on input:", r.onInput);
  } catch (e) { console.log("  no reply: " + s.trim()); } });'

#The service logs to syslog, which the TV keeps in /var/log/legacy-log. Power states, presses,
#and on/off only show up with Verbose logging on; start, stop, warnings, and errors always do.
echo "== service log (legacy-log)"
grep -h -F "com.abbiedoobie.crosshair[" /var/log/legacy-log 2>/dev/null | tail -12 | sed 's/^/  /'

echo "== Input Hook"
for n in lginput2 micomservice; do
    p=$(pidof $n | awk '{print $1}')
    if [ -n "$p" ] && grep -q libinputhookpp /proc/$p/maps 2>/dev/null; then h=hooked; else h="NOT hooked"; fi
    echo "  $n: $h"
done
pgrep -f org.webosbrew.inputhook.service >/dev/null && echo "  service: running" || echo "  service: not running"
echo "  boot scripts:"; ls /var/lib/webosbrew/init.d/ | sed 's/^/    /'
