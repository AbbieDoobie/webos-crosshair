"""Build the crosshair's two IPKs into build/.

  org.abbie.crosshair_<v>_all.ipk      settings app + root service
  org.abbie.crosshair.dot_<v>_all.ipk  the floating dot

Usage: python scripts/build.py [--js]
Needs `ares-package` (npm @webos-tools/cli, Node.js 20+) on PATH.

The service is the native C one (crosshair/native) by default. It needs the buildroot-nc4
webOS toolchain: on Windows in WSL (distro from CROSSHAIR_WSL_DISTRO, default
Ubuntu-24.04), elsewhere on this machine. See scripts/build-native.sh.

--js ships the older JS service (crosshair/service) instead, which needs no toolchain.
"""
import io
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

#Which shared files each component needs.
COMPONENTS = {
    "settings": ["luna.js", "config.js", "render.js"],
    "service": ["config.js"],
    "dot": ["luna.js", "config.js", "render.js"],
}


def stage(name: str) -> Path:
    out = STAGE / name
    shutil.copytree(SRC / name, out)
    for f in COMPONENTS[name]:
        shutil.copy2(SRC / "shared" / f, out / f)
    if name != "service":
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


def package(*dirs: Path) -> None:
    ares = shutil.which("ares-package")
    if not ares:
        sys.exit("ares-package not found on PATH (npm install -g @webos-tools/cli)")
    subprocess.run([ares, *map(str, dirs), "-o", str(BUILD), "--no-minify"], check=True)


def main() -> None:
    native = "--js" not in sys.argv[1:]
    if STAGE.exists():
        shutil.rmtree(STAGE)
    for ipk in BUILD.glob("*.ipk"):
        ipk.unlink()
    STAGE.mkdir(parents=True)

    staged = {name: stage(name) for name in COMPONENTS if not (native and name == "service")}
    if native:
        staged["service"] = build_native()
    package(staged["settings"], staged["service"])
    package(staged["dot"])
    if native:
        ipk = next(BUILD.glob("org.abbie.crosshair_*_all.ipk"))
        make_executable(ipk, "usr/palm/services/org.abbie.crosshair.service/crosshair-service")
    shutil.rmtree(STAGE)

    for ipk in sorted(BUILD.glob("*.ipk")):
        print(f"built {ipk.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
