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
        StreamService s = StreamService.instance;
        if (s == null || !s.ownsVolumeKeys()) return false;
        // Held keys repeat ACTION_DOWN; the matching ACTION_UP is swallowed too.
        if (e.getAction() == KeyEvent.ACTION_DOWN) s.volumeKey(direction);
        return true;
    }

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
