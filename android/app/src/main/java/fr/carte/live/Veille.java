package fr.carte.live;

// Service de veille : garde un œil sur la carte même écran éteint et application fermée, et prévient par une
// notification Android (message direct reçu, alerte critique, nouveau signalement). Il interroge toutes les
// 45 secondes l'adresse /api/notifications de la carte, avec la session ouverte dans l'application.

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.webkit.CookieManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

public class Veille extends Service {
    static final String CANAL_VEILLE = "veille", CANAL_ALERTES = "alertes";
    private static final long PERIODE = 45000;
    private HandlerThread fil;
    private Handler h;
    private SharedPreferences prefs;

    static void demarrer(Context c) {
        Intent i = new Intent(c, Veille.class);
        if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i); else c.startService(i);
    }
    static void arreter(Context c) { c.stopService(new Intent(c, Veille.class)); }

    static void creerCanaux(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        NotificationChannel v = new NotificationChannel(CANAL_VEILLE, "Veille de la carte", NotificationManager.IMPORTANCE_MIN);
        v.setDescription("Notification permanente pendant que l'application surveille la carte");
        nm.createNotificationChannel(v);
        NotificationChannel a = new NotificationChannel(CANAL_ALERTES, "Messages et alertes", NotificationManager.IMPORTANCE_HIGH);
        a.setDescription("Messages directs, alertes critiques et signalements");
        a.enableVibration(true);
        nm.createNotificationChannel(a);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        prefs = getSharedPreferences("carte", MODE_PRIVATE);
        creerCanaux(this);
        Notification n = construire(CANAL_VEILLE, "Carte live", "Surveille les messages et les alertes", false);
        if (Build.VERSION.SDK_INT >= 34) startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(1, n);
        fil = new HandlerThread("veille");
        fil.start();
        h = new Handler(fil.getLooper());
        h.post(this::tour);
    }

    private Notification construire(String canal, String titre, String texte, boolean alerte) {
        Intent ouvrir = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, alerte ? (int) (System.currentTimeMillis() & 0xffff) : 0, ouvrir, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, canal) : new Notification.Builder(this);
        b.setSmallIcon(android.R.drawable.stat_notify_chat).setContentTitle(titre).setContentText(texte)
                .setStyle(new Notification.BigTextStyle().bigText(texte)).setContentIntent(pi).setAutoCancel(alerte).setOngoing(!alerte);
        if (alerte && Build.VERSION.SDK_INT < 26) b.setPriority(Notification.PRIORITY_HIGH).setDefaults(Notification.DEFAULT_ALL);
        return b.build();
    }

    private void tour() {
        try {
            String carte = prefs.getString("courante", "");
            if (!carte.isEmpty() && prefs.getBoolean("notifications", true)) {
                Uri0 u = Uri0.de(carte);
                long depuis = prefs.getLong("notifDepuis", System.currentTimeMillis() - 600000);
                HttpURLConnection c = (HttpURLConnection) new URL(u.base + "/api/notifications?depuis=" + depuis + "&langue=" + java.util.Locale.getDefault().getLanguage()).openConnection();
                c.setConnectTimeout(10000);
                c.setReadTimeout(15000);
                String cookie = CookieManager.getInstance().getCookie(u.base);
                if (cookie != null) c.setRequestProperty("Cookie", cookie);
                c.setRequestProperty("User-Agent", "CarteLiveAndroid");
                if (c.getResponseCode() == 200) {
                    JSONObject r = new JSONObject(lire(c.getInputStream()));
                    JSONArray l = r.getJSONArray("notifications");
                    NotificationManager nm = getSystemService(NotificationManager.class);
                    String deja = prefs.getString("notifVues", "");
                    StringBuilder vues = new StringBuilder(deja.length() > 4000 ? deja.substring(deja.length() - 2000) : deja);
                    for (int i = 0; i < l.length(); i++) {
                        JSONObject x = l.getJSONObject(i);
                        String id = x.optString("id");
                        if (vues.indexOf("|" + id + "|") >= 0) continue;
                        vues.append("|").append(id).append("|");
                        nm.notify(id.hashCode(), construire(CANAL_ALERTES, x.optString("titre", "Carte live"), x.optString("texte", ""), true));
                    }
                    prefs.edit().putLong("notifDepuis", r.optLong("maintenant", System.currentTimeMillis())).putString("notifVues", vues.toString()).apply();
                }
                c.disconnect();
            }
        } catch (Exception e) { /* carte injoignable : nouvel essai au prochain tour */ }
        if (h != null) h.postDelayed(this::tour, PERIODE);
    }

    private static String lire(InputStream in) throws Exception {
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        byte[] t = new byte[8192];
        int n;
        while ((n = in.read(t)) > 0) o.write(t, 0, n);
        in.close();
        return o.toString("UTF-8");
    }

    // Base « http://hôte:port » d'une adresse de carte (sans le chemin ni « ?consultation »)
    static class Uri0 {
        final String base;
        Uri0(String b) { base = b; }
        static Uri0 de(String url) {
            android.net.Uri u = android.net.Uri.parse(url);
            return new Uri0(u.getScheme() + "://" + u.getHost() + (u.getPort() > 0 ? ":" + u.getPort() : ""));
        }
    }

    @Override
    public void onDestroy() {
        if (h != null) h.removeCallbacksAndMessages(null);
        h = null;
        if (fil != null) fil.quitSafely();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent i) { return null; }
}
