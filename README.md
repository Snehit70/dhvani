# Dhvani

Plays your Android phone's audio on your Linux laptop over Wi-Fi: music, videos, games. Only playback audio is sent, never the microphone or the screen.

```
phone (Android 10+)  --TCP 47800, raw 48 kHz stereo PCM-->  laptop (PipeWire)
                     <--UDP 47802 discovery-->
```

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
- **Reconnect automatically**: retries with backoff if Wi-Fi drops or the laptop restarts.

Stop it from the app or from the notification.

## Limits

- Apps that opt out of capture (some banking and DRM video apps) and calls are not shared. That is Android policy.
- Latency is roughly 50-100 ms. Fine for music and video, noticeable for rhythm games.
- Audio is not encrypted on the LAN. The pairing code stops strangers from playing to your laptop; it does not hide what you stream. Use it on networks you trust.

## Develop

```sh
cd laptop && bun install && bun test && bunx tsc --noEmit && bun src/main.ts
```
