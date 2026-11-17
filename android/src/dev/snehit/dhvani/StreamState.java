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
