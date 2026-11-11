package com.nickflix.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.UiModeManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

/**
 * NickFlix for Android and Fire TV.
 *
 * A full-screen window onto Screen 1 (https://nickflix.onrender.com). The site
 * does everything; this app adds what a TV needs:
 *   - a pointer you steer with the remote's D-pad (OK = click),
 *   - Play/Pause, Rewind and Fast-forward buttons mapped to the player,
 *   - a launcher tile on Fire TV / Android TV, screen kept awake, no browser bars,
 *   - a waiting screen while Render's free plan wakes up, with automatic retry,
 *   - updates: it offers, downloads and installs new versions of itself (see Updater).
 *
 * The app adds "NickFlixApp/x" to its user agent; the site uses that to start
 * in cinema view and skip its "Go fullscreen?" prompt.
 */
public class MainActivity extends Activity {

    static final String HOME = "https://nickflix.onrender.com/";
    static final String HOME_HOST = "nickflix.onrender.com";
    private static final int FILE_REQUEST = 41;
    private static final int RETRY_MS = 6000;
    private static final int CURSOR_HIDE_MS = 6000;

    private final Handler ui = new Handler(Looper.getMainLooper());

    private FrameLayout root;
    private WebView web;
    private Updater updater;
    private CursorView cursor;
    private View splash;
    private TextView splashText;

    private boolean tv;             // remote-driven device: show the pointer
    private boolean firstPageShown; // the splash has been lifted at least once
    private boolean mainFrameFailed;
    private float pageScale;        // device pixels per CSS pixel
    private long lastBack;
    private long touchDownAt;

    // Fullscreen video (when the site asks for real fullscreen)
    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;
    private ValueCallback<Uri[]> fileCallback;

    // ------------------------------------------------------------------ lifecycle

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        pageScale = getResources().getDisplayMetrics().density;
        tv = isTv();
        updater = new Updater(this);

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        setContentView(root);

        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setUpWeb();

        cursor = new CursorView(this);
        cursor.setVisibility(View.GONE);
        root.addView(cursor, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        splash = buildSplash();
        root.addView(splash, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        if (state != null) web.restoreState(state);
        if (web.getUrl() == null) web.loadUrl(HOME);
        hideSystemBars();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        web.resumeTimers();
        hideSystemBars();
        updater.onResume(); // looks for a new version (at most every few hours)
    }

    @Override
    protected void onPause() {
        // Stop the picture and sound when the app goes to the background.
        web.onPause();
        web.pauseTimers();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        ui.removeCallbacksAndMessages(null);
        root.removeView(web);
        web.destroy();
        super.onDestroy();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    private boolean isTv() {
        UiModeManager m = (UiModeManager) getSystemService(Context.UI_MODE_SERVICE);
        if (m != null && m.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION) return true;
        PackageManager pm = getPackageManager();
        return pm.hasSystemFeature("amazon.hardware.fire_tv")
                || pm.hasSystemFeature("android.software.leanback")
                || !pm.hasSystemFeature(PackageManager.FEATURE_TOUCHSCREEN);
    }

    @SuppressWarnings("deprecation")
    private void hideSystemBars() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }

    // ------------------------------------------------------------------ the web view

    @SuppressLint("SetJavaScriptEnabled")
    private void setUpWeb() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);                 // remembers your name and settings
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false); // lets the movie start in sync for everyone
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setUserAgentString(s.getUserAgentString() + " NickFlixApp/" + updater.currentName() + (tv ? " TV" : ""));
        CookieManager.getInstance().setAcceptCookie(true);

        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.setVerticalScrollBarEnabled(false);
        web.setHorizontalScrollBarEnabled(false);
        web.setFocusable(true);
        web.setFocusableInTouchMode(true);
        web.requestFocus();

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return handleNavigation(request.getUrl(), request.isForMainFrame());
            }

            @Override
            @SuppressWarnings("deprecation")
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return handleNavigation(Uri.parse(url), true);
            }

            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                if (!"about:blank".equals(url)) mainFrameFailed = false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (mainFrameFailed || "about:blank".equals(url)) return;
                firstPageShown = true;
                ui.removeCallbacks(retry);
                // Let the page paint before lifting the splash.
                ui.postDelayed(new Runnable() {
                    @Override public void run() { if (!mainFrameFailed) showSplash(null); }
                }, 350);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) pageFailed();
            }

            @Override
            @SuppressWarnings("deprecation")
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                if (Build.VERSION.SDK_INT < 23) pageFailed(); // older devices only report main-page errors here
            }

            @Override
            public void onScaleChanged(WebView view, float oldScale, float newScale) {
                if (newScale > 0) pageScale = newScale;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (customView != null) { callback.onCustomViewHidden(); return; }
                customView = view;
                customViewCallback = callback;
                view.setBackgroundColor(Color.BLACK);
                // Under the pointer, above the page.
                root.addView(view, root.indexOfChild(cursor), new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                hideSystemBars();
            }

            @Override
            public void onHideCustomView() {
                exitCustomView();
            }

            @Override
            public Bitmap getDefaultVideoPoster() {
                // Plain black instead of Android's grey "play" placeholder.
                return Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888);
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                // Used for "load a subtitle file".
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try {
                    Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
                    pick.addCategory(Intent.CATEGORY_OPENABLE);
                    pick.setType("*/*");
                    startActivityForResult(pick, FILE_REQUEST);
                } catch (ActivityNotFoundException e) {
                    fileCallback = null;
                    callback.onReceiveValue(null);
                    Toast.makeText(MainActivity.this, "This device has no file picker.", Toast.LENGTH_SHORT).show();
                }
                return true;
            }
        });
    }

    /** NickFlix pages stay in the app; anything else opens in the device's browser. */
    private boolean handleNavigation(Uri url, boolean mainFrame) {
        if (!mainFrame) return false;
        String scheme = url.getScheme();
        if (("https".equals(scheme) || "http".equals(scheme)) && HOME_HOST.equalsIgnoreCase(url.getHost())) return false;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, url));
        } catch (Exception e) {
            Toast.makeText(this, "Can't open that link on this device.", Toast.LENGTH_SHORT).show();
        }
        return true;
    }

    private void exitCustomView() {
        if (customView == null) return;
        root.removeView(customView);
        customView = null;
        if (customViewCallback != null) customViewCallback.onCustomViewHidden();
        customViewCallback = null;
        hideSystemBars();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != FILE_REQUEST) { super.onActivityResult(requestCode, resultCode, data); return; }
        if (fileCallback == null) return;
        Uri picked = (resultCode == RESULT_OK && data != null) ? data.getData() : null;
        fileCallback.onReceiveValue(picked != null ? new Uri[] { picked } : null);
        fileCallback = null;
    }

    // ------------------------------------------------------------------ splash, errors, retry

    private View buildSplash() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setBackgroundColor(Color.BLACK);
        box.setClickable(true); // swallow touches while it's up
        box.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { if (mainFrameFailed) retryNow(); }
        });

        ImageView logo = new ImageView(this);
        logo.setImageResource(R.drawable.logo);
        logo.setAdjustViewBounds(true);
        box.addView(logo, new LinearLayout.LayoutParams(dp(220), ViewGroup.LayoutParams.WRAP_CONTENT));

        ProgressBar spinner = new ProgressBar(this);
        LinearLayout.LayoutParams sp = new LinearLayout.LayoutParams(dp(34), dp(34));
        sp.topMargin = dp(26);
        box.addView(spinner, sp);

        splashText = new TextView(this);
        splashText.setTextColor(0xFFB9B4AE);
        splashText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        splashText.setGravity(Gravity.CENTER);
        splashText.setTypeface(Typeface.DEFAULT);
        splashText.setText("Opening Screen 1…\nIf nobody has been in for a while, the cinema takes about 30 seconds to wake up.");
        LinearLayout.LayoutParams tp = new LinearLayout.LayoutParams(dp(420), ViewGroup.LayoutParams.WRAP_CONTENT);
        tp.topMargin = dp(18);
        box.addView(splashText, tp);
        return box;
    }

    /** Show the waiting screen with a message, or hide it with null. */
    private void showSplash(String message) {
        if (message == null) {
            if (splash.getVisibility() != View.VISIBLE) return;
            splash.animate().alpha(0f).setDuration(350).withEndAction(new Runnable() {
                @Override public void run() { splash.setVisibility(View.GONE); splash.setAlpha(1f); }
            });
            return;
        }
        splash.animate().cancel();
        splashText.setText(message);
        splash.setAlpha(1f);
        splash.setVisibility(View.VISIBLE);
        hideCursor.run();
    }

    private final Runnable retry = new Runnable() {
        @Override public void run() { retryNow(); }
    };

    private void retryNow() {
        ui.removeCallbacks(retry);
        showSplash("Opening Screen 1…");
        String url = web.getUrl();
        if (url == null || !url.startsWith("http")) web.loadUrl(HOME); else web.reload();
    }

    private void pageFailed() {
        mainFrameFailed = true;
        web.loadUrl("about:blank"); // hide Android's error page
        showSplash("Can't reach NickFlix right now.\nCheck the internet connection. Trying again in a few seconds…"
                + (tv ? "\n\nPress OK to try now." : "\n\nTap to try now."));
        ui.removeCallbacks(retry);
        ui.postDelayed(retry, RETRY_MS);
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    // ------------------------------------------------------------------ remote control

    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        int code = e.getKeyCode();
        boolean down = e.getAction() == KeyEvent.ACTION_DOWN;
        boolean first = down && e.getRepeatCount() == 0;

        if (code == KeyEvent.KEYCODE_BACK) {
            if (first) onBack();
            return true;
        }
        if (code == KeyEvent.KEYCODE_MENU) {
            if (first) showMenu();
            return true;
        }

        // Player buttons on the remote (and on Bluetooth headsets / keyboards)
        String playerKey = null;
        switch (code) {
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
            case KeyEvent.KEYCODE_MEDIA_PLAY:
            case KeyEvent.KEYCODE_MEDIA_PAUSE:
                playerKey = "k"; break;
            case KeyEvent.KEYCODE_MEDIA_REWIND:
            case KeyEvent.KEYCODE_MEDIA_SKIP_BACKWARD:
                playerKey = "j"; break;
            case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD:
            case KeyEvent.KEYCODE_MEDIA_SKIP_FORWARD:
                playerKey = "l"; break;
            default: break;
        }
        if (playerKey != null) {
            if (first) sendPlayerKey(playerKey);
            return true;
        }

        if (splash.getVisibility() == View.VISIBLE) {
            if (first && mainFrameFailed && (code == KeyEvent.KEYCODE_DPAD_CENTER || code == KeyEvent.KEYCODE_ENTER || code == KeyEvent.KEYCODE_BUTTON_A)) retryNow();
            return true;
        }

        if (tv) {
            switch (code) {
                case KeyEvent.KEYCODE_DPAD_LEFT:
                case KeyEvent.KEYCODE_DPAD_RIGHT:
                case KeyEvent.KEYCODE_DPAD_UP:
                case KeyEvent.KEYCODE_DPAD_DOWN:
                    if (down) movePointer(code, e.getRepeatCount());
                    return true;
                case KeyEvent.KEYCODE_DPAD_CENTER:
                case KeyEvent.KEYCODE_BUTTON_A:
                    if (first) {
                        if (cursor.getVisibility() != View.VISIBLE) wakePointer(); // first press just shows the pointer
                        else pointerDown();
                    } else if (!down) pointerUp();
                    return true;
                default: break;
            }
        }
        return super.dispatchKeyEvent(e);
    }

    private void onBack() {
        if (customView != null) {
            web.evaluateJavascript("document.fullscreenElement&&document.exitFullscreen()", null);
            exitCustomView();
            return;
        }
        if (firstPageShown && web.canGoBack() && !"about:blank".equals(web.getUrl())) { web.goBack(); return; }
        long now = SystemClock.uptimeMillis();
        if (now - lastBack < 2500) { finish(); return; }
        lastBack = now;
        Toast.makeText(this, "Press back again to leave NickFlix", Toast.LENGTH_SHORT).show();
    }

    private void showMenu() {
        final String[] items = { "Reload", "Back to Screen 1", "Check for updates", "How the remote works", "Close NickFlix" };
        new AlertDialog.Builder(this)
                .setTitle("NickFlix " + updater.currentName())
                .setItems(items, new DialogInterface.OnClickListener() {
                    @Override public void onClick(DialogInterface dialog, int which) {
                        if (which == 0) retryNow();
                        else if (which == 1) { showSplash("Opening Screen 1…"); web.loadUrl(HOME); }
                        else if (which == 2) updater.check(true);
                        else if (which == 3) showRemoteHelp();
                        else finish();
                    }
                })
                .show();
    }

    private void showRemoteHelp() {
        new AlertDialog.Builder(this)
                .setTitle("Using the remote")
                .setMessage("Arrows: move the pointer (hold to go faster)\n"
                        + "OK / Select: click\n"
                        + "Play/Pause: play or pause for everyone\n"
                        + "Rewind / Fast-forward: skip 10 seconds\n"
                        + "Pointer at the top or bottom edge: scroll\n"
                        + "Menu (three lines): this menu\n"
                        + "Back: go back, press twice to leave")
                .setPositiveButton("OK", null)
                .show();
    }

    /** Presses a player shortcut key on the page (same as a keyboard on the website). */
    private void sendPlayerKey(String key) {
        web.evaluateJavascript("(function(k){var a=document.activeElement;"
                + "if(a&&/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))a.blur();"
                + "var t=document.body;['keydown','keyup'].forEach(function(n){"
                + "t.dispatchEvent(new KeyboardEvent(n,{key:k,bubbles:true,cancelable:true}))})})('" + key + "')", null);
    }

    // ------------------------------------------------------------------ the pointer

    private final Runnable hideCursor = new Runnable() {
        @Override public void run() {
            ui.removeCallbacks(this);
            if (cursor != null) cursor.setVisibility(View.GONE);
        }
    };

    private void wakePointer() {
        if (cursor.x < 0) cursor.place(root.getWidth() / 2f, root.getHeight() / 2f);
        cursor.setVisibility(View.VISIBLE);
        cursor.invalidate();
        ui.removeCallbacks(hideCursor);
        ui.postDelayed(hideCursor, CURSOR_HIDE_MS);
    }

    private void movePointer(int code, int repeat) {
        boolean wasHidden = cursor.getVisibility() != View.VISIBLE;
        wakePointer();
        if (wasHidden) return; // first press just shows the pointer where it was
        int w = root.getWidth(), h = root.getHeight();
        // Starts fine for small buttons, speeds up while the arrow is held.
        float step = Math.min(w, h) * (0.014f + Math.min(repeat, 14) * 0.0045f);
        float nx = cursor.x, ny = cursor.y;
        if (code == KeyEvent.KEYCODE_DPAD_LEFT) nx -= step;
        else if (code == KeyEvent.KEYCODE_DPAD_RIGHT) nx += step;
        else if (code == KeyEvent.KEYCODE_DPAD_UP) ny -= step;
        else ny += step;

        // Pushing against the top or bottom edge scrolls whatever is under the pointer.
        if (ny < 0) scrollPage(-step * 2.2f);
        else if (ny > h - 1) scrollPage(step * 2.2f);

        cursor.place(Math.max(0, Math.min(w - 1, nx)), Math.max(0, Math.min(h - 1, ny)));
    }

    private void scrollPage(float devicePx) {
        float sx = cursor.x / pageScale, sy = cursor.y / pageScale, dy = devicePx / pageScale;
        web.evaluateJavascript("(function(x,y,dy){var e=document.elementFromPoint(x,y);"
                + "while(e&&e!==document.documentElement){var s=getComputedStyle(e).overflowY;"
                + "if((s==='auto'||s==='scroll')&&e.scrollHeight>e.clientHeight+1){e.scrollBy(0,dy);return}"
                + "e=e.parentElement}window.scrollBy(0,dy)})(" + sx + "," + sy + "," + dy + ")", null);
    }

    private void pointerDown() {
        wakePointer();
        touchDownAt = SystemClock.uptimeMillis();
        cursor.setPressed(true);
        sendTouch(MotionEvent.ACTION_DOWN, touchDownAt);
    }

    private void pointerUp() {
        if (touchDownAt == 0) return;
        cursor.setPressed(false);
        sendTouch(MotionEvent.ACTION_UP, touchDownAt);
        touchDownAt = 0;
    }

    /** A tap on the page at the pointer, exactly as a finger would make it. */
    private void sendTouch(int action, long downTime) {
        View target = customView != null ? customView : web;
        MotionEvent ev = MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), action, cursor.x, cursor.y, 0);
        ev.setSource(0x00001002); // InputDevice.SOURCE_TOUCHSCREEN
        target.dispatchTouchEvent(ev);
        ev.recycle();
    }
}
