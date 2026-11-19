#!/bin/sh
#Build the native service with the buildroot-nc4 webOS toolchain. Runs on Linux (on
#Windows, scripts/build.py --native runs it in WSL). Needs build/native/gen/config_schema.h
#from scripts/gen_schema.py first.
#
#TOOLCHAIN picks the SDK folder (default: ~/arm-webos-linux-gnueabi_sdk-buildroot).
set -e
cd "$(dirname "$0")/.."
TOOLCHAIN="${TOOLCHAIN:-$HOME/arm-webos-linux-gnueabi_sdk-buildroot}"
if [ ! -f "$TOOLCHAIN/share/buildroot/toolchainfile.cmake" ]; then
    echo "webOS toolchain not found in $TOOLCHAIN (set TOOLCHAIN)" >&2
    exit 1
fi
cmake -S crosshair/native -B build/native/cmake \
    -DCMAKE_TOOLCHAIN_FILE="$TOOLCHAIN/share/buildroot/toolchainfile.cmake" \
    -DSCHEMA_DIR="$PWD/build/native/gen" >/dev/null
cmake --build build/native/cmake -- -s
