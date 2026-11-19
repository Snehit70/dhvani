#!/usr/bin/env bash
# Runs android/test on a connected device or emulator through app_process, so the tests use
# the real Android runtime (Intent, Bundle, org.json). Needs adb and one device.
set -euo pipefail
cd "$(dirname "$0")"
./build.sh >/dev/null

SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"
PLATFORM="${PLATFORM:-$(ls -d "$SDK"/platforms/android-* | sort -V | tail -1)}"
BT="${BUILD_TOOLS:-$(ls -d "$SDK"/build-tools/* | sort -V | tail -1)}"
JAR="$PLATFORM/android.jar"

OUT=build/test
rm -rf "$OUT"
mkdir -p "$OUT/classes" "$OUT/dex"
javac -nowarn -Xlint:-options --release 17 -classpath "$JAR:build/classes" -d "$OUT/classes" $(find test -name '*.java')
"$BT/d8" --lib "$JAR" --min-api 29 --output "$OUT/dex" \
  $(find build/classes "$OUT/classes" -name '*.class')
adb push "$OUT/dex/classes.dex" /data/local/tmp/dhvani-tests.dex >/dev/null
adb shell CLASSPATH=/data/local/tmp/dhvani-tests.dex app_process /system/bin dev.snehit.dhvani.DeviceTests
