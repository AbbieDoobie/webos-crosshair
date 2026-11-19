#!/bin/sh
#Run on the TV (ssh -tt, so luna-send prints): one-screen health check for the crosshair
#and LG Input Hook. Read-only.

echo "== crosshair service"
luna-send -n 1 luna://org.abbie.crosshair.service/status '{}' | node -e '
let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
  try { const r=JSON.parse(s); const c=r.config||{};
    console.log("  on:", c.visible, " auto-start:", c.autoStart, " dot app loaded:", r.dotLoaded);
    console.log("  power:", r.powerState, " HDR:", r.hdr, "(" + r.dynamicRange + ")");
    console.log("  shape:", c.shape, " color:", c.color, " size:", c.size);
    console.log("  root:", r.elevated, " in front:", r.foregroundApp, " on input:", r.onInput);
  } catch (e) { console.log("  no reply: " + s.trim()); } });'

echo "== power history (service log)"
grep -E "power state|auto-start|service started|crosshair (on|off)|ERROR|WARN" /tmp/org.abbie.crosshair.log 2>/dev/null | tail -12 | sed 's/^/  /'

echo "== Input Hook"
for n in lginput2 micomservice; do
    p=$(pidof $n | awk '{print $1}')
    if [ -n "$p" ] && grep -q libinputhookpp /proc/$p/maps 2>/dev/null; then h=hooked; else h="NOT hooked"; fi
    echo "  $n: $h"
done
pgrep -f org.webosbrew.inputhook.service >/dev/null && echo "  service: running" || echo "  service: not running"
echo "  boot script log:"; sed 's/^/    /' /tmp/inputhook-autostart.log 2>/dev/null || echo "    (none this boot)"
echo "  boot scripts:"; ls /var/lib/webosbrew/init.d/ | sed 's/^/    /'
