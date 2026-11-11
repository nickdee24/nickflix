# NickFlix for Android and Fire TV

A small full-screen app that opens Screen 1 (`https://nickflix.onrender.com`). The site does everything; the app adds a remote-controlled pointer, Play/Pause/Rewind/Fast-forward buttons, a launcher tile, and a waiting screen while Render wakes up. It adds `NickFlixApp/<version>` to its user agent, which the site uses to start in cinema view.

## Remote

| Button | Does |
|---|---|
| Arrows | Move the pointer (hold to go faster); push against the top or bottom edge to scroll |
| OK / Select | Click |
| Play/Pause | Play or pause for everyone |
| Rewind / Fast-forward | Skip 10 seconds |
| Menu | Reload, back to Screen 1, help, close |
| Back | Go back; press twice to leave |

## Building

No Gradle. `./build.sh` needs a JDK, `aapt2`, `dx`, `zipalign`, `apksigner` (on Ubuntu: `apt install aapt apksigner zipalign dalvik-exchange`) and an API 34 `android.jar` (set `ANDROID_JAR`).

Updates must be signed with the same keystore as the installed copy (`KEYSTORE`, `KEYPASS`), or Android refuses to install over it. The keystore is not in this repo.
