"""Check that the native service validates settings exactly like config.js.

Usage: python scripts/native_parity.py <ssh-host> [cases]

Makes random settings patches (good values, edge values, wrong types, numeric strings,
junk), merges each with merge() from config.js through Node, runs the same cases through
build/native/cmake/config-test on the TV, and compares the JSON. Build with
scripts/build.py --native first. Leaves nothing on the TV.
"""
import json
import random
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG_JS = ROOT / "crosshair" / "shared" / "config.js"
TEST_BIN = ROOT / "build" / "native" / "cmake" / "config-test"
REMOTE = "/tmp/crosshair-config-test"

NODE = r"""
const C = require(process.argv[1]);
const lines = require('fs').readFileSync(0, 'utf8').trim().split('\n');
for (const l of lines) {
    const c = JSON.parse(l);
    const base = c.base ? C.merge(C.DEFAULTS, c.base) : C.DEFAULTS;
    console.log(JSON.stringify(C.merge(base, c.patch)));
}
"""

INFO = r"""
const C = require(process.argv[1]);
process.stdout.write(JSON.stringify({d: C.DEFAULTS, n: C.NUMBERS, s: C.SHAPES}));
"""

JUNK = [None, [], {}, "", " ", "abc", "1e3", " 12 ", "0x10", "-0", "Infinity", "NaN", True,
        False, "#GGGGGG", "#ABCDEF", "#abc", "ffffff", 1e308, -1e308, 0.0001, -0.0001, 12.5,
        -12.5, 0.025, 0.075, 2.5, -2.5, 0.35, 999999]


def value_for(key, default, numbers, shapes):
    r = random.random()
    if r < 0.3:
        return random.choice(JUNK)
    if isinstance(default, bool):
        return random.choice([True, False])
    if key == "shape":
        return random.choice(shapes + ["nope", "DOT"])
    if isinstance(default, str):
        return "#" + "".join(random.choice("0123456789abcdefABCDEF") for _ in range(6))
    n = numbers[key]
    v = random.uniform(n["min"] - 3 * n["step"], n["max"] + 3 * n["step"])
    if random.random() < 0.3:
        v = round(v / n["step"]) * n["step"] + random.choice([0, n["step"] / 2, -n["step"] / 2])
    return str(v) if random.random() < 0.15 else v


def main() -> None:
    if len(sys.argv) not in (2, 3):
        sys.exit(__doc__)
    host = sys.argv[1]
    count = int(sys.argv[2]) if len(sys.argv) == 3 else 3000
    if not TEST_BIN.exists():
        sys.exit("build/native/cmake/config-test missing; run scripts/build.py --native")

    info = json.loads(subprocess.run(["node", "-e", INFO, str(CONFIG_JS)],
                                     check=True, capture_output=True, text=True).stdout)
    defaults, numbers, shapes = info["d"], info["n"], info["s"]
    random.seed(1)
    cases = []
    for _ in range(count):
        keys = random.sample(list(defaults), random.randint(1, len(defaults)))
        patch = {k: value_for(k, defaults[k], numbers, shapes) for k in keys}
        if random.random() < 0.05:
            patch["unknownKey"] = 1
        base = None
        if random.random() < 0.5:
            base = {k: value_for(k, defaults[k], numbers, shapes) for k in defaults}
        cases.append(json.dumps({"base": base, "patch": patch}))
    text = "\n".join(cases) + "\n"

    want = subprocess.run(["node", "-e", NODE, str(CONFIG_JS)], input=text,
                          check=True, capture_output=True, text=True).stdout.splitlines()
    subprocess.run(["scp", "-q", str(TEST_BIN), f"{host}:{REMOTE}"], check=True)
    got = subprocess.run(["ssh", "-T", host, f"chmod +x {REMOTE}; {REMOTE}; rm -f {REMOTE}"],
                         input=text, check=True, capture_output=True, text=True).stdout.splitlines()

    bad = 0
    for i, (w, g) in enumerate(zip(want, got)):
        if w != g:
            bad += 1
            same = json.loads(w) == json.loads(g) if g.startswith("{") else False
            if bad <= 5:
                print(f"case {i}: {cases[i]}\n  js: {w}\n   c: {g}\n  {'same values, different text' if same else 'DIFFERENT'}")
    if len(got) != len(want):
        print(f"line count differs: js {len(want)}, c {len(got)}")
        bad += 1
    print(f"{len(want) - bad}/{len(want)} cases match")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
