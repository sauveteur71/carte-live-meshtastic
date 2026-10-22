// Agent Gaulix : relie un module Meshtastic (USB/série ou Wi-Fi) à la carte live Gaulix qui tourne sur le NAS.
//
// L'agent se connecte au NAS (par Tailscale ou le réseau local), se présente avec le code secret affiché
// dans la carte (Réseau › Modules), puis attend. Quand la carte choisit ce module, le NAS envoie « OUVRIR » :
// l'agent ouvre alors le port USB (ou la connexion Wi-Fi du module) et fait suivre le flux Meshtastic
// dans les deux sens, sans le modifier. Le module n'est occupé que pendant ce temps.
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
	"strings"
	"sync"
	"time"

	"go.bug.st/serial"
)

const version = "1.3"

type Reglages struct {
	Serveur string `json:"serveur"` // ex. 100.64.1.2:4404 (adresse Tailscale ou locale du serveur)
	Code    string `json:"code"`    // code secret affiché dans la carte
	Nom     string `json:"nom"`     // nom affiché dans la carte (ex. Voiture)
	Source  string `json:"source"`  // port série (COM5, /dev/ttyACM0) ou adresse Wi-Fi du module (192.168.1.40:4403)
	Debit   int    `json:"debit,omitempty"`
	// La question du démarrage automatique a déjà été posée
	AutoDemande bool `json:"demarrageDemande,omitempty"`
}

var entree = bufio.NewReader(os.Stdin)

func journal(format string, a ...any) {
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

func configurer(r *Reglages) {
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
	r.Nom = demander("Nom de ce module dans la carte (ex. Voiture, Le Monteil)", firstNonEmpty(r.Nom, "Voiture"))
	ports, _ := serial.GetPortsList()
	sort.Strings(ports)
	if len(ports) > 0 {
		fmt.Println("Ports USB/série détectés :", strings.Join(ports, ", "))
	} else {
		fmt.Println("Aucun port USB/série détecté (module débranché ?).")
	}
	def := r.Source
	if def == "" && len(ports) > 0 {
		def = ports[len(ports)-1]
	}
	r.Source = demander("Module : port USB (ex. COM5) ou adresse Wi-Fi du module (ex. 192.168.1.40:4403)", def)
	if !estReseau(r.Source) && r.Debit == 0 {
		r.Debit = 115200
	}
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

func main() {
	chemin := flag.String("config", "", "fichier de réglages (par défaut agent-gaulix.json à côté du programme)")
	refaire := flag.Bool("configurer", false, "reposer les questions de configuration")
	auto := flag.Bool("demarrage-auto", false, "lancer l'agent automatiquement à l'ouverture de session (Windows)")
	sansAuto := flag.Bool("sans-demarrage-auto", false, "ne plus lancer l'agent automatiquement")
	flag.Parse()
	if *sansAuto {
		retirerDemarrageAuto()
		return
	}

	fmt.Printf("Agent Gaulix %s — relais d'un module Meshtastic vers la carte live\n", version)
	f := fichierReglages(*chemin)
	var r Reglages
	if b, err := os.ReadFile(f); err == nil {
		_ = json.Unmarshal(b, &r)
	}
	if *refaire || r.Serveur == "" || r.Code == "" || r.Source == "" {
		configurer(&r)
		b, _ := json.MarshalIndent(r, "", "  ")
		if err := os.WriteFile(f, b, 0600); err != nil {
			journal("réglages non enregistrés (%v)", err)
		} else {
			journal("réglages enregistrés dans %s (relancez avec -configurer pour les changer)", f)
		}
	}
	// Une seule fois : proposer le lancement automatique (plus besoin de relancer l'agent à la main)
	if runtime.GOOS == "windows" && !r.AutoDemande && !demarrageAutoActif() {
		if rep := strings.ToLower(demander("Lancer l'agent automatiquement à chaque démarrage de Windows ? (o/n)", "o")); strings.HasPrefix(rep, "o") || rep == "y" {
			installerDemarrageAuto()
		}
		r.AutoDemande = true
		if b, err := json.MarshalIndent(r, "", "  "); err == nil {
			_ = os.WriteFile(f, b, 0600)
		}
	}
	if *auto {
		installerDemarrageAuto()
	}
	journal("module « %s » sur %s, carte %s", r.Nom, r.Source, r.Serveur)
	for {
		attente := boucle(&r)
		time.Sleep(attente)
	}
}

// Une session avec le NAS. Renvoie le délai avant la tentative suivante.
func boucle(r *Reglages) time.Duration {
	c, err := net.DialTimeout("tcp", r.Serveur, 10*time.Second)
	if err != nil {
		journal("NAS injoignable (%v) — Tailscale est-il actif ? Nouvel essai dans 20 s", err)
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
	src := "USB " + r.Source
	if estReseau(r.Source) {
		src = "Wi-Fi " + adresseModule(r.Source)
	}
	b, _ := json.Marshal(bonjour{1, r.Code, r.Nom, src, version})
	c.SetDeadline(time.Now().Add(15 * time.Second))
	if _, err := c.Write(append(b, '\n')); err != nil {
		journal("envoi au NAS impossible (%v)", err)
		return 20 * time.Second
	}
	lecteur := bufio.NewReader(c)
	l, err := lecteur.ReadString('\n')
	if err != nil {
		journal("pas de réponse du NAS (%v) — le port 4404 est-il ouvert dans docker-compose ?", err)
		return 30 * time.Second
	}
	l = strings.TrimSpace(l)
	if strings.HasPrefix(l, "ERREUR") {
		journal("refusé par la carte : %s", strings.TrimSpace(strings.TrimPrefix(l, "ERREUR")))
		return 60 * time.Second
	}
	journal("relié à la carte, en attente (choisissez « %s » dans Réseau › Modules)", r.Nom)
	c.SetDeadline(time.Time{})
	// Attente de l'ordre d'ouverture (le NAS envoie PING régulièrement)
	for {
		c.SetReadDeadline(time.Now().Add(3 * time.Minute))
		l, err = lecteur.ReadString('\n')
		if err != nil {
			journal("liaison avec la carte perdue (%v), reconnexion dans 5 s", err)
			return 5 * time.Second
		}
		if strings.TrimSpace(l) == "OUVRIR" {
			break
		}
	}
	c.SetReadDeadline(time.Time{})
	return relayer(r, c, lecteur)
}

type moduleConn interface {
	io.ReadWriteCloser
}

func ouvrirModule(r *Reglages) (moduleConn, time.Duration, error) {
	if estReseau(r.Source) {
		m, err := net.DialTimeout("tcp", adresseModule(r.Source), 10*time.Second)
		return m, 0, err
	}
	debit := r.Debit
	if debit == 0 {
		debit = 115200
	}
	// DTR et RTS au repos : évite de redémarrer les cartes ESP32 à l'ouverture du port
	p, err := serial.Open(r.Source, &serial.Mode{BaudRate: debit, InitialStatusBits: &serial.ModemOutputBits{DTR: false, RTS: false}})
	if err != nil {
		// Certains ports (adaptateurs virtuels) refusent le réglage DTR/RTS : ouverture simple
		var err2 error
		p, err2 = serial.Open(r.Source, &serial.Mode{BaudRate: debit})
		if err2 != nil {
			return nil, 0, err
		}
	}
	// Si la carte redémarre malgré tout, on lui laisse le temps de démarrer avant d'envoyer
	return p, 3 * time.Second, nil
}

func relayer(r *Reglages, c net.Conn, lecteur *bufio.Reader) time.Duration {
	m, delai, err := ouvrirModule(r)
	if err != nil {
		journal("ouverture du module %s impossible : %v", r.Source, err)
		if !estReseau(r.Source) {
			journal("→ module branché ? port utilisé par l'appli Meshtastic ou un autre programme ?")
		}
		return 15 * time.Second
	}
	journal("module %s ouvert, relais actif", r.Source)
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
	journal("relais terminé après %s : %s (%d octets reçus du module, %d envoyés)", time.Since(debut).Round(time.Second), cote, versCarte, versModule)
	return 5 * time.Second
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
	contenu := "@echo off\r\nrem Agent Gaulix : relie le module Meshtastic à la carte live\r\nstart \"Agent Gaulix\" /min \"" + exe + "\"\r\n"
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
