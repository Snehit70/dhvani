# Dhvani

Plays your Android phone's audio on your Linux laptop over Wi-Fi: music, videos, games. Only playback audio is sent, never the microphone or the screen.

```
phone (Android 10+)  --UDP 47802, raw 48 kHz stereo PCM, each packet sent twice-->  laptop (PipeWire)
                     <--TCP 47800 pairing, laptop volume, keepalive-->
                     <--UDP 47802 discovery and phone reports-->
```

Over Wi-Fi the audio goes as 5 ms UDP packets, each one sent again 20 ms later. A lost
packet is filled from its copy, and one lost twice plays as 5 ms of silence. Over TCP the
same loss stalled the stream for one to three seconds while the packet was resent. If UDP
does not get through, the laptop asks the phone to send on the TCP socket instead. Over USB
(`adb reverse` carries TCP only) audio always uses TCP.

## Laptop

Needs Linux with PipeWire (`pw-cat`, `pactl`) and [Bun](https://bun.sh).

```sh
./install.sh      # builds, installs ~/.local/bin/dhvani, starts a systemd user service
./uninstall.sh
```

The control panel is at <http://127.0.0.1:47801> (also "Dhvani" in the app menu). There you can:

- pick the output (follow the system output, Bluetooth headset, speakers), set volume up to 150%, and mute
- see the pairing code, make a new one, and see the laptop's addresses
- check health (server, discovery, firewall) and disconnect the phone

Settings are in `~/.config/dhvani/config.json` (mode 600).

The firewall must allow 47800/tcp and 47802/udp. On Fedora:

```sh
sudo firewall-cmd --permanent --add-port=47800/tcp --add-port=47802/udp && sudo firewall-cmd --reload
```

Logs: `journalctl --user -u dhvani -f`

## Phone

```sh
android/build.sh   # -> android/dist/dhvani.apk, about 40 KB; no Gradle
```

It needs only an Android SDK (platform + build-tools) and a JDK 17+.

1. Install the APK, open Dhvani.
2. Tap your laptop in the list or type its IP, then enter the 6-digit code from the panel.
3. Tap **Start** and allow the sharing prompt.

Options:

- **Silence this phone**: mutes the phone speaker while streaming and restores it when you stop or the connection drops. Some phones also mute the shared audio when the speaker is muted. Dhvani detects that after about 3 s of silence, puts the volume back, and tells you to turn the option off.
- **Volume buttons control the laptop**: while the phone is silenced, its volume buttons change the laptop volume (5% a press, with a short on-screen note) and the phone stays quiet. This uses a small Accessibility service that only looks at the volume keys, and only while streaming. Turn on **Dhvani volume buttons** in Accessibility settings. On Android 13+ a sideloaded app's toggle is greyed out until you allow it: App info, ⋮ menu, **Allow restricted settings**. Without the service, Dhvani still catches the phone volume rising, puts it back to 0 within a moment and moves the laptop instead, but a press can be heard briefly and volume down can't be seen.
- **Reconnect automatically**: retries with backoff if Wi-Fi drops or the laptop restarts.
- **Start when opened**: opening Dhvani connects to the saved laptop right away.

The laptop and code are remembered, so you pair once. Android still shows the
"allow sharing" prompt at every start; apps cannot skip it.

While streaming, the app shows a **Laptop volume** slider and mute button that
change the laptop's own output. The notification has **Stop** and **Mute laptop**.

Add the **Dhvani** Quick Settings tile (edit the quick settings panel) to start
or stop from anywhere.

During long digital silence the phone sends only a short keepalive four times a
second, so the Wi-Fi radio can rest. The laptop counts that as idle, not as
network gaps.

**USB cable:** turn on USB mode in the laptop panel with `adb` installed and USB
debugging on. The phone then lists the laptop as "USB cable". Audio goes over the
cable; stats and the volume controls still go over Wi-Fi, so keep the phone on
the same network for those.

## Logs

Every session is logged as JSON lines to `~/.local/state/dhvani/events.jsonl`
(rotates at 5 MB) and to the journal (`journalctl --user -u dhvani`).

```sh
dhvani report        # last 10 sessions: drops, Wi-Fi gaps, phone signal, why it ended
dhvani report 50
jq 'select(.ev=="session_stats")' ~/.local/state/dhvani/events.jsonl
```

Events: `start`, `stop`, `firewall`, `settings`, `hello_rejected`, `session_start`,
`session_stats` (every 10 s: arrival gaps p50/p95/max, rate vs real time, drops
by cause, queued lead, underruns, peak, silence %; `dropQuiet` counts silent
chunks shed on purpose, `compressedMs` the audio removed by briefly playing
faster, `stale` UDP packets held over a second), `phone_stats` (every 10 s
from the phone, and at once when its screen turns on or off: socket write/read
stalls, watchdog trips, reconnects, Wi-Fi RSSI/link speed/band, screen),
`phone_screen`, `player_start`, `player_exit`, `session_end` (reason,
duration, totals).

When audio piles up after a Wi-Fi hiccup, Dhvani drops silent bits first and
otherwise catches up by playing up to about 20% faster for a moment, with pitch
kept, instead of skipping audio. While the phone screen is off, Android may let
Wi-Fi doze, so Low mode holds at least 80 ms. The pairing code is never logged.

On the phone: `adb logcat -s Dhvani`.

## Limits

- Apps that opt out of capture (some banking and DRM video apps) and calls are not shared. That is Android policy.
- Latency is roughly 50-70 ms through laptop speakers or a jack. Android captures in fixed
  21 ms blocks, so the buffer cannot go much below 50 ms
  without PipeWire running dry. Bluetooth headphones add their own
  delay on top (SBC is about 130 ms); the panel's Latency tile includes it.
- Audio is not encrypted on the LAN. The pairing code stops strangers from playing to your laptop; it does not hide what you stream. Use it on networks you trust.

## Develop

```sh
cd laptop && bun install && bun test && bunx tsc --noEmit && bun src/main.ts
```
