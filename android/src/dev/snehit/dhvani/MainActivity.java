package dev.snehit.dhvani;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
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
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
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

public final class MainActivity extends Activity implements StreamState.Listener {
    private static final int REQ_PERMS = 1;
    private static final int REQ_PROJECTION = 2;
    private static final long LAPTOP_TTL_MS = 8000;

    private SharedPreferences prefs;
    private final Handler main = new Handler(Looper.getMainLooper());

    // Theme
    private boolean dark;
    private int cBg, cPanel, cText, cMuted, cLine, cAccent, cAccentText, cOk, cWarn, cBad, cField;

    // Views
    private View dot;
    private TextView statusTitle, statusDetail, notice, searching;
    private Button startButton;
    private LinearLayout laptopList;
    private EditText addressField, codeField;
    private Switch silenceSwitch, reconnectSwitch;

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
        setContentView(buildUi());
    }

    @Override protected void onResume() {
        super.onResume();
        StreamState.add(this);
        onState();
        startDiscovery();
    }

    @Override protected void onPause() {
        StreamState.remove(this);
        stopDiscovery();
        saveFields();
        super.onPause();
    }

    // ---------- UI ----------

    private void palette() {
        if (dark) {
            cBg = 0xFF0F1114; cPanel = 0xFF171A1F; cText = 0xFFE8EAEE; cMuted = 0xFF9AA1AC;
            cLine = 0xFF262A31; cAccent = 0xFF2DD4BF; cAccentText = 0xFF0B1F1D; cOk = 0xFF4ADE80;
            cWarn = 0xFFFBBF24; cBad = 0xFFF87171; cField = 0xFF0F1114;
        } else {
            cBg = 0xFFF6F7F8; cPanel = 0xFFFFFFFF; cText = 0xFF16181D; cMuted = 0xFF646B76;
            cLine = 0xFFE3E6EA; cAccent = 0xFF0F766E; cAccentText = 0xFFFFFFFF; cOk = 0xFF15803D;
            cWarn = 0xFFB45309; cBad = 0xFFB91C1C; cField = 0xFFF6F7F8;
        }
    }

    private int dp(float v) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v,
                getResources().getDisplayMetrics()));
    }

    private GradientDrawable rounded(int fill, int stroke, float radiusDp) {
        GradientDrawable g = new GradientDrawable();
        g.setColor(fill);
        g.setCornerRadius(dp(radiusDp));
        if (stroke != 0) g.setStroke(dp(1), stroke);
        return g;
    }

    private TextView text(String s, float sp, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color);
        if (bold) t.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        return t;
    }

    private LinearLayout card(LinearLayout parent, String heading) {
        LinearLayout c = new LinearLayout(this);
        c.setOrientation(LinearLayout.VERTICAL);
        c.setBackground(rounded(cPanel, cLine, 16));
        c.setPadding(dp(18), dp(16), dp(18), dp(18));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(12);
        parent.addView(c, lp);
        if (heading != null) {
            TextView h = text(heading.toUpperCase(), 12, cMuted, true);
            h.setLetterSpacing(0.06f);
            h.setPadding(0, 0, 0, dp(10));
            c.addView(h);
        }
        return c;
    }

    private EditText field(String hint, int inputType) {
        EditText e = new EditText(this);
        e.setHint(hint);
        e.setInputType(inputType);
        e.setSingleLine(true);
        e.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        e.setTextColor(cText);
        e.setHintTextColor(cMuted);
        e.setBackground(rounded(cField, cLine, 12));
        e.setPadding(dp(14), dp(12), dp(14), dp(12));
        return e;
    }

    private Switch toggle(LinearLayout parent, String title, String sub, boolean value) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(0, dp(8), 0, dp(8));
        LinearLayout texts = new LinearLayout(this);
        texts.setOrientation(LinearLayout.VERTICAL);
        texts.addView(text(title, 16, cText, false));
        TextView s = text(sub, 13, cMuted, false);
        s.setPadding(0, dp(2), dp(12), 0);
        texts.addView(s);
        row.addView(texts, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        Switch sw = new Switch(this);
        sw.setChecked(value);
        sw.setContentDescription(title);
        row.addView(sw);
        row.setOnClickListener(v -> sw.toggle());
        parent.addView(row);
        return sw;
    }

    private View buildUi() {
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(cBg);
        scroll.setFillViewport(true);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(16), dp(16), dp(16), dp(24));
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

        // Header
        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.setPadding(dp(4), dp(8), 0, dp(4));
        TextView logo = text("", 1, cText, false);
        logo.setBackground(getDrawable(R.mipmap.ic_launcher));
        header.addView(logo, new LinearLayout.LayoutParams(dp(36), dp(36)));
        LinearLayout ht = new LinearLayout(this);
        ht.setOrientation(LinearLayout.VERTICAL);
        ht.setPadding(dp(12), 0, 0, 0);
        ht.addView(text("Dhvani", 22, cText, true));
        ht.addView(text("Phone audio on your laptop", 13, cMuted, false));
        header.addView(ht);
        root.addView(header);

        // Status
        LinearLayout status = card(root, null);
        LinearLayout srow = new LinearLayout(this);
        srow.setGravity(Gravity.CENTER_VERTICAL);
        dot = new View(this);
        LinearLayout.LayoutParams dlp = new LinearLayout.LayoutParams(dp(12), dp(12));
        dlp.rightMargin = dp(14);
        srow.addView(dot, dlp);
        LinearLayout st = new LinearLayout(this);
        st.setOrientation(LinearLayout.VERTICAL);
        statusTitle = text("Not streaming", 18, cText, true);
        statusDetail = text("", 13, cMuted, false);
        st.addView(statusTitle);
        st.addView(statusDetail);
        srow.addView(st, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        status.addView(srow);
        notice = text("", 13, cWarn, false);
        notice.setPadding(0, dp(10), 0, 0);
        notice.setVisibility(View.GONE);
        status.addView(notice);
        startButton = new Button(this);
        startButton.setAllCaps(false);
        startButton.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        startButton.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        startButton.setStateListAnimator(null);
        startButton.setOnClickListener(v -> onStartStop());
        LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(52));
        blp.topMargin = dp(16);
        status.addView(startButton, blp);

        // Laptop
        LinearLayout lap = card(root, "Laptop");
        searching = text("Looking for laptops on this Wi-Fi…", 14, cMuted, false);
        searching.setPadding(0, 0, 0, dp(8));
        lap.addView(searching);
        laptopList = new LinearLayout(this);
        laptopList.setOrientation(LinearLayout.VERTICAL);
        lap.addView(laptopList);
        TextView al = text("Address", 13, cMuted, false);
        al.setPadding(0, dp(8), 0, dp(6));
        lap.addView(al);
        addressField = field("192.168.1.20", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        addressField.setText(prefs.getString("host", ""));
        lap.addView(addressField);
        TextView cl = text("Pairing code (shown in Dhvani on the laptop)", 13, cMuted, false);
        cl.setPadding(0, dp(14), 0, dp(6));
        lap.addView(cl);
        codeField = field("6 digits", InputType.TYPE_CLASS_NUMBER);
        codeField.setFilters(new InputFilter[] {new InputFilter.LengthFilter(6)});
        codeField.setLetterSpacing(0.2f);
        codeField.setImeOptions(EditorInfo.IME_ACTION_DONE);
        codeField.setText(prefs.getString("code", ""));
        lap.addView(codeField);

        // Options
        LinearLayout opts = card(root, "Options");
        silenceSwitch = toggle(opts, "Silence this phone",
                "Mutes the phone speaker while the laptop plays. Restored when you stop.",
                prefs.getBoolean("silence", true));
        reconnectSwitch = toggle(opts, "Reconnect automatically",
                "Keeps trying if Wi-Fi drops or the laptop restarts.",
                prefs.getBoolean("reconnect", true));

        TextView foot = text("Only playback audio is shared, never the microphone or the screen. "
                + "Apps that block capture (some banking and DRM video apps) stay silent.", 12, cMuted, false);
        foot.setPadding(dp(4), dp(14), dp(4), 0);
        root.addView(foot);
        return scroll;
    }

    @Override public void onState() {
        StreamState.Status s = StreamState.status;
        int dotColor;
        String title, detail = StreamState.detail;
        switch (s) {
            case STREAMING: dotColor = cOk; title = "Playing on " + detail; detail = "Audio from this phone"; break;
            case CONNECTING: dotColor = cWarn; title = "Connecting…"; break;
            case RECONNECTING: dotColor = cWarn; title = "Reconnecting…"; break;
            case ERROR: dotColor = cBad; title = "Stopped"; break;
            default: dotColor = cMuted; title = "Not streaming"; detail = "Pick your laptop, enter the code, tap Start."; break;
        }
        GradientDrawable d = new GradientDrawable();
        d.setShape(GradientDrawable.OVAL);
        d.setColor(dotColor);
        dot.setBackground(d);
        statusTitle.setText(title);
        statusDetail.setText(detail);
        statusDetail.setTextColor(s == StreamState.Status.ERROR ? cBad : cMuted);
        String n = StreamState.notice;
        notice.setText(n);
        notice.setVisibility(n.isEmpty() ? View.GONE : View.VISIBLE);

        boolean active = StreamState.active();
        startButton.setText(active ? "Stop" : "Start");
        startButton.setTextColor(active ? cText : cAccentText);
        startButton.setBackground(active ? rounded(cPanel, cLine, 14) : rounded(cAccent, 0, 14));
        addressField.setEnabled(!active);
        codeField.setEnabled(!active);
        silenceSwitch.setEnabled(!active);
        reconnectSwitch.setEnabled(!active);
    }

    private void renderLaptops() {
        long now = System.currentTimeMillis();
        List<Laptop> list = new ArrayList<>();
        synchronized (laptops) {
            laptops.values().removeIf(l -> now - l.seen > LAPTOP_TTL_MS);
            list.addAll(laptops.values());
        }
        laptopList.removeAllViews();
        searching.setText(list.isEmpty()
                ? "Looking for laptops on this Wi-Fi… If none appear, type the address."
                : "Tap your laptop:");
        String current = addressField.getText().toString().trim();
        for (Laptop l : list) {
            String addr = l.port == Protocol.AUDIO_PORT ? l.ip : l.ip + ":" + l.port;
            boolean selected = addr.equals(current);
            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.VERTICAL);
            row.setPadding(dp(14), dp(10), dp(14), dp(10));
            row.setBackground(rounded(selected ? (dark ? 0xFF11302D : 0xFFE2F3F1) : cField,
                    selected ? cAccent : cLine, 12));
            row.addView(text(l.name, 16, cText, true));
            row.addView(text(addr, 13, cMuted, false));
            row.setOnClickListener(v -> {
                addressField.setText(addr);
                renderLaptops();
                codeField.requestFocus();
            });
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            lp.bottomMargin = dp(8);
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
                .apply();
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
