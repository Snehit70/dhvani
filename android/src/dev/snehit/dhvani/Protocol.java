package dev.snehit.dhvani;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.json.JSONException;
import org.json.JSONObject;

/** Wire protocol shared with laptop/src/protocol.ts. Keep both in sync. */
final class Protocol {
    static final int VERSION = 1;
    static final int AUDIO_PORT = 47800;
    static final int DISCOVERY_PORT = 47802;
    static final int RATE = 48000;
    static final int CHANNELS = 2;
    static final String APP_VERSION = "0.9.5";

    /** UDP audio packet: 'D' 'H', version, flags (bit 0 = late copy), 8-byte token, seq, phone ms, PCM. */
    static final int UDP_HEADER = 20;
    static final int UDP_VERSION = 1;
    /** 5 ms of 48 kHz stereo s16, so a packet stays under one Wi-Fi frame. */
    static final int UDP_PCM_BYTES = RATE * CHANNELS * 2 * 5 / 1000;
    /** Every packet goes out again this much later; a loss shorter than this is filled from the copy. */
    static final int REDUNDANT_DELAY_MS = 20;

    static byte[] audioPacket(byte[] token, int seq, int sentMs, byte[] pcm, int off, int len) {
        byte[] p = new byte[UDP_HEADER + len];
        writeAudioPacket(p, token, seq, sentMs, pcm, off, len);
        return p;
    }

    /** Fills `p` (at least UDP_HEADER + len bytes) as a first copy and returns the packet length. */
    static int writeAudioPacket(byte[] p, byte[] token, int seq, int sentMs, byte[] pcm, int off, int len) {
        p[0] = 'D';
        p[1] = 'H';
        p[2] = UDP_VERSION;
        p[3] = 0;
        System.arraycopy(token, 0, p, 4, 8);
        putInt(p, 12, seq);
        putInt(p, 16, sentMs);
        System.arraycopy(pcm, off, p, UDP_HEADER, len);
        return UDP_HEADER + len;
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
            o.put("ctl", 1);
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
        /** Session key for signing reports and controls; null from an older laptop. */
        String ctl;
        /** The laptop's lasting id and key, for checking its discovery replies later. */
        String laptopId;
        String laptopKey;

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
                String ctl = o.optString("ctl", "");
                if (ctl.matches("[0-9a-f]{16}")) r.ctl = ctl;
                String id = o.optString("id", ""), key = o.optString("key", "");
                if (id.matches("[0-9a-f]{16}") && key.matches("[0-9a-f]{32}") && id.equals(laptopId(key))) {
                    r.laptopId = id;
                    r.laptopKey = key;
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
        return volume(code, index, max, muted, null, 0);
    }

    /** With a session key, every report carries it and a rising counter (see the laptop's protocol.ts). */
    private static void sign(JSONObject o, String key, long n) throws JSONException {
        if (key == null) return;
        o.put("key", key);
        o.put("n", n);
    }

    static String volume(String code, int index, int max, boolean muted, String key, long n) {
        try {
            JSONObject o = new JSONObject();
            o.put("dhvani", "volume");
            o.put("v", VERSION);
            o.put("code", code);
            o.put("index", index);
            o.put("max", max);
            o.put("muted", muted);
            sign(o, key, n);
            return o.toString();
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }

    static String stats(String code, JSONObject fields) {
        return stats(code, fields, null, 0);
    }

    static String stats(String code, JSONObject fields, String key, long n) {
        try {
            fields.put("dhvani", "stats");
            fields.put("v", VERSION);
            fields.put("code", code);
            sign(fields, key, n);
            return fields.toString();
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }

    /** Sets the laptop's own playback volume (0..1.5) and/or mute. Null leaves a field unchanged. */
    static String control(String code, Double volume, Boolean muted) {
        return control(code, volume, muted, null, 0);
    }

    static String control(String code, Double volume, Boolean muted, String key, long n) {
        try {
            JSONObject o = new JSONObject();
            o.put("dhvani", "control");
            o.put("v", VERSION);
            o.put("code", code);
            if (volume != null) o.put("volume", Math.max(0, Math.min(1.5, volume)));
            if (muted != null) o.put("muted", muted.booleanValue());
            sign(o, key, n);
            return o.toString();
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }

    static final class Laptop {
        final double volume;
        final boolean muted;
        final String[] addresses;
        /** The laptop's chosen output is gone (headset off), so it plays silence. */
        final boolean outputMissing;

        Laptop(double volume, boolean muted, String[] addresses, boolean outputMissing) {
            this.volume = volume;
            this.muted = muted;
            this.addresses = addresses;
            this.outputMissing = outputMissing;
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
            return new Laptop(o.optDouble("volume", 1), o.optBoolean("muted", false), addrs,
                    o.optBoolean("outputMissing", false));
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

    /** A discover request with a fresh nonce, so a reply can prove which laptop sent it. */
    static String discover(String nonce) {
        return "{\"dhvani\":\"discover\",\"v\":1,\"nonce\":\"" + nonce + "\"}";
    }

    static final class Here {
        final String name;
        final int port;
        /** The laptop's id and its proof for the nonce; null from an older laptop. */
        final String id;
        final String proof;

        Here(String name, int port, String id, String proof) {
            this.name = name;
            this.port = port;
            this.id = id;
            this.proof = proof;
        }
    }

    /** Returns the reply, or null when the packet is not a Dhvani reply. */
    static Here parseDiscoverReply(String msg) {
        try {
            JSONObject o = new JSONObject(msg);
            if (!"here".equals(o.optString("dhvani"))) return null;
            int port = o.optInt("port", AUDIO_PORT);
            if (port <= 0 || port > 65535) return null;
            String name = o.optString("name", "Laptop");
            if (name.length() > 40) name = name.substring(0, 40);
            String id = o.optString("id", ""), proof = o.optString("proof", "");
            boolean signed = id.matches("[0-9a-f]{16}") && proof.matches("[0-9a-f]{64}");
            return new Here(name, port, signed ? id : null, signed ? proof : null);
        } catch (JSONException e) {
            return null;
        }
    }

    /** Matches laptopId() in protocol.ts: a public handle for the laptop key. */
    static String laptopId(String key) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-256").digest(("dhvani-id:" + key).getBytes(StandardCharsets.UTF_8));
            return hex(d).substring(0, 16);
        } catch (java.security.GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    /** Matches discoverProof() in protocol.ts. */
    static String discoverProof(String key, String nonce) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(key.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            return hex(mac.doFinal(("dhvani-discover:" + nonce).getBytes(StandardCharsets.UTF_8)));
        } catch (java.security.GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    /** True when the proof is right for this key and nonce; compared in constant time. */
    static boolean proofMatches(String key, String nonce, String proof) {
        if (proof == null) return false;
        return MessageDigest.isEqual(discoverProof(key, nonce).getBytes(StandardCharsets.UTF_8),
                proof.getBytes(StandardCharsets.UTF_8));
    }

    static String hex(byte[] b) {
        StringBuilder sb = new StringBuilder(b.length * 2);
        for (byte x : b) sb.append(Character.forDigit((x >> 4) & 15, 16)).append(Character.forDigit(x & 15, 16));
        return sb.toString();
    }

    /**
     * "host", "host:port", "[v6]" or "[v6]:port"; a bare IPv6 address has no port. Returns
     * {host, port} or {null, error message}.
     */
    static Object[] parseAddress(String addr) {
        addr = addr.trim();
        if (addr.isEmpty()) return new Object[] {null, "Pick a laptop or type its address."};
        String host = addr;
        String portText = null;
        if (addr.startsWith("[")) {
            int close = addr.indexOf(']');
            if (close < 2) return new Object[] {null, "An IPv6 address in brackets needs the closing ']'."};
            host = addr.substring(1, close);
            String rest = addr.substring(close + 1);
            if (!rest.isEmpty()) {
                if (!rest.startsWith(":")) return new Object[] {null, "Put the port after ']:' like [fe80::1]:47800."};
                portText = rest.substring(1);
            }
            if (!host.contains(":")) return new Object[] {null, "Brackets are only for IPv6 addresses."};
        } else {
            int colon = addr.lastIndexOf(':');
            if (colon > 0 && addr.indexOf(':') == colon) {
                host = addr.substring(0, colon);
                portText = addr.substring(colon + 1);
            } else if (colon == 0) {
                return new Object[] {null, "Type the laptop's address before the ':'."};
            }
        }
        if (host.matches(".*[\\s/@\\[\\]].*")) return new Object[] {null, "That doesn't look like an address: " + addr};
        int port = AUDIO_PORT;
        if (portText != null) {
            try {
                port = Integer.parseInt(portText);
            } catch (NumberFormatException e) {
                return new Object[] {null, "The port after ':' must be a number."};
            }
            if (port < 1 || port > 65535) return new Object[] {null, "The port must be between 1 and 65535."};
        }
        return new Object[] {host, port};
    }
}
