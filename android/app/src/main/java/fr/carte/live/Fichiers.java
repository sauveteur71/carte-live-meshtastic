package fr.carte.live;

// Fournisseur de fichiers minimal : donne à l'installateur Android l'accès à l'APK téléchargée par la mise à jour
// (content://fr.carte.live.fichiers/maj/carte-live.apk), sans bibliothèque supplémentaire
import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;

public class Fichiers extends ContentProvider {
    private File fichier(Uri u) throws FileNotFoundException {
        String nom = u.getLastPathSegment();
        if (nom == null || nom.contains("/") || nom.contains("..") || !nom.endsWith(".apk")) throw new FileNotFoundException();
        File f = new File(getContext().getExternalFilesDir(null), nom);
        if (!f.exists()) throw new FileNotFoundException();
        return f;
    }
    @Override public boolean onCreate() { return true; }
    @Override public String getType(Uri u) { return "application/vnd.android.package-archive"; }
    @Override public ParcelFileDescriptor openFile(Uri u, String mode) throws FileNotFoundException {
        return ParcelFileDescriptor.open(fichier(u), ParcelFileDescriptor.MODE_READ_ONLY);
    }
    @Override public Cursor query(Uri u, String[] p, String s, String[] a, String o) {
        MatrixCursor c = new MatrixCursor(new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE});
        try { File f = fichier(u); c.addRow(new Object[]{f.getName(), f.length()}); } catch (FileNotFoundException e) { /* vide */ }
        return c;
    }
    @Override public Uri insert(Uri u, ContentValues v) { return null; }
    @Override public int delete(Uri u, String s, String[] a) { return 0; }
    @Override public int update(Uri u, ContentValues v, String s, String[] a) { return 0; }
}
