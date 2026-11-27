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

    private static final String KEY = "00112233445566778899aabbccddeeff";
    private static final String PROOF = "0887d0f5affedc06919cd35ab01c11ad33e1f0736fa27e65aca396bd8ff05b88";

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
        test("volume fallback moves the laptop at most once per 100 ms", () -> {
            yes(StreamService.fallbackStepDue(10_000, 0), "first rise counts");
            yes(!StreamService.fallbackStepDue(10_050, 10_000), "a rise 50 ms later is the same press");
            yes(StreamService.fallbackStepDue(10_100, 10_000), "a rise 100 ms later is a new press");
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
            byte[] ring = new byte[Protocol.UDP_HEADER + pcm.length + 10];
            ring[3] = 1;
            pcm[0] = 42;
            int n = Protocol.writeAudioPacket(ring, tok, 7, 1234, pcm, 0, pcm.length);
            eq(Protocol.UDP_HEADER + pcm.length, n);
            eq(0, (int) ring[3]);
            eq(42, (int) ring[Protocol.UDP_HEADER]);
            for (int i = 0; i < Protocol.UDP_HEADER; i++) eq(p[i], ring[i]);
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
            eq(false, l.outputMissing);
            eq(true, Protocol.parseLaptop("{\"dhvani\":\"laptop\",\"outputMissing\":true}").outputMissing);
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
            Protocol.Here d = Protocol.parseDiscoverReply("{\"dhvani\":\"here\",\"v\":1,\"name\":\"box\",\"port\":47800}");
            eq("box", d.name);
            eq(47800, d.port);
            yes(d.id == null && d.proof == null, "old laptop proves nothing");
            yes(Protocol.parseDiscoverReply("junk") == null, "junk");
            yes(Protocol.parseDiscoverReply("{\"dhvani\":\"here\",\"port\":0}") == null, "bad port");
            Protocol.Here s = Protocol.parseDiscoverReply("{\"dhvani\":\"here\",\"name\":\"box\",\"port\":47800,"
                    + "\"id\":\"e29c5cf8d9f09040\",\"proof\":\"" + PROOF + "\"}");
            eq("e29c5cf8d9f09040", s.id);
            eq(PROOF, s.proof);
            JSONObject req = new JSONObject(Protocol.discover("0123456789abcdef"));
            eq("discover", req.getString("dhvani"));
            eq("0123456789abcdef", req.getString("nonce"));
        });
        test("laptop id and discovery proof match the laptop's", () -> {
            // Vectors from laptopId() and discoverProof() in laptop/src/protocol.ts.
            eq("e29c5cf8d9f09040", Protocol.laptopId(KEY));
            eq(PROOF, Protocol.discoverProof(KEY, "0123456789abcdef"));
            yes(Protocol.proofMatches(KEY, "0123456789abcdef", PROOF), "right proof");
            yes(!Protocol.proofMatches(KEY, "fedcba9876543210", PROOF), "other nonce");
            yes(!Protocol.proofMatches("ffffffffffffffffffffffffffffffff", "0123456789abcdef", PROOF), "other key");
            yes(!Protocol.proofMatches(KEY, "0123456789abcdef", null), "no proof");
        });
        test("reply carries the session and laptop keys", () -> {
            Protocol.Reply r = Protocol.parseReply("{\"ok\":true,\"ctl\":\"0011223344556677\","
                    + "\"id\":\"e29c5cf8d9f09040\",\"key\":\"" + KEY + "\"}");
            eq("0011223344556677", r.ctl);
            eq("e29c5cf8d9f09040", r.laptopId);
            eq(KEY, r.laptopKey);
            Protocol.Reply bad = Protocol.parseReply("{\"ok\":true,\"ctl\":\"xyz\","
                    + "\"id\":\"0000000000000000\",\"key\":\"" + KEY + "\"}");
            yes(bad.ctl == null && bad.laptopKey == null && bad.laptopId == null, "id must match key");
        });
        test("signed reports and controls", () -> {
            JSONObject c = new JSONObject(Protocol.control("123456", 0.5, true, "0011223344556677", 9));
            eq("0011223344556677", c.getString("key"));
            eq(9L, c.getLong("n"));
            JSONObject u = new JSONObject(Protocol.control("123456", 0.5, null));
            yes(!u.has("key") && !u.has("n"), "unsigned without a key");
            JSONObject v = new JSONObject(Protocol.volume("123456", 3, 15, false, "0011223344556677", 2));
            eq(2L, v.getLong("n"));
            JSONObject st = new JSONObject(Protocol.stats("123456", new JSONObject().put("x", 1), "0011223344556677", 3));
            eq(3L, st.getLong("n"));
            eq("0011223344556677", st.getString("key"));
            JSONObject h = new JSONObject(Protocol.hello("123456", "Pixel"));
            eq(1, h.getInt("ctl"));
        });
        test("addresses", () -> {
            Object[] a = Protocol.parseAddress(" 192.168.1.5 ");
            eq("192.168.1.5", a[0]);
            eq(Protocol.AUDIO_PORT, a[1]);
            a = Protocol.parseAddress("box.local:47900");
            eq("box.local", a[0]);
            eq(47900, a[1]);
            a = Protocol.parseAddress("fe80::1");
            eq("fe80::1", a[0]);
            eq(Protocol.AUDIO_PORT, a[1]);
            a = Protocol.parseAddress("[fe80::1]:47801");
            eq("fe80::1", a[0]);
            eq(47801, a[1]);
            eq("fe80::1", Protocol.parseAddress("[fe80::1]")[0]);
            for (String bad : new String[] {"", "host:abc", "host:0", "host:70000", ":47800", "[fe80::1", "[box]", "[fe80::1]x", "a b"}) {
                Object[] r = Protocol.parseAddress(bad);
                yes(r[0] == null && r[1] instanceof String && !((String) r[1]).isEmpty(), "rejects '" + bad + "'");
            }
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
