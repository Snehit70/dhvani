package dev.snehit.dhvani;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioPlaybackCaptureConfiguration;
import android.media.AudioRecord;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.net.wifi.WifiManager;
import android.os.SystemClock;
import android.util.Log;

import org.json.JSONObject;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.Process;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;

/**
 * Foreground service that captures what the phone is playing and sends it to the laptop.
 * One instance, one projection; reconnects reuse the same projection.
 */
public final class StreamService extends Service {
    static final String ACTION_START = "dev.snehit.dhvani.START";
    static final String ACTION_STOP = "dev.snehit.dhvani.STOP";
    static final String EXTRA_RESULT_CODE = "resultCode";
    static final String EXTRA_DATA = "data";
    static final String EXTRA_HOST = "host";
    static final String EXTRA_PORT = "port";
    static final String EXTRA_CODE = "code";
    static final String EXTRA_SILENCE = "silence";
    static final String EXTRA_RECONNECT = "reconnect";
    /** Changes the laptop's own volume while streaming: EXTRA_VOLUME, EXTRA_MUTED or EXTRA_TOGGLE_MUTE. */
    static final String ACTION_CONTROL = "dev.snehit.dhvani.CONTROL";
    static final String EXTRA_VOLUME = "volume";
    static final String EXTRA_MUTED = "muted";
    static final String EXTRA_TOGGLE_MUTE = "toggleMute";

    private static final String CHANNEL = "stream";
    private static final int NOTIFICATION_ID = 1;
    private static final int CHUNK_MS = 10;
    private static final int CHUNK_BYTES = Protocol.RATE * Protocol.CHANNELS * 2 * CHUNK_MS / 1000;
    /** Media playing but capture all zeros this long means muting the phone also mutes the capture. */
    private static final int SILENCE_PROBE_MS = 3000;

    /** A write stuck this long means the laptop vanished without closing the socket. */
    private static final long WRITE_STALL_MS = 3000;
    private static final String STATE_PREFS = "dhvani_state";
    private static final String KEY_SAVED_VOLUME = "savedVolume";
    private static final String TAG = "Dhvani";
    private static final long STATS_INTERVAL_MS = 10_000;
    private static final long VOLUME_POLL_MS = 200;
    private static final long VOLUME_RESEND_MS = 2_000;
    /** After this much digital silence, send only a short keepalive so the Wi-Fi radio can rest. */
    private static final int IDLE_AFTER_MS = 2000;
    private static final long KEEPALIVE_MS = 250;
    /** Over UDP the laptop pings the TCP socket every second; silence this long means it is gone. */
    private static final long LAPTOP_SILENT_MS = 8000;
    /** A dropped connection keeps the phone silenced this long, so a quick reconnect is not heard on the speaker. */
    private static final long RESTORE_GRACE_MS = 10_000;
    /**
     * Without the laptop this long (asleep, shut, gone), stop instead of retrying all night with
     * the capture, the foreground service and both Wi-Fi locks held.
     */
    private static final long GIVE_UP_MS = 10 * 60_000;
    private static final int GAVE_UP_NOTIFICATION_ID = 2;
    /** DSCP EF: Wi-Fi sends these in its video queue, ahead of bulk traffic. */
    private static final int TOS_EF = 0xB8;

    private final Handler main = new Handler(Looper.getMainLooper());
    /** Audio goes as UDP packets; false means it is written to the TCP socket. */
    private volatile boolean useUdp;
    /** Where reports and laptop controls go: the UDP port the laptop announced, else the default. */
    private volatile int reportPort = Protocol.DISCOVERY_PORT;
    /** The worker's report socket. Controls go on it too: packets from a fresh socket were lost. */
    private volatile DatagramSocket reportSock;
    /** Uptime when the laptop last wrote anything on the TCP socket. */
    private volatile long lastHeardAt;
    private int udpSeq;
    private int udpErrors;
    private final java.util.ArrayDeque<byte[]> lateCopies = new java.util.ArrayDeque<>();
    private final java.util.ArrayDeque<Long> lateDue = new java.util.ArrayDeque<>();
    /** Uptime when the current socket write began, 0 when no write is in flight. */
    private volatile long writeStartedAt;
    /** Times the watchdog killed a stuck connection this run. */
    private volatile int stalls;
    private int reconnects;
    private WifiManager.WifiLock wifiLock;
    private WifiManager.WifiLock wifiLockPerf;
    /** Where UDP reports go: the laptop, or one of its LAN addresses when streaming over USB. */
    private volatile java.net.InetAddress udpTarget;
    private volatile String notificationText = "";
    private final java.util.concurrent.ExecutorService sender =
            java.util.concurrent.Executors.newSingleThreadExecutor();
    private final Runnable watchdog = new Runnable() {
        @Override public void run() {
            Run r = run;
            if (r == null || !r.active) return;
            long t = writeStartedAt;
            if (t != 0 && SystemClock.uptimeMillis() - t > WRITE_STALL_MS) {
                stalls++;
                Log.w(TAG, "write stuck " + (SystemClock.uptimeMillis() - t) + " ms, dropping connection");
                closeQuietly(r.socket);
            }
            long heard = lastHeardAt;
            if (useUdp && heard != 0 && SystemClock.uptimeMillis() - heard > LAPTOP_SILENT_MS) {
                stalls++;
                Log.w(TAG, "laptop silent " + (SystemClock.uptimeMillis() - heard) + " ms, dropping connection");
                lastHeardAt = 0;
                closeQuietly(r.socket);
            }
            main.postDelayed(this, 1000);
        }
    };
    /** Capture failures this close together count toward giving up on the capture. */
    private static final long CAPTURE_FAIL_WINDOW_MS = 30_000;
    private static final int CAPTURE_MAX_FAILS = 3;
    /** How long teardown waits for a worker to finish before releasing the capture anyway. */
    private static final long WORKER_JOIN_MS = 5000;

    /**
     * One Start: its own stop flag, projection, recorder, worker and socket. A stopped run's
     * worker can linger (a blocked connect or read), and it must not touch the next run.
     */
    private final class Run {
        volatile boolean active = true;
        final MediaProjection projection;
        /** Swapped by the worker when the capture dies, released by teardown; guarded by this. */
        AudioRecord record;
        Thread worker;
        volatile Socket socket;
        int captureFails;
        long lastCaptureFail;
        /** A stop callback queued for an earlier run must not stop this one. */
        final MediaProjection.Callback onStop = new MediaProjection.Callback() {
            @Override public void onStop() {
                main.post(() -> {
                    if (run == Run.this) stopStreaming(null);
                });
            }
        };

        Run(MediaProjection projection) {
            this.projection = projection;
        }
    }

    /** The current run, null when not streaming. Set and cleared on the main thread. */
    private volatile Run run;

    /** The capture itself failed, not the network: retrying the laptop will not help. */
    private static final class CaptureLost extends Exception {
        CaptureLost(String why) { super(why); }
    }

    private String host;
    private int port;
    private String code;
    private boolean silence;
    private boolean reconnect;

    private AudioManager audio;
    private volatile int savedVolume = -1;
    private volatile boolean silenceBroken;

    /** The live service, for the volume-key Accessibility service. */
    static volatile StreamService instance;
    /** Laptop volume change per volume-button press (the range is 0..1.5). */
    private static final double KEY_STEP = 0.05;
    private android.widget.Toast keyToast;

    /**
     * Fallback without the Accessibility service: the phone's volume rose while Dhvani holds it
     * silent (a button press, the shade slider, a headset). Put it back to 0 at once and move the
     * laptop up one step instead. The phone may be heard for a moment; volume down can't be seen at 0.
     */
    private final android.content.BroadcastReceiver volumeChanged = new android.content.BroadcastReceiver() {
        @Override public void onReceive(Context c, Intent i) {
            if (i.getIntExtra("android.media.EXTRA_VOLUME_STREAM_TYPE", -1) != AudioManager.STREAM_MUSIC) return;
            int value = i.getIntExtra("android.media.EXTRA_VOLUME_STREAM_VALUE", 0);
            int prev = i.getIntExtra("android.media.EXTRA_PREV_VOLUME_STREAM_VALUE", 0);
            if (value <= 0 || !holdsPhoneSilent()) return;
            try { audio.setStreamVolume(AudioManager.STREAM_MUSIC, 0, 0); } catch (RuntimeException ignored) {}
            long now = SystemClock.uptimeMillis();
            if (!fallbackStepDue(now, lastFallbackStep)) return;
            lastFallbackStep = now;
            Log.i(TAG, "phone volume rose " + prev + "->" + value + " while silenced; laptop up one step");
            volumeKey(1);
        }
    };
    /**
     * One press is 10 phone steps on some phones (MIUI has 150), and a held key or the shade
     * slider sends a run of changes. Counting steps sent the laptop from 25% to 125% in two presses.
     */
    private static final long FALLBACK_STEP_MS = 100;
    private long lastFallbackStep;

    /** True when a phone volume rise should move the laptop: at most one step per FALLBACK_STEP_MS. */
    static boolean fallbackStepDue(long now, long lastStep) {
        return now - lastStep >= FALLBACK_STEP_MS;
    }

    /** Set when the screen turns on or off, so the stream loop reports it right away. */
    private volatile boolean statsNow;

    /**
     * Android keeps Wi-Fi out of power save only while the screen is on, so with it off the
     * laptop should hold a little more audio. The laptop learns the state from phone stats.
     */
    private final android.content.BroadcastReceiver screenChanged = new android.content.BroadcastReceiver() {
        @Override public void onReceive(Context c, Intent i) {
            statsNow = true;
        }
    };

    @Override public void onCreate() {
        super.onCreate();
        instance = this;
        android.content.IntentFilter f = new android.content.IntentFilter("android.media.VOLUME_CHANGED_ACTION");
        android.content.IntentFilter sf = new android.content.IntentFilter(Intent.ACTION_SCREEN_OFF);
        sf.addAction(Intent.ACTION_SCREEN_ON);
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(volumeChanged, f, Context.RECEIVER_NOT_EXPORTED);
            registerReceiver(screenChanged, sf, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(volumeChanged, f);
            registerReceiver(screenChanged, sf);
        }
    }

    private boolean running() {
        Run r = run;
        return r != null && r.active;
    }

    /** True while this run is the live one; a lingering worker from an old run is not. */
    private boolean owns(Run r) {
        return r.active && run == r;
    }

    private boolean holdsPhoneSilent() {
        return running() && audio != null && savedVolume >= 0 && !silenceBroken;
    }

    /** True while volume buttons should drive the laptop: streaming with the phone held silent. */
    boolean ownsVolumeKeys() {
        return holdsPhoneSilent() && StreamState.status == StreamState.Status.STREAMING
                && StreamState.laptopVolume >= 0 && udpTarget != null;
    }

    /** One volume-button press: +1 up, -1 down, 0 mute toggle. Runs on the main thread. */
    void volumeKey(int direction) {
        if (!ownsVolumeKeys()) return;
        double v = StreamState.laptopVolume;
        boolean muted = StreamState.laptopMuted;
        if (direction == 0) {
            laptopControl(null, !muted);
        } else {
            double next = Math.max(0, Math.min(1.5, Math.round((v + direction * KEY_STEP) * 100) / 100.0));
            // Pressing up on a muted laptop unmutes it, like the phone does.
            laptopControl(next, muted && direction > 0 ? Boolean.FALSE : null);
        }
        boolean nowMuted = StreamState.laptopMuted;
        String msg = nowMuted ? "Laptop muted" : "Laptop volume " + Math.round(StreamState.laptopVolume * 100) + "%";
        main.post(() -> {
            if (keyToast != null) keyToast.cancel();
            keyToast = android.widget.Toast.makeText(this, msg, android.widget.Toast.LENGTH_SHORT);
            keyToast.show();
        });
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_CONTROL.equals(intent.getAction())) {
            if (running()) control(intent);
            else {
                Log.d(TAG, "control ignored, not streaming");
                if (run == null) stopSelf(startId);
            }
            return START_NOT_STICKY;
        }
        if (intent == null || ACTION_STOP.equals(intent.getAction())) {
            Log.i(TAG, intent == null ? "restarted by the system without a session; stopping" : "stop requested");
            stopStreaming(null);
            return START_NOT_STICKY;
        }
        if (run != null) stopCapture();

        host = intent.getStringExtra(EXTRA_HOST);
        port = intent.getIntExtra(EXTRA_PORT, Protocol.AUDIO_PORT);
        code = intent.getStringExtra(EXTRA_CODE);
        silence = intent.getBooleanExtra(EXTRA_SILENCE, true);
        reconnect = intent.getBooleanExtra(EXTRA_RECONNECT, true);
        silenceBroken = false;
        getSystemService(NotificationManager.class).cancel(GAVE_UP_NOTIFICATION_ID);
        audio = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        restoreLeftoverVolume();

        // startForeground must come before getMediaProjection on Android 14+.
        try {
            startForeground(NOTIFICATION_ID, buildNotification("Connecting to " + host),
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
        } catch (RuntimeException e) {
            fail("Android blocked the background service: " + e.getMessage());
            return START_NOT_STICKY;
        }

        int resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, 0);
        Intent data = Build.VERSION.SDK_INT >= 34
                ? intent.getParcelableExtra(EXTRA_DATA, Intent.class)
                : intent.getParcelableExtra(EXTRA_DATA);
        MediaProjectionManager mpm = (MediaProjectionManager) getSystemService(MEDIA_PROJECTION_SERVICE);
        MediaProjection mp;
        try {
            mp = data == null ? null : mpm.getMediaProjection(resultCode, data);
        } catch (RuntimeException e) {
            mp = null;
        }
        if (mp == null) {
            fail("Audio sharing permission was not granted.");
            return START_NOT_STICKY;
        }
        Run r = new Run(mp);
        mp.registerCallback(r.onStop, main);

        try {
            r.record = buildRecorder(mp);
        } catch (RuntimeException e) {
            mp.unregisterCallback(r.onStop);
            mp.stop();
            fail("Could not start audio capture: " + e.getMessage());
            return START_NOT_STICKY;
        }

        stalls = 0;
        reconnects = 0;
        Log.i(TAG, "start host=" + host + ":" + port + " silence=" + silence + " reconnect=" + reconnect
                + " sdk=" + Build.VERSION.SDK_INT + " model=" + Build.MODEL);
        StreamState.setNotice("");
        acquireWifiLock();
        r.worker = new Thread(() -> runLoop(r), "dhvani-stream");
        run = r;
        r.worker.start();
        main.postDelayed(watchdog, 1000);
        return START_NOT_STICKY;
    }

    @Override public void onDestroy() {
        instance = null;
        try { unregisterReceiver(volumeChanged); } catch (RuntimeException ignored) {}
        try { unregisterReceiver(screenChanged); } catch (RuntimeException ignored) {}
        stopCapture();
        sender.shutdown();
        super.onDestroy();
    }

    private AudioRecord buildRecorder(MediaProjection mp) {
        AudioPlaybackCaptureConfiguration cfg = new AudioPlaybackCaptureConfiguration.Builder(mp)
                .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
                .addMatchingUsage(AudioAttributes.USAGE_GAME)
                .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
                .build();
        AudioFormat fmt = new AudioFormat.Builder()
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .setSampleRate(Protocol.RATE)
                .setChannelMask(AudioFormat.CHANNEL_IN_STEREO)
                .build();
        int min = AudioRecord.getMinBufferSize(Protocol.RATE, AudioFormat.CHANNEL_IN_STEREO,
                AudioFormat.ENCODING_PCM_16BIT);
        AudioRecord r;
        try {
            r = new AudioRecord.Builder()
                    .setAudioFormat(fmt)
                    .setBufferSizeInBytes(Math.max(min, CHUNK_BYTES * 8))
                    .setAudioPlaybackCaptureConfig(cfg)
                    .build();
        } catch (SecurityException e) {
            throw new IllegalStateException("microphone permission missing");
        }
        if (r.getState() != AudioRecord.STATE_INITIALIZED) {
            r.release();
            throw new IllegalStateException("recorder did not initialise");
        }
        return r;
    }

    /** Starts the recorder, replacing it while it will not record. */
    private AudioRecord startCapture(Run run, AudioRecord rec) throws CaptureLost {
        while (true) {
            try { rec.startRecording(); } catch (IllegalStateException ignored) {}
            if (rec.getRecordingState() == AudioRecord.RECORDSTATE_RECORDING) return rec;
            if (!run.active) throw new CaptureLost("stopped");
            rec = recoverCapture(run, rec, "recorder would not start");
        }
    }

    /**
     * Swaps a recorder that stopped working for a new one from the same projection. A few
     * failures close together mean the projection itself is gone, so stop trying.
     */
    private AudioRecord recoverCapture(Run run, AudioRecord old, String why) throws CaptureLost {
        long now = SystemClock.uptimeMillis();
        if (now - run.lastCaptureFail > CAPTURE_FAIL_WINDOW_MS) run.captureFails = 0;
        run.lastCaptureFail = now;
        run.captureFails++;
        Log.w(TAG, "capture failed (" + why + "), rebuilding the recorder, try " + run.captureFails);
        if (run.captureFails > CAPTURE_MAX_FAILS) throw new CaptureLost(why + ", " + run.captureFails + " times");
        synchronized (run) {
            if (!run.active) throw new CaptureLost("stopped");
            try { old.stop(); } catch (RuntimeException ignored) {}
            old.release();
            run.record = null;
            try {
                run.record = buildRecorder(run.projection);
            } catch (RuntimeException e) {
                throw new CaptureLost(why + "; new recorder failed: " + e.getMessage());
            }
            return run.record;
        }
    }

    private void runLoop(Run run) {
        Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO);
        int backoff = 1000;
        // Since when (elapsedRealtime, which counts deep sleep) no attempt has reached the laptop.
        long lostSince = 0;
        byte[] buf = new byte[CHUNK_BYTES];
        AudioRecord rec = run.record;
        while (run.active) {
            update(run, StreamState.Status.CONNECTING, "Connecting to " + host);
            Socket s = new Socket();
            run.socket = s;
            // stopCapture may have closed the previous socket just before this one was published.
            if (!run.active) { closeQuietly(s); break; }
            boolean streamed = false;
            DatagramSocket statsSock = null;
            DatagramSocket audioSock = null;
            try {
                s.setTcpNoDelay(true);
                // Small on purpose: after a stall a big buffer bursts stale audio the laptop must drop.
                s.setSendBufferSize(CHUNK_BYTES * 3);
                try { s.setTrafficClass(TOS_EF); } catch (IOException ignored) {}
                s.connect(new InetSocketAddress(host, port), 4000);
                s.setSoTimeout(5000);
                OutputStream out = s.getOutputStream();
                out.write(Protocol.hello(code, deviceName()).getBytes(StandardCharsets.UTF_8));
                out.flush();
                Protocol.Reply reply = Protocol.parseReply(readLine(s.getInputStream()));
                if (!reply.ok) {
                    if (!run.active) break;
                    Log.w(TAG, "laptop refused: " + reply.error);
                    stopFromWorker(run, Protocol.errorMessage(reply.error));
                    return;
                }
                Log.i(TAG, "streaming to " + reply.name);
                s.setSoTimeout(0);
                udpTarget = s.getInetAddress();
                reportPort = reply.udpPort > 0 ? reply.udpPort : Protocol.DISCOVERY_PORT;
                // adb reverse carries TCP only, so over USB the audio stays on the socket.
                useUdp = reply.udpToken != null && !s.getInetAddress().isLoopbackAddress();
                if (useUdp) {
                    audioSock = new DatagramSocket();
                    try { audioSock.setTrafficClass(TOS_EF); } catch (IOException ignored) {}
                    audioSock.connect(new InetSocketAddress(s.getInetAddress(), reply.udpPort));
                }
                udpSeq = 0;
                udpErrors = 0;
                lateCopies.clear();
                lateDue.clear();
                lastHeardAt = SystemClock.uptimeMillis();
                Log.i(TAG, "audio over " + (useUdp ? "udp" : "tcp"));
                startLaptopReader(run, s);
                rec = startCapture(run, rec);
                silencePhone(run);
                streamed = true;
                backoff = 1000;
                update(run, StreamState.Status.STREAMING, reply.name);
                int zeroMs = 0;
                int quietMs = 0;
                long nextKeepalive = 0;
                long nextStats = SystemClock.uptimeMillis() + STATS_INTERVAL_MS;
                long readMax = 0, writeMax = 0;
                int slowWrites = 0, slowReads = 0;
                try { statsSock = new DatagramSocket(); } catch (IOException ignored) {}
                reportSock = statsSock;
                String lastVolume = null;
                long nextVolumeCheck = 0, volumeResendAt = 0;
                boolean wasUdp = useUdp;
                while (run.active) {
                    long r0 = SystemClock.uptimeMillis();
                    int n = rec.read(buf, 0, buf.length);
                    long readMs = SystemClock.uptimeMillis() - r0;
                    if (readMs > readMax) readMax = readMs;
                    if (readMs > 50) slowReads++;
                    if (n < 0) {
                        if (!run.active) break;
                        // The recorder died (often the audio server restarting): build a new one, keep the laptop.
                        rec = startCapture(run, recoverCapture(run, rec, "read error " + n));
                        continue;
                    }
                    if (n == 0) continue;
                    // Over UDP nothing writes to the socket, so a closed one shows up only here.
                    if (s.isClosed()) throw new IOException("laptop closed the connection");
                    boolean udpNow = useUdp && audioSock != null;
                    // Back on UDP after a TCP stint: late copies queued before then are stale.
                    if (udpNow && !wasUdp) {
                        lateCopies.clear();
                        lateDue.clear();
                    }
                    wasUdp = udpNow;
                    if (udpNow) sendLateCopies(audioSock, SystemClock.uptimeMillis());
                    boolean zero = allZero(buf, n);
                    quietMs = zero ? quietMs + CHUNK_MS : 0;
                    long w0 = SystemClock.uptimeMillis();
                    // Long digital silence: skip most chunks. The laptop treats the pause as idle, not a gap.
                    boolean send = quietMs < IDLE_AFTER_MS || w0 >= nextKeepalive;
                    if (send) {
                        if (quietMs >= IDLE_AFTER_MS) nextKeepalive = w0 + KEEPALIVE_MS;
                        if (udpNow) {
                            sendUdp(audioSock, reply.udpToken, buf, n, w0);
                        } else {
                            writeStartedAt = w0;
                            out.write(buf, 0, n);
                            writeStartedAt = 0;
                        }
                        long writeMs = SystemClock.uptimeMillis() - w0;
                        if (writeMs > writeMax) writeMax = writeMs;
                        if (writeMs > 20) slowWrites++;
                    }
                    long now = SystemClock.uptimeMillis();
                    if (now >= nextVolumeCheck) {
                        nextVolumeCheck = now + VOLUME_POLL_MS;
                        if (holdsPhoneSilent() && audio.getStreamVolume(AudioManager.STREAM_MUSIC) > 0) {
                            audio.setStreamVolume(AudioManager.STREAM_MUSIC, 0, 0);
                        }
                        int[] v = phoneVolume();
                        String key = v[0] + "/" + v[1] + (v[2] == 1 ? " muted" : "");
                        if (!key.equals(lastVolume) || now >= volumeResendAt) {
                            if (!key.equals(lastVolume)) Log.i(TAG, "phone volume " + key);
                            sendVolume(statsSock, s, Protocol.volume(code, v[0], v[1], v[2] == 1));
                            lastVolume = key;
                            volumeResendAt = now + VOLUME_RESEND_MS;
                        }
                    }
                    if (statsNow || SystemClock.uptimeMillis() >= nextStats) {
                        statsNow = false;
                        sendStats(statsSock, s, readMax, writeMax, slowReads, slowWrites);
                        readMax = writeMax = 0;
                        slowReads = slowWrites = 0;
                        nextStats = SystemClock.uptimeMillis() + STATS_INTERVAL_MS;
                    }
                    if (savedVolume >= 0 && !silenceBroken) {
                        zeroMs = zero && audio.isMusicActive() ? zeroMs + CHUNK_MS : 0;
                        if (zeroMs >= SILENCE_PROBE_MS) {
                            silenceBroken = true;
                            Log.w(TAG, "capture is silent while muted; un-silencing phone");
                            restoreVolume();
                            StreamState.setNotice("This phone mutes the shared audio too, so it keeps "
                                    + "playing out loud. Turn off \"Silence this phone\".");
                        }
                    }
                }
            } catch (CaptureLost e) {
                if (!run.active) break;
                Log.w(TAG, "capture lost: " + e.getMessage());
                stopFromWorker(run, "Android stopped the audio capture. Tap Start to share again.");
                return;
            } catch (IOException | RuntimeException e) {
                if (!run.active) break;
                Log.w(TAG, (streamed ? "connection lost: " : "connect failed: ") + e);
                if (!reconnect) {
                    stopFromWorker(run, streamed ? "Connection to the laptop was lost." : friendly(e));
                    return;
                }
                reconnects++;
                long now = SystemClock.elapsedRealtime();
                if (streamed || lostSince == 0) lostSince = now;
                if (now - lostSince >= GIVE_UP_MS) {
                    Log.w(TAG, "no laptop for " + (now - lostSince) / 1000 + " s after " + reconnects + " tries; giving up");
                    notifyGaveUp();
                    stopFromWorker(run, "The laptop stopped answering, so streaming stopped. Tap Start when it's back.");
                    return;
                }
                update(run, StreamState.Status.RECONNECTING, streamed
                        ? "Connection lost. Retrying…" : friendly(e) + " Retrying…");
            } finally {
                // A stopped run's worker cleans up only its own sockets; the shared state is the next run's now.
                boolean mine = owns(run);
                if (mine) {
                    writeStartedAt = 0;
                    udpTarget = null;
                    useUdp = false;
                    lastHeardAt = 0;
                    StreamState.clearLaptop();
                    reportSock = null;
                }
                if (audioSock != null) audioSock.close();
                if (statsSock != null) statsSock.close();
                closeQuietly(s);
                try { rec.stop(); } catch (RuntimeException ignored) {}
                // While the laptop is away the phone plays on its own speaker again, but only
                // once a reconnect has had a moment; a Wi-Fi blip should not blare the speaker.
                // Only a dropped stream starts the wait: re-arming it on every failed retry
                // kept the phone muted for the whole outage.
                if (streamed && mine) {
                    main.removeCallbacks(restoreAfterGrace);
                    main.postDelayed(restoreAfterGrace, RESTORE_GRACE_MS);
                }
            }
            try {
                Thread.sleep(backoff);
            } catch (InterruptedException e) {
                break;
            }
            backoff = Math.min(backoff * 2, 8000);
        }
    }

    /**
     * Playback capture is taken before stream volume and mute apply, so the laptop
     * scales its output by this. While the app holds the phone silent, report full
     * volume so the laptop keeps its own level.
     */
    /** Sends one capture read as 5 ms packets and queues each one's late copy. */
    private void sendUdp(DatagramSocket ds, byte[] token, byte[] buf, int n, long now) {
        for (int off = 0; off < n; off += Protocol.UDP_PCM_BYTES) {
            int len = Math.min(Protocol.UDP_PCM_BYTES, n - off);
            byte[] p = Protocol.audioPacket(token, udpSeq++, (int) now, buf, off, len);
            sendPacket(ds, p);
            byte[] late = p.clone();
            late[3] = 1;
            lateCopies.add(late);
            lateDue.add(now + Protocol.REDUNDANT_DELAY_MS);
        }
    }

    private void sendLateCopies(DatagramSocket ds, long now) {
        while (!lateDue.isEmpty() && lateDue.peek() <= now) {
            lateDue.poll();
            sendPacket(ds, lateCopies.poll());
        }
    }

    /** A failed send loses one packet; the TCP socket decides whether the laptop is still there. */
    private void sendPacket(DatagramSocket ds, byte[] p) {
        try {
            ds.send(new DatagramPacket(p, p.length));
        } catch (IOException e) {
            udpErrors++;
        }
    }

    private int[] phoneVolume() {
        if (savedVolume >= 0) return new int[] {1, 1, 0};
        int max = Math.max(1, audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC));
        int index = Math.min(max, Math.max(0, audio.getStreamVolume(AudioManager.STREAM_MUSIC)));
        return new int[] {index, max, audio.isStreamMute(AudioManager.STREAM_MUSIC) ? 1 : 0};
    }

    private void sendVolume(DatagramSocket sock, Socket s, String packet) {
        if (sock == null) return;
        try {
            byte[] b = packet.getBytes(StandardCharsets.UTF_8);
            sock.send(new DatagramPacket(b, b.length, target(s), reportPort));
        } catch (Exception ignored) {}
    }

    private java.net.InetAddress target(Socket s) {
        java.net.InetAddress t = udpTarget;
        return t != null ? t : s.getInetAddress();
    }

    /**
     * Reads the laptop's JSON lines (its volume, mute and LAN addresses) until the socket closes.
     * Over USB the TCP peer is 127.0.0.1, which UDP cannot reach, so reports go to a LAN address.
     */
    private void startLaptopReader(Run run, Socket s) {
        Thread t = new Thread(() -> {
            try {
                InputStream in = s.getInputStream();
                boolean first = true, wasMuted = false, wasMissing = false;
                while (run.active && run.socket == s) {
                    String line = readLine(in);
                    // The run may have stopped or reconnected while this read blocked.
                    if (!owns(run) || run.socket != s) break;
                    lastHeardAt = SystemClock.uptimeMillis();
                    if (Protocol.isTcpFallback(line)) {
                        Log.w(TAG, "laptop got no UDP audio, switching to tcp");
                        useUdp = false;
                        continue;
                    }
                    if (Protocol.isUdpResume(line)) {
                        if (!s.getInetAddress().isLoopbackAddress()) {
                            Log.i(TAG, "laptop hears UDP again, switching back to udp");
                            useUdp = true;
                        }
                        continue;
                    }
                    Protocol.Laptop l = Protocol.parseLaptop(line);
                    if (l == null) continue;
                    if (s.getInetAddress().isLoopbackAddress()) {
                        for (String a : l.addresses) {
                            if (a.matches("\\d{1,3}(\\.\\d{1,3}){3}")) {
                                udpTarget = java.net.InetAddress.getByName(a);
                                break;
                            }
                        }
                    }
                    StreamState.setLaptop(l.volume, l.muted, l.addresses, l.outputMissing);
                    if (l.outputMissing != wasMissing && StreamState.status == StreamState.Status.STREAMING) {
                        notificationText = streamingText(StreamState.detail);
                    }
                    if (first || l.muted != wasMuted || l.outputMissing != wasMissing) refreshNotification();
                    first = false;
                    wasMuted = l.muted;
                    wasMissing = l.outputMissing;
                }
            } catch (IOException | RuntimeException ignored) {
                // Laptop closed the socket; make sure the stream loop sees it and reconnects.
                closeQuietly(s);
            }
        }, "dhvani-laptop");
        t.setDaemon(true);
        t.start();
    }

    private void control(Intent intent) {
        laptopControl(controlVolume(intent), controlMuted(intent, StreamState.laptopMuted));
    }

    /** Laptop volume asked for by a CONTROL intent, clamped to 0..1.5, or null to leave it. */
    static Double controlVolume(Intent intent) {
        if (!intent.hasExtra(EXTRA_VOLUME)) return null;
        float v = intent.getFloatExtra(EXTRA_VOLUME, 1f);
        if (Float.isNaN(v)) return null;
        return (double) Math.max(0f, Math.min(1.5f, v));
    }

    /**
     * Mute asked for by a CONTROL intent, or null to leave it. Plain ifs on purpose: a ternary
     * mixing boolean and null unboxes the null and crashed the app on every slider move.
     */
    static Boolean controlMuted(Intent intent, boolean currentlyMuted) {
        if (intent.hasExtra(EXTRA_MUTED)) return intent.getBooleanExtra(EXTRA_MUTED, false);
        if (intent.getBooleanExtra(EXTRA_TOGGLE_MUTE, false)) return !currentlyMuted;
        return null;
    }

    /** Sets the laptop's volume and/or mute. Null leaves a field unchanged. */
    private void laptopControl(Double volume, Boolean muted) {
        if (volume == null && muted == null) return;
        final java.net.InetAddress t = udpTarget;
        final String c = code;
        Log.d(TAG, "control volume=" + volume + " muted=" + muted + (t == null ? " (no laptop address)" : " to port " + reportPort));
        if (t == null || c == null) return;
        // Shown right away; the laptop confirms with its own update over TCP.
        if (volume != null) StreamState.laptopVolume = volume;
        if (muted != null) StreamState.setLaptop(StreamState.laptopVolume, muted, null, StreamState.laptopOutputMissing);
        final byte[] b = Protocol.control(c, volume, muted).getBytes(StandardCharsets.UTF_8);
        try {
            sender.execute(() -> {
                DatagramSocket ds = reportSock;
                if (ds == null) return;
                try {
                    ds.send(new DatagramPacket(b, b.length, t, reportPort));
                } catch (IOException e) {
                    Log.d(TAG, "control send failed: " + e);
                }
            });
        } catch (java.util.concurrent.RejectedExecutionException ignored) {}
    }

    /** Best effort: a lost packet only loses one sample of diagnostics. */
    private void sendStats(DatagramSocket sock, Socket s, long readMax, long writeMax, int slowReads, int slowWrites) {
        if (sock == null) return;
        try {
            JSONObject o = new JSONObject();
            o.put("readMaxMs", readMax);
            o.put("writeMaxMs", writeMax);
            o.put("slowReads", slowReads);
            o.put("slowWrites", slowWrites);
            o.put("stalls", stalls);
            o.put("transport", useUdp ? "udp" : "tcp");
            o.put("udpErrors", udpErrors);
            o.put("reconnects", reconnects);
            o.put("silenced", savedVolume >= 0);
            o.put("musicActive", audio.isMusicActive());
            android.os.PowerManager pm = (android.os.PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null) o.put("screenOn", pm.isInteractive());
            o.put("sdk", Build.VERSION.SDK_INT);
            o.put("model", Build.MODEL);
            o.put("app", Protocol.APP_VERSION);
            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wm != null) {
                @SuppressWarnings("deprecation")
                android.net.wifi.WifiInfo wi = wm.getConnectionInfo();
                if (wi != null && wi.getRssi() > -127) {
                    o.put("rssi", wi.getRssi());
                    o.put("linkMbps", wi.getLinkSpeed());
                    o.put("freqMHz", wi.getFrequency());
                    StreamState.setWifiTip(wifiTip(wi.getRssi(), wi.getFrequency()));
                }
            }
            byte[] b = Protocol.stats(code, o).getBytes(StandardCharsets.UTF_8);
            sock.send(new DatagramPacket(b, b.length, target(s), reportPort));
            Log.d(TAG, "stats " + o);
        } catch (Exception ignored) {}
    }

    private boolean weakWifi;

    private String wifiTip(int rssi, int freqMHz) {
        weakWifi = weakWifi(weakWifi, rssi);
        return wifiTip(weakWifi, freqMHz);
    }

    /** Weak below -70 dBm, fine again only above -66, so the tip does not flicker. */
    static boolean weakWifi(boolean wasWeak, int rssi) {
        return wasWeak ? rssi < -66 : rssi < -70;
    }

    /** What the user can do about this phone's Wi-Fi, or "" when it is fine. */
    static String wifiTip(boolean weak, int freqMHz) {
        boolean slowBand = freqMHz > 0 && freqMHz < 3000;
        if (weak && slowBand) return "Weak 2.4 GHz Wi-Fi, so audio may drop out. Move closer to the router so the phone can switch to 5 GHz.";
        if (slowBand) return "This phone is on 2.4 GHz Wi-Fi, which drops audio more often. Move closer to the router so it can switch to 5 GHz.";
        if (weak) return "Weak Wi-Fi signal, so audio may drop out. Move closer to the router, or use a USB cable.";
        return "";
    }

    private static boolean allZero(byte[] b, int n) {
        for (int i = 0; i < n; i++) if (b[i] != 0) return false;
        return true;
    }

    private static String friendly(Exception e) {
        String m = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
        if (m.contains("ECONNREFUSED") || m.contains("refused")) return "Laptop is not running Dhvani.";
        if (m.contains("timed out") || m.contains("ETIMEDOUT")) return "Laptop did not answer. Same Wi-Fi?";
        if (m.contains("EHOSTUNREACH") || m.contains("ENETUNREACH")) return "Laptop is unreachable. Same Wi-Fi?";
        return "Could not connect: " + m;
    }

    private static String readLine(InputStream in) throws IOException {
        StringBuilder sb = new StringBuilder();
        while (sb.length() < 2048) {
            int c = in.read();
            if (c < 0) throw new IOException("laptop closed the connection");
            if (c == '\n') return sb.toString();
            sb.append((char) c);
        }
        throw new IOException("reply too long");
    }

    private final Runnable restoreAfterGrace = this::restoreVolume;

    private synchronized void silencePhone(Run run) {
        // Checked under the lock restoreVolume takes, so a stop cannot slip in and leave the phone muted.
        if (!owns(run)) return;
        main.removeCallbacks(restoreAfterGrace);
        if (!silence || silenceBroken || savedVolume >= 0) return;
        try {
            savedVolume = audio.getStreamVolume(AudioManager.STREAM_MUSIC);
            // Persist first so a crash or force-stop cannot leave the phone muted for good.
            statePrefs().edit().putInt(KEY_SAVED_VOLUME, savedVolume).commit();
            audio.setStreamVolume(AudioManager.STREAM_MUSIC, 0, 0);
        } catch (RuntimeException e) {
            savedVolume = -1;
            statePrefs().edit().remove(KEY_SAVED_VOLUME).apply();
        }
    }

    private android.content.SharedPreferences statePrefs() {
        return getSharedPreferences(STATE_PREFS, MODE_PRIVATE);
    }

    /** Puts back a volume saved by a previous run that died while the phone was silenced. */
    private synchronized void restoreLeftoverVolume() {
        int v = statePrefs().getInt(KEY_SAVED_VOLUME, -1);
        if (v < 0 || savedVolume >= 0) return;
        savedVolume = v;
        restoreVolume();
    }

    private void acquireWifiLock() {
        try {
            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wm == null) return;
            wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_LOW_LATENCY, "dhvani:stream");
            wifiLock.setReferenceCounted(false);
            wifiLock.acquire();
        } catch (RuntimeException e) {
            wifiLock = null;
        }
        // LOW_LATENCY only applies while the screen is on; HIGH_PERF keeps Wi-Fi awake with it off.
        try {
            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wm == null) return;
            @SuppressWarnings("deprecation")
            WifiManager.WifiLock l = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "dhvani:stream-perf");
            wifiLockPerf = l;
            wifiLockPerf.setReferenceCounted(false);
            wifiLockPerf.acquire();
        } catch (RuntimeException e) {
            wifiLockPerf = null;
        }
    }

    private void releaseWifiLock() {
        if (wifiLock != null && wifiLock.isHeld()) {
            try { wifiLock.release(); } catch (RuntimeException ignored) {}
        }
        wifiLock = null;
        if (wifiLockPerf != null && wifiLockPerf.isHeld()) {
            try { wifiLockPerf.release(); } catch (RuntimeException ignored) {}
        }
        wifiLockPerf = null;
    }

    private synchronized void restoreVolume() {
        int v = savedVolume;
        if (v < 0) return;
        savedVolume = -1;
        statePrefs().edit().remove(KEY_SAVED_VOLUME).apply();
        try {
            // Leave it alone if the user changed the volume meanwhile.
            if (audio.getStreamVolume(AudioManager.STREAM_MUSIC) == 0) {
                audio.setStreamVolume(AudioManager.STREAM_MUSIC, v, 0);
            }
        } catch (RuntimeException ignored) {}
    }

    private String deviceName() {
        String n = android.provider.Settings.Global.getString(getContentResolver(), "device_name");
        if (n == null || n.trim().isEmpty()) n = Build.MANUFACTURER + " " + Build.MODEL;
        return n.trim();
    }

    private void update(Run run, StreamState.Status s, String detail) {
        if (!owns(run)) return;
        StreamState.set(s, detail);
        refreshTile();
        String text;
        switch (s) {
            case STREAMING: text = streamingText(detail); break;
            case RECONNECTING: text = detail; break;
            default: text = "Connecting to " + host; break;
        }
        notificationText = text;
        refreshNotification();
    }

    private static String streamingText(String laptop) {
        return StreamState.laptopOutputMissing ? "Laptop output is off, nothing is playing" : "Playing on " + laptop;
    }

    private void refreshNotification() {
        main.post(() -> {
            if (!running()) return;
            NotificationManager nm = getSystemService(NotificationManager.class);
            nm.notify(NOTIFICATION_ID, buildNotification(notificationText));
        });
    }

    private void refreshTile() {
        try {
            android.service.quicksettings.TileService.requestListeningState(this,
                    new android.content.ComponentName(this, DhvaniTile.class));
        } catch (RuntimeException ignored) {}
    }

    private void fail(String message) {
        stopCapture();
        StreamState.set(StreamState.Status.ERROR, message);
        refreshTile();
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    /** Left after giving up on the laptop, so the stop is noticed and one tap opens the app. */
    private void notifyGaveUp() {
        try {
            PendingIntent open = PendingIntent.getActivity(this, 3,
                    new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                    PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            NotificationManager nm = getSystemService(NotificationManager.class);
            nm.notify(GAVE_UP_NOTIFICATION_ID, new Notification.Builder(this, CHANNEL)
                    .setSmallIcon(R.drawable.ic_notify)
                    .setContentTitle("Dhvani stopped")
                    .setContentText("The laptop went away. Tap to open Dhvani and start again.")
                    .setContentIntent(open)
                    .setAutoCancel(true)
                    .build());
        } catch (RuntimeException ignored) {}
    }

    private void stopFromWorker(Run run, String error) {
        main.post(() -> {
            if (run == this.run) stopStreaming(error);
        });
    }

    /** Stops everything; error is shown in the app, null means a normal stop. */
    private void stopStreaming(String error) {
        stopCapture();
        if (error == null) StreamState.set(StreamState.Status.IDLE, "");
        else StreamState.set(StreamState.Status.ERROR, error);
        refreshTile();
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    /**
     * Stops the current run without blocking the main thread: flags it, closes its socket and
     * puts the volume back here, then stops the recorder, waits for the worker and releases
     * the capture on a separate thread.
     */
    private void stopCapture() {
        Run r = run;
        run = null;
        main.removeCallbacks(watchdog);
        releaseWifiLock();
        main.removeCallbacks(restoreAfterGrace);
        if (r != null) {
            r.active = false;
            closeQuietly(r.socket);
        }
        restoreVolume();
        writeStartedAt = 0;
        udpTarget = null;
        useUdp = false;
        lastHeardAt = 0;
        reportSock = null;
        StreamState.clearLaptop();
        if (r == null) return;
        Thread t = new Thread(() -> teardown(r), "dhvani-stop");
        t.setDaemon(true);
        t.start();
    }

    private static void teardown(Run r) {
        // Stopping the recorder unblocks a worker waiting in read().
        synchronized (r) {
            if (r.record != null) {
                try { r.record.stop(); } catch (RuntimeException ignored) {}
            }
        }
        Thread w = r.worker;
        if (w != null) {
            w.interrupt();
            try { w.join(WORKER_JOIN_MS); } catch (InterruptedException ignored) {}
            if (w.isAlive()) Log.w(TAG, "stream worker still running after " + WORKER_JOIN_MS + " ms; releasing anyway");
        }
        synchronized (r) {
            if (r.record != null) {
                r.record.release();
                r.record = null;
            }
        }
        try {
            r.projection.unregisterCallback(r.onStop);
            r.projection.stop();
        } catch (RuntimeException ignored) {}
    }

    private static void closeQuietly(Socket s) {
        if (s == null) return;
        try { s.close(); } catch (IOException ignored) {}
    }

    private Notification buildNotification(String text) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Streaming",
                    NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Shown while phone audio plays on your laptop");
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        PendingIntent open = PendingIntent.getActivity(this, 0,
                new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent stop = PendingIntent.getService(this, 1,
                new Intent(this, StreamService.class).setAction(ACTION_STOP),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder nb = new Notification.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_notify)
                .setContentTitle("Dhvani")
                .setContentText(text)
                .setContentIntent(open)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setCategory(Notification.CATEGORY_SERVICE)
                .addAction(new Notification.Action.Builder(null, "Stop", stop).build());
        if (StreamState.laptopVolume >= 0 && StreamState.status == StreamState.Status.STREAMING) {
            PendingIntent mute = PendingIntent.getService(this, 2,
                    new Intent(this, StreamService.class).setAction(ACTION_CONTROL)
                            .putExtra(EXTRA_TOGGLE_MUTE, true),
                    PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            nb.addAction(new Notification.Action.Builder(null,
                    StreamState.laptopMuted ? "Unmute laptop" : "Mute laptop", mute).build());
        }
        return nb.build();
    }
}
