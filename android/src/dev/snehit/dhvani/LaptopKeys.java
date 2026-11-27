package dev.snehit.dhvani;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Keys of laptops this phone has paired with, learned from a successful hello. A discovery
 * reply that proves one of these keys is the real laptop; another machine answering with the
 * same name cannot, so the list leaves it out.
 */
final class LaptopKeys {
    private static final String PREFS = "dhvani_laptops";
    private static final int MAX = 16;

    private LaptopKeys() {}

    static synchronized void remember(Context c, String id, String key, String name) {
        if (id == null || key == null) return;
        SharedPreferences p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        try {
            JSONObject all = new JSONObject(p.getString("keys", "{}"));
            JSONObject had = all.optJSONObject(id);
            if (had != null && key.equals(had.optString("key")) && name.equals(had.optString("name"))) return;
            all.remove(id);
            // Keep the list small: drop the oldest entry first.
            while (all.length() >= MAX) all.remove(all.keys().next());
            all.put(id, new JSONObject().put("key", key).put("name", name));
            p.edit().putString("keys", all.toString()).apply();
        } catch (JSONException ignored) {}
    }

    /** All known laptops: id -> {key, name}. */
    static synchronized JSONObject all(Context c) {
        try {
            return new JSONObject(c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("keys", "{}"));
        } catch (JSONException e) {
            return new JSONObject();
        }
    }
}
