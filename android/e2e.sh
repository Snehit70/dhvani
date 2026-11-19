#!/usr/bin/env bash
# Installs a fresh APK on a running emulator, then runs the on-device unit tests and the
# end-to-end suite in laptop/test/e2e. CI boots the emulator (.github/workflows/ci.yml); locally,
# with no device attached, this boots one (needs the emulator, an android-34 google_apis image, KVM).
# Pass APK=path to test another build.
set -euo pipefail
cd "$(dirname "$0")"

SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"
AVD="${AVD:-dhvani-e2e}"
IMAGE="${IMAGE:-system-images;android-34;google_apis;x86_64}"
PORT="${EMU_PORT:-5584}"
export PATH="$SDK/platform-tools:$SDK/emulator:$PATH"
running="$(adb devices | awk '/^emulator-[0-9]+\tdevice$/ {print $1; exit}')"
export ANDROID_SERIAL="${ANDROID_SERIAL:-${running:-emulator-$PORT}}"

if [[ -z "$running" ]] && ! "$SDK/emulator/emulator" -list-avds | grep -qx "$AVD"; then
  echo no | "$SDK/cmdline-tools/latest/bin/avdmanager" create avd -n "$AVD" -k "$IMAGE" -d pixel_6 >/dev/null
fi

started=""
cleanup() {
  local rc=$?
  if [[ $rc -ne 0 ]]; then
    adb logcat -d -b crash -b main >"${GITHUB_WORKSPACE:-${TMPDIR:-/tmp}}/logcat.txt" 2>/dev/null || true
  fi
  if [[ -n "$started" ]]; then adb emu kill >/dev/null 2>&1 || kill "$started"; fi
}
trap cleanup EXIT
if ! adb devices | grep -q "^$ANDROID_SERIAL\s*device"; then
  "$SDK/emulator/emulator" -avd "$AVD" -port "$PORT" -no-window -no-snapshot -no-boot-anim \
    -gpu swiftshader_indirect -audio none >"${TMPDIR:-/tmp}/dhvani-emulator.log" 2>&1 &
  started=$!
  adb wait-for-device
  until [[ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == 1 ]]; do sleep 2; done
fi
adb root >/dev/null
adb wait-for-device
adb shell settings put global window_animation_scale 0
adb shell settings put global transition_animation_scale 0
adb shell settings put global animator_duration_scale 0
adb shell input keyevent WAKEUP
adb shell wm dismiss-keyguard || true

if [[ -z "${APK:-}" ]]; then ./build.sh; APK=dist/dhvani.apk; fi
adb install -r -g "$APK" >/dev/null

echo "== device unit tests"
./test.sh
echo "== end to end"
cd ../laptop
DHVANI_E2E=1 bun test test/e2e
