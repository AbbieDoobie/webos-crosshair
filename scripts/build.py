"""Build the crosshair's IPK into build/, with its Homebrew Channel manifest.

  com.abbiedoobie.crosshair_<v>_all.ipk         the app (crosshair and settings panel) + root service
  com.abbiedoobie.crosshair.manifest.json       for the Homebrew Channel repository; attach
                                                both to the GitHub release v<v>

Usage: python scripts/build.py
Needs `ares-package` (npm @webos-tools/cli, Node.js 20+) on PATH, and the buildroot-nc4
webOS toolchain for the native service (crosshair/native): on Windows in WSL (distro from
CROSSHAIR_WSL_DISTRO, default Ubuntu-24.04), elsewhere on this machine. See
scripts/build-native.sh.
"""
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "crosshair"
BUILD = ROOT / "build"
STAGE = BUILD / "stage"

sys.path.insert(0, str(Path(__file__).resolve().parent))
import icons  # noqa: E402

APP_ID = "com.abbiedoobie.crosshair"
REPO = "https://github.com/AbbieDoobie/webos-crosshair"
#The store links the icon straight from the repository, so it's kept in assets/
ICON = ROOT / "assets" / "icon130.png"
ICON_URL = "https://raw.githubusercontent.com/AbbieDoobie/webos-crosshair/main/assets/icon130.png"

#Shared files the web app needs. The service is built separately (build_native).
SHARED = ["luna.js", "config.js", "render.js"]


def stage_app() -> Path:
    out = STAGE / "app"
    shutil.copytree(SRC / "app", out)
    #Fill in the version the panel shows, from appinfo.json
    version = json.loads((out / "appinfo.json").read_text(encoding="utf-8"))["version"]
    page = out / "index.html"
    page.write_bytes(page.read_bytes().replace(b"__VERSION__", version.encode()))
    for f in SHARED:
        shutil.copy2(SRC / "shared" / f, out / f)
    icons.write(out)
    return out


def build_native() -> Path:
    """Generate the settings table, compile the C service, and stage it."""
    subprocess.run([sys.executable, str(ROOT / "scripts" / "gen_schema.py"),
                    str(BUILD / "native" / "gen" / "config_schema.h")], check=True)
    if os.name == "nt":
        distro = os.environ.get("CROSSHAIR_WSL_DISTRO", "Ubuntu-24.04")
        cmd = ["wsl", "-d", distro, "--cd", str(ROOT), "--", "sh", "scripts/build-native.sh"]
    else:
        cmd = ["sh", str(ROOT / "scripts" / "build-native.sh")]
    subprocess.run(cmd, check=True)

    out = STAGE / "service"
    out.mkdir(parents=True)
    shutil.copy2(SRC / "native" / "services.json", out / "services.json")
    shutil.copy2(BUILD / "native" / "cmake" / "crosshair-service", out / "crosshair-service")
    return out


def make_executable(ipk: Path, member: str) -> None:
    """Set mode 0755 on one file inside an IPK.

    ares-package takes file modes from the disk, and Windows has no executable bit, so the
    native service would arrive as 0666 and never start. An IPK is an ar archive holding
    debian-binary, control.tar.gz, and data.tar.gz; this rewrites data.tar.gz only.
    """
    data = ipk.read_bytes()
    if data[:8] != b"!<arch>\n":
        sys.exit(f"{ipk.name} is not an ar archive")
    out = bytearray(b"!<arch>\n")
    pos = 8
    found = False
    while pos < len(data):
        header = data[pos:pos + 60]
        name = header[:16].decode().strip()
        size = int(header[48:58])
        body = data[pos + 60:pos + 60 + size]
        pos += 60 + size + (size % 2)
        if name.rstrip("/") == "data.tar.gz":
            src = tarfile.open(fileobj=io.BytesIO(body), mode="r:gz")
            buf = io.BytesIO()
            with tarfile.open(fileobj=buf, mode="w:gz", format=src.format) as dst:
                for m in src.getmembers():
                    if m.name.lstrip("./") == member:
                        m.mode = 0o755
                        found = True
                    dst.addfile(m, src.extractfile(m) if m.isfile() else None)
            body = buf.getvalue()
            header = header[:48] + str(len(body)).ljust(10).encode() + header[58:]
        out += header + body
        if len(body) % 2:
            out += b"\n"
    if not found:
        sys.exit(f"{member} not found in {ipk.name}")
    ipk.write_bytes(bytes(out))


def write_manifest(ipk: Path) -> Path:
    """Write the Homebrew Channel manifest for this IPK, pointing at its GitHub release."""
    appinfo = json.loads((SRC / "app" / "appinfo.json").read_text(encoding="utf-8"))
    data = ipk.read_bytes()
    manifest = {
        "id": APP_ID,
        "version": appinfo["version"],
        "type": "web",
        "title": appinfo["title"],
        "appDescription": appinfo["appDescription"],
        "iconUri": ICON_URL,
        "sourceUrl": REPO,
        "rootRequired": True,
        "ipkUrl": f"{REPO}/releases/download/v{appinfo['version']}/{ipk.name}",
        "ipkHash": {"sha256": hashlib.sha256(data).hexdigest()},
        "ipkSize": len(data),
    }
    out = BUILD / f"{APP_ID}.manifest.json"
    out.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8", newline="\n")
    return out


#Keep the store icon in step with the generated one
def refresh_store_icon() -> None:
    icon = icons.png(130)
    if not ICON.exists() or ICON.read_bytes() != icon:
        ICON.parent.mkdir(exist_ok=True)
        ICON.write_bytes(icon)
        print(f"updated {ICON.relative_to(ROOT)} (commit it)")


def package(*dirs: Path) -> None:
    ares = shutil.which("ares-package")
    if not ares:
        sys.exit("ares-package not found on PATH (npm install -g @webos-tools/cli)")
    subprocess.run([ares, *map(str, dirs), "-o", str(BUILD), "--no-minify"], check=True)


def main() -> None:
    if STAGE.exists():
        shutil.rmtree(STAGE)
    for old in [*BUILD.glob("*.ipk"), *BUILD.glob("*.manifest.json")]:
        old.unlink()
    STAGE.mkdir(parents=True)

    package(stage_app(), build_native())
    ipk = next(BUILD.glob(f"{APP_ID}_*_all.ipk"))
    make_executable(ipk, f"usr/palm/services/{APP_ID}.service/crosshair-service")
    shutil.rmtree(STAGE)
    manifest = write_manifest(ipk)
    refresh_store_icon()

    print(f"built {ipk.relative_to(ROOT)}")
    print(f"built {manifest.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
