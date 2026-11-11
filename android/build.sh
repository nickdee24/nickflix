#!/bin/bash
# Builds NickFlix.apk with the plain Android tools (no Gradle needed).
# Needs: JDK, aapt2, dx (or d8), zipalign, apksigner and an android.jar (API 34).
set -euo pipefail
cd "$(dirname "$0")"
ANDROID_JAR="${ANDROID_JAR:-../sdk/android.jar}"
KEYSTORE="${KEYSTORE:-nickflix-release.jks}"
KEYPASS="${KEYPASS:-nickflix}"
VERSION_CODE=1; VERSION_NAME=1.0
rm -rf build && mkdir -p build/res build/gen build/classes build/dex
aapt2 compile --dir res -o build/res/res.zip
aapt2 link -o build/base.apk -I "$ANDROID_JAR" --manifest AndroidManifest.xml --java build/gen \
  --min-sdk-version 22 --target-sdk-version 34 --version-code $VERSION_CODE --version-name $VERSION_NAME build/res/res.zip
javac -nowarn --release 8 -cp "$ANDROID_JAR" -d build/classes $(find src build/gen -name '*.java') 2>&1 | grep -v "bootstrap class path\|source value 8\|target value 8\|To suppress\|^[0-9]* warning" || true
"${DX:-/usr/lib/android-sdk/build-tools/debian/dx}" --dex --min-sdk-version=22 --output=build/dex/classes.dex build/classes
cp build/base.apk build/unaligned.apk && (cd build/dex && zip -q -j ../unaligned.apk classes.dex)
zipalign -f 4 build/unaligned.apk build/aligned.apk
[ -f "$KEYSTORE" ] || keytool -genkeypair -keystore "$KEYSTORE" -storepass "$KEYPASS" -keypass "$KEYPASS" -alias nickflix \
  -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=NickFlix" 2>/dev/null
apksigner sign --ks "$KEYSTORE" --ks-pass "pass:$KEYPASS" --key-pass "pass:$KEYPASS" --v1-signing-enabled true --v2-signing-enabled true --out NickFlix.apk build/aligned.apk
apksigner verify --verbose --min-sdk-version 22 NickFlix.apk | head -4
ls -la NickFlix.apk
