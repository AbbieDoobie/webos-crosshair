"""Build the crosshair's two IPKs into build/.

  org.abbie.crosshair_<v>_all.ipk      settings app + root service
  org.abbie.crosshair.dot_<v>_all.ipk  the floating dot

Usage: python scripts/build.py
Needs `ares-package` (npm @webos-tools/cli, Node.js 20+) on PATH.
"""
import shutil
import subprocess
import sys
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


def package(*dirs: Path) -> None:
    ares = shutil.which("ares-package")
    if not ares:
        sys.exit("ares-package not found on PATH (npm install -g @webos-tools/cli)")
    subprocess.run([ares, *map(str, dirs), "-o", str(BUILD), "--no-minify"], check=True)


def main() -> None:
    if STAGE.exists():
        shutil.rmtree(STAGE)
    for ipk in BUILD.glob("*.ipk"):
        ipk.unlink()
    STAGE.mkdir(parents=True)

    staged = {name: stage(name) for name in COMPONENTS}
    package(staged["settings"], staged["service"])
    package(staged["dot"])
    shutil.rmtree(STAGE)

    for ipk in sorted(BUILD.glob("*.ipk")):
        print(f"built {ipk.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
