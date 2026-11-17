package dev.snehit.dhvani;

import android.annotation.SuppressLint;
import android.app.PendingIntent;
import android.content.Intent;
import android.graphics.drawable.Icon;
import android.os.Build;
import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;

/**
 * Quick Settings tile. Tap while streaming stops; tap otherwise opens Dhvani and starts with the
 * saved laptop. Starting needs the activity because Android asks to allow sharing every time.
 */
public final class DhvaniTile extends TileService implements StreamState.Listener {
    @Override public void onStartListening() {
        StreamState.add(this);
        onState();
    }

    @Override public void onStopListening() {
        StreamState.remove(this);
    }

    @Override public void onState() {
        Tile t = getQsTile();
        if (t == null) return;
        StreamState.Status s = StreamState.status;
        t.setIcon(Icon.createWithResource(this, R.drawable.ic_notify));
        t.setLabel("Dhvani");
        t.setState(StreamState.active() ? Tile.STATE_ACTIVE : Tile.STATE_INACTIVE);
        {
            String sub;
            switch (s) {
                case STREAMING: sub = StreamState.detail.isEmpty() ? "Playing" : StreamState.detail; break;
                case CONNECTING: sub = "Connecting…"; break;
                case RECONNECTING: sub = "Reconnecting…"; break;
                default: sub = "Off"; break;
            }
            t.setSubtitle(sub);
        }
        t.updateTile();
    }

    @SuppressLint("StartActivityAndCollapseDeprecated")
    @Override public void onClick() {
        if (StreamState.active()) {
            startService(new Intent(this, StreamService.class).setAction(StreamService.ACTION_STOP));
            return;
        }
        Intent i = new Intent(this, MainActivity.class)
                .putExtra(MainActivity.EXTRA_AUTOSTART, true)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        if (Build.VERSION.SDK_INT >= 34) {
            startActivityAndCollapse(PendingIntent.getActivity(this, 0, i,
                    PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
        } else {
            startActivityAndCollapse(i);
        }
    }
}
