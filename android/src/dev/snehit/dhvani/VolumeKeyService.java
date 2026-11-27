package dev.snehit.dhvani;

import android.accessibilityservice.AccessibilityService;
import android.content.ComponentName;
import android.content.Context;
import android.provider.Settings;
import android.text.TextUtils;
import android.view.KeyEvent;
import android.view.accessibility.AccessibilityEvent;

/**
 * Takes the phone's volume buttons while Dhvani streams with the phone silenced, so they
 * change the laptop's volume instead of turning the phone speaker back on. At any other
 * time the keys pass through untouched. It reads no screen content and no other keys.
 */
public final class VolumeKeyService extends AccessibilityService {
    @Override protected boolean onKeyEvent(KeyEvent e) {
        int direction;
        switch (e.getKeyCode()) {
            case KeyEvent.KEYCODE_VOLUME_UP: direction = 1; break;
            case KeyEvent.KEYCODE_VOLUME_DOWN: direction = -1; break;
            case KeyEvent.KEYCODE_VOLUME_MUTE: direction = 0; break;
            default: return false;
        }
        int k = direction + 1;
        StreamService s = StreamService.instance;
        if (e.getAction() == KeyEvent.ACTION_DOWN && e.getRepeatCount() == 0) {
            // Decided once per press: a stream starting or stopping mid-press doesn't split it,
            // so the phone never sees an UP without its DOWN or the other way round.
            owned[k] = s != null && s.ownsVolumeKeys();
        }
        if (!owned[k]) return false;
        if (e.getAction() == KeyEvent.ACTION_UP) {
            owned[k] = false;
            return true;
        }
        // Holding up or down keeps stepping; holding mute toggles once.
        if (s != null && (direction != 0 || e.getRepeatCount() == 0)) s.volumeKey(direction);
        return true;
    }

    /** Whether the current press of mute, down or up (by direction + 1) belongs to Dhvani. */
    private final boolean[] owned = new boolean[3];

    @Override public void onAccessibilityEvent(AccessibilityEvent event) {}

    @Override public void onInterrupt() {}

    /** True when the user has switched this service on in Accessibility settings. */
    static boolean enabled(Context c) {
        String list = Settings.Secure.getString(c.getContentResolver(),
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
        if (TextUtils.isEmpty(list)) return false;
        ComponentName me = new ComponentName(c, VolumeKeyService.class);
        for (String s : list.split(":")) {
            ComponentName n = ComponentName.unflattenFromString(s);
            if (me.equals(n)) return true;
        }
        return false;
    }
}
