package dev.snehit.dhvani;

import android.os.Handler;
import android.os.Looper;

import java.util.concurrent.CopyOnWriteArrayList;

/** Process-wide stream status, observed by the activity. Listeners run on the main thread. */
final class StreamState {
    enum Status { IDLE, CONNECTING, STREAMING, RECONNECTING, ERROR }

    interface Listener { void onState(); }

    static volatile Status status = Status.IDLE;
    static volatile String detail = "";
    static volatile String laptop = "";
    static volatile String notice = "";
    /** Advice about the phone's own Wi-Fi while streaming (2.4 GHz, weak signal), or "". */
    static volatile String wifiTip = "";
    /** Laptop playback volume 0..1.5, or -1 until the laptop reports it. */
    static volatile double laptopVolume = -1;
    static volatile boolean laptopMuted = false;
    static volatile String[] laptopAddresses = new String[0];

    private static final CopyOnWriteArrayList<Listener> listeners = new CopyOnWriteArrayList<>();
    private static final Handler main = new Handler(Looper.getMainLooper());

    private StreamState() {}

    static void set(Status s, String d) {
        status = s;
        detail = d == null ? "" : d;
        notifyListeners();
    }

    static void setNotice(String n) {
        notice = n == null ? "" : n;
        notifyListeners();
    }

    static void setWifiTip(String t) {
        String n = t == null ? "" : t;
        if (n.equals(wifiTip)) return;
        wifiTip = n;
        notifyListeners();
    }

    static void setLaptop(double volume, boolean muted, String[] addresses) {
        laptopVolume = volume;
        laptopMuted = muted;
        if (addresses != null) laptopAddresses = addresses;
        notifyListeners();
    }

    static void clearLaptop() {
        laptopVolume = -1;
        laptopMuted = false;
        laptopAddresses = new String[0];
        wifiTip = "";
    }

    static boolean active() {
        Status s = status;
        return s == Status.CONNECTING || s == Status.STREAMING || s == Status.RECONNECTING;
    }

    static void add(Listener l) { listeners.add(l); }
    static void remove(Listener l) { listeners.remove(l); }

    private static void notifyListeners() {
        main.post(() -> { for (Listener l : listeners) l.onState(); });
    }
}
