"""Install the built IPK on a rooted webOS TV and restart the crosshair.

Usage: python scripts/deploy.py <ssh-host>

<ssh-host> is anything ssh accepts (root@<ip>, or a Host alias from your ssh config).
The TV needs root SSH from the Homebrew Channel. Run scripts/build.py first.

Steps, all on the TV: remove the separate dot app that versions before 0.6.0 installed,
install the IPK, elevate the service to root with the Homebrew Channel's elevate-service,
put the boot hook in /var/lib/webosbrew/init.d, and restart the service, which relaunches
the app with the new code if the crosshair is on.
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "build"
BOOT_HOOK = ROOT / "crosshair" / "boot" / "95-abbie-crosshair"

APP = "org.abbie.crosshair"
OLD_DOT_APP = "org.abbie.crosshair.dot"     #Versions before 0.6.0 shipped the dot separately
SERVICE = "org.abbie.crosshair.service"

REMOTE = r"""
set -e
HBC=/media/developer/apps/usr/palm/services/org.webosbrew.hbchannel.service

install_once() {
    id="$1"; ipk="$2"; log="/tmp/crosshair-install-$id.log"
    luna-send -i luna://com.webos.appInstallService/dev/install \
        "{\"id\":\"$id\",\"ipkUrl\":\"$ipk\",\"subscribe\":true}" > "$log" 2>&1 &
    pid=$!
    i=0
    while [ $i -lt 120 ]; do
        if grep -q '"state":"installed"' "$log"; then kill $pid 2>/dev/null || true; return 0; fi
        if grep -qE 'install failed|"returnValue":false' "$log"; then
            kill $pid 2>/dev/null || true; echo "FAILED $id:"; cat "$log"; return 1
        fi
        sleep 1; i=$((i + 1))
    done
    kill $pid 2>/dev/null || true; echo "TIMEOUT installing $id"; return 1
}

#The install service has once reported "installed" while leaving the old version in
#place, so check the version on disk and try once more if it's wrong.
install_ipk() {
    id="$1"; ipk="$2"; want="$3"
    appinfo="/media/developer/apps/usr/palm/applications/$id/appinfo.json"
    for attempt in 1 2; do
        install_once "$id" "$ipk" || return 1
        sleep 1
        if grep -q "\"version\": *\"$want\"" "$appinfo" 2>/dev/null; then
            echo "installed $id $want"; return 0
        fi
        echo "WARN $id still not at $want after install attempt $attempt"
    done
    echo "FAILED $id: installed version is not $want"; return 1
}

remove_old_dot() {
    id="__OLD_DOT__"; log="/tmp/crosshair-remove-$id.log"
    [ -d "/media/developer/apps/usr/palm/applications/$id" ] || return 0
    luna-send -n 1 luna://com.webos.applicationManager/closeByAppId "{\"id\":\"$id\"}" >/dev/null 2>&1 || true
    luna-send -i luna://com.webos.appInstallService/dev/remove \
        "{\"id\":\"$id\",\"subscribe\":true}" > "$log" 2>&1 &
    pid=$!
    i=0
    while [ $i -lt 60 ]; do
        if grep -q '"state":"removed"' "$log"; then kill $pid 2>/dev/null || true; echo "removed $id"; return 0; fi
        if grep -qE 'remove failed|"returnValue":false' "$log"; then
            kill $pid 2>/dev/null || true; echo "FAILED removing $id:"; cat "$log"; return 1
        fi
        sleep 1; i=$((i + 1))
    done
    kill $pid 2>/dev/null || true; echo "TIMEOUT removing $id"; return 1
}

#NOTE: This script arrives on stdin, so `pkill -f` can't match the shell running it.
pkill -f "__SERVICE__" 2>/dev/null || true
luna-send -n 1 luna://com.webos.applicationManager/closeByAppId '{"id":"__APP__"}' >/dev/null 2>&1 || true
remove_old_dot

install_ipk __APP__ /tmp/__IPK__ __VERSION__

"$HBC/elevate-service" __SERVICE__ >/tmp/crosshair-elevate.log 2>&1 || { echo "elevate failed:"; cat /tmp/crosshair-elevate.log; exit 1; }
echo "elevated __SERVICE__"

cp /tmp/95-abbie-crosshair /var/lib/webosbrew/init.d/95-abbie-crosshair
chmod 755 /var/lib/webosbrew/init.d/95-abbie-crosshair
echo "boot hook installed"

pkill -f "__SERVICE__" 2>/dev/null || true
sleep 1
luna-send -n 1 luna://__SERVICE__/start '{}'
echo
rm -f /tmp/org.abbie.crosshair*.ipk /tmp/crosshair-remove-*.log /tmp/95-abbie-crosshair
"""


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    host = sys.argv[1]

    found = list(BUILD.glob(f"{APP}_*_all.ipk"))
    if not found:
        sys.exit(f"no IPK for {APP} in build/; run scripts/build.py first")
    #IPK names are <id>_<version>_all.ipk. Sort by version numbers, not text, so 0.10.0
    #beats 0.9.0.
    ipk = max(found, key=lambda p: tuple(int(x) for x in p.name.split("_")[1].split(".")))

    subprocess.run(["scp", "-q", str(ipk), str(BOOT_HOOK), f"{host}:/tmp/"], check=True)

    script = (REMOTE.replace("__IPK__", ipk.name).replace("__VERSION__", ipk.name.split("_")[1])
              .replace("__APP__", APP).replace("__OLD_DOT__", OLD_DOT_APP)
              .replace("__SERVICE__", SERVICE))
    subprocess.run(["ssh", "-T", host, "sh -s"], input=script.encode(), check=True)


if __name__ == "__main__":
    main()
