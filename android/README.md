# NickFlix for Android and Fire TV

A small full-screen app that opens Screen 1 (`https://nickflix.onrender.com`). The site does everything; the app adds a remote-controlled pointer, Play/Pause/Rewind/Fast-forward buttons, a launcher tile, and a waiting screen while Render wakes up. It adds `NickFlixApp/<version>` to its user agent, which the site uses to start in cinema view.

## Remote

| Button | Does |
|---|---|
| Arrows | Move the pointer (hold to go faster); push against the top or bottom edge to scroll |
| OK / Select | Click |
| Play/Pause | Play or pause for everyone |
| Rewind / Fast-forward | Skip 10 seconds |
| Menu | Reload, back to Screen 1, check for updates, help, close |
| Back | Go back; press twice to leave |

## Updates

Changes to the **website** need no app update: the app shows the live site, so they appear on the next load.

Changes to **this folder** are built by `.github/workflows/android-app.yml` on every push to `main` and published to the repo's `app` release as `NickFlix.apk` and `version.json`. The app checks `version.json` when it opens (and every few hours), shows "A new update is available", downloads the APK and hands it to Android's installer. Android always asks the person to confirm the install, and on Android 8+ to allow NickFlix to install apps the first time. Afterwards the app reopens by itself on Android 9 / Fire OS 7 and older; on newer versions, press **Open** on the installer's last screen.

Latest APK, for a first install: https://github.com/nickdee24/nickflix/releases/download/app/NickFlix.apk

The workflow needs the `ANDROID_KEYSTORE_B64` and `ANDROID_KEYSTORE_PASSWORD` repository secrets.

## Building

No Gradle. `./build.sh` needs a JDK, `aapt2`, `dx`, `zipalign`, `apksigner` (on Ubuntu: `apt install aapt apksigner zipalign dalvik-exchange`) and an API 34 `android.jar` (set `ANDROID_JAR`).

Updates must be signed with the same keystore as the installed copy (`KEYSTORE`, `KEYPASS`), or Android refuses to install over it. The keystore is not in this repo.
