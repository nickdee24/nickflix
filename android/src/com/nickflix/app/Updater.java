package com.nickflix.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.ProgressDialog;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * In-app updates.
 *
 * Every change to android/ on main is built by GitHub Actions and published to
 * the "app" release of the repo as NickFlix.apk plus version.json. The app
 * compares version.json with its own version, offers the update, downloads it
 * and hands it to Android's installer (Android always asks the person to
 * confirm an install; an app can't skip that).
 */
@SuppressWarnings("deprecation")
class Updater {
    static final String BASE = "https://github.com/nickdee24/nickflix/releases/download/app/";
    private static final long CHECK_EVERY_MS = 3 * 60 * 60 * 1000L;

    private final Activity a;
    private long lastCheck;
    private int skipped;          // "Later" was pressed for this version (until the app is reopened)
    private boolean busy;         // a dialog or download is on screen
    private boolean waitingForPermission;

    Updater(Activity activity) { a = activity; }

    int currentCode() {
        try { return a.getPackageManager().getPackageInfo(a.getPackageName(), 0).versionCode; } catch (Exception e) { return 0; }
    }

    String currentName() {
        try { return a.getPackageManager().getPackageInfo(a.getPackageName(), 0).versionName; } catch (Exception e) { return "?"; }
    }

    /** Called when the app comes to the front. */
    void onResume() {
        if (waitingForPermission) {
            waitingForPermission = false;
            if (canInstall()) { install(); return; }
        }
        if (System.currentTimeMillis() - lastCheck > CHECK_EVERY_MS) check(false);
    }

    /** Looks for a newer version. `manual` also reports "you're up to date" and problems. */
    void check(final boolean manual) {
        if (busy) return;
        lastCheck = System.currentTimeMillis();
        new Thread(new Runnable() {
            @Override public void run() {
                try {
                    JSONObject v = new JSONObject(new String(fetch(BASE + "version.json"), "UTF-8"));
                    final int code = v.getInt("versionCode");
                    final String name = v.optString("versionName", String.valueOf(code));
                    final String notes = v.optString("notes", "");
                    a.runOnUiThread(new Runnable() {
                        @Override public void run() {
                            if (code > currentCode()) { if (manual || code != skipped) offer(code, name, notes); }
                            else if (manual) toast("NickFlix is up to date (version " + currentName() + ").");
                        }
                    });
                } catch (final Exception e) {
                    if (manual) a.runOnUiThread(new Runnable() {
                        @Override public void run() { toast("Couldn't check for updates. Try again in a moment."); }
                    });
                }
            }
        }, "update-check").start();
    }

    private void offer(final int code, String name, String notes) {
        if (busy || a.isFinishing()) return;
        busy = true;
        String message = "Version " + name + " is ready (you have " + currentName() + ")."
                + (notes.length() > 0 ? "\n\nWhat's new: " + notes : "")
                + "\n\nIt takes a few seconds. Android will ask you to confirm the install.";
        new AlertDialog.Builder(a)
                .setTitle("A new update is available")
                .setMessage(message)
                .setCancelable(false)
                .setPositiveButton("Update", new DialogInterface.OnClickListener() {
                    @Override public void onClick(DialogInterface d, int w) { download(); }
                })
                .setNegativeButton("Later", new DialogInterface.OnClickListener() {
                    @Override public void onClick(DialogInterface d, int w) { skipped = code; busy = false; }
                })
                .show();
    }

    private File target() {
        // Android 7+ reads the file through UpdateProvider; older versions need a plain file the installer can open.
        if (Build.VERSION.SDK_INT >= 24) return UpdateProvider.apkFile(a);
        File dir = a.getExternalCacheDir() != null ? a.getExternalCacheDir() : a.getCacheDir();
        return new File(dir, "NickFlix.apk");
    }

    private void download() {
        final ProgressDialog p = new ProgressDialog(a);
        p.setTitle("Downloading the update");
        p.setProgressStyle(ProgressDialog.STYLE_HORIZONTAL);
        p.setIndeterminate(true);
        p.setCancelable(false);
        p.setMax(100);
        p.show();
        new Thread(new Runnable() {
            @Override public void run() {
                String problem = null;
                try {
                    File out = target();
                    File dir = out.getParentFile();
                    if (dir != null) dir.mkdirs();
                    HttpURLConnection c = open(BASE + "NickFlix.apk");
                    try {
                        if (c.getResponseCode() != 200) throw new Exception("HTTP " + c.getResponseCode());
                        final int total = c.getContentLength();
                        InputStream in = c.getInputStream();
                        OutputStream os = new FileOutputStream(out);
                        try {
                            byte[] buf = new byte[32 * 1024];
                            int n; long done = 0; int shown = -1;
                            while ((n = in.read(buf)) > 0) {
                                os.write(buf, 0, n);
                                done += n;
                                final int pct = total > 0 ? (int) (done * 100 / total) : -1;
                                if (pct != shown && pct >= 0) {
                                    shown = pct;
                                    a.runOnUiThread(new Runnable() {
                                        @Override public void run() { p.setIndeterminate(false); p.setProgress(pct); }
                                    });
                                }
                            }
                        } finally { os.close(); in.close(); }
                    } finally { c.disconnect(); }
                    // Only ever install a newer NickFlix. (Android also refuses anything not signed with the same key.)
                    PackageInfo info = a.getPackageManager().getPackageArchiveInfo(out.getAbsolutePath(), 0);
                    if (info == null || !a.getPackageName().equals(info.packageName)) problem = "The download wasn't a NickFlix update.";
                    else if (info.versionCode <= currentCode()) problem = "That version is already installed.";
                } catch (Exception e) {
                    problem = "The download didn't finish. Check the connection and try again from the menu.";
                }
                final String failed = problem;
                a.runOnUiThread(new Runnable() {
                    @Override public void run() {
                        try { p.dismiss(); } catch (Exception ignored) { }
                        if (failed != null) { busy = false; toast(failed); return; }
                        install();
                    }
                });
            }
        }, "update-download").start();
    }

    private boolean canInstall() {
        return Build.VERSION.SDK_INT < 26 || a.getPackageManager().canRequestPackageInstalls();
    }

    private void install() {
        if (!canInstall()) { askPermission(); return; }
        busy = false;
        try {
            Intent i = new Intent(Intent.ACTION_INSTALL_PACKAGE);
            if (Build.VERSION.SDK_INT >= 24) {
                i.setData(UpdateProvider.APK_URI);
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } else {
                File f = target();
                f.setReadable(true, false);
                i.setData(Uri.fromFile(f));
            }
            a.startActivity(i);
        } catch (Exception e) {
            toast("This device wouldn't open the installer.");
        }
    }

    /** Android 8+: the person has to allow NickFlix to install apps, once. */
    private void askPermission() {
        new AlertDialog.Builder(a)
                .setTitle("Allow NickFlix to update itself")
                .setMessage("Android needs your OK once. On the next screen, switch on \"Allow from this source\" for NickFlix, then press Back.\n\n"
                        + "Fire TV: Settings → My Fire TV → Developer options → Install unknown apps → NickFlix → On.")
                .setCancelable(false)
                .setPositiveButton("Continue", new DialogInterface.OnClickListener() {
                    @Override public void onClick(DialogInterface d, int w) {
                        waitingForPermission = true;
                        try {
                            a.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + a.getPackageName())));
                        } catch (Exception e) {
                            try { a.startActivity(new Intent(Settings.ACTION_SETTINGS)); } catch (Exception ignored) { }
                        }
                    }
                })
                .setNegativeButton("Not now", new DialogInterface.OnClickListener() {
                    @Override public void onClick(DialogInterface d, int w) { busy = false; }
                })
                .show();
    }

    private void toast(String s) { Toast.makeText(a, s, Toast.LENGTH_LONG).show(); }

    private static HttpURLConnection open(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(15000);
        c.setReadTimeout(30000);
        c.setUseCaches(false);
        c.setInstanceFollowRedirects(true);
        c.setRequestProperty("User-Agent", "NickFlixApp");
        return c;
    }

    private static byte[] fetch(String url) throws Exception {
        HttpURLConnection c = open(url);
        try {
            if (c.getResponseCode() != 200) throw new Exception("HTTP " + c.getResponseCode());
            InputStream in = c.getInputStream();
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0 && out.size() < 64 * 1024) out.write(buf, 0, n);
            in.close();
            return out.toByteArray();
        } finally { c.disconnect(); }
    }
}
