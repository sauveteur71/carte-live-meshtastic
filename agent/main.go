// Agent Gaulix : relie un ou plusieurs modules Meshtastic (USB/série ou Wi-Fi) à la carte live qui tourne sur le serveur.
//
// L'agent se connecte au serveur (par Tailscale ou le réseau local), se présente avec le code secret affiché
// dans la carte (Réseau › Modules), puis attend. Quand la carte choisit ce module, le serveur envoie « OUVRIR » :
// l'agent ouvre alors le port USB (ou la connexion Wi-Fi du module) et fait suivre le flux Meshtastic
// dans les deux sens, sans le modifier. Le module n'est occupé que pendant ce temps.
//
// Plusieurs connexions peuvent être gardées en mémoire (ex. « USB », « Le Monteil », « QRA ») : chacune apparaît
// dans la carte comme un module distinct, mais seulement quand le module est présent (port USB branché,
// ou module Wi-Fi sur le même réseau local que le PC).
package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"go.bug.st/serial"
)

const version = "1.5"

// Une connexion gardée en mémoire : un module et le nom sous lequel il apparaît dans la carte
type Connexion struct {
	Nom    string `json:"nom"`    // nom affiché dans la carte (ex. Le Monteil)
	Source string `json:"source"` // port série (COM5, /dev/ttyACM0) ou adresse Wi-Fi du module (192.168.1.40[:4403])
	Debit  int    `json:"debit,omitempty"`
	// Module Wi-Fi joignable par une route (VPN, routeur) : ne pas exiger qu'il soit sur le réseau local du PC
	Toujours bool `json:"toujours,omitempty"`
}

type Reglages struct {
	Serveur    string      `json:"serveur"` // ex. 100.64.1.2:4404 (adresse Tailscale ou locale du serveur)
	Code       string      `json:"code"`    // code secret affiché dans la carte
	Connexions []Connexion `json:"connexions"`
	// La question du démarrage automatique a déjà été posée
	AutoDemande bool `json:"demarrageDemande,omitempty"`
	// Ancien format (agent ≤ 1.3) : une seule connexion, reprise automatiquement
	Nom    string `json:"nom,omitempty"`
	Source string `json:"source,omitempty"`
	Debit  int    `json:"debit,omitempty"`
}

var entree = bufio.NewReader(os.Stdin)
var muJournal sync.Mutex

func journal(format string, a ...any) {
	muJournal.Lock()
	defer muJournal.Unlock()
	fmt.Printf("%s  %s\n", time.Now().Format("15:04:05"), fmt.Sprintf(format, a...))
}

func demander(question, defaut string) string {
	if defaut != "" {
		fmt.Printf("%s [%s] : ", question, defaut)
	} else {
		fmt.Printf("%s : ", question)
	}
	l, _ := entree.ReadString('\n')
	l = strings.TrimSpace(l)
	if l == "" {
		return defaut
	}
	return l
}

func fichierReglages(chemin string) string {
	if chemin != "" {
		return chemin
	}
	exe, err := os.Executable()
	if err != nil {
		return "agent-gaulix.json"
	}
	return filepath.Join(filepath.Dir(exe), "agent-gaulix.json")
}

func charger(f string) Reglages {
	var r Reglages
	if b, err := os.ReadFile(f); err == nil {
		_ = json.Unmarshal(b, &r)
	}
	// Reprise de l'ancien format à une seule connexion
	if len(r.Connexions) == 0 && r.Source != "" {
		r.Connexions = []Connexion{{Nom: firstNonEmpty(r.Nom, "Module"), Source: r.Source, Debit: r.Debit}}
	}
	r.Nom, r.Source, r.Debit = "", "", 0
	return r
}

func enregistrer(f string, r Reglages) {
	b, _ := json.MarshalIndent(r, "", "  ")
	if err := os.WriteFile(f, b, 0600); err != nil {
		journal("réglages non enregistrés (%v)", err)
	} else {
		journal("réglages enregistrés dans %s", f)
	}
}

// Module Wi-Fi : adresse IP (ou nom réseau avec un point), avec ou sans « :port ». Sinon : port série (COM5, /dev/ttyACM0).
func estReseau(source string) bool {
	s := strings.TrimSpace(source)
	if strings.HasPrefix(strings.ToUpper(s), "COM") || strings.HasPrefix(s, "/dev/") {
		return false
	}
	return regexp.MustCompile(`^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+(:\d+)?$`).MatchString(s)
}

// Adresse du module Wi-Fi avec le port Meshtastic par défaut (4403)
func adresseModule(source string) string {
	s := strings.TrimSpace(source)
	if regexp.MustCompile(`:\d+$`).MatchString(s) {
		return s
	}
	return s + ":4403"
}

// Le module est-il là ? USB : le port existe. Wi-Fi : son adresse est sur un réseau local du PC.
// (On ne se connecte pas au module pour vérifier : cela couperait l'appli du téléphone ou un autre client.)
func present(cx Connexion) (bool, string) {
	if !estReseau(cx.Source) {
		ports, _ := serial.GetPortsList()
		for _, p := range ports {
			if strings.EqualFold(p, cx.Source) {
				return true, ""
			}
		}
		return false, "port " + cx.Source + " absent (module débranché ?)"
	}
	if cx.Toujours {
		return true, ""
	}
	hote, _, err := net.SplitHostPort(adresseModule(cx.Source))
	if err != nil {
		return true, ""
	}
	ip := net.ParseIP(hote)
	if ip == nil {
		ips, err := net.LookupIP(hote)
		if err != nil || len(ips) == 0 {
			return false, "nom " + hote + " introuvable sur ce réseau"
		}
		ip = ips[0]
	}
	if ip.IsLoopback() {
		return true, ""
	}
	adresses, _ := net.InterfaceAddrs()
	for _, a := range adresses {
		if n, ok := a.(*net.IPNet); ok && n.Contains(ip) {
			ones, bits := n.Mask.Size()
			if ones < bits { // un /32 (Tailscale…) ne compte pas comme réseau local
				return true, ""
			}
		}
	}
	return false, "le PC n'est pas sur le réseau de " + hote
}

func decrire(cx Connexion) string {
	if estReseau(cx.Source) {
		return "Wi-Fi " + adresseModule(cx.Source)
	}
	return "USB " + cx.Source
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

func normaliserNom(n string) string {
	return strings.ToLower(strings.TrimSpace(n))
}

// ---- Configuration interactive ----

func configurerServeur(r *Reglages) {
	fmt.Println()
	fmt.Println("=== Configuration de l'agent Gaulix ===")
	fmt.Println("Le code secret se trouve dans la carte : Réseau › Modules › « Module par agent ».")
	for r.Serveur = demander("Adresse du serveur de la carte (Tailscale ou réseau local) et port, ex. 192.168.1.10:4404", r.Serveur); r.Serveur == ""; {
		r.Serveur = demander("Adresse du serveur (obligatoire)", "")
	}
	if !strings.Contains(r.Serveur, ":") {
		r.Serveur += ":4404"
	}
	r.Code = demander("Code secret de la carte", r.Code)
}

func saisirConnexion(r *Reglages, cx Connexion, exclure int) (Connexion, bool) {
	fmt.Println()
	for {
		cx.Nom = demander("Nom de ce module dans la carte (ex. Le Monteil, QRA, USB)", cx.Nom)
		if cx.Nom == "" {
			return cx, false
		}
		doublon := false
		for i, a := range r.Connexions {
			if i != exclure && normaliserNom(a.Nom) == normaliserNom(cx.Nom) {
				doublon = true
			}
		}
		if !doublon {
			break
		}
		fmt.Println("→ ce nom est déjà utilisé par une autre connexion, choisissez-en un autre.")
		cx.Nom = ""
	}
	ports, _ := serial.GetPortsList()
	sort.Strings(ports)
	if len(ports) > 0 {
		fmt.Println("Ports USB/série détectés :", strings.Join(ports, ", "))
	} else {
		fmt.Println("Aucun port USB/série détecté (module débranché ?).")
	}
	def := cx.Source
	if def == "" && len(ports) > 0 {
		def = ports[len(ports)-1]
	}
	cx.Source = demander("Module : port USB (ex. COM5) ou adresse Wi-Fi du module (ex. 192.168.1.40)", def)
	if cx.Source == "" {
		return cx, false
	}
	if !estReseau(cx.Source) && cx.Debit == 0 {
		cx.Debit = 115200
	}
	if estReseau(cx.Source) {
		if ok, _ := present(Connexion{Source: cx.Source}); !ok {
			fmt.Println("(Ce PC n'est pas sur le réseau de ce module en ce moment : normal si le module est ailleurs.")
			fmt.Println(" L'agent le proposera à la carte dès que le PC sera sur ce réseau.)")
		}
	}
	return cx, true
}

func afficherConnexions(r *Reglages) {
	fmt.Println()
	fmt.Println("Connexions enregistrées :")
	if len(r.Connexions) == 0 {
		fmt.Println("  (aucune)")
	}
	for i, cx := range r.Connexions {
		etat := "présent"
		if ok, pourquoi := present(cx); !ok {
			etat = "absent : " + pourquoi
		}
		fmt.Printf("  %d. %-18s %-26s (%s)\n", i+1, cx.Nom, decrire(cx), etat)
	}
}

// Menu : ajouter, modifier, retirer des connexions
func gererConnexions(r *Reglages) {
	if len(r.Connexions) == 0 {
		if cx, ok := saisirConnexion(r, Connexion{}, -1); ok {
			r.Connexions = append(r.Connexions, cx)
		}
	}
	for {
		afficherConnexions(r)
		fmt.Println()
		fmt.Println("  a = ajouter une connexion   m N = modifier la n° N   r N = retirer la n° N   s = serveur et code")
		choix := strings.ToLower(demander("Votre choix (Entrée = terminer et lancer l'agent)", ""))
		if choix == "" {
			if len(r.Connexions) == 0 {
				fmt.Println("→ il faut au moins une connexion.")
				continue
			}
			return
		}
		champs := strings.Fields(choix)
		n := 0
		if len(champs) > 1 {
			n, _ = strconv.Atoi(champs[1])
		} else if len(champs[0]) > 1 {
			n, _ = strconv.Atoi(champs[0][1:])
		}
		switch champs[0][:1] {
		case "a":
			if cx, ok := saisirConnexion(r, Connexion{}, -1); ok {
				r.Connexions = append(r.Connexions, cx)
			}
		case "m":
			if n < 1 || n > len(r.Connexions) {
				fmt.Println("→ numéro inconnu (ex. « m 2 »)")
				continue
			}
			if cx, ok := saisirConnexion(r, r.Connexions[n-1], n-1); ok {
				r.Connexions[n-1] = cx
			}
		case "r":
			if n < 1 || n > len(r.Connexions) {
				fmt.Println("→ numéro inconnu (ex. « r 2 »)")
				continue
			}
			fmt.Printf("→ « %s » retirée\n", r.Connexions[n-1].Nom)
			r.Connexions = append(r.Connexions[:n-1], r.Connexions[n:]...)
		case "s":
			configurerServeur(r)
		default:
			fmt.Println("→ choix inconnu")
		}
	}
}

func main() {
	chemin := flag.String("config", "", "fichier de réglages (par défaut agent-gaulix.json à côté du programme)")
	refaire := flag.Bool("configurer", false, "gérer les connexions (ajouter, modifier, retirer) et le serveur")
	ajouter := flag.Bool("ajouter", false, "ajouter une connexion")
	liste := flag.Bool("liste", false, "afficher les connexions enregistrées")
	auto := flag.Bool("demarrage-auto", false, "lancer l'agent automatiquement à l'ouverture de session (Windows)")
	sansAuto := flag.Bool("sans-demarrage-auto", false, "ne plus lancer l'agent automatiquement")
	flag.Parse()
	if *sansAuto {
		retirerDemarrageAuto()
		return
	}

	fmt.Printf("Agent Gaulix %s — relais de modules Meshtastic vers la carte live\n", version)
	f := fichierReglages(*chemin)
	r := charger(f)
	if *liste {
		afficherConnexions(&r)
		return
	}
	modifie := false
	if r.Serveur == "" || r.Code == "" {
		configurerServeur(&r)
		modifie = true
	}
	if *ajouter {
		if cx, ok := saisirConnexion(&r, Connexion{}, -1); ok {
			r.Connexions = append(r.Connexions, cx)
			modifie = true
		}
	}
	if *refaire || len(r.Connexions) == 0 {
		gererConnexions(&r)
		modifie = true
	}
	if modifie {
		enregistrer(f, r)
	}
	// Une seule fois : proposer le lancement automatique (plus besoin de relancer l'agent à la main)
	if runtime.GOOS == "windows" && !r.AutoDemande && !demarrageAutoActif() {
		if rep := strings.ToLower(demander("Lancer l'agent automatiquement à chaque démarrage de Windows ? (o/n)", "o")); strings.HasPrefix(rep, "o") || rep == "y" {
			installerDemarrageAuto()
		}
		r.AutoDemande = true
		b, _ := json.MarshalIndent(r, "", "  ")
		_ = os.WriteFile(f, b, 0600)
	}
	if *auto {
		installerDemarrageAuto()
	}
	journal("carte %s — %d connexion(s) : pour en ajouter ou en retirer, relancez avec -configurer", r.Serveur, len(r.Connexions))
	var g sync.WaitGroup
	for _, cx := range r.Connexions {
		g.Add(1)
		go func(cx Connexion) {
			defer g.Done()
			surveiller(r.Serveur, r.Code, cx)
		}(cx)
	}
	g.Wait()
}

// Une connexion : proposée à la carte tant que son module est présent
func surveiller(serveur, code string, cx Connexion) {
	dernier := ""
	for {
		if ok, pourquoi := present(cx); !ok {
			if pourquoi != dernier {
				journal("[%s] en attente : %s", cx.Nom, pourquoi)
				dernier = pourquoi
			}
			time.Sleep(20 * time.Second)
			continue
		}
		if dernier != "" {
			journal("[%s] module de nouveau présent (%s)", cx.Nom, decrire(cx))
		}
		dernier = ""
		time.Sleep(boucle(serveur, code, cx))
	}
}

// Une session avec le serveur. Renvoie le délai avant la tentative suivante.
// Échecs consécutifs de dialogue avec la carte : le conseil sur le port 4404 n'est donné qu'après plusieurs essais
// (une seule coupure vient presque toujours d'un redémarrage de la carte, par exemple lors d'une mise à jour)
var echecsServeur int

func boucle(serveur, code string, cx Connexion) time.Duration {
	c, err := net.DialTimeout("tcp", serveur, 10*time.Second)
	if err != nil {
		journal("[%s] serveur injoignable (%v) — Tailscale est-il actif ? Nouvel essai dans 20 s", cx.Nom, err)
		return 20 * time.Second
	}
	defer c.Close()
	if tc, ok := c.(*net.TCPConn); ok {
		tc.SetKeepAlive(true)
		tc.SetKeepAlivePeriod(30 * time.Second)
		tc.SetNoDelay(true)
	}
	type bonjour struct {
		V       int    `json:"v"`
		Code    string `json:"code"`
		Nom     string `json:"nom"`
		Source  string `json:"source"`
		Version string `json:"version"`
	}
	b, _ := json.Marshal(bonjour{1, code, cx.Nom, decrire(cx), version})
	c.SetDeadline(time.Now().Add(15 * time.Second))
	if _, err := c.Write(append(b, '\n')); err != nil {
		journal("[%s] envoi au serveur impossible (%v)", cx.Nom, err)
		return 20 * time.Second
	}
	lecteur := bufio.NewReader(c)
	l, err := lecteur.ReadString('\n')
	if err != nil {
		echecsServeur++
		if echecsServeur >= 4 {
			journal("[%s] la carte ne répond toujours pas (%v) — est-elle démarrée ? le port 4404 est-il ouvert dans docker-compose (jamais sur la box) ?", cx.Nom, err)
		} else {
			journal("[%s] la carte ne répond pas encore (elle redémarre sans doute, par exemple après une mise à jour) : nouvel essai dans 30 s", cx.Nom)
		}
		return 30 * time.Second
	}
	l = strings.TrimSpace(l)
	if strings.HasPrefix(l, "ERREUR") {
		journal("[%s] refusé par la carte : %s", cx.Nom, strings.TrimSpace(strings.TrimPrefix(l, "ERREUR")))
		return 60 * time.Second
	}
	echecsServeur = 0
	journal("[%s] relié à la carte, prêt (%s)", cx.Nom, decrire(cx))
	c.SetDeadline(time.Time{})
	// Attente de l'ordre d'ouverture (le serveur envoie PING régulièrement)
	for {
		c.SetReadDeadline(time.Now().Add(3 * time.Minute))
		l, err = lecteur.ReadString('\n')
		if err != nil {
			journal("[%s] liaison avec la carte interrompue (redémarrage de la carte ?), reconnexion dans 5 s", cx.Nom)
			return 5 * time.Second
		}
		if strings.TrimSpace(l) == "OUVRIR" {
			break
		}
		// « TCP 3232 » : relais vers un autre port du module Wi-Fi (mise à jour du firmware par le Wi-Fi)
		if strings.HasPrefix(strings.TrimSpace(l), "TCP ") {
			c.SetReadDeadline(time.Time{})
			return relayerPort(cx, c, lecteur, strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(l), "TCP ")))
		}
		// À chaque PING : si le module a disparu (USB débranché, PC changé de réseau), on se retire de la carte
		if ok, pourquoi := present(cx); !ok {
			journal("[%s] retiré de la carte : %s", cx.Nom, pourquoi)
			return time.Second
		}
	}
	c.SetReadDeadline(time.Time{})
	return relayer(cx, c, lecteur)
}

type moduleConn interface {
	io.ReadWriteCloser
}

func ouvrirModule(cx Connexion) (moduleConn, time.Duration, error) {
	if estReseau(cx.Source) {
		m, err := net.DialTimeout("tcp", adresseModule(cx.Source), 10*time.Second)
		return m, 0, err
	}
	debit := cx.Debit
	if debit == 0 {
		debit = 115200
	}
	// DTR et RTS au repos : évite de redémarrer les cartes ESP32 à l'ouverture du port
	p, err := serial.Open(cx.Source, &serial.Mode{BaudRate: debit, InitialStatusBits: &serial.ModemOutputBits{DTR: false, RTS: false}})
	if err != nil {
		// Certains ports (adaptateurs virtuels) refusent le réglage DTR/RTS : ouverture simple
		var err2 error
		p, err2 = serial.Open(cx.Source, &serial.Mode{BaudRate: debit})
		if err2 != nil {
			return nil, 0, err
		}
	}
	// Si la carte redémarre malgré tout, on lui laisse le temps de démarrer avant d'envoyer
	return p, 3 * time.Second, nil
}

func relayer(cx Connexion, c net.Conn, lecteur *bufio.Reader) time.Duration {
	m, delai, err := ouvrirModule(cx)
	if err != nil {
		journal("[%s] ouverture du module %s impossible : %v", cx.Nom, cx.Source, err)
		if !estReseau(cx.Source) {
			journal("[%s] → port utilisé par l'appli Meshtastic, la page de la carte (« Brancher en USB ») ou un autre programme ?", cx.Nom)
		}
		return 15 * time.Second
	}
	journal("[%s] module %s ouvert, relais actif", cx.Nom, cx.Source)
	debut := time.Now()
	var once sync.Once
	fin := make(chan struct{})
	fermer := func() { once.Do(func() { c.Close(); m.Close(); close(fin) }) }
	var versModule, versCarte int64
	cote := ""
	var mu sync.Mutex
	marquer := func(t string) {
		mu.Lock()
		if cote == "" {
			cote = t
		}
		mu.Unlock()
	}
	go func() { // module → carte
		n, _ := io.Copy(c, m)
		versCarte = n
		marquer("le module a coupé la liaison (autre client sur le module ? appli du téléphone en Wi-Fi ?)")
		fermer()
	}()
	go func() { // carte → module (après le délai de démarrage éventuel)
		if delai > 0 {
			time.Sleep(delai)
		}
		n, _ := io.Copy(m, lecteur)
		versModule = n
		marquer("la carte a fermé la liaison (autre module choisi ou déconnexion)")
		fermer()
	}()
	<-fin
	journal("[%s] relais terminé après %s : %s (%d octets reçus du module, %d envoyés)", cx.Nom, time.Since(debut).Round(time.Second), cote, versCarte, versModule)
	return 5 * time.Second
}

// Relais vers un autre port TCP du module Wi-Fi (seulement 3232 : chargeur de mise à jour du firmware)
func relayerPort(cx Connexion, c net.Conn, lecteur *bufio.Reader, port string) time.Duration {
	if port != "3232" || !estReseau(cx.Source) {
		journal("[%s] demande refusée : port %s (seule la mise à jour par Wi-Fi d'un module en réseau est relayée)", cx.Nom, port)
		return 5 * time.Second
	}
	hote := strings.TrimSpace(cx.Source)
	if i := strings.LastIndex(hote, ":"); i > 0 {
		hote = hote[:i]
	}
	var m net.Conn
	var err error
	for essai := 0; essai < 3; essai++ {
		if m, err = net.DialTimeout("tcp", hote+":"+port, 10*time.Second); err == nil {
			break
		}
		time.Sleep(2 * time.Second)
	}
	if err != nil {
		journal("[%s] mise à jour : chargeur du module injoignable sur %s:%s (%v)", cx.Nom, hote, port, err)
		return 5 * time.Second
	}
	journal("[%s] mise à jour du firmware : relais vers %s:%s", cx.Nom, hote, port)
	var once sync.Once
	fin := make(chan struct{})
	fermer := func() { once.Do(func() { c.Close(); m.Close(); close(fin) }) }
	go func() { io.Copy(c, m); fermer() }()
	go func() { io.Copy(m, lecteur); fermer() }()
	<-fin
	journal("[%s] relais de mise à jour terminé", cx.Nom)
	return 3 * time.Second
}

// ---- Démarrage automatique (Windows : petit fichier dans le dossier « Démarrage » de la session) ----
func fichierDemarrage() string {
	appdata := os.Getenv("APPDATA")
	if appdata == "" {
		return ""
	}
	return filepath.Join(appdata, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "agent-gaulix.cmd")
}

func demarrageAutoActif() bool {
	f := fichierDemarrage()
	if f == "" {
		return false
	}
	_, err := os.Stat(f)
	return err == nil
}

func installerDemarrageAuto() {
	if runtime.GOOS != "windows" {
		journal("démarrage automatique : sous Linux / Raspberry Pi, créez un service systemd (voir le README du dépôt)")
		return
	}
	exe, err := os.Executable()
	if err != nil {
		journal("démarrage automatique impossible (%v)", err)
		return
	}
	contenu := "@echo off\r\nrem Agent Gaulix : relie les modules Meshtastic à la carte live\r\nstart \"Agent Gaulix\" /min \"" + exe + "\"\r\n"
	if err := os.WriteFile(fichierDemarrage(), []byte(contenu), 0644); err != nil {
		journal("démarrage automatique impossible (%v)", err)
		return
	}
	journal("l'agent se lancera tout seul (fenêtre réduite) à chaque ouverture de session Windows. Pour l'arrêter : -sans-demarrage-auto")
}

func retirerDemarrageAuto() {
	if f := fichierDemarrage(); f != "" {
		if err := os.Remove(f); err == nil {
			journal("démarrage automatique retiré")
			return
		}
	}
	journal("le démarrage automatique n'était pas activé")
}
