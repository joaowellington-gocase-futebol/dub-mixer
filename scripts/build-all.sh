#!/bin/bash
# Builds every DUB-MIXER package into release/final (run from the project root on a Mac).
set -e
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@21}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export CSC_IDENTITY_AUTO_DISCOVERY=false
rm -rf release
npx vite build
npx cap sync android
(cd android && ./gradlew assembleRelease --no-daemon -q)
npx electron-builder --mac dmg --arm64
hdiutil detach -force /Volumes/DUB-MIXER >/dev/null 2>&1 || true
npx electron-builder --mac dmg --x64
npx electron-builder --win
mkdir -p release/final
cp release/DUB-MIXER-1.0.0-arm64.dmg release/final/DUB-MIXER-1.0.0-mac-apple-silicon.dmg
cp release/DUB-MIXER-1.0.0.dmg release/final/DUB-MIXER-1.0.0-mac-intel.dmg
cp release/DUB-MIXER-Setup-1.0.0.exe release/DUB-MIXER-Portable-1.0.0.exe release/final/
cp android/app/build/outputs/apk/release/app-release.apk release/final/DUB-MIXER-1.0.0.apk
"$ANDROID_HOME/build-tools/34.0.0/apksigner" verify release/final/DUB-MIXER-1.0.0.apk && echo "APK signature OK"
ls -la release/final
