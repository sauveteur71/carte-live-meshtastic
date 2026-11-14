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
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

public class MainActivity extends Activity {
    private static final String ACCUEIL = "file:///android_asset/accueil.html";
    private static final int DEMANDE_POSITION = 1, DEMANDE_FICHIER = 2;
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
        setContentView(vue);

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

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] res) {
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
                .setTitle("Carte live")
                .setItems(new String[]{"Changer de carte", "Recharger", "Quitter"}, (d, i) -> {
                    if (i == 0) vue.loadUrl(ACCUEIL);
                    else if (i == 1) vue.reload();
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
            prefs.edit().putString("courante", url).apply();
            runOnUiThread(() -> { vue.clearHistory(); vue.loadUrl(url); });
        }

        @JavascriptInterface
        public String version() { return MainActivity.this.version(); }

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
