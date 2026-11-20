#!/usr/bin/env bash
# Installs a fresh APK on a running emulator, then runs the on-device unit tests and the
# end-to-end suite in laptop/test/e2e. Meant for CI, which boots the emulator
# (.github/workflows/ci.yml). It never boots one itself and never touches a real phone: with no
# emulator attached it exits without running anything. Pass APK=path to test another build.
set -euo pipefail
cd "$(dirname "$0")"

SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"
export PATH="$SDK/platform-tools:$PATH"
running="$(adb devices | awk '/^emulator-[0-9]+\tdevice$/ {print $1; exit}')"
if [[ -z "$running" ]]; then
  echo "no emulator attached; the emulator suite runs in CI"
  exit 0
fi
export ANDROID_SERIAL="$running"

cleanup() {
  if [[ $? -ne 0 ]]; then
    adb logcat -d -b crash -b main >"${GITHUB_WORKSPACE:-${TMPDIR:-/tmp}}/logcat.txt" 2>/dev/null || true
  fi
}
trap cleanup EXIT
adb root >/dev/null
adb wait-for-device
adb shell settings put global window_animation_scale 0
adb shell settings put global transition_animation_scale 0
adb shell settings put global animator_duration_scale 0
# System ANR dialogs on a cold emulator cover the app. Dhvani's own crashes still reach logcat.
adb shell settings put global hide_error_dialogs 1
adb shell input keyevent WAKEUP
adb shell wm dismiss-keyguard || true

if [[ -z "${APK:-}" ]]; then ./build.sh; APK=dist/dhvani.apk; fi
adb install -r -g "$APK" >/dev/null

echo "== device unit tests"
./test.sh
echo "== end to end"
cd ../laptop
DHVANI_E2E=1 bun test test/e2e
