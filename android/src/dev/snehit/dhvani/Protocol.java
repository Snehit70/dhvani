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
            return o.toString() + "\n";
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }

    static final class Reply {
        final boolean ok;
        final String name;
        final String error;

        Reply(boolean ok, String name, String error) {
            this.ok = ok;
            this.name = name;
            this.error = error;
        }
    }

    static Reply parseReply(String line) {
        try {
            JSONObject o = new JSONObject(line);
            if (o.optBoolean("ok", false)) return new Reply(true, o.optString("name", "Laptop"), null);
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
