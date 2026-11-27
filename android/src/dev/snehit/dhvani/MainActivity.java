package dev.snehit.dhvani;

import android.Manifest;
import android.animation.LayoutTransition;
import android.animation.ValueAnimator;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.res.ColorStateList;
import android.content.res.Configuration;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.graphics.drawable.ClipDrawable;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.LayerDrawable;
import android.graphics.drawable.RippleDrawable;
import android.media.projection.MediaProjectionConfig;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputFilter;
import android.text.InputType;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.animation.PathInterpolator;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.SeekBar;
import android.widget.Switch;
import android.widget.TextView;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Single-screen UI built in code, following Material 3: tonal surfaces instead of borders,
 * the M3 type scale and shape scale, and dynamic color from the wallpaper on Android 12+.
 *
 * Two layouts share the screen. Idle: a status card, the laptop picker with the pairing code,
 * and options. Connecting or streaming: only the status card, which then holds the laptop's
 * volume and the stop button; the setup is hidden until the stream ends.
 */
public final class MainActivity extends Activity implements StreamState.Listener {
    private static final int REQ_PERMS = 1;
    private static final int REQ_PROJECTION = 2;
    private static final long LAPTOP_TTL_MS = 8000;
    /** Set by the Quick Settings tile: start streaming as soon as the screen opens. */
    static final String EXTRA_AUTOSTART = "autostart";
    private static final String USB_HOST = "127.0.0.1";
    /** M3 emphasized easing, used for every state change on this screen. */
    private static final PathInterpolator EASE = new PathInterpolator(0.2f, 0f, 0f, 1f);

    private SharedPreferences prefs;
    private final Handler main = new Handler(Looper.getMainLooper());

    // ---------- Material 3 color roles ----------
    private boolean dark;
    private int primary, onPrimary, primaryContainer, onPrimaryContainer;
    private int secondaryContainer, onSecondaryContainer;
    private int error, onError, errorContainer, onErrorContainer;
    private int warningContainer, onWarningContainer;
    private int surface, surfaceLow, surfaceMid, surfaceHigh, surfaceHighest;
    private int onSurface, onSurfaceVariant, outline, outlineVariant;

    // Status card
    private GradientDrawable heroBg;
    private ValueAnimator heroFade;
    private FrameLayout heroAvatar;
    private ImageView heroIcon;
    private Bars heroBars;
    private TextView heroOverline, heroTitle, heroDetail;
    private ProgressBar heroProgress;
    private LinearLayout noticeBox;
    private ImageView noticeIcon;
    private TextView notice;
    private Pill actionButton;
    // Laptop volume, inside the card while streaming
    private LinearLayout volumeRow;
    private FrameLayout muteButton;
    private ImageView muteOn, muteOff;
    private Boolean shownMuted;
    private SeekBar volumeBar;
    private TextView volumeValue;
    private boolean draggingVolume;
    private long lastVolumeSent;
    // Setup, hidden while active
    private LinearLayout setup;
    private LinearLayout searchRow, laptopList, manualRow, addressBox;
    private boolean manualOpen;
    private EditText addressField, codeField;
    private Switch silenceSwitch, reconnectSwitch, autoSwitch;
    private TextView keysSub;
    private ImageView keysTrail;

    // Discovery
    /** The live discovery thread; a stopped thread sees it changed and exits. */
    private volatile Thread discoveryThread;
    private final Map<String, Laptop> laptops = Collections.synchronizedMap(new LinkedHashMap<>());

    private static final class Laptop {
        final String ip; final String name; final int port; long seen;
        Laptop(String ip, String name, int port, long seen) {
            this.ip = ip; this.name = name; this.port = port; this.seen = seen;
        }
    }

    /** A button with a leading icon and a label, centered: M3 filled or tonal. */
    private static final class Pill {
        LinearLayout view; ImageView icon; TextView label;
    }

    /**
     * Four rounded bars that move while audio streams, in place of a static icon.
     * The animator runs only while the bars are shown and the screen is in front.
     */
    private static final class Bars extends View {
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final RectF r = new RectF();
        private final float[] rest = {0.35f, 0.8f, 0.55f, 0.3f};
        private final float[] speed = {1.9f, 1.3f, 2.3f, 1.6f};
        private final float[] phase = {0f, 1.1f, 2.3f, 0.6f};
        private ValueAnimator anim;
        private float t;

        Bars(Context c) { super(c); }

        void setColor(int color) { paint.setColor(color); invalidate(); }

        void play(boolean on) {
            if (on == (anim != null)) return;
            if (on) {
                anim = ValueAnimator.ofFloat(0f, 1f);
                anim.setDuration(1000);
                anim.setRepeatCount(ValueAnimator.INFINITE);
                anim.addUpdateListener(a -> { t = android.os.SystemClock.uptimeMillis() / 1000f; invalidate(); });
                anim.start();
            } else {
                anim.cancel();
                anim = null;
                invalidate();
            }
        }

        @Override protected void onDetachedFromWindow() {
            play(false);
            super.onDetachedFromWindow();
        }

        @Override protected void onDraw(Canvas c) {
            float w = getWidth(), h = getHeight();
            float bar = w * 0.14f, gap = w * 0.09f;
            float x = (w - (4 * bar + 3 * gap)) / 2f;
            for (int i = 0; i < 4; i++) {
                float k = anim == null ? rest[i]
                        : 0.28f + 0.72f * Math.abs((float) Math.sin(t * speed[i] * 3f + phase[i]));
                float bh = Math.max(bar, h * 0.62f * k);
                r.set(x, (h - bh) / 2f, x + bar, (h + bh) / 2f);
                c.drawRoundRect(r, bar / 2f, bar / 2f, paint);
                x += bar + gap;
            }
        }
    }

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences("dhvani", MODE_PRIVATE);
        if (!StreamState.active()) StreamService.restoreLeftover(this);
        dark = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
        palette();
        getWindow().getDecorView().setBackgroundColor(surface);
        setContentView(buildUi());
        boolean launcher = Intent.ACTION_MAIN.equals(getIntent().getAction());
        if (state == null && (getIntent().getBooleanExtra(EXTRA_AUTOSTART, false)
                || (launcher && prefs.getBoolean("autoConnect", false)))) {
            main.post(this::autostart);
        }
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (intent.getBooleanExtra(EXTRA_AUTOSTART, false)) main.post(this::autostart);
    }

    /** Starts with the saved laptop and code; without them, stays put so the user can fill them in. */
    private void autostart() {
        if (StreamState.active()) return;
        if (addressField.getText().toString().trim().isEmpty()
                || !codeField.getText().toString().trim().matches("\\d{6}")) return;
        onStartStop();
    }

    @Override protected void onResume() {
        super.onResume();
        StreamState.add(this);
        onState();
        renderVolumeKeys();
        startDiscovery();
    }

    @Override protected void onPause() {
        StreamState.remove(this);
        stopDiscovery();
        saveFields();
        heroBars.play(false);
        super.onPause();
    }

    // ---------- Color ----------

    private static int mix(int a, int b, float t) {
        return Color.rgb(
                Math.round(Color.red(a) + (Color.red(b) - Color.red(a)) * t),
                Math.round(Color.green(a) + (Color.green(b) - Color.green(a)) * t),
                Math.round(Color.blue(a) + (Color.blue(b) - Color.blue(a)) * t));
    }

    private static int alpha(int color, float a) {
        return (Math.round(a * 255) << 24) | (color & 0x00FFFFFF);
    }

    private int sys(int id) { return getColor(id); }

    private void palette() {
        // Status colors are fixed so "error" and "warning" mean the same thing on every wallpaper.
        if (dark) {
            error = 0xFFFFB4AB; onError = 0xFF690005; errorContainer = 0xFF93000A; onErrorContainer = 0xFFFFDAD6;
            warningContainer = 0xFF5C4200; onWarningContainer = 0xFFFFDEA1;
        } else {
            error = 0xFFBA1A1A; onError = 0xFFFFFFFF; errorContainer = 0xFFFFDAD6; onErrorContainer = 0xFF410002;
            warningContainer = 0xFFFFDEA1; onWarningContainer = 0xFF261900;
        }
        if (Build.VERSION.SDK_INT >= 31) {
            // Dynamic color: map the system tonal palettes onto M3 roles.
            int n10 = sys(android.R.color.system_neutral1_10), n50 = sys(android.R.color.system_neutral1_50);
            int n100 = sys(android.R.color.system_neutral1_100), n800 = sys(android.R.color.system_neutral1_800);
            int n900 = sys(android.R.color.system_neutral1_900);
            if (dark) {
                primary = sys(android.R.color.system_accent1_200);
                onPrimary = sys(android.R.color.system_accent1_800);
                primaryContainer = sys(android.R.color.system_accent1_700);
                onPrimaryContainer = sys(android.R.color.system_accent1_100);
                secondaryContainer = sys(android.R.color.system_accent2_700);
                onSecondaryContainer = sys(android.R.color.system_accent2_100);
                surface = mix(n900, Color.BLACK, 0.4f);
                surfaceLow = n900;
                surfaceMid = mix(n900, n800, 0.2f);
                surfaceHigh = mix(n900, n800, 0.6f);
                surfaceHighest = n800;
                onSurface = n100;
                onSurfaceVariant = sys(android.R.color.system_neutral2_200);
                outline = sys(android.R.color.system_neutral2_400);
                outlineVariant = sys(android.R.color.system_neutral2_700);
            } else {
                primary = sys(android.R.color.system_accent1_600);
                onPrimary = sys(android.R.color.system_accent1_0);
                primaryContainer = sys(android.R.color.system_accent1_100);
                onPrimaryContainer = sys(android.R.color.system_accent1_900);
                secondaryContainer = sys(android.R.color.system_accent2_100);
                onSecondaryContainer = sys(android.R.color.system_accent2_900);
                surface = n10;
                surfaceLow = mix(n10, n50, 0.7f);
                surfaceMid = mix(n50, n100, 0.2f);
                surfaceHigh = mix(n50, n100, 0.55f);
                surfaceHighest = n100;
                onSurface = n900;
                onSurfaceVariant = sys(android.R.color.system_neutral2_700);
                outline = sys(android.R.color.system_neutral2_500);
                outlineVariant = sys(android.R.color.system_neutral2_200);
            }
            return;
        }
        // Static teal scheme (same seed as the laptop panel).
        if (dark) {
            primary = 0xFF82D5CC; onPrimary = 0xFF003733; primaryContainer = 0xFF00504B; onPrimaryContainer = 0xFF9EF2E8;
            secondaryContainer = 0xFF334B48; onSecondaryContainer = 0xFFCCE8E3;
            surface = 0xFF0E1514; surfaceLow = 0xFF161D1C; surfaceMid = 0xFF1A2120;
            surfaceHigh = 0xFF252B2A; surfaceHighest = 0xFF2F3635;
            onSurface = 0xFFDDE4E2; onSurfaceVariant = 0xFFBEC9C6; outline = 0xFF899390; outlineVariant = 0xFF3F4947;
        } else {
            primary = 0xFF006A64; onPrimary = 0xFFFFFFFF; primaryContainer = 0xFF9EF2E8; onPrimaryContainer = 0xFF00201D;
            secondaryContainer = 0xFFCCE8E3; onSecondaryContainer = 0xFF051F1C;
            surface = 0xFFF4FBF9; surfaceLow = 0xFFEFF5F3; surfaceMid = 0xFFE9EFED;
            surfaceHigh = 0xFFE3EAE8; surfaceHighest = 0xFFDDE4E2;
            onSurface = 0xFF161D1C; onSurfaceVariant = 0xFF3F4947; outline = 0xFF6F7977; outlineVariant = 0xFFBEC9C6;
        }
    }

    // ---------- Building blocks ----------

    private int dp(float v) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v,
                getResources().getDisplayMetrics()));
    }

    private GradientDrawable shape(int fill, float radiusDp) {
        GradientDrawable g = new GradientDrawable();
        g.setColor(fill);
        g.setCornerRadius(dp(radiusDp));
        return g;
    }

    /** Content drawable with an M3 state layer (ripple) in the given content color. */
    private Drawable pressable(Drawable content, int contentColor, float radiusDp) {
        return new RippleDrawable(ColorStateList.valueOf(alpha(contentColor, 0.12f)), content,
                shape(Color.WHITE, radiusDp));
    }

    /** Scale to 0.96 while pressed: tactile feedback for buttons. */
    private void pressScale(View v) {
        v.setOnTouchListener((view, e) -> {
            int a = e.getActionMasked();
            if (a == MotionEvent.ACTION_DOWN) {
                view.animate().scaleX(0.96f).scaleY(0.96f).setDuration(100).setInterpolator(EASE).start();
            } else if (a == MotionEvent.ACTION_UP || a == MotionEvent.ACTION_CANCEL) {
                view.animate().scaleX(1f).scaleY(1f).setDuration(150).setInterpolator(EASE).start();
            }
            return false;
        });
    }

    private TextView text(String s, float sp, int color, boolean medium) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color);
        if (medium) t.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        return t;
    }

    private LinearLayout vertical() {
        LinearLayout l = new LinearLayout(this);
        l.setOrientation(LinearLayout.VERTICAL);
        return l;
    }

    private static LinearLayout.LayoutParams fullWidth() {
        return new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    }

    private static LinearLayout.LayoutParams weighted() {
        return new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1);
    }

    private ImageView icon(int res, int tint, int sizeDp) {
        ImageView i = new ImageView(this);
        i.setImageResource(res);
        i.setImageTintList(ColorStateList.valueOf(tint));
        i.setLayoutParams(new FrameLayout.LayoutParams(dp(sizeDp), dp(sizeDp), Gravity.CENTER));
        return i;
    }

    /** Sections slide open and shut, and their contents fade, instead of jumping. */
    private LayoutTransition smooth() {
        LayoutTransition lt = new LayoutTransition();
        lt.enableTransitionType(LayoutTransition.CHANGING);
        for (int type : new int[] {LayoutTransition.CHANGING, LayoutTransition.CHANGE_APPEARING,
                LayoutTransition.CHANGE_DISAPPEARING, LayoutTransition.APPEARING, LayoutTransition.DISAPPEARING}) {
            lt.setInterpolator(type, EASE);
        }
        lt.setDuration(LayoutTransition.CHANGING, 240);
        lt.setDuration(LayoutTransition.CHANGE_APPEARING, 240);
        lt.setDuration(LayoutTransition.CHANGE_DISAPPEARING, 240);
        lt.setDuration(LayoutTransition.APPEARING, 200);
        lt.setDuration(LayoutTransition.DISAPPEARING, 120);
        lt.setStartDelay(LayoutTransition.APPEARING, 80);
        lt.setStartDelay(LayoutTransition.CHANGE_DISAPPEARING, 0);
        return lt;
    }

    private void showKeyboard(View v) {
        InputMethodManager imm = getSystemService(InputMethodManager.class);
        if (imm != null) imm.showSoftInput(v, InputMethodManager.SHOW_IMPLICIT);
    }

    private void hideKeyboard() {
        View f = getCurrentFocus();
        if (f != null) f.clearFocus();
        InputMethodManager imm = getSystemService(InputMethodManager.class);
        if (imm != null) imm.hideSoftInputFromWindow(getWindow().getDecorView().getWindowToken(), 0);
    }

    /** M3 list subheader followed by a grouped container; returns the container. */
    private LinearLayout section(LinearLayout parent, String heading) {
        TextView h = text(heading, 14, primary, true);
        h.setPadding(dp(16), dp(28), dp(16), dp(8));
        parent.addView(h);
        LinearLayout c = vertical();
        c.setBackground(shape(surfaceLow, 24));
        c.setClipToOutline(true);
        c.setPadding(0, dp(4), 0, dp(4));
        parent.addView(c, fullWidth());
        return c;
    }

    /** Filled text field: tonal box with a label; a primary outline while focused. */
    private EditText field(LinearLayout parent, String label, String hint, int inputType) {
        LinearLayout box = vertical();
        GradientDrawable bg = shape(surfaceHighest, 12);
        box.setBackground(bg);
        box.setPadding(dp(16), dp(10), dp(16), dp(4));
        TextView l = text(label, 12, onSurfaceVariant, true);
        box.addView(l);
        EditText e = new EditText(this);
        e.setHint(hint);
        e.setInputType(inputType);
        e.setSingleLine(true);
        e.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        e.setTextColor(onSurface);
        e.setHintTextColor(alpha(onSurfaceVariant, 0.7f));
        e.setBackground(null);
        e.setPadding(0, dp(2), 0, dp(8));
        box.addView(e, fullWidth());
        e.setOnFocusChangeListener((v, focused) -> {
            bg.setStroke(focused ? dp(2) : 0, primary);
            l.setTextColor(focused ? primary : onSurfaceVariant);
        });
        box.setOnClickListener(v -> { e.requestFocus(); showKeyboard(e); });
        LinearLayout.LayoutParams lp = fullWidth();
        lp.setMargins(dp(12), dp(8), dp(12), dp(4));
        parent.addView(box, lp);
        return e;
    }

    /** List row: leading icon, title, optional supporting text (kept in the row's tag), trailing view. */
    private LinearLayout listRow(LinearLayout parent, int iconRes, String title, String sub, View trailing) {
        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setMinimumHeight(dp(64));
        row.setPadding(dp(16), dp(10), dp(16), dp(10));
        row.setBackground(pressable(null, onSurface, 0));
        ImageView i = new ImageView(this);
        i.setImageResource(iconRes);
        i.setImageTintList(ColorStateList.valueOf(onSurfaceVariant));
        LinearLayout.LayoutParams ilp = new LinearLayout.LayoutParams(dp(24), dp(24));
        ilp.setMarginEnd(dp(16));
        row.addView(i, ilp);
        LinearLayout texts = vertical();
        texts.addView(text(title, 16, onSurface, false));
        TextView s = text(sub, 13, onSurfaceVariant, false);
        s.setPadding(0, dp(1), dp(8), 0);
        s.setVisibility(sub.isEmpty() ? View.GONE : View.VISIBLE);
        texts.addView(s);
        row.setTag(s);
        row.addView(texts, weighted());
        if (trailing != null) row.addView(trailing);
        parent.addView(row, fullWidth());
        return row;
    }

    private Switch switchRow(LinearLayout parent, int iconRes, String title, String sub, boolean value) {
        Switch sw = new Switch(this);
        sw.setChecked(value);
        sw.setContentDescription(title);
        int[][] states = {{android.R.attr.state_checked}, {}};
        sw.setThumbTintList(new ColorStateList(states, new int[] {primary, outline}));
        sw.setTrackTintList(new ColorStateList(states, new int[] {alpha(primary, 0.5f), outlineVariant}));
        LinearLayout row = listRow(parent, iconRes, title, sub, sw);
        row.setOnClickListener(v -> sw.toggle());
        return sw;
    }

    /** Full-width 56dp button with a leading icon; colors are set per state by stylePill. */
    private Pill pill() {
        Pill p = new Pill();
        p.view = new LinearLayout(this);
        p.view.setGravity(Gravity.CENTER);
        p.view.setClickable(true);
        p.view.setFocusable(true);
        p.icon = new ImageView(this);
        LinearLayout.LayoutParams ilp = new LinearLayout.LayoutParams(dp(20), dp(20));
        ilp.setMarginEnd(dp(8));
        p.view.addView(p.icon, ilp);
        p.label = text("", 16, onPrimary, true);
        p.view.addView(p.label);
        pressScale(p.view);
        return p;
    }

    private void stylePill(Pill p, int iconRes, String label, int bg, int fg) {
        p.icon.setImageResource(iconRes);
        p.icon.setImageTintList(ColorStateList.valueOf(fg));
        p.label.setText(label);
        p.label.setTextColor(fg);
        p.view.setBackground(pressable(shape(bg, 16), fg, 16));
    }

    /**
     * Thick rounded track and a ringed thumb, in the streaming card's colors. The fill is clipped
     * from the left on purpose: the SeekBar mirrors its drawable in RTL itself, and START would
     * flip it a second time.
     */
    private void styleSlider(SeekBar b) {
        GradientDrawable track = shape(alpha(onPrimaryContainer, 0.16f), 4);
        ClipDrawable fill = new ClipDrawable(shape(primary, 4), Gravity.LEFT, ClipDrawable.HORIZONTAL);
        LayerDrawable ld = new LayerDrawable(new Drawable[] {track, fill});
        ld.setId(0, android.R.id.background);
        ld.setId(1, android.R.id.progress);
        b.setProgressDrawable(ld);
        b.setMinHeight(dp(8));
        b.setMaxHeight(dp(8));
        GradientDrawable thumb = new GradientDrawable();
        thumb.setShape(GradientDrawable.OVAL);
        thumb.setColor(primary);
        thumb.setStroke(dp(3), primaryContainer);
        thumb.setSize(dp(24), dp(24));
        b.setThumb(thumb);
        b.setSplitTrack(false);
        b.setBackground(null);
        b.setPadding(dp(14), 0, dp(14), 0);
    }

    private void renderVolumeKeys() {
        if (keysSub == null) return;
        boolean on = VolumeKeyService.enabled(this);
        keysSub.setText(on ? "On while this phone is silenced"
                : Build.VERSION.SDK_INT >= 33
                        ? "Tap to turn on in Accessibility. Greyed out? App info › ⋮ › Allow restricted settings"
                        : "Tap to turn on in Accessibility");
        keysSub.setVisibility(View.VISIBLE);
        keysTrail.setImageResource(on ? R.drawable.ic_check : R.drawable.ic_chevron);
        keysTrail.setImageTintList(ColorStateList.valueOf(on ? primary : onSurfaceVariant));
    }

    // ---------- Screen ----------

    private View buildUi() {
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(surface);
        scroll.setFillViewport(true);
        LinearLayout root = vertical();
        root.setPadding(dp(16), dp(8), dp(16), dp(24));
        root.setLayoutTransition(smooth());
        scroll.addView(root);
        scroll.setOnApplyWindowInsetsListener((v, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets i = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
                v.setPadding(i.left, i.top, i.right, i.bottom);
                return WindowInsets.CONSUMED;
            }
            v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                    insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets.consumeSystemWindowInsets();
        });

        TextView title = text("Dhvani", 22, onSurface, true);
        title.setPadding(dp(8), dp(20), dp(8), dp(16));
        root.addView(title);

        // ---- Status card: everything about the current stream ----
        LinearLayout hero = vertical();
        hero.setPadding(dp(16), dp(16), dp(16), dp(16));
        heroBg = shape(surfaceMid, 32);
        hero.setBackground(heroBg);
        hero.setLayoutTransition(smooth());
        root.addView(hero, fullWidth());

        LinearLayout top = new LinearLayout(this);
        top.setGravity(Gravity.CENTER_VERTICAL);
        top.setPadding(dp(4), dp(4), dp(4), dp(4));
        heroAvatar = new FrameLayout(this);
        heroIcon = icon(R.drawable.ic_phone, onSurfaceVariant, 24);
        heroAvatar.addView(heroIcon);
        heroBars = new Bars(this);
        heroBars.setVisibility(View.GONE);
        heroAvatar.addView(heroBars, new FrameLayout.LayoutParams(dp(32), dp(32), Gravity.CENTER));
        LinearLayout.LayoutParams alp = new LinearLayout.LayoutParams(dp(52), dp(52));
        alp.setMarginEnd(dp(16));
        top.addView(heroAvatar, alp);
        LinearLayout texts = vertical();
        heroOverline = text("", 12, onSurfaceVariant, true);
        heroOverline.setLetterSpacing(0.04f);
        heroTitle = text("", 22, onSurface, false);
        heroTitle.setMaxLines(2);
        heroTitle.setEllipsize(TextUtils.TruncateAt.END);
        heroDetail = text("", 14, onSurfaceVariant, false);
        heroDetail.setPadding(0, dp(2), 0, 0);
        texts.addView(heroOverline);
        texts.addView(heroTitle);
        texts.addView(heroDetail);
        top.addView(texts, weighted());
        hero.addView(top, fullWidth());

        heroProgress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        heroProgress.setIndeterminate(true);
        LinearLayout.LayoutParams plp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(4));
        plp.setMargins(dp(4), dp(16), dp(4), 0);
        hero.addView(heroProgress, plp);

        // Laptop volume: mute toggle, slider, value
        volumeRow = new LinearLayout(this);
        volumeRow.setGravity(Gravity.CENTER_VERTICAL);
        muteButton = new FrameLayout(this);
        muteButton.setClickable(true);
        muteButton.setFocusable(true);
        muteOn = icon(R.drawable.ic_volume, onPrimaryContainer, 22);
        muteOff = icon(R.drawable.ic_volume_off, onPrimaryContainer, 22);
        muteButton.addView(muteOn);
        muteButton.addView(muteOff);
        muteButton.setOnClickListener(v -> sendControl(null, !StreamState.laptopMuted));
        pressScale(muteButton);
        volumeRow.addView(muteButton, new LinearLayout.LayoutParams(dp(48), dp(48)));
        volumeBar = new SeekBar(this);
        volumeBar.setMax(150);
        volumeBar.setContentDescription("Laptop volume");
        styleSlider(volumeBar);
        volumeBar.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override public void onProgressChanged(SeekBar b, int p, boolean user) {
                if (!user) return;
                volumeValue.setText(p + "%");
                long now = System.currentTimeMillis();
                if (now - lastVolumeSent >= 80) {
                    lastVolumeSent = now;
                    sendControl(p / 100f, null);
                }
            }
            @Override public void onStartTrackingTouch(SeekBar b) { draggingVolume = true; }
            @Override public void onStopTrackingTouch(SeekBar b) {
                draggingVolume = false;
                sendControl(b.getProgress() / 100f, null);
            }
        });
        volumeRow.addView(volumeBar, new LinearLayout.LayoutParams(0, dp(48), 1));
        volumeValue = text("", 14, onPrimaryContainer, true);
        volumeValue.setFontFeatureSettings("tnum");
        volumeValue.setGravity(Gravity.END | Gravity.CENTER_VERTICAL);
        volumeRow.addView(volumeValue, new LinearLayout.LayoutParams(dp(52), ViewGroup.LayoutParams.WRAP_CONTENT));
        LinearLayout.LayoutParams vrlp = fullWidth();
        vrlp.topMargin = dp(16);
        hero.addView(volumeRow, vrlp);

        // Notice: a problem with the stream, or a Wi-Fi tip
        noticeBox = new LinearLayout(this);
        noticeBox.setGravity(Gravity.CENTER_VERTICAL);
        noticeBox.setPadding(dp(12), dp(12), dp(16), dp(12));
        noticeBox.setBackground(shape(warningContainer, 16));
        noticeIcon = new ImageView(this);
        noticeIcon.setImageTintList(ColorStateList.valueOf(onWarningContainer));
        LinearLayout.LayoutParams nilp = new LinearLayout.LayoutParams(dp(20), dp(20));
        nilp.setMarginEnd(dp(12));
        noticeBox.addView(noticeIcon, nilp);
        notice = text("", 14, onWarningContainer, false);
        noticeBox.addView(notice, weighted());
        LinearLayout.LayoutParams nlp = fullWidth();
        nlp.topMargin = dp(16);
        hero.addView(noticeBox, nlp);

        actionButton = pill();
        actionButton.view.setOnClickListener(v -> onStartStop());
        LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(56));
        blp.topMargin = dp(16);
        hero.addView(actionButton.view, blp);

        // ---- Setup: hidden while connecting or streaming ----
        setup = vertical();
        setup.setLayoutTransition(smooth());
        root.addView(setup, fullWidth());

        LinearLayout lap = section(setup, "Laptop");
        lap.setLayoutTransition(smooth());
        searchRow = new LinearLayout(this);
        searchRow.setGravity(Gravity.CENTER_VERTICAL);
        searchRow.setPadding(dp(16), dp(14), dp(16), dp(14));
        ProgressBar spinner = new ProgressBar(this, null, android.R.attr.progressBarStyleSmall);
        spinner.setIndeterminateTintList(ColorStateList.valueOf(primary));
        LinearLayout.LayoutParams slp = new LinearLayout.LayoutParams(dp(20), dp(20));
        slp.setMarginEnd(dp(16));
        searchRow.addView(spinner, slp);
        searchRow.addView(text("Looking for laptops on this Wi-Fi…", 14, onSurfaceVariant, false), weighted());
        lap.addView(searchRow, fullWidth());
        laptopList = vertical();
        laptopList.setPadding(dp(8), 0, dp(8), 0);
        lap.addView(laptopList, fullWidth());
        manualRow = listRow(lap, R.drawable.ic_edit, "Enter address", "", null);
        manualRow.setOnClickListener(v -> {
            manualOpen = true;
            renderLaptops();
            addressField.requestFocus();
            showKeyboard(addressField);
        });
        addressField = field(lap, "Address", "192.168.1.20",
                InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        addressField.setText(prefs.getString("host", ""));
        addressBox = (LinearLayout) addressField.getParent();
        codeField = field(lap, "Pairing code", "6 digits from the laptop panel", InputType.TYPE_CLASS_NUMBER);
        codeField.setFilters(new InputFilter[] {new InputFilter.LengthFilter(6)});
        codeField.setImeOptions(EditorInfo.IME_ACTION_DONE);
        codeField.setFontFeatureSettings("tnum");
        codeField.setText(prefs.getString("code", ""));
        ((LinearLayout.LayoutParams) ((View) codeField.getParent()).getLayoutParams()).bottomMargin = dp(12);
        styleCode();

        LinearLayout opts = section(setup, "Options");
        silenceSwitch = switchRow(opts, R.drawable.ic_phone_quiet, "Silence this phone",
                "Mute its speaker while the laptop plays", prefs.getBoolean("silence", true));
        keysTrail = new ImageView(this);
        keysTrail.setLayoutParams(new LinearLayout.LayoutParams(dp(20), dp(20)));
        LinearLayout keysRow = listRow(opts, R.drawable.ic_keys, "Volume buttons control the laptop", "", keysTrail);
        keysSub = (TextView) keysRow.getTag();
        keysRow.setOnClickListener(v -> {
            try {
                startActivity(new Intent(android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS));
            } catch (RuntimeException ignored) {}
        });
        reconnectSwitch = switchRow(opts, R.drawable.ic_retry_auto, "Reconnect automatically",
                "If Wi-Fi drops or the laptop restarts", prefs.getBoolean("reconnect", true));
        autoSwitch = switchRow(opts, R.drawable.ic_bolt, "Start when opened",
                "Connect to the saved laptop on launch", prefs.getBoolean("autoConnect", false));

        LinearLayout foot = new LinearLayout(this);
        foot.setGravity(Gravity.CENTER_VERTICAL);
        foot.setPadding(dp(16), dp(20), dp(16), 0);
        ImageView lock = new ImageView(this);
        lock.setImageResource(R.drawable.ic_lock);
        lock.setImageTintList(ColorStateList.valueOf(onSurfaceVariant));
        LinearLayout.LayoutParams lklp = new LinearLayout.LayoutParams(dp(16), dp(16));
        lklp.setMarginEnd(dp(8));
        foot.addView(lock, lklp);
        foot.addView(text("Only playback audio is shared, never the mic or screen.", 12, onSurfaceVariant, false), weighted());
        setup.addView(foot, fullWidth());

        android.text.TextWatcher refresh = new android.text.TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int a, int b, int c) {}
            @Override public void onTextChanged(CharSequence s, int a, int b, int c) {}
            @Override public void afterTextChanged(android.text.Editable s) {
                styleCode();
                if (!StreamState.active()) onState();
            }
        };
        addressField.addTextChangedListener(refresh);
        codeField.addTextChangedListener(refresh);
        renderLaptops();
        return scroll;
    }

    /** Digits spaced like a code once typed; the hint stays plain text. */
    private void styleCode() {
        boolean empty = codeField.getText().length() == 0;
        codeField.setTextSize(TypedValue.COMPLEX_UNIT_SP, empty ? 16 : 22);
        codeField.setLetterSpacing(empty ? 0f : 0.3f);
    }

    /** The name of the laptop at this address, if discovery has seen it. */
    private String laptopName(String addr) {
        synchronized (laptops) {
            for (Laptop l : laptops.values()) if (address(l).equals(addr)) return l.name;
        }
        return addr;
    }

    private static String address(Laptop l) {
        return l.port == Protocol.AUDIO_PORT ? l.ip : l.ip + ":" + l.port;
    }

    private String idleHint() {
        String addr = addressField.getText().toString().trim();
        if (addr.isEmpty()) return "Pick your laptop below.";
        if (!codeField.getText().toString().trim().matches("\\d{6}")) return "Enter the pairing code below.";
        return "Ready for " + laptopName(addr) + ".";
    }

    private boolean heroColorSet;
    private int heroShown;

    /** Cross-fades the card's color between states. */
    private void fadeHero(int to) {
        if (heroColorSet && heroFade == null && heroShown == to) return;
        if (heroFade != null) heroFade.cancel();
        heroFade = null;
        if (!heroColorSet) {
            heroColorSet = true;
            heroShown = to;
            heroBg.setColor(to);
            return;
        }
        if (heroShown == to) return;
        ValueAnimator a = ValueAnimator.ofArgb(heroShown, to);
        a.setDuration(250);
        a.setInterpolator(EASE);
        a.addUpdateListener(v -> {
            heroShown = (int) v.getAnimatedValue();
            heroBg.setColor(heroShown);
        });
        a.addListener(new android.animation.AnimatorListenerAdapter() {
            @Override public void onAnimationEnd(android.animation.Animator x) {
                if (heroFade == a) heroFade = null;
            }
        });
        heroFade = a;
        a.start();
    }

    @Override public void onState() {
        StreamState.Status s = StreamState.status;
        boolean active = StreamState.active();
        boolean streaming = s == StreamState.Status.STREAMING;
        String overline = "", title, detail = StreamState.detail, action;
        int bg, fg, fgVariant, avatarBg, avatarFg, iconRes, actionIcon, actionBg, actionFg;
        switch (s) {
            case STREAMING:
                bg = primaryContainer; fg = onPrimaryContainer; fgVariant = alpha(onPrimaryContainer, 0.75f);
                avatarBg = primary; avatarFg = onPrimary; iconRes = R.drawable.ic_notify;
                overline = "Playing on";
                title = detail.isEmpty() ? "your laptop" : detail;
                detail = "";
                action = "Stop"; actionIcon = R.drawable.ic_stop;
                actionBg = alpha(onPrimaryContainer, 0.1f); actionFg = onPrimaryContainer;
                break;
            case CONNECTING:
            case RECONNECTING:
                bg = secondaryContainer; fg = onSecondaryContainer; fgVariant = alpha(onSecondaryContainer, 0.75f);
                avatarBg = alpha(onSecondaryContainer, 0.1f); avatarFg = onSecondaryContainer;
                iconRes = R.drawable.ic_laptop;
                title = s == StreamState.Status.CONNECTING ? "Connecting…" : "Reconnecting…";
                action = "Cancel"; actionIcon = R.drawable.ic_close;
                actionBg = alpha(onSecondaryContainer, 0.1f); actionFg = onSecondaryContainer;
                break;
            case ERROR:
                bg = errorContainer; fg = onErrorContainer; fgVariant = alpha(onErrorContainer, 0.85f);
                avatarBg = error; avatarFg = onError; iconRes = R.drawable.ic_error;
                title = "Stopped";
                action = "Try again"; actionIcon = R.drawable.ic_retry;
                actionBg = primary; actionFg = onPrimary;
                break;
            default:
                bg = surfaceMid; fg = onSurface; fgVariant = onSurfaceVariant;
                avatarBg = surfaceHighest; avatarFg = onSurfaceVariant; iconRes = R.drawable.ic_phone;
                title = "Not streaming";
                if (detail.isEmpty()) detail = idleHint();
                action = "Start streaming"; actionIcon = R.drawable.ic_play;
                actionBg = primary; actionFg = onPrimary;
                break;
        }
        fadeHero(bg);
        heroAvatar.setBackground(shape(avatarBg, 16));
        heroIcon.setImageResource(iconRes);
        heroIcon.setImageTintList(ColorStateList.valueOf(avatarFg));
        heroIcon.setVisibility(streaming ? View.GONE : View.VISIBLE);
        heroBars.setVisibility(streaming ? View.VISIBLE : View.GONE);
        heroBars.setColor(avatarFg);
        heroBars.play(streaming);
        heroOverline.setText(overline);
        heroOverline.setTextColor(fgVariant);
        heroOverline.setVisibility(overline.isEmpty() ? View.GONE : View.VISIBLE);
        heroTitle.setText(title);
        heroTitle.setTextColor(fg);
        heroDetail.setText(detail);
        heroDetail.setTextColor(fgVariant);
        heroDetail.setVisibility(detail.isEmpty() ? View.GONE : View.VISIBLE);
        heroProgress.setVisibility(active && !streaming ? View.VISIBLE : View.GONE);
        heroProgress.setIndeterminateTintList(ColorStateList.valueOf(fg));

        String n = StreamState.notice;
        boolean wifi = false;
        if (n.isEmpty() && streaming && StreamState.laptopOutputMissing) {
            n = "The laptop's chosen output (a headset?) is off, so nothing is playing. Turn it on or pick "
                    + "another output in the laptop panel.";
        }
        if (n.isEmpty() && streaming) { n = StreamState.wifiTip; wifi = true; }
        notice.setText(n);
        noticeIcon.setImageResource(wifi ? R.drawable.ic_wifi : R.drawable.ic_alert);
        noticeBox.setVisibility(n.isEmpty() ? View.GONE : View.VISIBLE);

        stylePill(actionButton, actionIcon, action, actionBg, actionFg);

        boolean showVolume = streaming && StreamState.laptopVolume >= 0;
        volumeRow.setVisibility(showVolume ? View.VISIBLE : View.GONE);
        if (showVolume) renderVolume();

        if (active && setup.getVisibility() == View.VISIBLE) hideKeyboard();
        setup.setVisibility(active ? View.GONE : View.VISIBLE);
    }

    private void renderVolume() {
        int pct = (int) Math.round(StreamState.laptopVolume * 100);
        boolean muted = StreamState.laptopMuted;
        if (!draggingVolume) {
            volumeBar.setProgress(pct);
            volumeValue.setText(muted ? "Muted" : pct + "%");
        }
        volumeBar.setAlpha(muted ? 0.45f : 1f);
        // Muted reads as "on": a filled circle, like a pressed toggle.
        int fill = muted ? onPrimaryContainer : alpha(onPrimaryContainer, 0.1f);
        int ink = muted ? primaryContainer : onPrimaryContainer;
        muteButton.setBackground(pressable(shape(fill, 24), ink, 24));
        muteOn.setImageTintList(ColorStateList.valueOf(ink));
        muteOff.setImageTintList(ColorStateList.valueOf(ink));
        muteButton.setContentDescription(muted ? "Unmute" : "Mute");
        if (shownMuted == null || shownMuted != muted) {
            swapIcon(muted ? muteOff : muteOn, muted ? muteOn : muteOff, shownMuted != null);
            shownMuted = muted;
        }
    }

    /** Icon swap: the new one scales up from 0.25 and fades in while the old one shrinks out. */
    private static void swapIcon(View in, View out, boolean animate) {
        in.animate().cancel();
        out.animate().cancel();
        if (!animate) {
            in.setAlpha(1f); in.setScaleX(1f); in.setScaleY(1f);
            out.setAlpha(0f); out.setScaleX(0.25f); out.setScaleY(0.25f);
            return;
        }
        in.animate().alpha(1f).scaleX(1f).scaleY(1f).setDuration(200).setInterpolator(EASE).start();
        out.animate().alpha(0f).scaleX(0.25f).scaleY(0.25f).setDuration(200).setInterpolator(EASE).start();
    }

    private String laptopsShown;

    private void renderLaptops() {
        long now = System.currentTimeMillis();
        List<Laptop> list = new ArrayList<>();
        synchronized (laptops) {
            laptops.values().removeIf(l -> now - l.seen > LAPTOP_TTL_MS);
            list.addAll(laptops.values());
        }
        String current = addressField.getText().toString().trim();
        boolean inList = false;
        StringBuilder key = new StringBuilder(current).append('|');
        for (Laptop l : list) {
            String a = address(l);
            if (a.equals(current)) inList = true;
            key.append(a).append('=').append(l.name).append(';');
        }
        searchRow.setVisibility(list.isEmpty() ? View.VISIBLE : View.GONE);
        // The typed address shows only when asked for, or when it is not one of the laptops listed.
        boolean typed = manualOpen || addressField.hasFocus() || (!current.isEmpty() && !inList);
        addressBox.setVisibility(typed ? View.VISIBLE : View.GONE);
        manualRow.setVisibility(typed ? View.GONE : View.VISIBLE);
        // Rebuild only on a real change, so rows don't flash every discovery round.
        if (key.toString().equals(laptopsShown)) return;
        laptopsShown = key.toString();
        laptopList.removeAllViews();
        for (Laptop l : list) {
            String addr = address(l);
            boolean selected = addr.equals(current);
            boolean usb = USB_HOST.equals(l.ip);
            LinearLayout row = new LinearLayout(this);
            row.setGravity(Gravity.CENTER_VERTICAL);
            row.setMinimumHeight(dp(64));
            row.setPadding(dp(8), dp(8), dp(12), dp(8));
            row.setBackground(pressable(shape(selected ? secondaryContainer : Color.TRANSPARENT, 16),
                    onSurface, 16));
            FrameLayout lead = new FrameLayout(this);
            lead.setBackground(shape(selected ? primary : surfaceHighest, 12));
            lead.addView(icon(usb ? R.drawable.ic_usb : R.drawable.ic_laptop,
                    selected ? onPrimary : onSurfaceVariant, 22));
            LinearLayout.LayoutParams llp = new LinearLayout.LayoutParams(dp(44), dp(44));
            llp.setMarginEnd(dp(16));
            row.addView(lead, llp);
            LinearLayout t = vertical();
            int fg = selected ? onSecondaryContainer : onSurface;
            TextView name = text(l.name, 16, fg, selected);
            name.setSingleLine(true);
            name.setEllipsize(TextUtils.TruncateAt.END);
            t.addView(name);
            String shown = usb ? "USB cable" : addr;
            t.addView(text(shown, 13, selected ? alpha(onSecondaryContainer, 0.8f) : onSurfaceVariant, false));
            row.addView(t, weighted());
            if (selected) {
                ImageView check = new ImageView(this);
                check.setImageResource(R.drawable.ic_check);
                check.setImageTintList(ColorStateList.valueOf(primary));
                row.addView(check, new LinearLayout.LayoutParams(dp(22), dp(22)));
            }
            row.setContentDescription(l.name + ", " + shown + (selected ? ", selected" : ""));
            row.setOnClickListener(v -> {
                if (StreamState.active()) return;
                manualOpen = false;
                addressField.clearFocus();
                addressField.setText(addr);
                renderLaptops();
                if (codeField.getText().length() < 6) {
                    codeField.requestFocus();
                    showKeyboard(codeField);
                } else {
                    hideKeyboard();
                }
            });
            LinearLayout.LayoutParams lp = fullWidth();
            lp.setMargins(0, dp(2), 0, dp(2));
            laptopList.addView(row, lp);
        }
        if (!StreamState.active()) onState();
    }

    // ---------- Start / stop ----------

    private void saveFields() {
        prefs.edit()
                .putString("host", addressField.getText().toString().trim())
                .putString("code", codeField.getText().toString().trim())
                .putBoolean("silence", silenceSwitch.isChecked())
                .putBoolean("reconnect", reconnectSwitch.isChecked())
                .putBoolean("autoConnect", autoSwitch.isChecked())
                .apply();
    }

    private void sendControl(Float volume, Boolean muted) {
        if (StreamState.status != StreamState.Status.STREAMING) {
            android.util.Log.d("Dhvani", "control not sent, status " + StreamState.status);
            return;
        }
        Intent i = new Intent(this, StreamService.class).setAction(StreamService.ACTION_CONTROL);
        if (volume != null) i.putExtra(StreamService.EXTRA_VOLUME, volume.floatValue());
        if (muted != null) i.putExtra(StreamService.EXTRA_MUTED, muted.booleanValue());
        try { startService(i); } catch (RuntimeException ignored) {}
    }

    private void showError(String msg) {
        StreamState.set(StreamState.Status.ERROR, msg);
    }

    private void onStartStop() {
        if (StreamState.active()) {
            startService(new Intent(this, StreamService.class).setAction(StreamService.ACTION_STOP));
            return;
        }
        String addr = addressField.getText().toString().trim();
        if (addr.isEmpty()) { showError("Pick a laptop or type its address."); return; }
        if (!codeField.getText().toString().trim().matches("\\d{6}")) {
            showError("Enter the 6-digit code shown on the laptop.");
            return;
        }
        saveFields();
        List<String> need = new ArrayList<>();
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            need.add(Manifest.permission.RECORD_AUDIO);
        }
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            need.add(Manifest.permission.POST_NOTIFICATIONS);
        }
        if (!need.isEmpty()) {
            requestPermissions(need.toArray(new String[0]), REQ_PERMS);
            return;
        }
        askProjection();
    }

    @Override public void onRequestPermissionsResult(int req, String[] perms, int[] results) {
        if (req != REQ_PERMS) return;
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            showError("Android needs the audio permission to share what's playing. "
                    + "Dhvani never records the microphone.");
            return;
        }
        askProjection();
    }

    private void askProjection() {
        MediaProjectionManager mpm = getSystemService(MediaProjectionManager.class);
        Intent i = Build.VERSION.SDK_INT >= 34
                ? mpm.createScreenCaptureIntent(MediaProjectionConfig.createConfigForDefaultDisplay())
                : mpm.createScreenCaptureIntent();
        StreamState.set(StreamState.Status.IDLE, "Allow sharing on the next screen.");
        startActivityForResult(i, REQ_PROJECTION);
    }

    @Override protected void onActivityResult(int req, int result, Intent data) {
        if (req != REQ_PROJECTION) return;
        if (result != RESULT_OK || data == null) {
            showError("Sharing was cancelled.");
            return;
        }
        String addr = prefs.getString("host", "");
        String host = addr;
        int port = Protocol.AUDIO_PORT;
        int colon = addr.lastIndexOf(':');
        if (colon > 0 && addr.indexOf(':') == colon) {
            try {
                port = Integer.parseInt(addr.substring(colon + 1));
                host = addr.substring(0, colon);
            } catch (NumberFormatException e) {
                showError("The port after ':' must be a number.");
                return;
            }
        }
        Intent svc = new Intent(this, StreamService.class)
                .setAction(StreamService.ACTION_START)
                .putExtra(StreamService.EXTRA_RESULT_CODE, result)
                .putExtra(StreamService.EXTRA_DATA, data)
                .putExtra(StreamService.EXTRA_HOST, host)
                .putExtra(StreamService.EXTRA_PORT, port)
                .putExtra(StreamService.EXTRA_CODE, prefs.getString("code", ""))
                .putExtra(StreamService.EXTRA_SILENCE, prefs.getBoolean("silence", true))
                .putExtra(StreamService.EXTRA_RECONNECT, prefs.getBoolean("reconnect", true));
        StreamState.set(StreamState.Status.CONNECTING, "Connecting to " + host);
        startForegroundService(svc);
    }

    // ---------- Discovery ----------

    private void startDiscovery() {
        if (discoveryThread != null) return;
        Thread t = new Thread(this::discoverLoop, "dhvani-discovery");
        discoveryThread = t;
        t.start();
    }

    private void stopDiscovery() {
        Thread t = discoveryThread;
        discoveryThread = null;
        if (t != null) t.interrupt();
    }

    private static List<InetAddress> broadcastTargets() {
        List<InetAddress> out = new ArrayList<>();
        try {
            out.add(InetAddress.getByName("255.255.255.255"));
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InterfaceAddress ia : ni.getInterfaceAddresses()) {
                    InetAddress b = ia.getBroadcast();
                    if (b != null && !out.contains(b)) out.add(b);
                }
            }
        } catch (Exception ignored) {}
        return out;
    }

    /**
     * With a cable and the laptop's USB mode on, adb reverse forwards 127.0.0.1:47800 to the laptop.
     * Ask it the discovery question over TCP; no listener there fails at once.
     */
    private void probeUsb() {
        try (java.net.Socket s = new java.net.Socket()) {
            s.connect(new java.net.InetSocketAddress(USB_HOST, Protocol.AUDIO_PORT), 300);
            s.setSoTimeout(600);
            s.getOutputStream().write((Protocol.DISCOVER + "\n").getBytes(StandardCharsets.UTF_8));
            java.io.InputStream in = s.getInputStream();
            StringBuilder sb = new StringBuilder();
            int c;
            while (sb.length() < 512 && (c = in.read()) >= 0 && c != '\n') sb.append((char) c);
            Object[] r = Protocol.parseDiscoverReply(sb.toString());
            if (r == null) return;
            boolean fresh = !laptops.containsKey(USB_HOST);
            laptops.put(USB_HOST, new Laptop(USB_HOST, (String) r[0], Protocol.AUDIO_PORT, System.currentTimeMillis()));
            if (fresh) main.post(this::renderLaptops);
        } catch (Exception ignored) {
            // No cable, USB mode off, or the laptop is not running.
        }
    }

    private void discoverLoop() {
        byte[] probe = Protocol.DISCOVER.getBytes(StandardCharsets.UTF_8);
        byte[] buf = new byte[512];
        try (DatagramSocket sock = new DatagramSocket()) {
            sock.setBroadcast(true);
            sock.setSoTimeout(400);
            long nextProbe = 0;
            long nextRender = 0;
            while (discoveryThread == Thread.currentThread()) {
                long now = System.currentTimeMillis();
                if (now >= nextProbe) {
                    for (InetAddress t : broadcastTargets()) {
                        try {
                            sock.send(new DatagramPacket(probe, probe.length, t, Protocol.DISCOVERY_PORT));
                        } catch (Exception ignored) {}
                    }
                    probeUsb();
                    nextProbe = now + 2000;
                }
                try {
                    DatagramPacket p = new DatagramPacket(buf, buf.length);
                    sock.receive(p);
                    Object[] r = Protocol.parseDiscoverReply(
                            new String(p.getData(), 0, p.getLength(), StandardCharsets.UTF_8));
                    if (r != null) {
                        String ip = p.getAddress().getHostAddress();
                        boolean fresh = !laptops.containsKey(ip);
                        laptops.put(ip, new Laptop(ip, (String) r[0], (Integer) r[1], System.currentTimeMillis()));
                        if (fresh) main.post(this::renderLaptops);
                    }
                } catch (SocketTimeoutException ignored) {}
                if (now >= nextRender) {
                    main.post(this::renderLaptops);
                    nextRender = now + 2000;
                }
            }
        } catch (Exception ignored) {
            // No network: the manual address field still works.
        }
    }
}
