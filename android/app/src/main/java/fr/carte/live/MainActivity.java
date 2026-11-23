package fr.carte.live;

// Application Android de la carte live : une page d'accueil (choix de la carte : adresse du serveur, mémorisée)
// puis la carte elle-même dans une vue web, avec la position du téléphone, les fichiers (GPX, exports, photos)
// et le bouton retour. La carte reste celle du serveur : chaque mise à jour du serveur se voit tout de suite ici.

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.view.WindowInsets;
import android.widget.FrameLayout;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.URL;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;

public class MainActivity extends Activity {
    private static final String ACCUEIL = "file:///android_asset/accueil.html";
    private static final int DEMANDE_POSITION = 1, DEMANDE_FICHIER = 2, DEMANDE_NOTIF = 3;
    private static final String DEPOT = "sauveteur71/carte-live-meshtastic";
    private WebView vue;
    private SharedPreferences prefs;
    private GeolocationPermissions.Callback rappelPosition;
    private String origineDemandee;
    private ValueCallback<Uri[]> rappelFichier;

    @Override
    protected void onCreate(Bundle etatSauve) {
        super.onCreate(etatSauve);
        prefs = getSharedPreferences("carte", Context.MODE_PRIVATE);
        vue = new WebView(this);
        // Android 15 affiche l'appli bord à bord : la carte passait sous la barre d'état (heure, icônes) et sous la barre
        // de navigation. Le cadre laisse la place des barres système, de l'encoche et du clavier.
        FrameLayout cadre = new FrameLayout(this);
        cadre.setBackgroundColor(0xff0f172a);
        cadre.addView(vue, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        cadre.setOnApplyWindowInsetsListener((v, encarts) -> {
            int g, h, d, b;
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets i = encarts.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                // Clavier : à partir d'Android 15, adjustResize ne réduit plus la fenêtre bord à bord
                android.graphics.Insets clavier = Build.VERSION.SDK_INT >= 35 ? encarts.getInsets(WindowInsets.Type.ime()) : android.graphics.Insets.NONE;
                g = i.left; h = i.top; d = i.right; b = Math.max(i.bottom, clavier.bottom);
            } else {
                g = encarts.getSystemWindowInsetLeft(); h = encarts.getSystemWindowInsetTop();
                d = encarts.getSystemWindowInsetRight(); b = encarts.getSystemWindowInsetBottom();
            }
            v.setPadding(g, h, d, b);
            return encarts;
        });
        setContentView(cadre);

        WebSettings s = vue.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setGeolocationEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false); // bips des messages
        s.setAllowFileAccess(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setUserAgentString(s.getUserAgentString() + " CarteLiveAndroid/" + version());
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(vue, true);
        vue.addJavascriptInterface(new Pont(), "Appli");

        vue.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                String sch = u.getScheme() == null ? "" : u.getScheme();
                if (sch.equals("http") || sch.equals("https") || sch.equals("file")) {
                    // Liens vers un autre site (GitHub, Google Maps, cartes.gouv.fr…) : navigateur du téléphone
                    String carte = prefs.getString("courante", "");
                    if (!carte.isEmpty() && !sch.equals("file") && !memeOrigine(u, Uri.parse(carte))) { ouvrirAilleurs(u); return true; }
                    return false;
                }
                ouvrirAilleurs(u); // geo:, tel:, mailto:…
                return true;
            }

            // Nom des fichiers fabriqués dans la page : retenu au clic sur un lien « download »
            @Override
            public void onPageFinished(WebView v, String url) {
                v.evaluateJavascript("if(window.Appli&&!window.__nomFichier){window.__nomFichier=1;document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a[download]');if(a)Appli.nomFichier(a.getAttribute('download')||'')},true);"
                        + "var o=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){if(this.hasAttribute('download'))Appli.nomFichier(this.getAttribute('download')||'');return o.apply(this,arguments)}}", null);
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest r, android.webkit.WebResourceError e) {
                if (r.isForMainFrame() && !String.valueOf(r.getUrl()).startsWith("file:")) {
                    String msg = String.valueOf(e.getDescription());
                    v.loadUrl(ACCUEIL + "#erreur=" + Uri.encode(r.getUrl() + " : " + msg));
                }
            }
        });

        vue.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(String origine, GeolocationPermissions.Callback rappel) {
                if (aPosition()) { rappel.invoke(origine, true, false); return; }
                rappelPosition = rappel; origineDemandee = origine;
                requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, DEMANDE_POSITION);
            }

            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> rappel, FileChooserParams p) {
                if (rappelFichier != null) rappelFichier.onReceiveValue(null);
                rappelFichier = rappel;
                try { startActivityForResult(p.createIntent(), DEMANDE_FICHIER); }
                catch (Exception e) { rappelFichier = null; return false; }
                return true;
            }
        });

        // Téléchargements : fichiers du serveur (avec la session) et fichiers fabriqués dans la page (blob:)
        vue.setDownloadListener((url, agent, disposition, type, taille) -> {
            String nom = URLUtil.guessFileName(url, disposition, type);
            if (url.startsWith("blob:") || url.startsWith("data:")) {
                String js = "(function(){fetch('" + url + "').then(function(r){return r.blob()}).then(function(b){var f=new FileReader();"
                        + "f.onload=function(){Appli.fichier(" + jsTexte(nomBlob(nom)) + ",b.type||" + jsTexte(type) + ",f.result)};f.readAsDataURL(b)})})()";
                vue.evaluateJavascript(js, null);
                return;
            }
            try {
                DownloadManager.Request d = new DownloadManager.Request(Uri.parse(url));
                String c = CookieManager.getInstance().getCookie(url);
                if (c != null) d.addRequestHeader("Cookie", c);
                d.addRequestHeader("User-Agent", agent);
                d.setMimeType(type);
                d.setTitle(nom);
                d.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                d.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, nom);
                ((DownloadManager) getSystemService(DOWNLOAD_SERVICE)).enqueue(d);
                Toast.makeText(this, "Téléchargement : " + nom, Toast.LENGTH_SHORT).show();
            } catch (Exception e) {
                Toast.makeText(this, "Téléchargement impossible : " + e.getMessage(), Toast.LENGTH_LONG).show();
            }
        });

        Veille.creerCanaux(this);
        lancerVeille();
        if (!BuildConfig.PLAY) verifierMiseAJour(false);
        if (etatSauve != null) { vue.restoreState(etatSauve); return; }
        String courante = prefs.getString("courante", "");
        vue.loadUrl(courante.isEmpty() ? ACCUEIL : courante);
    }

    // Nom d'un fichier fabriqué dans la page : celui de l'attribut download du dernier lien cliqué, sinon deviné
    private String nomBlob(String devine) {
        String n = prefs.getString("dernierNom", "");
        return n.isEmpty() ? devine : n;
    }

    private static String jsTexte(String t) {
        return "'" + String.valueOf(t == null ? "" : t).replace("\\", "\\\\").replace("'", "\\'") + "'";
    }

    private static boolean memeOrigine(Uri a, Uri b) {
        return String.valueOf(a.getHost()).equalsIgnoreCase(String.valueOf(b.getHost())) && a.getPort() == b.getPort();
    }

    private void ouvrirAilleurs(Uri u) {
        try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception e) { /* aucune appli */ }
    }

    private boolean aPosition() {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
                || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private String version() {
        try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception e) { return "?"; }
    }

    // Veille des messages (service en arrière-plan) : demande la permission de notifier (Android 13+) puis démarre
    private void lancerVeille() {
        if (!prefs.getBoolean("notifications", true) || prefs.getString("courante", "").isEmpty()) return;
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, DEMANDE_NOTIF);
            return;
        }
        try { Veille.demarrer(this); } catch (Exception e) { /* refusé par Android */ }
    }

    // Nouvelle version de l'APK publiée sur GitHub : signalée une fois par jour (ou à la demande), avec un bouton qui
    // ouvre sa page dans le navigateur ; elle s'installe par-dessus (même clé de signature), les cartes sont gardées
    private void verifierMiseAJour(boolean demande) {
        if (BuildConfig.PLAY) { // version du Play Store : les mises à jour passent par le Store
            try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=" + getPackageName()))); }
            catch (Exception e) { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=" + getPackageName()))); }
            return;
        }
        long der = prefs.getLong("majVerifiee", 0);
        if (!demande && System.currentTimeMillis() - der < 20 * 3600000L) return;
        new Thread(() -> {
            try {
                HttpURLConnection c = (HttpURLConnection) new URL("https://api.github.com/repos/" + DEPOT + "/releases/latest").openConnection();
                c.setConnectTimeout(10000); c.setReadTimeout(15000);
                c.setRequestProperty("Accept", "application/vnd.github+json");
                c.setRequestProperty("User-Agent", "CarteLiveAndroid");
                if (c.getResponseCode() != 200) return;
                java.io.InputStream in = c.getInputStream();
                java.io.ByteArrayOutputStream o = new java.io.ByteArrayOutputStream();
                byte[] t = new byte[8192]; int n;
                while ((n = in.read(t)) > 0) o.write(t, 0, n);
                JSONObject r = new JSONObject(o.toString("UTF-8"));
                prefs.edit().putLong("majVerifiee", System.currentTimeMillis()).apply();
                String tag = r.optString("tag_name", "").replaceFirst("^v", "");
                String apk = null;
                JSONArray a = r.optJSONArray("assets");
                for (int i = 0; a != null && i < a.length(); i++) if (a.getJSONObject(i).optString("name").endsWith(".apk")) apk = a.getJSONObject(i).optString("browser_download_url");
                final String lien = apk;
                boolean plusRecente = comparer(tag, version()) > 0;
                runOnUiThread(() -> {
                    if (plusRecente && lien != null) {
                        new AlertDialog.Builder(this).setTitle("Nouvelle version " + tag)
                                .setMessage("Une nouvelle version de l'application est disponible (installée : " + version() + "). Ouvrir sa page de téléchargement dans le navigateur ? Vos cartes enregistrées sont gardées.")
                                .setPositiveButton("Ouvrir la page", (d, w) -> ouvrirAilleurs(Uri.parse("https://github.com/" + DEPOT + "/releases/tag/v" + tag)))
                                .setNegativeButton("Plus tard", null).show();
                    } else if (demande) Toast.makeText(this, "L'application est à jour (" + version() + ")", Toast.LENGTH_LONG).show();
                });
            } catch (Exception e) {
                if (demande) runOnUiThread(() -> Toast.makeText(this, "Vérification impossible : " + e.getMessage(), Toast.LENGTH_LONG).show());
            }
        }).start();
    }

    private static int comparer(String a, String b) {
        String[] x = a.split("\\."), y = b.split("\\.");
        for (int i = 0; i < Math.max(x.length, y.length); i++) {
            int u = i < x.length ? entier(x[i]) : 0, v = i < y.length ? entier(y[i]) : 0;
            if (u != v) return Integer.compare(u, v);
        }
        return 0;
    }
    private static int entier(String s) { try { return Integer.parseInt(s.replaceAll("[^0-9].*$", "")); } catch (Exception e) { return 0; } }

    // L'appli ne télécharge ni n'installe jamais de fichier APK elle-même : elle ouvre seulement la page de la version
    // dans le navigateur du téléphone, qui télécharge et installe. Une appli qui va chercher une APK et la présente à
    // l'installateur ressemble, pour Google Play Protect, à un programme qui en installe d'autres en cachette
    // (alerte « Appli dangereuse bloquée »), même sans aucune permission d'installation.

    // Cherche une carte live sur le réseau local (Wi-Fi de la maison, point d'accès d'un Pi autonome) : toutes les
    // adresses du sous-réseau, port 8095, réponse de /sante
    private void chercherCartes() {
        new Thread(() -> {
            List<String> trouvees = Collections.synchronizedList(new ArrayList<>());
            try {
                List<String> prefixes = new ArrayList<>();
                for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                    if (!ni.isUp() || ni.isLoopback()) continue;
                    for (InetAddress ad : Collections.list(ni.getInetAddresses())) {
                        if (!(ad instanceof Inet4Address) || !ad.isSiteLocalAddress()) continue;
                        String ip = ad.getHostAddress();
                        String p = ip.substring(0, ip.lastIndexOf('.') + 1);
                        if (!prefixes.contains(p)) prefixes.add(p);
                    }
                }
                ExecutorService ex = Executors.newFixedThreadPool(48);
                for (String p : prefixes) for (int k = 1; k < 255; k++) {
                    final String base = "http://" + p + k + ":8095";
                    ex.submit(() -> {
                        try {
                            HttpURLConnection c = (HttpURLConnection) new URL(base + "/sante").openConnection();
                            c.setConnectTimeout(700); c.setReadTimeout(1200);
                            if (c.getResponseCode() == 200) {
                                java.io.InputStream in = c.getInputStream(); byte[] t = new byte[200]; int n = in.read(t);
                                if (n > 0 && new String(t, 0, n).contains("\"ok\"")) trouvees.add(base);
                            }
                            c.disconnect();
                        } catch (Exception e) { /* rien à cette adresse */ }
                    });
                }
                ex.shutdown();
                ex.awaitTermination(25, TimeUnit.SECONDS);
            } catch (Exception e) { /* réseau indisponible */ }
            JSONArray r = new JSONArray(trouvees);
            runOnUiThread(() -> vue.evaluateJavascript("window.cartesTrouvees && window.cartesTrouvees(" + r + ")", null));
        }).start();
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] res) {
        if (code == DEMANDE_NOTIF) { try { Veille.demarrer(this); } catch (Exception e) { /* refusé */ } return; }
        if (code == DEMANDE_POSITION && rappelPosition != null) {
            rappelPosition.invoke(origineDemandee, aPosition(), false);
            rappelPosition = null;
        }
    }

    @Override
    protected void onActivityResult(int code, int resultat, Intent donnees) {
        if (code == DEMANDE_FICHIER && rappelFichier != null) {
            rappelFichier.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultat, donnees));
            rappelFichier = null;
            return;
        }
        super.onActivityResult(code, resultat, donnees);
    }

    @Override
    protected void onSaveInstanceState(Bundle b) {
        super.onSaveInstanceState(b);
        vue.saveState(b);
    }

    // Retour : page précédente de la carte ; tout au début, proposer de changer de carte ou de quitter
    @Override
    public void onBackPressed() {
        if (vue.canGoBack()) { vue.goBack(); return; }
        if (String.valueOf(vue.getUrl()).startsWith(ACCUEIL)) { finish(); return; }
        new AlertDialog.Builder(this)
                .setTitle("Carte live · appli " + version())
                .setItems(new String[]{"Changer de carte", "Recharger", "Rechercher une mise à jour", "Quitter"}, (d, i) -> {
                    if (i == 0) vue.loadUrl(ACCUEIL);
                    else if (i == 1) vue.reload();
                    else if (i == 2) verifierMiseAJour(true);
                    else finish();
                })
                .show();
    }

    // Échanges avec la page d'accueil (liste des cartes) et avec la carte (fichiers à enregistrer)
    private class Pont {
        @JavascriptInterface
        public String cartes() { return prefs.getString("cartes", "[]"); }

        @JavascriptInterface
        public void enregistrerCartes(String json) { prefs.edit().putString("cartes", json).apply(); }

        @JavascriptInterface
        public String courante() { return prefs.getString("courante", ""); }

        @JavascriptInterface
        public void ouvrir(String url) {
            prefs.edit().putString("courante", url).putLong("notifDepuis", System.currentTimeMillis()).apply();
            runOnUiThread(() -> { vue.clearHistory(); vue.loadUrl(url); lancerVeille(); });
        }

        @JavascriptInterface
        public String version() { return MainActivity.this.version(); }

        @JavascriptInterface
        public boolean notifications() { return prefs.getBoolean("notifications", true); }

        @JavascriptInterface
        public void reglerNotifications(boolean oui) {
            prefs.edit().putBoolean("notifications", oui).apply();
            runOnUiThread(() -> { if (oui) lancerVeille(); else Veille.arreter(MainActivity.this); });
        }

        @JavascriptInterface
        public void chercher() { chercherCartes(); }

        @JavascriptInterface
        public void verifierMaj() { runOnUiThread(() -> verifierMiseAJour(true)); }

        @JavascriptInterface
        public void nomFichier(String nom) { prefs.edit().putString("dernierNom", nom == null ? "" : nom).apply(); }

        // Fichier fabriqué dans la page (GPX, export…) : enregistré dans Téléchargements
        @JavascriptInterface
        public void fichier(String nom, String type, String dataUrl) {
            try {
                byte[] octets = Base64.decode(dataUrl.substring(dataUrl.indexOf(',') + 1), Base64.DEFAULT);
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.Downloads.DISPLAY_NAME, nom);
                    v.put(MediaStore.Downloads.MIME_TYPE, type == null || type.isEmpty() ? "application/octet-stream" : type);
                    Uri u = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                    try (OutputStream o = getContentResolver().openOutputStream(u)) { o.write(octets); }
                } else {
                    File f = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), nom);
                    try (FileOutputStream o = new FileOutputStream(f)) { o.write(octets); }
                }
                runOnUiThread(() -> Toast.makeText(MainActivity.this, "Enregistré dans Téléchargements : " + nom, Toast.LENGTH_LONG).show());
            } catch (Exception e) {
                runOnUiThread(() -> Toast.makeText(MainActivity.this, "Enregistrement impossible : " + e.getMessage(), Toast.LENGTH_LONG).show());
            }
        }
    }
}
