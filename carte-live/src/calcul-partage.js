'use strict';
// Calcul asynchrone partagé par clé : N demandes identiques lancées en même temps (plusieurs onglets, double clic,
// visiteurs d'une carte publique) attendent la même promesse au lieu de lancer N calculs — mémoire × N dans un
// conteneur de 512 Mo pour une couverture radio. La promesse est retirée dès qu'elle est réglée (succès ou échec) :
// la demande suivante relance un calcul si le résultat n'a pas été mis en cache.
function creerCalculPartage() {
  const enCours = new Map();
  function partager(cle, fn) {
    let p = enCours.get(cle);
    if (p) return p;
    p = Promise.resolve().then(fn).finally(() => enCours.delete(cle));
    enCours.set(cle, p);
    return p;
  }
  return { partager, nombre: () => enCours.size };
}

module.exports = { creerCalculPartage };
