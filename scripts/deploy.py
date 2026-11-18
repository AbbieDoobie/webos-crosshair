"""Install the built IPKs on a rooted webOS TV and restart the crosshair.

Usage: python scripts/deploy.py <ssh-host>

<ssh-host> is anything ssh accepts (root@<ip>, or a Host alias from your ssh config).
The TV needs root SSH from the Homebrew Channel. Run scripts/build.py first.

Steps, all on the TV: install both IPKs, elevate the service to root with the Homebrew
Channel's elevate-service, put the boot hook in /var/lib/webosbrew/init.d, restart the
service, and reload the dot app so it runs the new code. If LG Input Hook is installed, also
put in extras/inputhook-autostart/96-inputhook-autostart, which keeps its autostart working.
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "build"
BOOT_HOOK = ROOT / "crosshair" / "boot" / "95-abbie-crosshair"
INPUTHOOK_HOOK = ROOT / "extras" / "inputhook-autostart" / "96-inputhook-autostart"

APPS = ["org.abbie.crosshair.dot", "org.abbie.crosshair"]
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

# The install service has once reported "installed" while leaving the old version in
# place, so check the version on disk and try once more if it's wrong.
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

# This script arrives on stdin, so `pkill -f` can't match the shell running it.
luna-send -n 1 luna://com.webos.applicationManager/closeByAppId '{"id":"org.abbie.crosshair.dot"}' >/dev/null 2>&1 || true
pkill -f "__SERVICE__" 2>/dev/null || true

__INSTALLS__

"$HBC/elevate-service" __SERVICE__ >/tmp/crosshair-elevate.log 2>&1 || { echo "elevate failed:"; cat /tmp/crosshair-elevate.log; exit 1; }
echo "elevated __SERVICE__"

cp /tmp/95-abbie-crosshair /var/lib/webosbrew/init.d/95-abbie-crosshair
chmod 755 /var/lib/webosbrew/init.d/95-abbie-crosshair
echo "boot hook installed"

if [ -d /media/developer/apps/usr/palm/services/org.webosbrew.inputhook.service ]; then
    cp /tmp/96-inputhook-autostart /var/lib/webosbrew/init.d/96-inputhook-autostart
    chmod 755 /var/lib/webosbrew/init.d/96-inputhook-autostart
    echo "Input Hook autostart script installed"
else
    echo "Input Hook not installed; skipped its autostart script"
fi

pkill -f "__SERVICE__" 2>/dev/null || true
sleep 1
luna-send -n 1 luna://__SERVICE__/start '{}'
echo
rm -f /tmp/org.abbie.crosshair*.ipk /tmp/95-abbie-crosshair /tmp/96-inputhook-autostart
"""


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    host = sys.argv[1]

    ipks = {}
    for app in APPS:
        found = sorted(BUILD.glob(f"{app}_*_all.ipk"))
        if not found:
            sys.exit(f"no IPK for {app} in build/; run scripts/build.py first")
        ipks[app] = found[-1]

    files = [str(p) for p in ipks.values()] + [str(BOOT_HOOK), str(INPUTHOOK_HOOK)]
    subprocess.run(["scp", "-q", *files, f"{host}:/tmp/"], check=True)

    # IPK names are <id>_<version>_all.ipk.
    installs = "\n".join(f'install_ipk {app} /tmp/{ipk.name} {ipk.name.split("_")[1]}'
                         for app, ipk in ipks.items())
    script = REMOTE.replace("__INSTALLS__", installs).replace("__SERVICE__", SERVICE)
    subprocess.run(["ssh", "-T", host, "sh -s"], input=script.encode(), check=True)


if __name__ == "__main__":
    main()
