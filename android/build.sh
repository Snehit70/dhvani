#!/usr/bin/env bash
# Builds dist/dhvani.apk without Gradle: aapt2 + javac + d8 + apksigner. Takes a few seconds.
set -euo pipefail
cd "$(dirname "$0")"

SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"
PLATFORM="${PLATFORM:-$(ls -d "$SDK"/platforms/android-* | sort -V | tail -1)}"
BT="${BUILD_TOOLS:-$(ls -d "$SDK"/build-tools/* | sort -V | tail -1)}"
JAR="$PLATFORM/android.jar"
KEYSTORE="${KEYSTORE:-$HOME/.android/debug.keystore}"
for t in aapt2 d8 zipalign apksigner; do [[ -x "$BT/$t" ]] || { echo "missing $BT/$t" >&2; exit 1; }; done
[[ -f "$JAR" ]] || { echo "missing $JAR" >&2; exit 1; }

OUT=build
rm -rf "$OUT"
mkdir -p "$OUT/res" "$OUT/gen" "$OUT/classes" "$OUT/dex" dist

"$BT/aapt2" compile --dir res -o "$OUT/res/res.zip"
"$BT/aapt2" link -I "$JAR" --manifest AndroidManifest.xml --java "$OUT/gen" \
  -o "$OUT/unsigned.apk" "$OUT/res/res.zip"

javac -nowarn -Xlint:-options --release 17 -classpath "$JAR" -d "$OUT/classes" \
  $(find src "$OUT/gen" -name '*.java')
"$BT/d8" --release --lib "$JAR" --min-api 29 --output "$OUT/dex" $(find "$OUT/classes" -name '*.class')

(cd "$OUT/dex" && zip -q -j ../unsigned.apk classes.dex)
"$BT/zipalign" -f -p 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

if [[ ! -f "$KEYSTORE" ]]; then
  mkdir -p "$(dirname "$KEYSTORE")"
  keytool -genkeypair -keystore "$KEYSTORE" -storepass android -keypass android \
    -alias androiddebugkey -dname "CN=Android Debug,O=Android,C=US" -keyalg RSA -validity 10000 >/dev/null
fi
"$BT/apksigner" sign --ks "$KEYSTORE" --ks-pass pass:android --key-pass pass:android \
  --out dist/dhvani.apk "$OUT/aligned.apk"
echo "built $(pwd)/dist/dhvani.apk ($(du -h dist/dhvani.apk | cut -f1))"
