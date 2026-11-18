package dev.snehit.dhvani;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.res.ColorStateList;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.media.projection.MediaProjectionConfig;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputFilter;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.RadioButton;
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
 */
public final class MainActivity extends Activity implements StreamState.Listener {
    private static final int REQ_PERMS = 1;
    private static final int REQ_PROJECTION = 2;
    private static final long LAPTOP_TTL_MS = 8000;
    /** Set by the Quick Settings tile: start streaming as soon as the screen opens. */
    static final String EXTRA_AUTOSTART = "autostart";
    private static final String USB_HOST = "127.0.0.1";

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

    // Views
    private LinearLayout hero;
    private FrameLayout heroAvatar;
    private ImageView heroIcon;
    private TextView heroTitle, heroDetail, notice, searching;
    private ProgressBar heroProgress, searchSpinner;
    private Button startButton;
    private LinearLayout laptopList;
    private View fieldsDivider;
    private EditText addressField, codeField;
    private Switch silenceSwitch, reconnectSwitch, autoSwitch;
    private TextView keysSub, keysAction;
    private LinearLayout volumeCard;
    private SeekBar volumeBar;
    private TextView volumeValue;
    private Button muteButton;
    private boolean draggingVolume;
    private long lastVolumeSent;

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

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences("dhvani", MODE_PRIVATE);
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

    /** Scale to 0.96 while pressed: tactile feedback for primary actions. */
    private void pressScale(View v) {
        v.setOnTouchListener((view, e) -> {
            int a = e.getActionMasked();
            if (a == MotionEvent.ACTION_DOWN) view.animate().scaleX(0.96f).scaleY(0.96f).setDuration(100).start();
            else if (a == MotionEvent.ACTION_UP || a == MotionEvent.ACTION_CANCEL)
                view.animate().scaleX(1f).scaleY(1f).setDuration(150).start();
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

    private static LinearLayout.LayoutParams fullWidth() {
        return new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    }

    private ImageView icon(int res, int tint, int sizeDp) {
        ImageView i = new ImageView(this);
        i.setImageResource(res);
        i.setImageTintList(ColorStateList.valueOf(tint));
        i.setLayoutParams(new FrameLayout.LayoutParams(dp(sizeDp), dp(sizeDp), Gravity.CENTER));
        return i;
    }

    /** M3 list subheader followed by a grouped container; returns the container. */
    private LinearLayout section(LinearLayout parent, String heading) {
        TextView h = text(heading, 14, primary, true);
        h.setPadding(dp(16), dp(24), dp(16), dp(8));
        parent.addView(h);
        LinearLayout c = new LinearLayout(this);
        c.setOrientation(LinearLayout.VERTICAL);
        c.setBackground(shape(surfaceLow, 24));
        c.setClipToOutline(true);
        c.setPadding(0, dp(8), 0, dp(8));
        parent.addView(c, fullWidth());
        return c;
    }

    /** M3 filled text field: tonal box, floating label, active indicator line. */
    private EditText filledField(LinearLayout parent, String label, String hint, int inputType, String support) {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(surfaceHighest);
        float r = dp(4);
        bg.setCornerRadii(new float[] {r, r, r, r, 0, 0, 0, 0});
        box.setBackground(bg);
        TextView l = text(label, 12, onSurfaceVariant, false);
        l.setPadding(dp(16), dp(8), dp(16), 0);
        box.addView(l);
        EditText e = new EditText(this);
        e.setHint(hint);
        e.setInputType(inputType);
        e.setSingleLine(true);
        e.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        e.setTextColor(onSurface);
        e.setHintTextColor(alpha(onSurfaceVariant, 0.6f));
        e.setBackground(null);
        e.setPadding(dp(16), dp(2), dp(16), dp(8));
        box.addView(e, fullWidth());
        View line = new View(this);
        line.setBackgroundColor(onSurfaceVariant);
        box.addView(line, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(1)));
        e.setOnFocusChangeListener((v, focused) -> {
            line.setBackgroundColor(focused ? primary : onSurfaceVariant);
            line.getLayoutParams().height = dp(focused ? 2 : 1);
            line.requestLayout();
            l.setTextColor(focused ? primary : onSurfaceVariant);
        });
        box.setOnClickListener(v -> e.requestFocus());
        LinearLayout.LayoutParams lp = fullWidth();
        lp.leftMargin = lp.rightMargin = dp(16);
        lp.topMargin = dp(8);
        parent.addView(box, lp);
        if (support != null) {
            TextView s = text(support, 12, onSurfaceVariant, false);
            s.setPadding(dp(32), dp(4), dp(32), dp(4));
            parent.addView(s);
        }
        return e;
    }

    private Switch switchRow(LinearLayout parent, String title, String sub, boolean value) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setMinimumHeight(dp(72));
        row.setPadding(dp(16), dp(12), dp(16), dp(12));
        row.setBackground(pressable(null, onSurface, 0));
        LinearLayout texts = new LinearLayout(this);
        texts.setOrientation(LinearLayout.VERTICAL);
        texts.addView(text(title, 16, onSurface, false));
        TextView s = text(sub, 14, onSurfaceVariant, false);
        s.setPadding(0, dp(2), dp(16), 0);
        texts.addView(s);
        row.addView(texts, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        Switch sw = new Switch(this);
        sw.setChecked(value);
        sw.setContentDescription(title);
        int[][] states = {{android.R.attr.state_checked}, {}};
        sw.setThumbTintList(new ColorStateList(states, new int[] {primary, outline}));
        sw.setTrackTintList(new ColorStateList(states, new int[] {alpha(primary, 0.5f), outlineVariant}));
        row.addView(sw);
        row.setOnClickListener(v -> { if (sw.isEnabled()) sw.toggle(); });
        parent.addView(row, fullWidth());
        return sw;
    }

    /** Row that opens Accessibility settings so the volume buttons can drive the laptop. */
    private void volumeKeysRow(LinearLayout parent) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setMinimumHeight(dp(72));
        row.setPadding(dp(16), dp(12), dp(16), dp(12));
        row.setBackground(pressable(null, onSurface, 0));
        LinearLayout texts = new LinearLayout(this);
        texts.setOrientation(LinearLayout.VERTICAL);
        texts.addView(text("Volume buttons control the laptop", 16, onSurface, false));
        keysSub = text("", 14, onSurfaceVariant, false);
        keysSub.setPadding(0, dp(2), dp(16), 0);
        texts.addView(keysSub);
        row.addView(texts, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        keysAction = text("", 14, primary, true);
        row.addView(keysAction);
        row.setOnClickListener(v -> {
            try {
                startActivity(new Intent(android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS));
            } catch (RuntimeException ignored) {}
        });
        parent.addView(row, fullWidth());
    }

    private void renderVolumeKeys() {
        if (keysSub == null) return;
        boolean on = VolumeKeyService.enabled(this);
        keysSub.setText(on
                ? "On. While the phone is silenced, its volume buttons change the laptop and the phone stays quiet."
                : "In Accessibility, open Dhvani volume buttons and turn it on. If it is greyed out: App info, "
                        + "⋮ menu, Allow restricted settings. Until then a press may be heard on the phone for a moment.");
        keysAction.setText(on ? "On" : "Set up");
        keysAction.setTextColor(on ? onSurfaceVariant : primary);
    }

    // ---------- Screen ----------

    private View buildUi() {
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(surface);
        scroll.setFillViewport(true);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(16), dp(8), dp(16), dp(32));
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

        // Top app bar (medium): title + supporting line
        TextView title = text("Dhvani", 28, onSurface, false);
        title.setPadding(dp(8), dp(24), dp(8), 0);
        root.addView(title);
        TextView sub = text("Phone audio on your laptop", 14, onSurfaceVariant, false);
        sub.setPadding(dp(8), dp(2), dp(8), dp(16));
        root.addView(sub);

        // Status hero
        hero = new LinearLayout(this);
        hero.setOrientation(LinearLayout.VERTICAL);
        hero.setPadding(dp(20), dp(20), dp(20), dp(20));
        root.addView(hero, fullWidth());
        LinearLayout top = new LinearLayout(this);
        top.setGravity(Gravity.CENTER_VERTICAL);
        heroAvatar = new FrameLayout(this);
        heroIcon = icon(R.drawable.ic_phone, onSurfaceVariant, 26);
        heroAvatar.addView(heroIcon);
        LinearLayout.LayoutParams alp = new LinearLayout.LayoutParams(dp(52), dp(52));
        alp.rightMargin = dp(16);
        top.addView(heroAvatar, alp);
        LinearLayout texts = new LinearLayout(this);
        texts.setOrientation(LinearLayout.VERTICAL);
        heroTitle = text("", 22, onSurface, false);
        heroDetail = text("", 14, onSurfaceVariant, false);
        heroDetail.setPadding(0, dp(2), 0, 0);
        texts.addView(heroTitle);
        texts.addView(heroDetail);
        top.addView(texts, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        hero.addView(top);
        heroProgress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        heroProgress.setIndeterminate(true);
        LinearLayout.LayoutParams plp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(4));
        plp.topMargin = dp(18);
        hero.addView(heroProgress, plp);
        notice = text("", 14, onWarningContainer, false);
        notice.setBackground(shape(warningContainer, 12));
        notice.setPadding(dp(14), dp(10), dp(14), dp(10));
        LinearLayout.LayoutParams nlp = fullWidth();
        nlp.topMargin = dp(16);
        hero.addView(notice, nlp);
        startButton = new Button(this);
        startButton.setAllCaps(false);
        startButton.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        startButton.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        startButton.setStateListAnimator(null);
        startButton.setOnClickListener(v -> onStartStop());
        pressScale(startButton);
        LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(56));
        blp.topMargin = dp(20);
        hero.addView(startButton, blp);

        // Laptop volume, while streaming
        volumeCard = new LinearLayout(this);
        volumeCard.setOrientation(LinearLayout.VERTICAL);
        volumeCard.setBackground(shape(surfaceLow, 24));
        volumeCard.setPadding(dp(20), dp(16), dp(12), dp(12));
        LinearLayout.LayoutParams vclp = fullWidth();
        vclp.topMargin = dp(12);
        root.addView(volumeCard, vclp);
        LinearLayout vhead = new LinearLayout(this);
        vhead.setGravity(Gravity.CENTER_VERTICAL);
        vhead.addView(text("Laptop volume", 16, onSurface, false),
                new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        volumeValue = text("", 14, onSurfaceVariant, false);
        volumeValue.setFontFeatureSettings("tnum");
        vhead.addView(volumeValue);
        muteButton = new Button(this);
        muteButton.setAllCaps(false);
        muteButton.setStateListAnimator(null);
        muteButton.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        muteButton.setOnClickListener(v -> sendControl(null, !StreamState.laptopMuted));
        LinearLayout.LayoutParams mlp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(40));
        mlp.leftMargin = dp(12);
        vhead.addView(muteButton, mlp);
        volumeCard.addView(vhead);
        volumeBar = new SeekBar(this);
        volumeBar.setMax(150);
        volumeBar.setContentDescription("Laptop volume");
        volumeBar.setProgressTintList(ColorStateList.valueOf(primary));
        volumeBar.setThumbTintList(ColorStateList.valueOf(primary));
        volumeBar.setProgressBackgroundTintList(ColorStateList.valueOf(outlineVariant));
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
        LinearLayout.LayoutParams vblp = fullWidth();
        vblp.topMargin = dp(8);
        volumeCard.addView(volumeBar, vblp);
        TextView vnote = text("Changes the laptop's own output. While the phone is silenced, its volume buttons do too.",
                12, onSurfaceVariant, false);
        vnote.setPadding(0, dp(4), dp(8), 0);
        volumeCard.addView(vnote);

        // Laptop
        LinearLayout lap = section(root, "Laptop");
        LinearLayout searchRow = new LinearLayout(this);
        searchRow.setGravity(Gravity.CENTER_VERTICAL);
        searchRow.setPadding(dp(16), dp(8), dp(16), dp(8));
        searchSpinner = new ProgressBar(this, null, android.R.attr.progressBarStyleSmall);
        searchSpinner.setIndeterminateTintList(ColorStateList.valueOf(primary));
        LinearLayout.LayoutParams slp = new LinearLayout.LayoutParams(dp(18), dp(18));
        slp.rightMargin = dp(12);
        searchRow.addView(searchSpinner, slp);
        searching = text("", 14, onSurfaceVariant, false);
        searchRow.addView(searching, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        lap.addView(searchRow);
        laptopList = new LinearLayout(this);
        laptopList.setOrientation(LinearLayout.VERTICAL);
        laptopList.setPadding(dp(8), 0, dp(8), 0);
        lap.addView(laptopList, fullWidth());
        fieldsDivider = new View(this);
        fieldsDivider.setBackgroundColor(outlineVariant);
        LinearLayout.LayoutParams dlp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(1));
        dlp.setMargins(dp(16), dp(8), dp(16), dp(8));
        lap.addView(fieldsDivider, dlp);
        addressField = filledField(lap, "Address", "192.168.1.20",
                InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI, null);
        addressField.setText(prefs.getString("host", ""));
        codeField = filledField(lap, "Pairing code", "000000", InputType.TYPE_CLASS_NUMBER,
                "Shown in Dhvani on the laptop");
        codeField.setFilters(new InputFilter[] {new InputFilter.LengthFilter(6)});
        codeField.setTypeface(Typeface.MONOSPACE);
        codeField.setTextSize(TypedValue.COMPLEX_UNIT_SP, 24);
        codeField.setLetterSpacing(0.3f);
        codeField.setImeOptions(EditorInfo.IME_ACTION_DONE);
        codeField.setText(prefs.getString("code", ""));

        // Options
        LinearLayout opts = section(root, "Options");
        silenceSwitch = switchRow(opts, "Silence this phone",
                "Mutes the phone speaker while the laptop plays. Restored when you stop.",
                prefs.getBoolean("silence", true));
        volumeKeysRow(opts);
        reconnectSwitch = switchRow(opts, "Reconnect automatically",
                "Keeps trying if Wi-Fi drops or the laptop restarts.",
                prefs.getBoolean("reconnect", true));
        autoSwitch = switchRow(opts, "Start when opened",
                "Opening Dhvani connects to the saved laptop. Android still asks to allow sharing.",
                prefs.getBoolean("autoConnect", false));

        TextView foot = text("Only playback audio is shared, never the microphone or the screen. "
                + "Apps that block capture (some banking and DRM video apps) stay silent.", 12, onSurfaceVariant, false);
        foot.setPadding(dp(16), dp(16), dp(16), 0);
        root.addView(foot);
        renderLaptops();
        return scroll;
    }

    @Override public void onState() {
        StreamState.Status s = StreamState.status;
        String title, detail = StreamState.detail;
        int bg, fg, fgVariant, avatarBg, avatarFg, iconRes;
        String action;
        switch (s) {
            case STREAMING:
                bg = primaryContainer; fg = onPrimaryContainer; fgVariant = onPrimaryContainer;
                avatarBg = primary; avatarFg = onPrimary; iconRes = R.drawable.ic_notify;
                title = "Playing on " + detail; detail = "Sound from this phone now plays on the laptop.";
                action = "Stop";
                break;
            case CONNECTING:
            case RECONNECTING:
                bg = secondaryContainer; fg = onSecondaryContainer; fgVariant = onSecondaryContainer;
                avatarBg = surfaceLow; avatarFg = primary; iconRes = R.drawable.ic_laptop;
                title = s == StreamState.Status.CONNECTING ? "Connecting…" : "Reconnecting…";
                action = "Cancel";
                break;
            case ERROR:
                bg = errorContainer; fg = onErrorContainer; fgVariant = onErrorContainer;
                avatarBg = error; avatarFg = onError; iconRes = R.drawable.ic_error;
                title = "Stopped";
                action = "Try again";
                break;
            default:
                bg = surfaceMid; fg = onSurface; fgVariant = onSurfaceVariant;
                avatarBg = surfaceHighest; avatarFg = onSurfaceVariant; iconRes = R.drawable.ic_phone;
                title = "Not streaming";
                if (detail.isEmpty()) detail = "Pick your laptop, enter the code and tap Start.";
                action = "Start streaming";
                break;
        }
        hero.setBackground(shape(bg, 28));
        heroAvatar.setBackground(shape(avatarBg, 16));
        heroIcon.setImageResource(iconRes);
        heroIcon.setImageTintList(ColorStateList.valueOf(avatarFg));
        heroTitle.setText(title);
        heroTitle.setTextColor(fg);
        heroDetail.setText(detail);
        heroDetail.setTextColor(fgVariant);
        heroDetail.setVisibility(detail.isEmpty() ? View.GONE : View.VISIBLE);
        heroProgress.setVisibility(s == StreamState.Status.CONNECTING || s == StreamState.Status.RECONNECTING
                ? View.VISIBLE : View.GONE);
        heroProgress.setIndeterminateTintList(ColorStateList.valueOf(primary));
        String n = StreamState.notice;
        notice.setText(n);
        notice.setVisibility(n.isEmpty() ? View.GONE : View.VISIBLE);

        boolean active = StreamState.active();
        startButton.setText(action);
        if (active) {
            // Outlined button in the hero's content color.
            GradientDrawable o = shape(Color.TRANSPARENT, 28);
            o.setStroke(dp(1), alpha(fg, 0.6f));
            startButton.setBackground(pressable(o, fg, 28));
            startButton.setTextColor(fg);
        } else {
            startButton.setBackground(pressable(shape(primary, 28), onPrimary, 28));
            startButton.setTextColor(onPrimary);
        }
        boolean showVolume = s == StreamState.Status.STREAMING && StreamState.laptopVolume >= 0;
        volumeCard.setVisibility(showVolume ? View.VISIBLE : View.GONE);
        if (showVolume) {
            int pct = (int) Math.round(StreamState.laptopVolume * 100);
            boolean muted = StreamState.laptopMuted;
            if (!draggingVolume) {
                volumeBar.setProgress(pct);
                volumeValue.setText(muted ? "Muted" : pct + "%");
            }
            volumeBar.setAlpha(muted ? 0.5f : 1f);
            muteButton.setText(muted ? "Unmute" : "Mute");
            muteButton.setTextColor(muted ? onPrimary : onSecondaryContainer);
            muteButton.setBackground(pressable(shape(muted ? primary : secondaryContainer, 20),
                    muted ? onPrimary : onSecondaryContainer, 20));
        }
        for (View v : new View[] {addressField, codeField, silenceSwitch, reconnectSwitch, autoSwitch}) {
            v.setEnabled(!active);
            ((View) v.getParent()).setAlpha(active ? 0.38f : 1f);
        }
    }

    private void renderLaptops() {
        long now = System.currentTimeMillis();
        List<Laptop> list = new ArrayList<>();
        synchronized (laptops) {
            laptops.values().removeIf(l -> now - l.seen > LAPTOP_TTL_MS);
            list.addAll(laptops.values());
        }
        laptopList.removeAllViews();
        boolean empty = list.isEmpty();
        searchSpinner.setVisibility(empty ? View.VISIBLE : View.GONE);
        searching.setText(empty
                ? "Looking for laptops on this Wi-Fi… If none appear, type the address below."
                : "Tap your laptop, or type an address below.");
        String current = addressField.getText().toString().trim();
        for (Laptop l : list) {
            String addr = l.port == Protocol.AUDIO_PORT ? l.ip : l.ip + ":" + l.port;
            boolean selected = addr.equals(current);
            LinearLayout row = new LinearLayout(this);
            row.setGravity(Gravity.CENTER_VERTICAL);
            row.setMinimumHeight(dp(72));
            row.setPadding(dp(12), dp(10), dp(8), dp(10));
            row.setBackground(pressable(shape(selected ? secondaryContainer : Color.TRANSPARENT, 16),
                    onSurface, 16));
            FrameLayout lead = new FrameLayout(this);
            lead.setBackground(shape(selected ? primary : surfaceHighest, 12));
            lead.addView(icon(R.drawable.ic_laptop, selected ? onPrimary : onSurfaceVariant, 22));
            LinearLayout.LayoutParams llp = new LinearLayout.LayoutParams(dp(44), dp(44));
            llp.rightMargin = dp(16);
            row.addView(lead, llp);
            LinearLayout t = new LinearLayout(this);
            t.setOrientation(LinearLayout.VERTICAL);
            int fg = selected ? onSecondaryContainer : onSurface;
            TextView name = text(l.name, 16, fg, false);
            name.setSingleLine(true);
            name.setEllipsize(android.text.TextUtils.TruncateAt.END);
            t.addView(name);
            String shown = USB_HOST.equals(l.ip) ? "USB cable" : addr;
            t.addView(text(shown, 14, selected ? onSecondaryContainer : onSurfaceVariant, false));
            row.addView(t, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
            RadioButton rb = new RadioButton(this);
            rb.setChecked(selected);
            rb.setClickable(false);
            rb.setFocusable(false);
            rb.setButtonTintList(ColorStateList.valueOf(selected ? primary : onSurfaceVariant));
            row.addView(rb);
            row.setContentDescription(l.name + ", " + shown + (selected ? ", selected" : ""));
            row.setOnClickListener(v -> {
                if (StreamState.active()) return;
                addressField.setText(addr);
                renderLaptops();
                if (codeField.getText().length() < 6) codeField.requestFocus();
            });
            LinearLayout.LayoutParams lp = fullWidth();
            lp.bottomMargin = dp(2);
            laptopList.addView(row, lp);
        }
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
        if (StreamState.status != StreamState.Status.STREAMING) return;
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
