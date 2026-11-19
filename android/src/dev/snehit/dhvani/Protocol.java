package dev.snehit.dhvani;

import org.json.JSONException;
import org.json.JSONObject;

/** Wire protocol shared with laptop/src/protocol.ts. Keep both in sync. */
final class Protocol {
    static final int VERSION = 1;
    static final int AUDIO_PORT = 47800;
    static final int DISCOVERY_PORT = 47802;
    static final int RATE = 48000;
    static final int CHANNELS = 2;
    static final String APP_VERSION = "0.7.0";

    /** UDP audio packet: 'D' 'H', version, flags (bit 0 = late copy), 8-byte token, seq, phone ms, PCM. */
    static final int UDP_HEADER = 20;
    static final int UDP_VERSION = 1;
    /** 5 ms of 48 kHz stereo s16, so a packet stays under one Wi-Fi frame. */
    static final int UDP_PCM_BYTES = RATE * CHANNELS * 2 * 5 / 1000;
    /** Every packet goes out again this much later; a loss shorter than this is filled from the copy. */
    static final int REDUNDANT_DELAY_MS = 20;

    static byte[] audioPacket(byte[] token, int seq, int sentMs, byte[] pcm, int off, int len) {
        byte[] p = new byte[UDP_HEADER + len];
        p[0] = 'D';
        p[1] = 'H';
        p[2] = UDP_VERSION;
        System.arraycopy(token, 0, p, 4, 8);
        putInt(p, 12, seq);
        putInt(p, 16, sentMs);
        System.arraycopy(pcm, off, p, UDP_HEADER, len);
        return p;
    }

    private static void putInt(byte[] b, int at, int v) {
        b[at] = (byte) (v >>> 24);
        b[at + 1] = (byte) (v >>> 16);
        b[at + 2] = (byte) (v >>> 8);
        b[at + 3] = (byte) v;
    }

    private Protocol() {}

    static String hello(String code, String device) {
        try {
            JSONObject o = new JSONObject();
            o.put("v", VERSION);
            o.put("code", code);
            o.put("device", device);
            o.put("rate", RATE);
            o.put("channels", CHANNELS);
            o.put("format", "s16le");
            o.put("udp", 1);
            return o.toString() + "\n";
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }

    static final class Reply {
        final boolean ok;
        final String name;
        final String error;
        /** Set when the laptop wants audio over UDP; null means send it on the TCP socket. */
        byte[] udpToken;
        int udpPort;

        Reply(boolean ok, String name, String error) {
            this.ok = ok;
            this.name = name;
            this.error = error;
        }
    }

    static Reply parseReply(String line) {
        try {
            JSONObject o = new JSONObject(line);
            if (o.optBoolean("ok", false)) {
                Reply r = new Reply(true, o.optString("name", "Laptop"), null);
                JSONObject u = o.optJSONObject("udp");
                String tok = u == null ? "" : u.optString("token", "");
                int port = u == null ? 0 : u.optInt("port", 0);
                if (tok.matches("[0-9a-f]{16}") && port > 0 && port <= 65535) {
                    r.udpToken = new byte[8];
                    for (int i = 0; i < 8; i++) r.udpToken[i] = (byte) Integer.parseInt(tok.substring(i * 2, i * 2 + 2), 16);
                    r.udpPort = port;
                }
                return r;
            }
            return new Reply(false, null, o.optString("error", "unknown"));
        } catch (JSONException e) {
            return new Reply(false, null, "bad_reply");
        }
    }

    static String errorMessage(String error) {
        switch (error) {
            case "bad_code": return "Wrong pairing code. Check the code in Dhvani on the laptop.";
            case "rate_limited": return "Too many wrong codes. Wait a minute and try again.";
            case "bad_version": return "The laptop runs a different Dhvani version. Update both.";
            case "bad_format": return "The laptop rejected the audio format. Update both apps.";
            default: return "The laptop refused the connection (" + error + ").";
        }
    }

    /** Phone health report, sent over UDP to the discovery port while streaming. */
    /** Phone media volume, so the laptop can follow it (capture is taken before volume applies). */
    static String volume(String code, int index, int max, boolean muted) {
        try {
            JSONObject o = new JSONObject();
            o.put("dhvani", "volume");
            o.put("v", VERSION);
            o.put("code", code);
            o.put("index", index);
            o.put("max", max);
            o.put("muted", muted);
            return o.toString();
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }

    static String stats(String code, JSONObject fields) {
        try {
            fields.put("dhvani", "stats");
            fields.put("v", VERSION);
            fields.put("code", code);
            return fields.toString();
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }

    /** Sets the laptop's own playback volume (0..1.5) and/or mute. Null leaves a field unchanged. */
    static String control(String code, Double volume, Boolean muted) {
        try {
            JSONObject o = new JSONObject();
            o.put("dhvani", "control");
            o.put("v", VERSION);
            o.put("code", code);
            if (volume != null) o.put("volume", Math.max(0, Math.min(1.5, volume)));
            if (muted != null) o.put("muted", muted.booleanValue());
            return o.toString();
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }

    static final class Laptop {
        final double volume;
        final boolean muted;
        final String[] addresses;

        Laptop(double volume, boolean muted, String[] addresses) {
            this.volume = volume;
            this.muted = muted;
            this.addresses = addresses;
        }
    }

    /** Parses the laptop's JSON line sent while streaming, or null for anything else. */
    static Laptop parseLaptop(String line) {
        try {
            JSONObject o = new JSONObject(line);
            if (!"laptop".equals(o.optString("dhvani"))) return null;
            org.json.JSONArray a = o.optJSONArray("addresses");
            int n = a == null ? 0 : Math.min(8, a.length());
            String[] addrs = new String[n];
            for (int i = 0; i < n; i++) addrs[i] = a.optString(i, "");
            return new Laptop(o.optDouble("volume", 1), o.optBoolean("muted", false), addrs);
        } catch (JSONException e) {
            return null;
        }
    }

    /** UDP reaches the laptop again (after a fallback): send audio over UDP once more. */
    static boolean isUdpResume(String line) {
        try {
            JSONObject o = new JSONObject(line);
            return "transport".equals(o.optString("dhvani")) && o.optBoolean("udp", false);
        } catch (JSONException e) {
            return false;
        }
    }

    /** The laptop got no UDP audio and asks for it on the TCP socket instead. */
    static boolean isTcpFallback(String line) {
        try {
            JSONObject o = new JSONObject(line);
            return "transport".equals(o.optString("dhvani")) && !o.optBoolean("udp", true);
        } catch (JSONException e) {
            return false;
        }
    }

    static final String DISCOVER = "{\"dhvani\":\"discover\",\"v\":1}";

    /** Returns {name, port} or null when the packet is not a Dhvani reply. */
    static Object[] parseDiscoverReply(String msg) {
        try {
            JSONObject o = new JSONObject(msg);
            if (!"here".equals(o.optString("dhvani"))) return null;
            int port = o.optInt("port", AUDIO_PORT);
            if (port <= 0 || port > 65535) return null;
            String name = o.optString("name", "Laptop");
            if (name.length() > 40) name = name.substring(0, 40);
            return new Object[] {name, port};
        } catch (JSONException e) {
            return null;
        }
    }
}
