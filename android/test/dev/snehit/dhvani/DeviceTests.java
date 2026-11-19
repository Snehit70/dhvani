package dev.snehit.dhvani;

import android.content.Intent;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * Unit tests that run on a real Android runtime (emulator or phone) through app_process,
 * so Intent, Bundle and org.json behave exactly as in the app. Run with android/test.sh.
 */
public final class DeviceTests {
    interface Body { void run() throws Exception; }

    private static final List<String> failures = new ArrayList<>();
    private static int passed;

    private static void test(String name, Body b) {
        try {
            b.run();
            passed++;
            System.out.println("  ok   " + name);
        } catch (Throwable t) {
            failures.add(name + ": " + t);
            System.out.println("  FAIL " + name + ": " + t);
        }
    }

    private static void eq(Object want, Object got) {
        if (want == null ? got != null : !want.equals(got)) {
            throw new AssertionError("expected " + want + ", got " + got);
        }
    }

    private static void yes(boolean c, String what) {
        if (!c) throw new AssertionError(what);
    }

    private static Intent control() {
        return new Intent(StreamService.ACTION_CONTROL);
    }

    public static void main(String[] args) {
        System.out.println("Dhvani device tests");

        // ---- CONTROL intents (the slider, mute button, notification, volume keys) ----
        test("volume only: the slider path, which used to crash", () -> {
            Intent i = control().putExtra(StreamService.EXTRA_VOLUME, 0.42f);
            eq(0.42, Math.round(StreamService.controlVolume(i) * 100) / 100.0);
            eq(null, StreamService.controlMuted(i, false));
            eq(null, StreamService.controlMuted(i, true));
        });
        test("muted only", () -> {
            Intent i = control().putExtra(StreamService.EXTRA_MUTED, true);
            eq(null, StreamService.controlVolume(i));
            eq(Boolean.TRUE, StreamService.controlMuted(i, false));
            eq(Boolean.FALSE, StreamService.controlMuted(control().putExtra(StreamService.EXTRA_MUTED, false), true));
        });
        test("toggle mute flips the current state", () -> {
            Intent i = control().putExtra(StreamService.EXTRA_TOGGLE_MUTE, true);
            eq(Boolean.TRUE, StreamService.controlMuted(i, false));
            eq(Boolean.FALSE, StreamService.controlMuted(i, true));
        });
        test("empty and toggle=false intents change nothing", () -> {
            eq(null, StreamService.controlVolume(control()));
            eq(null, StreamService.controlMuted(control(), false));
            eq(null, StreamService.controlMuted(control().putExtra(StreamService.EXTRA_TOGGLE_MUTE, false), true));
        });
        test("volume and mute together", () -> {
            Intent i = control().putExtra(StreamService.EXTRA_VOLUME, 1f).putExtra(StreamService.EXTRA_MUTED, false);
            eq(1.0, StreamService.controlVolume(i));
            eq(Boolean.FALSE, StreamService.controlMuted(i, true));
        });
        test("volume is clamped, NaN ignored", () -> {
            eq(1.5, StreamService.controlVolume(control().putExtra(StreamService.EXTRA_VOLUME, 9f)));
            eq(0.0, StreamService.controlVolume(control().putExtra(StreamService.EXTRA_VOLUME, -1f)));
            eq(null, StreamService.controlVolume(control().putExtra(StreamService.EXTRA_VOLUME, Float.NaN)));
        });
        test("a volume extra of the wrong type falls back instead of crashing", () -> {
            Double v = StreamService.controlVolume(control().putExtra(StreamService.EXTRA_VOLUME, "loud"));
            yes(v != null && v >= 0 && v <= 1.5, "got " + v);
        });

        // ---- Packets the phone sends ----
        test("control packet carries only the fields given", () -> {
            JSONObject a = new JSONObject(Protocol.control("123456", 0.5, null));
            eq("control", a.getString("dhvani"));
            eq("123456", a.getString("code"));
            eq(0.5, a.getDouble("volume"));
            yes(!a.has("muted"), "no muted field");
            JSONObject b = new JSONObject(Protocol.control("123456", null, true));
            yes(!b.has("volume"), "no volume field");
            eq(true, b.getBoolean("muted"));
            eq(1.5, new JSONObject(Protocol.control("1", 7.0, null)).getDouble("volume"));
        });
        test("hello and volume report are valid JSON", () -> {
            JSONObject h = new JSONObject(Protocol.hello("123456", "Pixel"));
            eq("123456", h.getString("code"));
            eq(48000, h.getInt("rate"));
            JSONObject v = new JSONObject(Protocol.volume("123456", 3, 15, true));
            eq(3, v.getInt("index"));
            eq(true, v.getBoolean("muted"));
        });
        test("audio packet header", () -> {
            byte[] tok = {1, 2, 3, 4, 5, 6, 7, 8};
            byte[] pcm = new byte[Protocol.UDP_PCM_BYTES];
            byte[] p = Protocol.audioPacket(tok, 7, 1234, pcm, 0, pcm.length);
            eq(Protocol.UDP_HEADER + pcm.length, p.length);
            eq((int) 'D', (int) p[0]);
            eq((int) 'H', (int) p[1]);
        });

        // ---- Lines and replies from the laptop ----
        test("reply with UDP offer", () -> {
            Protocol.Reply r = Protocol.parseReply("{\"ok\":true,\"name\":\"box\",\"udp\":{\"port\":47902,\"token\":\"0102030405060708\"}}");
            yes(r.ok, "ok");
            eq("box", r.name);
            eq(47902, r.udpPort);
            eq(8, r.udpToken.length);
        });
        test("reply without UDP, refusals and garbage", () -> {
            Protocol.Reply r = Protocol.parseReply("{\"ok\":true}");
            yes(r.ok && r.udpToken == null && r.udpPort == 0, "plain ok");
            eq("bad_code", Protocol.parseReply("{\"ok\":false,\"error\":\"bad_code\"}").error);
            eq("bad_reply", Protocol.parseReply("not json").error);
            eq("bad_reply", Protocol.parseReply("").error);
            yes(Protocol.parseReply("{\"ok\":true,\"udp\":{\"port\":99999,\"token\":\"zz\"}}").udpToken == null, "bad udp ignored");
            yes(!Protocol.errorMessage("bad_code").isEmpty(), "message for bad_code");
            yes(!Protocol.errorMessage("something new").isEmpty(), "message for unknown error");
        });
        test("laptop state line", () -> {
            Protocol.Laptop l = Protocol.parseLaptop("{\"dhvani\":\"laptop\",\"volume\":1.2,\"muted\":true,\"addresses\":[\"10.0.0.5\"]}");
            eq(1.2, l.volume);
            eq(true, l.muted);
            eq("10.0.0.5", l.addresses[0]);
            yes(Protocol.parseLaptop("{\"dhvani\":\"ping\"}") == null, "ping is not state");
            yes(Protocol.parseLaptop("garbage") == null, "garbage");
            yes(Protocol.parseLaptop("{\"dhvani\":\"laptop\"}") != null, "missing fields default");
        });
        test("transport lines", () -> {
            String fallback = "{\"dhvani\":\"transport\",\"udp\":false}";
            String resume = "{\"dhvani\":\"transport\",\"udp\":true}";
            yes(Protocol.isTcpFallback(fallback) && !Protocol.isUdpResume(fallback), "fallback");
            yes(Protocol.isUdpResume(resume) && !Protocol.isTcpFallback(resume), "resume");
            yes(!Protocol.isTcpFallback("{\"dhvani\":\"ping\"}") && !Protocol.isUdpResume("x"), "others");
            yes(Protocol.parseLaptop(resume) == null, "resume is not laptop state");
        });
        test("discovery reply", () -> {
            Object[] d = Protocol.parseDiscoverReply("{\"dhvani\":\"here\",\"v\":1,\"name\":\"box\",\"port\":47800}");
            yes(d == null || d.length > 0, "parses or rejects cleanly");
            yes(Protocol.parseDiscoverReply("junk") == null, "junk");
        });

        // ---- Wi-Fi tips ----
        test("Wi-Fi tips and hysteresis", () -> {
            eq("", StreamService.wifiTip(false, 5220));
            yes(StreamService.wifiTip(false, 2437).contains("2.4 GHz"), "2.4 GHz tip");
            yes(StreamService.wifiTip(true, 5220).contains("Weak"), "weak tip");
            yes(StreamService.wifiTip(true, 2437).contains("Weak 2.4 GHz"), "both");
            eq("", StreamService.wifiTip(false, 0));
            yes(!StreamService.weakWifi(false, -68), "not weak yet at -68");
            yes(StreamService.weakWifi(false, -72), "weak at -72");
            yes(StreamService.weakWifi(true, -68), "still weak at -68");
            yes(!StreamService.weakWifi(true, -60), "recovered at -60");
        });

        System.out.println(passed + " passed, " + failures.size() + " failed");
        System.exit(failures.isEmpty() ? 0 : 1);
    }
}
