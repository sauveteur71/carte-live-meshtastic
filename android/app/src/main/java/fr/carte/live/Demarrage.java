package fr.carte.live;

// Au redémarrage du téléphone : la veille des messages repart si elle était activée
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class Demarrage extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent i) {
        if (!Intent.ACTION_BOOT_COMPLETED.equals(i.getAction())) return;
        android.content.SharedPreferences p = c.getSharedPreferences("carte", Context.MODE_PRIVATE);
        if (p.getBoolean("notifications", true) && !p.getString("courante", "").isEmpty()) {
            try { Veille.demarrer(c); } catch (Exception e) { /* refusé par Android : repartira à l'ouverture de l'appli */ }
        }
    }
}
